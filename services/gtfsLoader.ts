/**
 * gtfsLoader.ts — TRIP-SCOPED in-memory GTFS loader.
 *
 * The previous version loaded the ENTIRE network's day timetable regardless
 * of origin/destination — that's why even a short Caulfield -> Carnegie
 * search OOM'd exactly like Caulfield -> Clayton: geography was never part of
 * the loading decision, only of the search afterwards.
 *
 * Root cause data from on-device testing (whole-network version):
 *   - pattern_stops (267K rows): ~4.9s to marshal across the JS<->native bridge
 *   - trips (373K rows): ~7.1s
 *   - stop_times: OutOfMemoryError before even finishing the query
 *
 * FIX: filter geographically FIRST using cheap indexed queries against
 * `stops`, THEN only load patterns/trips/stop_times for routes that actually
 * pass near the search corridor. The ellipse (same shape used by the router)
 * is now a DATA LOADING boundary, not just a search-space optimization.
 *
 * There is no persistent whole-network cache anymore — each search loads its
 * own scoped index. That's intentional: once scoped, the data is small
 * enough that reloading per search is cheap and avoids ever holding
 * irrelevant routes (e.g. V/Line services on the other side of the state) in
 * memory at all.
 */

import type { LatLng } from './gtfsDb';
import { getDb } from './gtfsDb';
import { makeKey, parseKey } from './gtfsKeyUtil';

export interface StopInfo {
    stop_id:   string;
    stop_name: string;
    stop_lat:  number;
    stop_lon:  number;
    agency:    number;
}

export interface PatternMeta {
    pattern_id:       string;
    route_id:         string;
    agency:           number;
    shape_id:         string | null;
    route_name:       string;
    route_type:       number;
    route_color:      string;
    route_text_color: string;
}

export interface PatternStopEntry {
    stop_id:       string;
    stop_sequence: number;
}

export interface StopTimeEntry {
    trip_id:       string;
    pattern_id:    string;
    stop_sequence: number;
    arrival_sec:   number;
    departure_sec: number;
}

export interface GtfsIndex {
    stopsByKey: Map<string, StopInfo>;
    allStops: StopInfo[];
    patternsByKey: Map<string, PatternMeta>;
    patternStops: Map<string, PatternStopEntry[]>;
    stopTimesByStop: Map<string, StopTimeEntry[]>;
    /** Same data as stopTimesByStop, but keyed by trip_id for O(1) lookup
     *  during trip-riding (avoids a linear .find() per downstream stop). */
    stopTimesByStopAndTrip: Map<string, Map<string, StopTimeEntry>>;
    shapePoints: Map<string, { latitude: number; longitude: number }[]>;
    serviceDate: string;
}

const DOW_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function todayYYYYMMDD(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

function haversineMeters(a: LatLng, b: { lat: number; lon: number }): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.latitude);
    const dLon = toRad(b.lon - a.longitude);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const x = s1 * s1 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.lat)) * s2 * s2;
    return R * 2 * Math.asin(Math.sqrt(x));
}

/**
 * Ellipse detour buffer. A stop is in play if
 *   dist(origin, stop) + dist(stop, destination) <= straightLineDist + buffer
 * The buffer is capped in absolute terms, not purely proportional — a real
 * transit detour rarely grows past a few km regardless of total trip length.
 * A flat multiplier (e.g. x1.5) is fine for a 5km hop (2.5km slack) but
 * catastrophic for a 50km trip (25km slack, thousands of irrelevant stops).
 */
const ELLIPSE_BUFFER_RATIO = 0.5;    // up to 50% of straight-line distance...
const ELLIPSE_BUFFER_CAP_M = 8000;   // ...but never more than 8km absolute.
const ELLIPSE_BUFFER_MIN_M = 1500;   // floor so very short trips still get some slack.
const ELLIPSE_MIN_DISTANCE_M = 1500;

/** SQLite's default bound-parameter limit is 999; stay comfortably under it. */
const SQL_CHUNK_SIZE = 400;

function placeholders(n: number): string {
    return Array(n).fill('?').join(',');
}

/** Runs `queryFn` in chunks over `items`, unioning the results — needed
 *  because candidate ID lists (stop ids, pattern ids) can exceed SQLite's
 *  bound-parameter cap for a single query. */
async function chunkedQuery<T, R>(
    items: T[],
    chunkSize: number,
    queryFn: (chunk: T[]) => Promise<R[]>,
): Promise<R[]> {
    if (items.length === 0) return [];
    const out: R[] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const rows = await queryFn(chunk);
        for (const r of rows) out.push(r);
    }
    return out;
}

/**
 * Loads a GTFS index SCOPED to the given trip: only stops/patterns/trips/
 * stop_times for routes that plausibly serve an origin -> destination journey
 * are loaded. Call this fresh per search — it's cheap enough (bounded by the
 * ellipse) that there's no need to cache it globally like the old version did.
 */
