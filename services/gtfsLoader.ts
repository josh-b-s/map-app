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
 * FIX (v1): filter geographically FIRST using a single ellipse between
 * origin and destination, THEN only load patterns/trips/stop_times for
 * routes that pass near it.
 *
 * FIX (v2, this version): the single ellipse was either generous everywhere
 * (defeating the point of pruning) or clipped real branching routes when a
 * valid path loops away from the straight line — geographically close isn't
 * the same as topologically related ("small world" problem). Instead, we now
 * run a coarse schedule-agnostic BFS (coarseGraph.ts / seedRouteBfs.ts) to
 * find the actual shape of plausible routes, then build a tapered buffer
 * around those seed paths (corridorTagging.ts) and use that as the loading
 * boundary. Same principle as before — the corridor is a DATA LOADING
 * boundary, not just a search-space optimization — just a better-fitting
 * shape.
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
import { computeCorridor } from './corridorTagging';

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
    /** Unqualified stop_ids that survived corridor scoping for this query.
     *  Computed once here by gtfsLoader.ts and shared with gtfsRouter.ts so
     *  the two stages agree on a single corridor shape instead of each
     *  computing (and potentially disagreeing on) their own filter. */
    corridorStopIds: Set<string>;
    patternsByKey: Map<string, PatternMeta>;
    patternStops: Map<string, PatternStopEntry[]>;
    stopTimesByStop: Map<string, StopTimeEntry[]>;
    /** Same data as stopTimesByStop, but keyed by trip_id for O(1) lookup
     *  during trip-riding (avoids a linear .find() per downstream stop). */
    stopTimesByStopAndTrip: Map<string, Map<string, StopTimeEntry>>;
    shapePoints: Map<string, { latitude: number; longitude: number }[]>;
    serviceDate: string;
    /** True if no active trip departed within any search window, even after
     *  widening (up to 20h ahead). Distinguishes "genuinely no service in
     *  this window" (e.g. overnight gap) from a normal search — the UI
     *  should show something like "no more services until tomorrow" rather
     *  than a bare empty journey list. */
    noServiceFound: boolean;
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

/** How many of the nearest stops (at each end) to seed the corridor BFS
 *  from. Wider than "just the single nearest stop" so the corridor can find
 *  a route that boards from, say, the 3rd-closest stop if that's the one
 *  that's actually on a useful pattern. */
const NEAREST_FOR_CORRIDOR_SEED = 6;

/** Journey-planning transfer budget. Since coarseGraph.ts now models a BFS
 *  hop as "ride one line," this is a real transfer count, not a stop-count
 *  proxy — see seedRouteBfs.ts. 5 comfortably covers any plausible Melbourne
 *  metro trip (worst case is usually 2-3 transfers) with margin to spare. */
const MAX_TRANSFERS = 5;

/**
 * Loads a GTFS index SCOPED to the given trip: only stops/patterns/trips/
 * stop_times for routes that plausibly serve an origin -> destination journey
 * are loaded. Call this fresh per search — it's cheap enough (bounded by the
 * corridor) that there's no need to cache it globally like the old version did.
 */
