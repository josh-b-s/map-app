// services/gtfsRouter.ts
import type { LatLng } from './places';
import { getDb } from './gtfsDb';

// ── Geometry ──────────────────────────────────────────────────────────────────
function haversineMeters(
    a: { latitude: number; longitude: number },
    b: { lat: number; lon: number },
): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.latitude);
    const dLon = toRad(b.lon - a.longitude);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const x =
        sinLat * sinLat +
        Math.cos(toRad(a.latitude)) *
        Math.cos(toRad(b.lat)) *
        sinLon * sinLon;
    return R * 2 * Math.asin(Math.sqrt(x));
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface Stop {
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
    agency: number;
    dist?: number;
}

interface Leg {
    pattern_id: string;
    shape_id: string;
    agency: number;
    route_name: string;
    route_type: number;
    origin_stop: Stop;
    dest_stop: Stop;
    origin_seq: number;
    dest_seq: number;
}

export interface GtfsRouteResult {
    coords: LatLng[];
    legs: {
        routeName: string;
        routeType: number;
        originStopName: string;
        destStopName: string;
    }[];
    routeName: string;
    routeType: number;
    originStopName: string;
    destStopName: string;
    transferStopName?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function placeholders(n: number): string {
    return Array(n).fill('?').join(',');
}

// ── Nearest stops ─────────────────────────────────────────────────────────────
async function nearestStops(center: LatLng, limit: number): Promise<Stop[]> {
    const db = await getDb();
    let delta = 0.005;

    for (let attempt = 0; attempt < 8; attempt++, delta *= 1.8) {
        const rows = await db.getAllAsync<Stop>(
            `SELECT stop_id, stop_name, stop_lat, stop_lon, agency
             FROM stops
             WHERE stop_lat BETWEEN ? AND ?
               AND stop_lon BETWEEN ? AND ?
             LIMIT 200`,
            [
                center.latitude  - delta, center.latitude  + delta,
                center.longitude - delta, center.longitude + delta,
            ],
        );

        if (rows.length >= limit) {
            return rows
                .map(s => ({
                    ...s,
                    dist: haversineMeters(center, { lat: s.stop_lat, lon: s.stop_lon }),
                }))
                .sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0))
                .slice(0, limit);
        }
    }

    const rows = await db.getAllAsync<Stop>(
        `SELECT stop_id, stop_name, stop_lat, stop_lon, agency
         FROM stops
         WHERE stop_lat BETWEEN ? AND ?
           AND stop_lon BETWEEN ? AND ?
         LIMIT 200`,
        [
            center.latitude  - 0.05, center.latitude  + 0.05,
            center.longitude - 0.05, center.longitude + 0.05,
        ],
    );
    return rows
        .map(s => ({
            ...s,
            dist: haversineMeters(center, { lat: s.stop_lat, lon: s.stop_lon }),
        }))
        .sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0))
        .slice(0, limit);
}

// ── Shape segment ─────────────────────────────────────────────────────────────
async function shapeSegment(
    shapeId: string,
    agency: number,
    oStop: Stop,
    dStop: Stop,
): Promise<LatLng[]> {
    const db = await getDb();

    const closestSeq = async (lat: number, lon: number) => {
        const row = await db.getFirstAsync<{ shape_pt_sequence: number }>(
            `SELECT shape_pt_sequence
             FROM shapes
             WHERE shape_id = ? AND agency = ?
             ORDER BY ((shape_pt_lat - ?) * (shape_pt_lat - ?)) +
                      ((shape_pt_lon - ?) * (shape_pt_lon - ?))
             LIMIT 1`,
            [shapeId, agency, lat, lat, lon, lon],
        );
        return row?.shape_pt_sequence ?? null;
    };

    const [startSeq, endSeq] = await Promise.all([
        closestSeq(oStop.stop_lat, oStop.stop_lon),
        closestSeq(dStop.stop_lat, dStop.stop_lon),
    ]);

    if (startSeq === null || endSeq === null) return [];

    const lo = Math.min(startSeq, endSeq);
    const hi = Math.max(startSeq, endSeq);

    const pts = await db.getAllAsync<{ shape_pt_lat: number; shape_pt_lon: number }>(
        `SELECT shape_pt_lat, shape_pt_lon
         FROM shapes
         WHERE shape_id = ? AND agency = ?
           AND shape_pt_sequence BETWEEN ? AND ?
         ORDER BY shape_pt_sequence`,
        [shapeId, agency, lo, hi],
    );

    return pts.map(p => ({ latitude: p.shape_pt_lat, longitude: p.shape_pt_lon }));
}