export async function loadGtfsIndexForTrip(
    origin: LatLng,
    destination: LatLng,
    forDate: Date = new Date(),
): Promise<GtfsIndex> {
    const t0 = Date.now();
    const lap = (label: string, since: number) => {
        console.log(`[gtfsLoader] ${label}: ${Date.now() - since}ms`);
        return Date.now();
    };
    let t = t0;

    const db = await getDb();
    const dateStr = todayYYYYMMDD(forDate);
    const dow = DOW_COLUMNS[forDate.getDay()];

    // ── 1. All stops (cheap: ~30K rows, no timetable data attached) ──────────
    const stopRows = await db.getAllAsync<StopInfo>(
        `SELECT stop_id, stop_name, stop_lat, stop_lon, agency FROM stops`,
    );
    t = lap(`stops query (${stopRows.length} rows)`, t);

    const stopsByKey = new Map<string, StopInfo>();
    const allStops: StopInfo[] = [];
    for (const s of stopRows) {
        stopsByKey.set(makeKey(s.agency, s.stop_id), s);
        allStops.push(s);
    }

    // ── 2. Ellipse filter -> candidate stop_ids ───────────────────────────────
    const straightM = haversineMeters(origin, { lat: destination.latitude, lon: destination.longitude });
    let allowedStopIds: Set<string>;
    if (straightM < ELLIPSE_MIN_DISTANCE_M) {
        allowedStopIds = new Set(allStops.map(s => s.stop_id));
    } else {
        const buffer = Math.min(Math.max(straightM * ELLIPSE_BUFFER_RATIO, ELLIPSE_BUFFER_MIN_M), ELLIPSE_BUFFER_CAP_M);
        const maxSum = straightM + buffer;
        allowedStopIds = new Set();
        for (const s of allStops) {
            const dO = haversineMeters(origin, { lat: s.stop_lat, lon: s.stop_lon });
            const dD = haversineMeters(destination, { lat: s.stop_lat, lon: s.stop_lon });
            if (dO + dD <= maxSum) allowedStopIds.add(s.stop_id);
        }
    }
    t = lap(`ellipse filter (${allowedStopIds.size}/${allStops.length} stops kept)`, t);

    // TEMP DIAGNOSTIC: confirm whether known Springvale train platforms
    // actually pass the ellipse check, and what their computed distances are.
    for (const testId of ['13714', '13715']) {
        const stop = allStops.find(s => s.stop_id === testId);
        if (!stop) { console.log(`[gtfsLoader] DIAG stop ${testId}: not found in allStops at all`); continue; }
        const dO = haversineMeters(origin, { lat: stop.stop_lat, lon: stop.stop_lon });
        const dD = haversineMeters(destination, { lat: stop.stop_lat, lon: stop.stop_lon });
        console.log(`[gtfsLoader] DIAG stop ${testId} (${stop.stop_name}, agency ${stop.agency}): distO=${Math.round(dO)}m distD=${Math.round(dD)}m sum=${Math.round(dO+dD)}m inEllipse=${allowedStopIds.has(testId)}`);
    }

    // ── 3. Which patterns pass through the ellipse? (chunked IN query) ───────
    const stopIdList = [...allowedStopIds];
    const candidatePatternRows = await chunkedQuery(stopIdList, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ pattern_id: string; agency: number }>(
            `SELECT DISTINCT pattern_id, agency FROM pattern_stops WHERE stop_id IN (${placeholders(chunk.length)})`,
            chunk,
        ),
    );
    const candidatePatternKeys = new Set<string>(candidatePatternRows.map(r => makeKey(r.agency, r.pattern_id)));
    t = lap(`candidate patterns discovery (${candidatePatternKeys.size} patterns)`, t);

    if (candidatePatternKeys.size === 0) {
        return {
            stopsByKey, allStops, patternsByKey: new Map(), patternStops: new Map(),
            stopTimesByStop: new Map(), stopTimesByStopAndTrip: new Map(), shapePoints: new Map(), serviceDate: dateStr,
        };
    }

    const patternIdList = [...candidatePatternKeys].map(k => parseKey(k).id);
    const uniquePatternIds = [...new Set(patternIdList)];

    // ── 4. Full pattern_stops for candidate patterns (need whole sequence, not
    //       just in-ellipse stops, so stop_sequence numbering stays intact) ────
    const psRows = await chunkedQuery(uniquePatternIds, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ pattern_id: string; stop_id: string; stop_sequence: number; agency: number }>(
            `SELECT pattern_id, stop_id, stop_sequence, agency FROM pattern_stops
             WHERE pattern_id IN (${placeholders(chunk.length)})
             ORDER BY pattern_id, stop_sequence`,
            chunk,
        ),
    );
    t = lap(`pattern_stops for candidates (${psRows.length} rows)`, t);

    const patternStops = new Map<string, PatternStopEntry[]>();
    for (const r of psRows) {
        const key = makeKey(r.agency, r.pattern_id);
        if (!candidatePatternKeys.has(key)) continue; // guard against pattern_id collisions across agencies
        if (!patternStops.has(key)) patternStops.set(key, []);
        patternStops.get(key)!.push({ stop_id: r.stop_id, stop_sequence: r.stop_sequence });
    }

    // ── 5. Pattern + route metadata for candidates ────────────────────────────
    const patternRows = await chunkedQuery(uniquePatternIds, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{
            pattern_id: string; route_id: string; agency: number; shape_id: string | null;
            route_short_name: string; route_long_name: string; route_type: number;
            route_color: string; route_text_color: string;
        }>(
            `SELECT p.pattern_id, p.route_id, p.agency, p.shape_id,
                    r.route_short_name, r.route_long_name, r.route_type,
                    r.route_color, r.route_text_color
             FROM patterns p
                      JOIN routes r ON r.route_id = p.route_id AND r.agency = p.agency
             WHERE p.pattern_id IN (${placeholders(chunk.length)})`,
            chunk,
        ),
    );
    t = lap(`patterns+routes for candidates (${patternRows.length} rows)`, t);

    const patternsByKey = new Map<string, PatternMeta>();
    for (const p of patternRows) {
        const key = makeKey(p.agency, p.pattern_id);
        if (!candidatePatternKeys.has(key)) continue;
        patternsByKey.set(key, {
            pattern_id: p.pattern_id, route_id: p.route_id, agency: p.agency, shape_id: p.shape_id,
            route_name: p.route_short_name || p.route_long_name || '?',
            route_type: p.route_type,
            route_color: p.route_color || '',
            route_text_color: p.route_text_color || '#FFFFFF',
        });
    }

    // ── 6. Active service_ids for today ───────────────────────────────────────
    const [calRows, calDateRows] = await Promise.all([
        db.getAllAsync<{ service_id: string; agency: number }>(
            `SELECT service_id, agency FROM calendar WHERE ${dow} = 1 AND start_date <= ? AND end_date >= ?`,
            [dateStr, dateStr],
        ),
        db.getAllAsync<{ service_id: string; agency: number; exception_type: number }>(
            `SELECT service_id, agency, exception_type FROM calendar_dates WHERE date = ?`,
            [dateStr],
        ),
    ]);
    const activeServices = new Set<string>(calRows.map(r => makeKey(r.agency, r.service_id)));
    for (const r of calDateRows) {
        const key = makeKey(r.agency, r.service_id);
        if (r.exception_type === 1) activeServices.add(key);
        else if (r.exception_type === 2) activeServices.delete(key);
    }
    t = lap('active services', t);

    // ── 7. Trips for candidate patterns only, filtered to active services ────
    const tripRows = await chunkedQuery(uniquePatternIds, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ trip_id: string; agency: number; pattern_id: string; service_id: string }>(
            `SELECT trip_id, agency, pattern_id, service_id FROM trips WHERE pattern_id IN (${placeholders(chunk.length)})`,
            chunk,
        ),
    );
    t = lap(`trips for candidates (${tripRows.length} rows)`, t);

    const activeTripKeys = new Set<string>();
    for (const tr of tripRows) {
        if (!candidatePatternKeys.has(makeKey(tr.agency, tr.pattern_id))) continue;
        if (!activeServices.has(makeKey(tr.agency, tr.service_id))) continue;
        activeTripKeys.add(makeKey(tr.agency, tr.trip_id));
    }
    t = lap(`active trips filtered (${activeTripKeys.size} active)`, t);

    // ── 8. Stop times for candidate patterns, TIME-WINDOWED ───────────────────
    // Loading every stop_time row for a pattern across the whole day is wasteful
    // for high-frequency routes (e.g. a train every 10 min for 19 hours is
    // ~114 stops * many trips). We only actually need trips departing within a
    // bounded window of the search time. Two passes:
    //   (a) narrow, time-filtered query to find which trip_ids are relevant
    //   (b) full stop_times for exactly those trips (need the whole sequence,
    //       not just the in-window rows, so downstream matching still works)
    const departSec = forDate.getHours() * 3600 + forDate.getMinutes() * 60 + forDate.getSeconds();
    const SEARCH_WINDOW_SEC = 4 * 3600; // 4 hours forward is generous for on-device local trips
    const windowLo = Math.max(0, departSec - 15 * 60); // small buffer for already-walking-there boarding
    const windowHi = departSec + SEARCH_WINDOW_SEC;

    // Query by STOP_ID (not pattern_id) — this matches the existing
    // idx_st_stop_dep(stop_id, departure_sec) index exactly, so SQLite can
    // range-scan departure_sec directly instead of scanning every row for a
    // pattern regardless of time. It's also semantically better: we want
    // "does this trip depart from a stop we can actually board at, within the
    // window" — which is exactly what RAPTOR's boarding step needs.
    const windowedRows = await chunkedQuery(stopIdList, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ trip_id: string; agency: number; pattern_id: string }>(
            `SELECT DISTINCT trip_id, agency, pattern_id FROM stop_times
             WHERE stop_id IN (${placeholders(chunk.length)})
               AND departure_sec BETWEEN ? AND ?`,
            [...chunk, windowLo, windowHi],
        ),
    );
    t = lap(`time-windowed trip discovery (${windowedRows.length} candidate trips)`, t);

    const windowedActiveTripIds = [...new Set(
        windowedRows
            .filter(r => candidatePatternKeys.has(makeKey(r.agency, r.pattern_id)))
            .filter(r => activeTripKeys.has(makeKey(r.agency, r.trip_id)))
            .map(r => r.trip_id),
    )];
    t = lap(`windowed trips filtered to active + candidate patterns (${windowedActiveTripIds.length})`, t);

    const stopTimeRows = windowedActiveTripIds.length > 0
        ? await chunkedQuery(windowedActiveTripIds, SQL_CHUNK_SIZE, chunk =>
            db.getAllAsync<{
                trip_id: string; agency: number; stop_id: string; stop_sequence: number;
                arrival_sec: number; departure_sec: number; pattern_id: string;
            }>(
                `SELECT trip_id, agency, stop_id, stop_sequence, arrival_sec, departure_sec, pattern_id
                 FROM stop_times WHERE trip_id IN (${placeholders(chunk.length)})`,
                chunk,
            ),
        )
        : [];
    t = lap(`stop_times for windowed trips (${stopTimeRows.length} rows)`, t);

    const stopTimesByStop = new Map<string, StopTimeEntry[]>();
    const stopTimesByStopAndTrip = new Map<string, Map<string, StopTimeEntry>>();
    for (const st of stopTimeRows) {
        const tKey = makeKey(st.agency, st.trip_id);
        if (!activeTripKeys.has(tKey)) continue;
        const stopKey = makeKey(st.agency, st.stop_id);

        const entry: StopTimeEntry = {
            trip_id: st.trip_id, pattern_id: st.pattern_id, stop_sequence: st.stop_sequence,
            arrival_sec: st.arrival_sec, departure_sec: st.departure_sec,
        };

        if (!stopTimesByStop.has(stopKey)) stopTimesByStop.set(stopKey, []);
        stopTimesByStop.get(stopKey)!.push(entry);

        if (!stopTimesByStopAndTrip.has(stopKey)) stopTimesByStopAndTrip.set(stopKey, new Map());
        stopTimesByStopAndTrip.get(stopKey)!.set(st.trip_id, entry);
    }
    for (const arr of stopTimesByStop.values()) arr.sort((a, b) => a.departure_sec - b.departure_sec);
    t = lap('stop_times filter + sort + trip-index build', t);

    // ── 9. Shapes — only for candidate patterns' shape_ids ────────────────────
    const shapeKeys = [...patternsByKey.values()]
        .filter(p => p.shape_id)
        .map(p => ({ shape_id: p.shape_id as string, agency: p.agency }));
    const uniqueShapeIds = [...new Set(shapeKeys.map(s => s.shape_id))];

    const shapeRows = uniqueShapeIds.length > 0
        ? await chunkedQuery(uniqueShapeIds, SQL_CHUNK_SIZE, chunk =>
            db.getAllAsync<{ shape_id: string; agency: number; shape_pt_lat: number; shape_pt_lon: number; shape_pt_sequence: number }>(
                `SELECT shape_id, agency, shape_pt_lat, shape_pt_lon, shape_pt_sequence
                 FROM shapes WHERE shape_id IN (${placeholders(chunk.length)})
                 ORDER BY shape_id, agency, shape_pt_sequence`,
                chunk,
            ),
        )
        : [];
    t = lap(`shapes for candidates (${shapeRows.length} rows)`, t);

    const shapePoints = new Map<string, { latitude: number; longitude: number }[]>();
    for (const r of shapeRows) {
        const key = makeKey(r.agency, r.shape_id);
        if (!shapePoints.has(key)) shapePoints.set(key, []);
        shapePoints.get(key)!.push({ latitude: r.shape_pt_lat, longitude: r.shape_pt_lon });
    }

    console.log(`[gtfsLoader] TOTAL scoped load time: ${Date.now() - t0}ms`);

    return { stopsByKey, allStops, patternsByKey, patternStops, stopTimesByStop, stopTimesByStopAndTrip, shapePoints, serviceDate: dateStr };
}