export async function loadGtfsIndexForTrip(
    origin: LatLng,
    destination: LatLng,
    forDate: Date = new Date(),
    opts?: { forceWindowSec?: number },
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

    // ── 2. Corridor filter -> candidate stop_ids ──────────────────────────────
    // Replaces the old single-ellipse filter. Run a coarse BFS (schedule-
    // agnostic, cached across queries — see coarseGraph.ts) from several
    // nearby stops at each end to find the actual seed route shape(s), then
    // buffer around those paths (corridorTagging.ts). Falls back to a wider
    // buffer, then the full network, if the result looks too small.
    const candidateAll = allStops.map(s => ({ stop_id: s.stop_id, lat: s.stop_lat, lon: s.stop_lon, agency: s.agency }));

    const nearestForSeed = (center: LatLng, limit: number) =>
        allStops
            .map(s => ({ s, d: haversineMeters(center, { lat: s.stop_lat, lon: s.stop_lon }) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, limit)
            .map(x => makeKey(x.s.agency, x.s.stop_id));

    const originSeedKeys = nearestForSeed(origin, NEAREST_FOR_CORRIDOR_SEED);
    const destSeedKeys = nearestForSeed(destination, NEAREST_FOR_CORRIDOR_SEED);

    const corridor = await computeCorridor(
        { lat: origin.latitude, lon: origin.longitude },
        { lat: destination.latitude, lon: destination.longitude },
        originSeedKeys,
        destSeedKeys,
        candidateAll,
        MAX_TRANSFERS,
    );

    let allowedStopIds: Set<string>;
    if (corridor.stopIds.size > 0) {
        allowedStopIds = corridor.stopIds;
    } else {
        // Coarse BFS found nothing at all (e.g. disconnected topology data,
        // or origin/destination not near any known stop) — fall back to the
        // full network rather than returning zero stops.
        console.log('[gtfsLoader] corridor came back empty even after widening — falling back to full network');
        allowedStopIds = new Set(allStops.map(s => s.stop_id));
    }
    t = lap(
        `corridor filter (${allowedStopIds.size}/${allStops.length} stops kept, ` +
        `${corridor.seedPathCount} seed paths, widened=${corridor.widened})`,
        t,
    );

    // ── 3. Which patterns pass through the corridor? (chunked IN query) ──────
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
            stopsByKey, allStops, corridorStopIds: allowedStopIds, patternsByKey: new Map(), patternStops: new Map(),
            stopTimesByStop: new Map(), stopTimesByStopAndTrip: new Map(), shapePoints: new Map(), serviceDate: dateStr,
            noServiceFound: true,
        };
    }

    const patternIdList = [...candidatePatternKeys].map(k => parseKey(k).id);
    const uniquePatternIds = [...new Set(patternIdList)];

    // ── 4. Full pattern_stops for candidate patterns (need whole sequence, not
    //       just in-corridor stops, so stop_sequence numbering stays intact) ──
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

    // Distance-scaled starting window. IMPORTANT: this window has to cover
    // not just the FIRST leg's departure, but every later leg's boarding
    // time too — a transfer partway through a long trip can depart well
    // after the first leg, and if its departure_sec falls outside the
    // window, that trip's timetable never gets loaded at all, so RAPTOR
    // silently can't connect through it (looks like "no route found" even
    // though service exists). 150s/km (not straight-line speed) plus a flat
    // 45min buffer is a deliberately generous estimate that bakes in
    // transfer wait time, not just in-vehicle travel time. Even so, this is
    // an estimate — computeGtfsRoute in gtfsRouter.ts retries with
    // forceWindowSec if RAPTOR fails to reach the destination despite
    // trips existing, which is the real safety net.
    const straightLineM = haversineMeters(
        origin,
        { lat: destination.latitude, lon: destination.longitude },
    );
    const SEC_PER_KM = 150;
    const BUFFER_SEC = 45 * 60;
    const distanceScaledSec = (straightLineM / 1000) * SEC_PER_KM + BUFFER_SEC;
    const initialWindowSec = opts?.forceWindowSec ?? Math.min(5 * 3600, Math.max(2.5 * 3600, distanceScaledSec));
    console.log(`[gtfsLoader] window sizing: straightLine=${(straightLineM / 1000).toFixed(1)}km, ` +
        `distanceScaled=${(distanceScaledSec / 3600).toFixed(2)}h, initial=${(initialWindowSec / 3600).toFixed(2)}h` +
        `${opts?.forceWindowSec ? ' (forced)' : ''}, departSec=${departSec}`);

    // If the initial window finds no usable trips — most commonly because
    // it's off-peak/overnight and the next real departure is hours away —
    // widen and retry rather than silently returning an empty result.
    // Stages are deliberately generous at the top end since overnight gaps
    // on lower-frequency lines can be large (e.g. last train ~1am, first
    // ~5am is a real 4h+ gap with zero service, not a bug to route around).
    const WINDOW_STAGES_SEC = [initialWindowSec, 10 * 3600, 20 * 3600];
    const WINDOW_BOARD_BUFFER_SEC = 15 * 60; // small buffer for already-walking-there boarding

    let windowLo = 0, windowHi = 0;
    let windowedRows: Array<{ trip_id: string; agency: number; pattern_id: string }> = [];
    let windowedActiveTripIds: string[] = [];
    let usedWindowStageIdx = -1;

    for (let stageIdx = 0; stageIdx < WINDOW_STAGES_SEC.length; stageIdx++) {
        const windowSec = WINDOW_STAGES_SEC[stageIdx];
        windowLo = Math.max(0, departSec - WINDOW_BOARD_BUFFER_SEC);
        windowHi = departSec + windowSec;

        // Query by STOP_ID (not pattern_id) — this matches the existing
        // idx_st_stop_dep(stop_id, departure_sec) index exactly, so SQLite can
        // range-scan departure_sec directly instead of scanning every row for a
        // pattern regardless of time. It's also semantically better: we want
        // "does this trip depart from a stop we can actually board at, within the
        // window" — which is exactly what RAPTOR's boarding step needs.
        windowedRows = await chunkedQuery(stopIdList, SQL_CHUNK_SIZE, chunk =>
            db.getAllAsync<{ trip_id: string; agency: number; pattern_id: string }>(
                `SELECT DISTINCT trip_id, agency, pattern_id FROM stop_times
                 WHERE stop_id IN (${placeholders(chunk.length)})
                   AND departure_sec BETWEEN ? AND ?`,
                [...chunk, windowLo, windowHi],
            ),
        );
        t = lap(`time-windowed trip discovery, stage ${stageIdx} (${(windowSec / 3600).toFixed(1)}h -> ${windowedRows.length} candidate trips)`, t);

        windowedActiveTripIds = [...new Set(
            windowedRows
                .filter(r => candidatePatternKeys.has(makeKey(r.agency, r.pattern_id)))
                .filter(r => activeTripKeys.has(makeKey(r.agency, r.trip_id)))
                .map(r => r.trip_id),
        )];
        t = lap(`windowed trips filtered to active + candidate patterns (${windowedActiveTripIds.length})`, t);

        usedWindowStageIdx = stageIdx;
        if (windowedActiveTripIds.length > 0) break;
        if (stageIdx < WINDOW_STAGES_SEC.length - 1) {
            console.log(`[gtfsLoader] no active trips in ${(windowSec / 3600).toFixed(1)}h window — widening to ${(WINDOW_STAGES_SEC[stageIdx + 1] / 3600).toFixed(1)}h and retrying`);
        }
    }

    // Surfaced to the caller so the UI can distinguish "genuinely no service
    // today within a day+ of this time" from a normal result, and show
    // something like "no more services until tomorrow" instead of a bare
    // empty journey list.
    const noServiceFound = windowedActiveTripIds.length === 0;
    if (noServiceFound) {
        console.log(`[gtfsLoader] no active trips found even after widening to ${(WINDOW_STAGES_SEC[WINDOW_STAGES_SEC.length - 1] / 3600).toFixed(1)}h — likely genuinely no service in this window`);
    }

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

    // ── 9. Shapes — deferred, NOT loaded here ──────────────────────────────
    // Shape polylines are a pure rendering concern: RAPTOR itself never reads
    // shapePoints, only reconstructPath() does, and only for the handful of
    // journeys that survive the Pareto filter at the very end. Loading shapes
    // for every candidate pattern (up to ~1300+ patterns for a long corridor)
    // was the single biggest remaining cost — see loadShapesForShapeIds below,
    // which the caller invokes only for the patterns actually used in the
    // journeys it decides to keep.
    const shapePoints = new Map<string, { latitude: number; longitude: number }[]>();

    console.log(`[gtfsLoader] TOTAL scoped load time: ${Date.now() - t0}ms`);

    return {
        stopsByKey, allStops, corridorStopIds: allowedStopIds, patternsByKey, patternStops,
        stopTimesByStop, stopTimesByStopAndTrip, shapePoints, serviceDate: dateStr, noServiceFound,
    };
}