async function stopSequenceCoords(
    patternId: string,
    originSeq: number,
    destSeq: number,
): Promise<LatLng[]> {
    const db = await getDb();
    const lo = Math.min(originSeq, destSeq);
    const hi = Math.max(originSeq, destSeq);
    const rows = await db.getAllAsync<{ stop_lat: number; stop_lon: number }>(
        `SELECT s.stop_lat, s.stop_lon
         FROM pattern_stops ps
         JOIN stops s ON s.stop_id = ps.stop_id AND s.agency = ps.agency
         WHERE ps.pattern_id    = ?
           AND ps.stop_sequence >= ?
           AND ps.stop_sequence <= ?
         ORDER BY ps.stop_sequence`,
        [patternId, lo, hi],
    );
    return rows.map(r => ({ latitude: r.stop_lat, longitude: r.stop_lon }));
}

async function legCoords(leg: Leg): Promise<LatLng[]> {
    if (leg.shape_id) {
        const pts = await shapeSegment(leg.shape_id, leg.agency, leg.origin_stop, leg.dest_stop);
        if (pts.length > 0) return pts;
    }
    return stopSequenceCoords(leg.pattern_id, leg.origin_seq, leg.dest_seq);
}

// ── Direct route ──────────────────────────────────────────────────────────────
async function findDirectLeg(
    originStops: Stop[],
    destStops: Stop[],
): Promise<Leg | null> {
    const db = await getDb();

    // Try both directions in case pattern is stored in reverse
    for (const [stops1, stops2, swapped] of [
        [originStops, destStops, false] as const,
        [destStops, originStops, true]  as const,
    ]) {
        for (const oStop of stops1) {
            for (const dStop of stops2) {
                if (oStop.stop_id === dStop.stop_id && oStop.agency === dStop.agency) continue;

                const match = await db.getFirstAsync<{
                    pattern_id: string; shape_id: string; agency: number;
                    route_short_name: string; route_long_name: string;
                    route_type: number; origin_seq: number; dest_seq: number;
                }>(
                    `SELECT p.pattern_id, p.shape_id, p.agency,
                            r.route_short_name, r.route_long_name, r.route_type,
                            ps1.stop_sequence AS origin_seq,
                            ps2.stop_sequence AS dest_seq
                     FROM patterns p
                     JOIN pattern_stops ps1
                         ON ps1.pattern_id = p.pattern_id
                        AND ps1.stop_id = ? AND ps1.agency = ?
                     JOIN pattern_stops ps2
                         ON ps2.pattern_id = p.pattern_id
                        AND ps2.stop_id = ? AND ps2.agency = ?
                     JOIN routes r ON r.route_id = p.route_id AND r.agency = p.agency
                     WHERE ps1.stop_sequence < ps2.stop_sequence
                     ORDER BY (ps2.stop_sequence - ps1.stop_sequence)
                     LIMIT 1`,
                    [oStop.stop_id, oStop.agency, dStop.stop_id, dStop.agency],
                );

                if (!match) continue;

                const origin = swapped ? dStop : oStop;
                const dest   = swapped ? oStop : dStop;

                return {
                    pattern_id:  match.pattern_id,
                    shape_id:    match.shape_id,
                    agency:      match.agency,
                    route_name:  match.route_short_name || match.route_long_name || '?',
                    route_type:  match.route_type,
                    origin_stop: origin,
                    dest_stop:   dest,
                    origin_seq:  swapped ? match.dest_seq   : match.origin_seq,
                    dest_seq:    swapped ? match.origin_seq : match.dest_seq,
                };
            }
        }
    }

    return null;
}

// ── 1-transfer route ──────────────────────────────────────────────────────────
interface Leg1Row {
    pattern_id: string; shape_id: string; agency: number;
    route_name: string; route_type: number;
    origin_stop_id: string; origin_agency: number; origin_seq: number;
    transfer_stop_id: string; transfer_agency: number; transfer_seq: number;
}

interface Leg2Row {
    pattern_id: string; shape_id: string; agency: number;
    route_name: string; route_type: number;
    transfer_stop_id: string; transfer_agency: number; transfer_seq: number;
    dest_stop_id: string; dest_agency: number; dest_seq: number;
}

