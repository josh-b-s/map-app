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

interface PatternMatch {
    pattern_id: string;
    shape_id: string;
    agency: number;
    route_short_name: string;
    route_long_name: string;
    route_type: number;
    origin_seq: number;
    dest_seq: number;
}

export interface GtfsRouteResult {
    coords: LatLng[];
    routeName: string;
    routeType: number;
    originStopName: string;
    destStopName: string;
}

// ── Nearest stops with expanding search ───────────────────────────────────────
async function nearestStops(center: LatLng, limit: number): Promise<Stop[]> {
    const db = await getDb();
    let delta = 0.005; // ~550m

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

    // Return whatever we found even if < limit
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

// ── Shape segment (SQL distance sort) ─────────────────────────────────────────
async function shapeSegment(
    shapeId: string,
    agency: number,
    oStop: Stop,
    dStop: Stop,
): Promise<LatLng[]> {
    const db = await getDb();

    const closestSeq = async (lat: number, lon: number): Promise<number | null> => {
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

// ── Stop-sequence fallback (no shape data) ────────────────────────────────────
async function stopSequenceCoords(
    patternId: string,
    originSeq: number,
    destSeq: number,
): Promise<LatLng[]> {
    const db = await getDb();
    const lo = Math.min(originSeq, destSeq);
    const hi = Math.max(originSeq, destSeq);
    const stops = await db.getAllAsync<{ stop_lat: number; stop_lon: number }>(
        `SELECT s.stop_lat, s.stop_lon
         FROM pattern_stops ps
         JOIN stops s ON s.stop_id = ps.stop_id AND s.agency = ps.agency
         WHERE ps.pattern_id    = ?
           AND ps.stop_sequence >= ?
           AND ps.stop_sequence <= ?
         ORDER BY ps.stop_sequence`,
        [patternId, lo, hi],
    );
    return stops.map(s => ({ latitude: s.stop_lat, longitude: s.stop_lon }));
}

// ── Find a matching pattern for two stops ─────────────────────────────────────
async function findPattern(
    oStop: Stop,
    dStop: Stop,
): Promise<PatternMatch | null> {
    const db = await getDb();

    // Try forward direction first, then reverse (handles bidirectional patterns)
    for (const [s1, s2] of [[oStop, dStop], [dStop, oStop]]) {
        const matches = await db.getAllAsync<PatternMatch>(
            `SELECT
                 p.pattern_id,
                 p.shape_id,
                 p.agency,
                 r.route_short_name,
                 r.route_long_name,
                 r.route_type,
                 ps1.stop_sequence AS origin_seq,
                 ps2.stop_sequence AS dest_seq
             FROM patterns p
             JOIN pattern_stops ps1
                 ON ps1.pattern_id = p.pattern_id
                AND ps1.stop_id    = ?
                AND ps1.agency     = ?
             JOIN pattern_stops ps2
                 ON ps2.pattern_id = p.pattern_id
                AND ps2.stop_id    = ?
                AND ps2.agency     = ?
             JOIN routes r
                 ON r.route_id = p.route_id
                AND r.agency   = p.agency
             WHERE ps1.stop_sequence < ps2.stop_sequence
             ORDER BY (ps2.stop_sequence - ps1.stop_sequence) ASC
             LIMIT 5`,
            [s1.stop_id, s1.agency, s2.stop_id, s2.agency],
        );

        if (matches.length > 0) {
            // If we matched in reverse, swap the sequences so the route draws correctly
            const m = matches[0];
            if (s1 === dStop) {
                return { ...m, origin_seq: m.dest_seq, dest_seq: m.origin_seq };
            }
            return m;
        }
    }

    return null;
}

// ── Debug helper — call this temporarily if routing fails ─────────────────────
export async function debugNearbyStops(location: LatLng): Promise<void> {
    const stops = await nearestStops(location, 10);
    console.log('=== Nearby stops ===');
    stops.forEach((s, i) =>
        console.log(
            `${i + 1}. [Agency ${s.agency}] ${s.stop_name} (${s.stop_id}) — ${Math.round(s.dist ?? 0)}m`,
        ),
    );
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function computeGtfsRoute(
    origin: LatLng,
    destination: LatLng,
): Promise<GtfsRouteResult> {

    const [originStops, destStops] = await Promise.all([
        nearestStops(origin, 15),
        nearestStops(destination, 15),
    ]);

    console.log(`Origin stops found: ${originStops.length}`);
    console.log(`Dest stops found: ${destStops.length}`);

    if (originStops.length === 0)
        throw new Error('No stops found near your location. Are you in Melbourne?');
    if (destStops.length === 0)
        throw new Error('No stops found near destination.');

    // Log the closest few for debugging
    originStops.slice(0, 3).forEach(s =>
        console.log(`  Origin stop: [${s.agency}] ${s.stop_name} — ${Math.round(s.dist ?? 0)}m`),
    );
    destStops.slice(0, 3).forEach(s =>
        console.log(`  Dest stop: [${s.agency}] ${s.stop_name} — ${Math.round(s.dist ?? 0)}m`),
    );

    // Try every (origin, destination) stop pair — closest first
    for (const oStop of originStops) {
        for (const dStop of destStops) {
            if (
                oStop.stop_id === dStop.stop_id &&
                oStop.agency  === dStop.agency
            ) continue;

            const match = await findPattern(oStop, dStop);
            if (!match) continue;

            console.log(
                `Match: route ${match.route_short_name} (agency ${match.agency})`,
                `| ${oStop.stop_name} → ${dStop.stop_name}`,
            );

            // Get transit polyline
            let transitCoords: LatLng[] = [];

            if (match.shape_id) {
                transitCoords = await shapeSegment(
                    match.shape_id, match.agency, oStop, dStop,
                );
            }

            if (transitCoords.length === 0) {
                transitCoords = await stopSequenceCoords(
                    match.pattern_id, match.origin_seq, match.dest_seq,
                );
            }

            const coords: LatLng[] = [
                origin,
                { latitude: oStop.stop_lat, longitude: oStop.stop_lon },
                ...transitCoords,
                { latitude: dStop.stop_lat, longitude: dStop.stop_lon },
                destination,
            ];

            const routeLabel = match.route_short_name || match.route_long_name || '?';

            return {
                coords,
                routeName:      routeLabel,
                routeType:      match.route_type,
                originStopName: oStop.stop_name,
                destStopName:   dStop.stop_name,
            };
        }
    }

    // ── Helpful error: show what stops were found ─────────────────────────────
    const oNames = originStops.slice(0, 3).map(s => s.stop_name).join(', ');
    const dNames = destStops.slice(0,  3).map(s => s.stop_name).join(', ');
    throw new Error(
        `No direct route found.\n\nNear origin: ${oNames}\nNear destination: ${dNames}\n\nThis journey likely requires a transfer — coming soon.`,
    );
}