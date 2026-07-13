/**
 * gtfsRoute.ts  –  Round-based Public Transit Optimised Router (RAPTOR)
 *
 * Implements the timetable-based RAPTOR algorithm:
 *   Delling, Pajor, Werneck – "Round-Based Public Transit Routing" (2012)
 *
 * Key design decisions
 * ────────────────────
 * • All DB work is batched into ~4 queries per round to keep async overhead low.
 * • Walking speed is fully parameterised.  The footpath transfer radius scales
 *   with speed so that faster travellers can cover more ground between stops.
 * • Times are stored / compared as "seconds since midnight".  GTFS permits
 *   values > 86 400 for after-midnight services (e.g. 25:30:00 → 91 800 s)
 *   which means plain integer comparison is always correct.
 */

import type { LatLng } from './gtfsDb';
import { getDb } from './gtfsDb';

// ─────────────────────────────────────────────────────────────────────────────
// Walking speed presets  (m/s)
// ─────────────────────────────────────────────────────────────────────────────

export const WALK_SPEED_MPS = {
    SLOW:   0.8,   //  2.9 km/h  – accessibility / elderly
    NORMAL: 1.4,   //  5.0 km/h  – default
    FAST:   1.8,   //  6.5 km/h
    JOG:    2.5,   //  9.0 km/h
    RUN:    4.0,   // 14.4 km/h
    SPRINT: 7.0,   // 25.2 km/h
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of transfers attempted (legs = MAX_ROUNDS). */
const MAX_ROUNDS = 5;

/** Maximum walking time (seconds) allowed for a mid-journey transfer.
 *  The actual distance radius is derived from this × walkingSpeedMps. */
const MAX_TRANSFER_WALK_SEC = 7 * 60; // 7 minutes

/** How many nearest stops to consider at origin / destination. */
const NEARBY_STOPS = 50;

/** Trip search window: only load trips departing within this many seconds of
 *  the earliest boarding time.  Prevents fetching overnight departures during
 *  a daytime search. */
const TRIP_SEARCH_WINDOW_SEC = 3 * 3600; // 3 hours

/**
 * Maximum number of stops to carry as "marked" into any single round.
 * After a few rounds RAPTOR can mark thousands of stops across Melbourne;
 * building an IN(…) clause with thousands of values, and loading all their
 * stop_times, is the primary cause of slowness and stack-depth errors.
 * We keep only the BEST_MARKED_CAP stops by earliest τ – stragglers cannot
 * produce a better final journey than already-settled stops.
 */
const BEST_MARKED_CAP = 200;

const INF = Number.MAX_SAFE_INTEGER;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type StopKey = string; // `${stop_id}:${agency}`
const makeKey = (stopId: string, agency: number): StopKey => `${stopId}:${agency}`;

interface StopInfo {
    stop_id:   string;
    stop_name: string;
    stop_lat:  number;
    stop_lon:  number;
    agency:    number;
}

type ParentInfo =
    | { type: 'origin-walk'; distM: number }
    | { type: 'footpath';    fromKey: StopKey; distM: number }
    | { type: 'transit';     tripId: string; patternId: string; agency: number;
    boardKey: StopKey; boardSeq: number; alightSeq: number };

export interface RouteSegment {
    coords:        LatLng[];
    routeName:     string;
    routeType:     number;
    routeColor?:   string;
    routeTextColor?: string;
    originStopName: string;
    destStopName:  string;
    type:          'transit' | 'walk';
    departureTime?: string;   // HH:MM (local)
    arrivalTime?:   string;   // HH:MM (local)
}

export interface GtfsRouteResult {
    coords:    LatLng[];
    segments:  RouteSegment[];
    legs: Array<{
        routeName:      string;
        routeType:      number;
        routeColor?:    string;
        routeTextColor?: string;
        originStopName: string;
        destStopName:   string;
        departureTime?: string;
        arrivalTime?:   string;
    }>;
    routeName:       string;
    routeType:       number;
    routeColor?:     string;
    routeTextColor?: string;
    originStopName:  string;
    destStopName:    string;
    transferStopName?: string;
    totalDurationMin: number;
    departureTime:   string;
    arrivalTime:     string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function haversineMeters(
    a: { latitude: number; longitude: number },
    b: { lat: number; lon: number },
): number {
    const R     = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat  = toRad(b.lat - a.latitude);
    const dLon  = toRad(b.lon - a.longitude);
    const s1    = Math.sin(dLat / 2);
    const s2    = Math.sin(dLon / 2);
    const x     = s1 * s1 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.lat)) * s2 * s2;
    return R * 2 * Math.asin(Math.sqrt(x));
}