/**
 * Loads shape polylines for a specific, small set of shape_ids — the
 * counterpart to the deferred step 9 above. Callers (gtfsRouter.ts) should
 * collect the shape_ids actually used by the journeys they're keeping
 * (typically a handful, after Pareto filtering) and call this once, rather
 * than gtfsLoader eagerly loading shapes for every candidate pattern.
 */
export async function loadShapesForShapeIds(
    shapeIds: Array<{ shape_id: string; agency: number }>,
): Promise<Map<string, { latitude: number; longitude: number }[]>> {
    const shapePoints = new Map<string, { latitude: number; longitude: number }[]>();
    const uniqueShapeIds = [...new Set(shapeIds.map(s => s.shape_id))];
    if (uniqueShapeIds.length === 0) return shapePoints;

    const db = await getDb();
    const shapeRows = await chunkedQuery(uniqueShapeIds, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ shape_id: string; agency: number; shape_pt_lat: number; shape_pt_lon: number; shape_pt_sequence: number }>(
            `SELECT shape_id, agency, shape_pt_lat, shape_pt_lon, shape_pt_sequence
             FROM shapes WHERE shape_id IN (${placeholders(chunk.length)})
             ORDER BY shape_id, agency, shape_pt_sequence`,
            chunk,
        ),
    );

    for (const r of shapeRows) {
        const key = makeKey(r.agency, r.shape_id);
        if (!shapePoints.has(key)) shapePoints.set(key, []);
        shapePoints.get(key)!.push({ latitude: r.shape_pt_lat, longitude: r.shape_pt_lon });
    }
    return shapePoints;
}