async function findOneTransferRoute(
    originStops: Stop[],
    destStops: Stop[],
): Promise<[Leg, Leg] | null> {
    const db = await getDb();

    const oIds = originStops.map(s => s.stop_id);
    const dIds = destStops.map(s => s.stop_id);

    // All stops reachable from origin stops (forward direction only)
    const leg1Rows = await db.getAllAsync<Leg1Row>(
        `SELECT
             p.pattern_id, p.shape_id, p.agency,
             COALESCE(r.route_short_name, r.route_long_name, '?') AS route_name,
             r.route_type,
             ps_o.stop_id        AS origin_stop_id,
             ps_o.agency         AS origin_agency,
             ps_o.stop_sequence  AS origin_seq,
             ps_t.stop_id        AS transfer_stop_id,
             ps_t.agency         AS transfer_agency,
             ps_t.stop_sequence  AS transfer_seq
         FROM pattern_stops ps_o
         JOIN patterns p ON p.pattern_id = ps_o.pattern_id
         JOIN routes r   ON r.route_id = p.route_id AND r.agency = p.agency
         JOIN pattern_stops ps_t
             ON ps_t.pattern_id = p.pattern_id
            AND ps_t.stop_sequence > ps_o.stop_sequence
         WHERE ps_o.stop_id IN (${placeholders(oIds.length)})
         LIMIT 20000`,
        oIds,
    );

    if (leg1Rows.length === 0) return null;

    // All stops that can board a pattern leading to dest stops
    const leg2Rows = await db.getAllAsync<Leg2Row>(
        `SELECT
             p.pattern_id, p.shape_id, p.agency,
             COALESCE(r.route_short_name, r.route_long_name, '?') AS route_name,
             r.route_type,
             ps_t.stop_id        AS transfer_stop_id,
             ps_t.agency         AS transfer_agency,
             ps_t.stop_sequence  AS transfer_seq,
             ps_d.stop_id        AS dest_stop_id,
             ps_d.agency         AS dest_agency,
             ps_d.stop_sequence  AS dest_seq
         FROM pattern_stops ps_d
         JOIN patterns p ON p.pattern_id = ps_d.pattern_id
         JOIN routes r   ON r.route_id = p.route_id AND r.agency = p.agency
         JOIN pattern_stops ps_t
             ON ps_t.pattern_id = p.pattern_id
            AND ps_t.stop_sequence < ps_d.stop_sequence
         WHERE ps_d.stop_id IN (${placeholders(dIds.length)})
         LIMIT 20000`,
        dIds,
    );

    if (leg2Rows.length === 0) return null;

    // Index leg2 by transfer stop for O(1) lookup
    const leg2Map = new Map<string, Leg2Row[]>();
    for (const row of leg2Rows) {
        const key = `${row.transfer_stop_id}:${row.transfer_agency}`;
        if (!leg2Map.has(key)) leg2Map.set(key, []);
        leg2Map.get(key)!.push(row);
    }

    // Stop detail cache
    const stopCache = new Map<string, Stop>(
        [...originStops, ...destStops].map(s => [`${s.stop_id}:${s.agency}`, s]),
    );

    const getStop = async (stop_id: string, agency: number): Promise<Stop | null> => {
        const key = `${stop_id}:${agency}`;
        if (stopCache.has(key)) return stopCache.get(key)!;
        const s = await db.getFirstAsync<Stop>(
            `SELECT stop_id, stop_name, stop_lat, stop_lon, agency
             FROM stops WHERE stop_id = ? AND agency = ? LIMIT 1`,
            [stop_id, agency],
        );
        if (s) stopCache.set(key, s);
        return s ?? null;
    };

    // Find first valid transfer combination
    for (const l1 of leg1Rows) {
        const key = `${l1.transfer_stop_id}:${l1.transfer_agency}`;
        const l2Candidates = leg2Map.get(key);
        if (!l2Candidates) continue;

        for (const l2 of l2Candidates) {
            if (l1.pattern_id === l2.pattern_id) continue; // same route = direct

            const oStop = originStops.find(
                s => s.stop_id === l1.origin_stop_id && s.agency === l1.origin_agency,
            );
            const dStop = destStops.find(
                s => s.stop_id === l2.dest_stop_id && s.agency === l2.dest_agency,
            );
            if (!oStop || !dStop) continue;

            const transferStop = await getStop(l1.transfer_stop_id, l1.transfer_agency);
            if (!transferStop) continue;

            return [
                {
                    pattern_id: l1.pattern_id, shape_id: l1.shape_id,
                    agency: l1.agency, route_name: l1.route_name, route_type: l1.route_type,
                    origin_stop: oStop, dest_stop: transferStop,
                    origin_seq: l1.origin_seq, dest_seq: l1.transfer_seq,
                },
                {
                    pattern_id: l2.pattern_id, shape_id: l2.shape_id,
                    agency: l2.agency, route_name: l2.route_name, route_type: l2.route_type,
                    origin_stop: transferStop, dest_stop: dStop,
                    origin_seq: l2.transfer_seq, dest_seq: l2.dest_seq,
                },
            ];
        }
    }

    return null;
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function computeGtfsRoute(
    origin: LatLng,
    destination: LatLng,
): Promise<GtfsRouteResult> {
    const [originStops, destStops] = await Promise.all([
        nearestStops(origin, 50),
        nearestStops(destination, 50)
    ]);

    console.log(`Origin: ${originStops.length} stops, Dest: ${destStops.length} stops`);
    originStops.slice(0, 3).forEach(s =>
        console.log(`  O [${s.agency}] ${s.stop_name} ${Math.round(s.dist ?? 0)}m`));
    destStops.slice(0, 3).forEach(s =>
        console.log(`  D [${s.agency}] ${s.stop_name} ${Math.round(s.dist ?? 0)}m`));

    if (originStops.length === 0) throw new Error('No stops near your location.');
    if (destStops.length   === 0) throw new Error('No stops near destination.');

    // Direct
    const direct = await findDirectLeg(originStops, destStops);
    if (direct) {
        console.log(`Direct: ${direct.route_name}`);
        const transit = await legCoords(direct);
        return {
            coords: [
                origin,
                { latitude: direct.origin_stop.stop_lat, longitude: direct.origin_stop.stop_lon },
                ...transit,
                { latitude: direct.dest_stop.stop_lat, longitude: direct.dest_stop.stop_lon },
                destination,
            ],
            legs: [{
                routeName: direct.route_name, routeType: direct.route_type,
                originStopName: direct.origin_stop.stop_name,
                destStopName: direct.dest_stop.stop_name,
            }],
            routeName: direct.route_name,
            routeType: direct.route_type,
            originStopName: direct.origin_stop.stop_name,
            destStopName: direct.dest_stop.stop_name,
        };
    }

    // 1-transfer
    console.log('No direct route — trying 1 transfer…');
    const transfer = await findOneTransferRoute(originStops, destStops);
    if (transfer) {
        const [leg1, leg2] = transfer;
        console.log(`Transfer: ${leg1.route_name} → ${leg2.route_name} @ ${leg1.dest_stop.stop_name}`);

        const [coords1, coords2] = await Promise.all([legCoords(leg1), legCoords(leg2)]);
        const transferStop = leg1.dest_stop;

        return {
            coords: [
                origin,
                { latitude: leg1.origin_stop.stop_lat, longitude: leg1.origin_stop.stop_lon },
                ...coords1,
                { latitude: transferStop.stop_lat, longitude: transferStop.stop_lon },
                ...coords2,
                { latitude: leg2.dest_stop.stop_lat, longitude: leg2.dest_stop.stop_lon },
                destination,
            ],
            legs: [
                {
                    routeName: leg1.route_name, routeType: leg1.route_type,
                    originStopName: leg1.origin_stop.stop_name,
                    destStopName: transferStop.stop_name,
                },
                {
                    routeName: leg2.route_name, routeType: leg2.route_type,
                    originStopName: transferStop.stop_name,
                    destStopName: leg2.dest_stop.stop_name,
                },
            ],
            routeName: `${leg1.route_name} → ${leg2.route_name}`,
            routeType: leg1.route_type,
            originStopName: leg1.origin_stop.stop_name,
            destStopName: leg2.dest_stop.stop_name,
            transferStopName: transferStop.stop_name,
        };
    }

    const oNames = originStops.slice(0, 3).map(s => s.stop_name).join(', ');
    const dNames = destStops.slice(0,  3).map(s => s.stop_name).join(', ');
    throw new Error(`No route found (direct or 1 transfer).\n\nNear origin: ${oNames}\nNear destination: ${dNames}`);
}