function walkTimeSec(meters: number, speedMps: number): number {
    return meters / speedMps;
}

function walkTimeMin(meters: number, speedMps: number): number {
    return meters / speedMps / 60;
}

/** Maximum transfer walk radius in metres for a given speed. */
function transferRadiusM(speedMps: number): number {
    return speedMps * MAX_TRANSFER_WALK_SEC;
}

function toSecsMidnight(d: Date): number {
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function formatSec(sec: number): string {
    const h = Math.floor(sec / 3600) % 24;
    const m = Math.floor((sec % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function placeholders(n: number): string {
    return Array(n).fill('?').join(',');
}

function normalizeHexColor(color?: string | null): string | undefined {
    if (!color) return undefined;
    const hex = color.trim().replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : undefined;
}

function fallbackRouteColor(routeType: number, routeName: string): string {
    const name = routeName.toLowerCase();
    if (routeType === 0) return '#EAB308';
    if (routeType === 3) return '#F97316';
    if (routeType === 4) return '#0EA5E9';
    if (routeType === 1) return '#2563EB';
    if (routeType === 2) {
        const regional = [
            'v/line','regional','albury','ballarat','bairnsdale','bendigo',
            'echuca','geelong','maryborough','shepparton','swan hill',
            'traralgon','warrnambool','seymour',
        ];
        if (regional.some(h => name.includes(h))) return '#8F1A95';
        return '#2563EB';
    }
    return '#2563EB';
}

function resolveRouteColor(c: string | null | undefined, type: number, name: string): string {
    return normalizeHexColor(c) ?? fallbackRouteColor(type, name);
}

function resolveTextColor(c: string | null | undefined): string {
    return normalizeHexColor(c) ?? '#FFFFFF';
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

async function nearestStops(center: LatLng, limit: number): Promise<StopInfo[]> {
    const db = await getDb();
    let delta = 0.005;

    for (let attempt = 0; attempt < 8; attempt++, delta *= 1.8) {
        const rows = await db.getAllAsync<StopInfo>(
            `SELECT stop_id, stop_name, stop_lat, stop_lon, agency
             FROM stops
             WHERE stop_lat BETWEEN ? AND ?
               AND stop_lon BETWEEN ? AND ?
                 LIMIT 300`,
            [center.latitude - delta, center.latitude + delta,
                center.longitude - delta, center.longitude + delta],
        );
        if (rows.length >= limit) {
            return rows
                .map(s => ({ ...s, _d: haversineMeters(center, { lat: s.stop_lat, lon: s.stop_lon }) }))
                .sort((a: any, b: any) => a._d - b._d)
                .slice(0, limit);
        }
    }

    // Wide fallback
    const rows = await db.getAllAsync<StopInfo>(
        `SELECT stop_id, stop_name, stop_lat, stop_lon, agency
         FROM stops
         WHERE stop_lat BETWEEN ? AND ?
           AND stop_lon BETWEEN ? AND ?
             LIMIT 500`,
        [center.latitude - 0.15, center.latitude + 0.15,
            center.longitude - 0.15, center.longitude + 0.15],
    );
    return rows
        .map(s => ({ ...s, _d: haversineMeters(center, { lat: s.stop_lat, lon: s.stop_lon }) }))
        .sort((a: any, b: any) => a._d - b._d)
        .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

async function shapeSegment(
    shapeId: string,
    agency:  number,
    oStop:   StopInfo,
    dStop:   StopInfo,
): Promise<LatLng[]> {
    const db = await getDb();

    const closestSeq = async (lat: number, lon: number) => {
        const row = await db.getFirstAsync<{ shape_pt_sequence: number }>(
            `SELECT shape_pt_sequence
             FROM shapes
             WHERE shape_id = ? AND agency = ?
             ORDER BY ((shape_pt_lat-?)*(shape_pt_lat-?))+
                      ((shape_pt_lon-?)*(shape_pt_lon-?))
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

async function patternSegmentCoords(
    patternId: string,
    boardSeq:  number,
    alightSeq: number,
): Promise<LatLng[]> {
    const db = await getDb();
    const lo = Math.min(boardSeq, alightSeq);
    const hi = Math.max(boardSeq, alightSeq);
    const rows = await db.getAllAsync<{ stop_lat: number; stop_lon: number }>(
        `SELECT s.stop_lat, s.stop_lon
         FROM pattern_stops ps
                  JOIN stops s ON s.stop_id = ps.stop_id AND s.agency = ps.agency
         WHERE ps.pattern_id = ?
           AND ps.stop_sequence >= ? AND ps.stop_sequence <= ?
         ORDER BY ps.stop_sequence`,
        [patternId, lo, hi],
    );
    return rows.map(r => ({ latitude: r.stop_lat, longitude: r.stop_lon }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the best transit route from `origin` to `destination`.
 *
 * @param origin          User's current location.
 * @param destination     Target location.
 * @param departureTime   When the journey starts (defaults to now).
 * @param walkingSpeedMps Walking (and running) speed in m/s.
 *                        Use the WALK_SPEED_MPS presets or any value.
 *                        Affects initial/final walk time AND the maximum
 *                        distance allowed for mid-journey transfers.
 */
export async function computeGtfsRoute(
    origin:          LatLng,
    destination:     LatLng,
    departureTime:   Date   = new Date(),
    walkingSpeedMps: number = WALK_SPEED_MPS.NORMAL,
): Promise<GtfsRouteResult> {
    const db         = await getDb();
    const departSec  = toSecsMidnight(departureTime);
    const xferRadius = transferRadiusM(walkingSpeedMps);
    // Degrees-of-latitude approximation for the transfer bounding box
    const xferDelta  = (xferRadius / 111_000) * 1.3;

    // ── 0.  Nearest stops at both ends ───────────────────────────────────────
    const [originStops, destStops] = await Promise.all([
        nearestStops(origin,      NEARBY_STOPS),
        nearestStops(destination, NEARBY_STOPS),
    ]);
    if (originStops.length === 0) throw new Error('No stops near your location.');
    if (destStops.length   === 0) throw new Error('No stops near destination.');

    // ── 1.  RAPTOR state ─────────────────────────────────────────────────────

    /** Best arrival time (seconds since midnight) at each stop reached so far. */
    const tau    = new Map<StopKey, number>();
    /** How we arrived at each stop (for path reconstruction). */
    const parent = new Map<StopKey, ParentInfo>();
    /** Stop metadata cache so we avoid re-querying the DB. */
    const cache  = new Map<StopKey, StopInfo>();

    // Seed: walk from the user's location to every nearby origin stop.
    let marked = new Set<StopKey>();
    for (const s of originStops) {
        const distM  = haversineMeters(origin, { lat: s.stop_lat, lon: s.stop_lon });
        const arrSec = departSec + walkTimeSec(distM, walkingSpeedMps);
        const key    = makeKey(s.stop_id, s.agency);
        tau.set(key, arrSec);
        parent.set(key, { type: 'origin-walk', distM });
        cache.set(key, s);
        marked.add(key);
    }

    // Pre-register destination stops in cache.
    const destKeyMap = new Map<StopKey, { stop: StopInfo; distM: number }>();
    for (const s of destStops) {
        const key  = makeKey(s.stop_id, s.agency);
        const distM = haversineMeters(destination, { lat: s.stop_lat, lon: s.stop_lon });
        destKeyMap.set(key, { stop: s, distM });
        if (!cache.has(key)) cache.set(key, s);
    }

    // ── 2.  RAPTOR rounds ────────────────────────────────────────────────────
    //
    // Each round adds one transit leg.  Round k finds routes reachable with
    // exactly k legs (plus any number of walking transfers).
    //
    for (let round = 0; round < MAX_ROUNDS && marked.size > 0; round++) {

        // Early exit: if every destination stop is already settled AND the best
        // arrival is better than every still-marked stop, no further round can
        // improve the answer.
        const bestDestSoFar = Math.min(
            ...[...destKeyMap.keys()].map(k => {
                const t = tau.get(k);
                const d = destKeyMap.get(k)!.distM;
                return t !== undefined ? t + walkTimeSec(d, walkingSpeedMps) : INF;
            }),
        );
        const bestMarkedTau = Math.min(...[...marked].map(k => tau.get(k) ?? INF));
        if (bestDestSoFar < INF && bestMarkedTau >= bestDestSoFar) break;

        // Trim marked set: keep only the BEST_MARKED_CAP stops with lowest τ.
        // This bounds the size of every IN(…) clause in this round.
        if (marked.size > BEST_MARKED_CAP) {
            const sorted = [...marked].sort((a, b) => (tau.get(a) ?? INF) - (tau.get(b) ?? INF));
            marked = new Set(sorted.slice(0, BEST_MARKED_CAP));
        }

        const newlyMarked = new Set<StopKey>();

        // ── 2a.  Which patterns serve the marked stops?  (1 query) ────────────
        const markedStopIds = [...marked].map(k => k.split(':')[0]);

        const patternRows = await db.getAllAsync<{
            pattern_id:    string;
            stop_id:       string;
            stop_sequence: number;
            agency:        number;
        }>(
            `SELECT pattern_id, stop_id, stop_sequence, agency
             FROM pattern_stops
             WHERE stop_id IN (${placeholders(markedStopIds.length)})`,
            markedStopIds,
        );

        // For each pattern collect ALL marked stops that lie on it, keyed by
        // their position in the pattern.  We keep all candidates because a
        // stop that is later in the sequence but has a lower τ might allow
        // boarding an earlier trip (the RAPTOR "catch-earlier-trip" case).
        const boardingsByPattern = new Map<string, Array<{
            stopId:    string;
            agency:    number;
            stopKey:   StopKey;
            stopSeq:   number;
            tauAtStop: number;
        }>>();

        for (const row of patternRows) {
            const key = makeKey(row.stop_id, row.agency);
            if (!marked.has(key)) continue;          // stop_id matched wrong agency
            const tauAtStop = tau.get(key) ?? INF;
            if (tauAtStop === INF) continue;

            const pKey = `${row.pattern_id}:${row.agency}`;
            if (!boardingsByPattern.has(pKey)) boardingsByPattern.set(pKey, []);
            boardingsByPattern.get(pKey)!.push({
                stopId: row.stop_id, agency: row.agency,
                stopKey: key, stopSeq: row.stop_sequence, tauAtStop,
            });
        }

        if (boardingsByPattern.size === 0) break;

        // ── 2b.  Find the earliest feasible trip for each pattern  (1 query) ──
        //
        // Query stop_times for all boarding stops at once, then pick the best
        // trip per pattern in memory.
        //
        const allBoardingStopIds = new Set(
            [...boardingsByPattern.values()].flatMap(arr => arr.map(b => b.stopId))
        );
        // Use reduce instead of Math.min(...spread) – spread onto Math.min blows
        // the call stack when there are hundreds of boarding stops.
        let minTauOverall = INF;
        for (const arr of boardingsByPattern.values())
            for (const b of arr)
                if (b.tauAtStop < minTauOverall) minTauOverall = b.tauAtStop;
        const maxSearchSec = minTauOverall + TRIP_SEARCH_WINDOW_SEC;

        const tripCandidates = await db.getAllAsync<{
            stop_id:       string;
            stop_sequence: number;
            trip_id:       string;
            pattern_id:    string;
            departure_sec: number;
            agency:        number;
        }>(
            `SELECT stop_id, stop_sequence, trip_id, pattern_id, departure_sec, agency
             FROM stop_times
             WHERE stop_id IN (${placeholders(allBoardingStopIds.size)})
               AND departure_sec >= ?
               AND departure_sec <= ?
             ORDER BY stop_id, pattern_id, departure_sec`,
            [[...allBoardingStopIds], minTauOverall, maxSearchSec].flat(),
        );

        // Build a fast lookup: (pattern_key, stop_id) → earliest feasible departure row.
        // "Feasible" means departure_sec >= tau[that stop].
        interface CandRow {
            stop_id: string; stop_sequence: number; trip_id: string;
            pattern_id: string; departure_sec: number; agency: number;
        }
        const earliestPerCombo = new Map<string, CandRow>();
        for (const row of tripCandidates) {
            const pKey   = `${row.pattern_id}:${row.agency}`;
            const boardings = boardingsByPattern.get(pKey);
            if (!boardings) continue;

            // Find the boarding slot for this stop on this pattern.
            const slot = boardings.find(b => b.stopId === row.stop_id && b.agency === row.agency);
            if (!slot) continue;
            if (row.departure_sec < slot.tauAtStop) continue;  // not yet reachable

            const comboKey = `${pKey}:${row.stop_id}`;
            if (!earliestPerCombo.has(comboKey)) {
                earliestPerCombo.set(comboKey, row);  // rows ordered by departure_sec
            }
        }

        // Per pattern: pick the single best (boarding stop, trip) pair –
        // specifically the one with the earliest departure across all candidates.
        // An earlier-departing trip scans more downstream stops.
        interface SelectedTrip {
            tripId:    string;
            boardKey:  StopKey;
            boardSeq:  number;
            agency:    number;
            patternId: string;
        }
        const selectedTrips = new Map<string, SelectedTrip>();

        for (const [pKey, boardings] of boardingsByPattern) {
            let bestRow: CandRow | null = null;
            let bestSlotKey: StopKey   = '';

            for (const b of boardings) {
                const comboKey = `${pKey}:${b.stopId}`;
                const row      = earliestPerCombo.get(comboKey);
                if (!row) continue;
                if (!bestRow || row.departure_sec < bestRow.departure_sec) {
                    bestRow      = row;
                    bestSlotKey  = b.stopKey;
                }
            }

            if (bestRow) {
                selectedTrips.set(pKey, {
                    tripId:    bestRow.trip_id,
                    boardKey:  bestSlotKey,
                    boardSeq:  bestRow.stop_sequence,
                    agency:    bestRow.agency,
                    patternId: bestRow.pattern_id,
                });
            }
        }

        if (selectedTrips.size === 0) break;

        // ── 2c.  Load all stop_times for selected trips  (1 query) ────────────
        const tripIds = [...new Set([...selectedTrips.values()].map(t => t.tripId))];

        const allStopTimes = await db.getAllAsync<{
            trip_id:       string;
            agency:        number;
            stop_id:       string;
            stop_sequence: number;
            arrival_sec:   number;
            departure_sec: number;
            pattern_id:    string;
        }>(
            `SELECT trip_id, agency, stop_id, stop_sequence, arrival_sec, departure_sec, pattern_id
             FROM stop_times
             WHERE trip_id IN (${placeholders(tripIds.length)})
             ORDER BY trip_id, stop_sequence`,
            tripIds,
        );

        // Index by trip key for O(1) lookup below.
        const stopTimesByTrip = new Map<string, typeof allStopTimes>();
        for (const st of allStopTimes) {
            const tKey = `${st.trip_id}:${st.agency}`;
            if (!stopTimesByTrip.has(tKey)) stopTimesByTrip.set(tKey, []);
            stopTimesByTrip.get(tKey)!.push(st);
        }

        // ── 2d.  Scan each trip and update τ ──────────────────────────────────
        for (const [pKey, sel] of selectedTrips) {
            const tKey     = `${sel.tripId}:${sel.agency}`;
            const stopTimes = stopTimesByTrip.get(tKey) ?? [];

            let scanning = false;
            for (const st of stopTimes) {
                // Start scanning the stop AFTER the boarding stop.
                if (st.stop_sequence === sel.boardSeq) { scanning = true; continue; }
                if (!scanning) continue;

                const stopKey    = makeKey(st.stop_id, sel.agency);
                const currentBest = tau.get(stopKey) ?? INF;

                if (st.arrival_sec < currentBest) {
                    tau.set(stopKey, st.arrival_sec);
                    parent.set(stopKey, {
                        type:      'transit',
                        tripId:    sel.tripId,
                        patternId: sel.patternId,
                        agency:    sel.agency,
                        boardKey:  sel.boardKey,
                        boardSeq:  sel.boardSeq,
                        alightSeq: st.stop_sequence,
                    });
                    newlyMarked.add(stopKey);
                }
            }
        }

        // ── 2e.  Cache metadata for newly reached stops  (1 query) ────────────
        const unknownIds = [...newlyMarked]
            .filter(k => !cache.has(k))
            .map(k => k.split(':')[0]);

        if (unknownIds.length > 0) {
            const fetched = await db.getAllAsync<StopInfo>(
                `SELECT stop_id, stop_name, stop_lat, stop_lon, agency
                 FROM stops WHERE stop_id IN (${placeholders(unknownIds.length)})`,
                unknownIds,
            );
            for (const s of fetched) cache.set(makeKey(s.stop_id, s.agency), s);
        }

        // ── 2f.  Footpath relaxation  (1 spatial query) ───────────────────────
        //
        // For every stop newly reached by transit this round, look for stops
        // within walking distance and update their τ.  The search radius
        // scales with walkingSpeedMps, so a runner can cover more ground.
        //
        if (newlyMarked.size > 0) {
            let minLat =  Infinity, maxLat = -Infinity;
            let minLon =  Infinity, maxLon = -Infinity;
            for (const key of newlyMarked) {
                const s = cache.get(key);
                if (!s) continue;
                if (s.stop_lat < minLat) minLat = s.stop_lat;
                if (s.stop_lat > maxLat) maxLat = s.stop_lat;
                if (s.stop_lon < minLon) minLon = s.stop_lon;
                if (s.stop_lon > maxLon) maxLon = s.stop_lon;
            }

            const nearbyStopsForTransfer = await db.getAllAsync<StopInfo>(
                `SELECT stop_id, stop_name, stop_lat, stop_lon, agency
                 FROM stops
                 WHERE stop_lat BETWEEN ? AND ?
                   AND stop_lon BETWEEN ? AND ?`,
                [minLat - xferDelta, maxLat + xferDelta,
                    minLon - xferDelta, maxLon + xferDelta],
            );

            for (const key of newlyMarked) {
                const s    = cache.get(key);
                if (!s) continue;
                const tauS = tau.get(key) ?? INF;
                if (tauS === INF) continue;

                for (const n of nearbyStopsForTransfer) {
                    if (n.stop_id === s.stop_id && n.agency === s.agency) continue;
                    const nKey  = makeKey(n.stop_id, n.agency);
                    const distM = haversineMeters(
                        { latitude: s.stop_lat, longitude: s.stop_lon },
                        { lat: n.stop_lat, lon: n.stop_lon },
                    );
                    if (distM > xferRadius) continue;

                    const arrAtN      = tauS + walkTimeSec(distM, walkingSpeedMps);
                    const currentBest = tau.get(nKey) ?? INF;
                    if (arrAtN < currentBest) {
                        tau.set(nKey, arrAtN);
                        parent.set(nKey, { type: 'footpath', fromKey: key, distM });
                        newlyMarked.add(nKey);
                        if (!cache.has(nKey)) cache.set(nKey, n);
                    }
                }
            }
        }

        marked = newlyMarked;
    }

    // ── 3.  Find best destination stop ───────────────────────────────────────
    let bestArrSec    = INF;
    let bestDestKey:  StopKey | null = null;
    let bestFinalWalkM               = 0;

    for (const [dKey, { distM }] of destKeyMap) {
        const tauD = tau.get(dKey);
        if (tauD === undefined) continue;
        const totalSec = tauD + walkTimeSec(distM, walkingSpeedMps);
        if (totalSec < bestArrSec) {
            bestArrSec     = totalSec;
            bestDestKey    = dKey;
            bestFinalWalkM = distM;
        }
    }

    if (!bestDestKey) {
        const oNames = originStops.slice(0, 3).map(s => s.stop_name).join(', ');
        const dNames = destStops.slice(0, 3).map(s => s.stop_name).join(', ');
        throw new Error(
            `No route found within ${MAX_ROUNDS} transfers.\n` +
            `Near origin: ${oNames}\nNear destination: ${dNames}`,
        );
    }

    // ── 4.  Reconstruct and return the path ──────────────────────────────────
    return reconstructPath(
        origin, destination,
        bestDestKey, bestFinalWalkM, bestArrSec, departSec,
        tau, parent, cache, walkingSpeedMps,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Path reconstruction
// ─────────────────────────────────────────────────────────────────────────────

async function reconstructPath(
    origin:          LatLng,
    destination:     LatLng,
    destKey:         StopKey,
    finalWalkM:      number,
    arrivalSec:      number,
    departureSec:    number,
    tau:             Map<StopKey, number>,
    parent:          Map<StopKey, ParentInfo>,
    cache:           Map<StopKey, StopInfo>,
    walkingSpeedMps: number,
): Promise<GtfsRouteResult> {
    const db = await getDb();

    // ── Trace parent chain backward from destination stop ────────────────────
    type Step =
        | { type: 'origin-walk'; toKey: StopKey; originWalkM: number }
        | { type: 'footpath';    fromKey: StopKey; fpToKey: StopKey; footpathM: number }
        | { type: 'transit';     tripId: string; patternId: string; agency: number;
        boardKey: StopKey; alightKey: StopKey; boardSeq: number; alightSeq: number };

    const steps: Step[] = [];
    let cur = destKey;

    while (true) {
        const p = parent.get(cur);
        if (!p) break;

        if (p.type === 'origin-walk') {
            steps.push({ type: 'origin-walk', toKey: cur, originWalkM: p.distM });
            break;
        } else if (p.type === 'transit') {
            steps.push({
                type:      'transit',
                tripId:    p.tripId,
                patternId: p.patternId,
                agency:    p.agency,
                boardKey:  p.boardKey,
                alightKey: cur,
                boardSeq:  p.boardSeq,
                alightSeq: p.alightSeq,
            });
            cur = p.boardKey;
        } else {
            steps.push({ type: 'footpath', fromKey: p.fromKey, fpToKey: cur, footpathM: p.distM });
            cur = p.fromKey;
        }
    }

    steps.reverse(); // now in chronological order

    // ── Build segments + legs ─────────────────────────────────────────────────
    const segments:  RouteSegment[]              = [];
    const legs:      GtfsRouteResult['legs']     = [];
    const allCoords: LatLng[]                    = [origin];
    let   transferStopName: string | undefined;

    const walkSegment = (
        from: LatLng, to: LatLng,
        fromName: string, toName: string,
        distM: number,
    ): RouteSegment => ({
        coords:         [from, to],
        routeName:      `Walk (~${Math.max(1, Math.round(walkTimeMin(distM, walkingSpeedMps)))} min)`,
        routeType:      -1,
        routeColor:     '#666666',
        routeTextColor: '#FFFFFF',
        originStopName: fromName,
        destStopName:   toName,
        type:           'walk',
    });

    for (const step of steps) {

        // ── Walking from origin ────────────────────────────────────────────────
        if (step.type === 'origin-walk') {
            const toStop   = cache.get(step.toKey)!;
            const toLatLng = { latitude: toStop.stop_lat, longitude: toStop.stop_lon };
            if (step.originWalkM > 1) {
                segments.push(walkSegment(origin, toLatLng, 'Your location', toStop.stop_name, step.originWalkM));
                allCoords.push(toLatLng);
            }
            continue;
        }

        // ── Walking transfer between stops ─────────────────────────────────────
        if (step.type === 'footpath') {
            const from     = cache.get(step.fromKey)!;
            const to       = cache.get(step.fpToKey)!;
            const fromLL   = { latitude: from.stop_lat, longitude: from.stop_lon };
            const toLL     = { latitude: to.stop_lat,   longitude: to.stop_lon   };
            const walkMin  = Math.max(1, Math.round(walkTimeMin(step.footpathM, walkingSpeedMps)));

            transferStopName = from.stop_name === to.stop_name
                ? from.stop_name
                : `${from.stop_name} → ${to.stop_name} (~${walkMin} min walk)`;

            if (step.footpathM > 1) {
                segments.push(walkSegment(fromLL, toLL, from.stop_name, to.stop_name, step.footpathM));
                allCoords.push(toLL);
            }
            continue;
        }

        // ── Transit leg ────────────────────────────────────────────────────────
        if (step.type === 'transit') {
            const { tripId, patternId, agency, boardKey, alightKey, boardSeq, alightSeq } = step;
            const boardStop  = cache.get(boardKey)!;
            const alightStop = cache.get(alightKey)!;

            // Route metadata
            const routeInfo = await db.getFirstAsync<{
                route_short_name: string;
                route_long_name:  string;
                route_type:       number;
                route_color:      string | null;
                route_text_color: string | null;
                shape_id:         string | null;
            }>(
                `SELECT r.route_short_name, r.route_long_name, r.route_type,
                        r.route_color, r.route_text_color, p.shape_id
                 FROM patterns p
                          JOIN routes r ON r.route_id = p.route_id AND r.agency = p.agency
                 WHERE p.pattern_id = ?`,
                [patternId],
            );

            const routeName      = routeInfo?.route_short_name || routeInfo?.route_long_name || '?';
            const routeType      = routeInfo?.route_type       ?? 3;
            const routeColor     = resolveRouteColor(routeInfo?.route_color,      routeType, routeName);
            const routeTextColor = resolveTextColor(routeInfo?.route_text_color);

            // Exact departure / arrival times from stop_times
            const [boardST, alightST] = await Promise.all([
                db.getFirstAsync<{ departure_sec: number }>(
                    `SELECT departure_sec FROM stop_times
                     WHERE trip_id = ? AND agency = ? AND stop_sequence = ? LIMIT 1`,
                    [tripId, agency, boardSeq],
                ),
                db.getFirstAsync<{ arrival_sec: number }>(
                    `SELECT arrival_sec FROM stop_times
                     WHERE trip_id = ? AND agency = ? AND stop_sequence = ? LIMIT 1`,
                    [tripId, agency, alightSeq],
                ),
            ]);

            const departTimeStr = boardST  ? formatSec(boardST.departure_sec)  : undefined;
            const arriveTimeStr = alightST ? formatSec(alightST.arrival_sec)   : undefined;

            // Route geometry
            let coords: LatLng[] = [];
            if (routeInfo?.shape_id) {
                coords = await shapeSegment(routeInfo.shape_id, agency!, boardStop, alightStop);
            }
            if (coords.length === 0) {
                coords = await patternSegmentCoords(patternId!, boardSeq!, alightSeq!);
            }
            if (coords.length === 0) {
                coords = [
                    { latitude: boardStop.stop_lat,  longitude: boardStop.stop_lon  },
                    { latitude: alightStop.stop_lat, longitude: alightStop.stop_lon },
                ];
            }

            segments.push({
                coords,
                routeName,
                routeType,
                routeColor,
                routeTextColor,
                originStopName: boardStop.stop_name,
                destStopName:   alightStop.stop_name,
                type:           'transit',
                departureTime:  departTimeStr,
                arrivalTime:    arriveTimeStr,
            });

            legs.push({
                routeName, routeType, routeColor, routeTextColor,
                originStopName: boardStop.stop_name,
                destStopName:   alightStop.stop_name,
                departureTime:  departTimeStr,
                arrivalTime:    arriveTimeStr,
            });

            // Never use push(...largeArray) – spreading thousands of shape points
            // as function arguments overflows the JS call stack.
            for (const c of coords) allCoords.push(c);
            allCoords.push({ latitude: alightStop.stop_lat, longitude: alightStop.stop_lon });
        }
    }

    // ── Final walk from last transit stop to destination ──────────────────────
    const destStop  = cache.get(destKey)!;
    const destStopLL = { latitude: destStop.stop_lat, longitude: destStop.stop_lon };
    if (finalWalkM > 1) {
        segments.push(walkSegment(destStopLL, destination, destStop.stop_name, 'Your destination', finalWalkM));
        allCoords.push(destination);
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    const firstLeg = legs[0];
    const lastLeg  = legs[legs.length - 1];
    const totalDurationMin = Math.round((arrivalSec - departureSec) / 60);

    return {
        coords:    allCoords,
        segments,
        legs,
        routeName: legs.length === 1
            ? legs[0].routeName
            : legs.map(l => l.routeName).join(' → '),
        routeType:       firstLeg?.routeType      ?? -1,
        routeColor:      firstLeg?.routeColor,
        routeTextColor:  firstLeg?.routeTextColor,
        originStopName:  firstLeg?.originStopName ?? '',
        destStopName:    lastLeg?.destStopName    ?? '',
        transferStopName,
        totalDurationMin,
        departureTime: formatSec(departureSec),
        arrivalTime:   formatSec(arrivalSec),
    };
}