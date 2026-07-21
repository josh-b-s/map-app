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
 * There is no persistent whole-network cache anymore for patterns/trips/
 * stop_times — each search loads its own scoped index. That's intentional:
 * once scoped, the data is small enough that reloading per search is cheap
 * and avoids ever holding irrelevant routes (e.g. V/Line services on the
 * other side of the state) in memory at all.
 *
 * The one exception is the `stops` table itself: it's read in FULL on every
 * single search (needed just to compute the corridor/nearest-stop seeds
 * before we even know which patterns are relevant), and it doesn't change
 * mid-session — same profile as coarseGraph.ts's cached graph. Measured at
 * ~700-1000ms per search regardless of trip length or corridor size, so
 * it's pure fixed overhead worth caching in-memory the same way. Call
 * invalidateStopsCache() (alongside invalidateCoarseGraphCache()) after a
 * GTFS feed update.
 */

import type {LatLng} from './gtfsDb';
import {getDb} from './gtfsDb';
import {makeKey, parseKey} from './gtfsKeyUtil';
import {haversineMeters} from './geoUtil';
import {chunkedQuery, placeholders, SQL_CHUNK_SIZE} from './sqlChunkUtil';
import {ORIGIN_DEST_WALK_RADIUS_M, resolveCorridor} from './corridorResolver';
import type {CorridorBoundary} from './corridorTagging';
import {
    INITIAL_WINDOW_MAX_SEC,
    INITIAL_WINDOW_MIN_SEC,
    WINDOW_BOARD_BUFFER_SEC,
    WINDOW_DISTANCE_BUFFER_SEC,
    WINDOW_DISTANCE_SCALE_SEC_PER_KM,
    WINDOW_WIDENING_STAGES_SEC,
} from './routingSettings';
import {
    getAllPatternKeys,
    getAllStopsCached as repoGetAllStopsCached,
    getPatternStopsForPatternKeys,
    getShapePointsForShapeIds,
    getStopKeysForPks,
    getStopPksForStopKeys,
    invalidateGtfsRepoCaches,
    isStopsCacheWarm,
    patternKeyFor,
    patternPkFromKey,
    type RepoPatternStop,
} from './gtfsRepo';

/** Re-exported for backward compatibility — the actual cache now lives in
 *  gtfsRepo.ts (shared with coarseGraph.ts, which used to run its own
 *  separate, un-cached copy of the same stops query). */
export async function getAllStopsCached(db: Awaited<ReturnType<typeof getDb>>): Promise<StopInfo[]> {
    return repoGetAllStopsCached(db);
}

export {invalidateGtfsRepoCaches as invalidateStopsCache};

export interface StopInfo {
    stop_id: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
    agency: number;
}

export interface PatternMeta {
    pattern_id: string;
    route_id: string;
    agency: number;
    shape_id: string | null;
    route_name: string;
    route_type: number;
    route_color: string;
    route_text_color: string;
}

export interface PatternStopEntry {
    stop_id: string;
    stop_sequence: number;
}

export interface StopTimeEntry {
    trip_id: string;
    pattern_id: string;
    stop_sequence: number;
    arrival_sec: number;
    departure_sec: number;
}

export interface GtfsIndex {
    stopsByKey: Map<string, StopInfo>;
    allStops: StopInfo[];
    /** Agency-qualified stop KEYS (makeKey(agency,stop_id)) that survived
     *  corridor scoping for this query — NOT bare stop_id (tightened
     *  alongside corridorResolver.ts/corridorTagging.ts to close a
     *  cross-agency stop_id collision risk; see ResolvedCorridor's doc
     *  comment in corridorResolver.ts). Computed once here by gtfsLoader.ts
     *  and shared with gtfsRouter.ts so the two stages agree on a single
     *  corridor shape instead of each computing (and potentially
     *  disagreeing on) their own filter. gtfsRouter.ts's stop filters must
     *  use makeKey(s.agency, s.stop_id) against this set, not s.stop_id
     *  alone. */
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
    /** Raw BFS seed paths (stop-key sequences) the corridor was built from —
     *  see corridorTagging.ts's CorridorResult.seedPaths. Purely for the
     *  debug overlay; routing never reads this. */
    debugSeedPaths: string[][];
    /** BFS's per-level frontier snapshots — see seedRouteBfs.ts's
     *  levelFrontiers. Purely for the debug replay's "BFS expanding
     *  outward" phase. */
    debugBfsLevels: string[][];
    /** BFS exploration-tree edges (see corridorTagging.ts's
     *  bfsTreeEdges) — lets the debug overlay render a connected "web"
     *  instead of per-stop dots. */
    debugBfsTreeEdges: [string, string][];
    /** Fixed walk-tolerance radius (meters) that's always unioned into the
     *  corridor around origin/destination regardless of the taper — see
     *  corridorTagging.ts's ORIGIN_DEST_WALK_RADIUS_M. Exposed so the debug
     *  overlay can draw the two radius circles explicitly; without this,
     *  the debug view only showed the tapered polygon, understating the
     *  real corridor's extent at both ends. */
    debugWalkRadiusM: number;
    /** Tapered-buffer outline per seed path — see corridorTagging.ts's
     *  CorridorBoundary. Purely for the debug overlay's corridor-shape
     *  phase; routing never reads this. */
    debugCorridorBoundary: { left: { lat: number; lon: number }[]; right: { lat: number; lon: number }[] }[];
}

const DOW_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function todayYYYYMMDD(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

/** How many of the nearest stops (at each end) to seed the corridor BFS
 *  from, and the transfer budget for the BFS itself — see
 *  corridorResolver.ts, which now owns corridor/pattern resolution
 *  entirely (including these constants). */

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
    opts?: {
        forceWindowSec?: number;
        /** Benchmark-only — see this function's step 2 for why this exists.
         *  Never set this from real search code. */
        skipCorridorScoping?: boolean;
    },
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

    // ── 1. All stops — cached in-memory across searches (see getAllStopsCached
    // above), not re-queried every time. Previously ~700-1000ms on every
    // single search regardless of trip length; now paid once per app session.
    const wasAlreadyCached = isStopsCacheWarm();
    const stopRows = await getAllStopsCached(db);
    t = lap(`stops query (${stopRows.length} rows${wasAlreadyCached ? ', cached' : ', cold fetch'})`, t);

    const stopsByKey = new Map<string, StopInfo>();
    const allStops: StopInfo[] = [];
    for (const s of stopRows) {
        stopsByKey.set(makeKey(s.agency, s.stop_id), s);
        allStops.push(s);
    }

    // ── 2. Corridor -> candidate patterns + stops ─────────────────────────────
    // Delegated entirely to corridorResolver.ts (schedule-agnostic — cached
    // there by origin/destination, so a repeat search that only changes the
    // departure time skips straight back to this being a cache hit). See
    // corridorResolver.ts for the BFS -> seed-path-derived-patterns ->
    // bbox-fallback logic this used to contain inline.
    let candidatePatternKeys: Set<string>;
    let allowedStopIds: Set<string>;
    let patternStopRowsFromCorridor: RepoPatternStop[] = [];
    let debugSeedPaths: string[][] = [];
    let debugBfsLevels: string[][] = [];
    let debugBfsTreeEdges: [string, string][] = [];
    let debugCorridorBoundary: CorridorBoundary[] = [];

    if (opts?.skipCorridorScoping) {
        // Benchmark-only escape hatch: skip corridor discovery entirely and
        // scope to the WHOLE network instead. Lets gtfsBenchmark.ts run the
        // exact same downstream loading/RAPTOR code with corridor filtering
        // on vs off, to measure what corridor scoping actually costs/saves
        // relative to plain full-network RAPTOR over real data — rather
        // than a separate reimplementation that could subtly diverge from
        // the real algorithm. Never set by a real search caller
        // (computeGtfsRoute never passes it); exists purely as a same-
        // codepath comparison baseline.
        const allPatternKeys = await getAllPatternKeys(db);
        candidatePatternKeys = allPatternKeys;
        allowedStopIds = new Set(allStops.map(s => makeKey(s.agency, s.stop_id)));
        t = lap(`corridor scoping SKIPPED (benchmark mode) — using full network ` +
            `(${candidatePatternKeys.size} patterns, ${allowedStopIds.size} stops)`, t);
    } else {
        const resolved = await resolveCorridor(origin, destination, allStops, db, lap, t);
        t = Date.now();
        candidatePatternKeys = resolved.patternKeys;
        allowedStopIds = resolved.allowedStopIds;
        patternStopRowsFromCorridor = resolved.patternStopRows;
        debugSeedPaths = resolved.debugSeedPaths;
        debugBfsLevels = resolved.debugBfsLevels;
        debugBfsTreeEdges = resolved.debugBfsTreeEdges;
        debugCorridorBoundary = resolved.debugCorridorBoundary;
    }

    // ── DIAGNOSTIC: is a specific route present among the corridor's raw
    // candidate patterns, BEFORE the "active today" filter? Answers "was
    // this route ever discovered by BFS at all" independent of scheduling —
    // if it's not in this list, the gap is upstream (corridor/BFS); if it
    // IS in this list but the search still didn't offer it, the gap is
    // downstream (not active today, or filtered by RAPTOR/Pareto). Set to
    // null to disable; this is a temporary debugging aid, not something
    // that should ship logging on every real search.
    const DEBUG_CHECK_ROUTE_NAME: string | null = '601';
    if (DEBUG_CHECK_ROUTE_NAME && candidatePatternKeys.size > 0) {
        const candidatePatternPks = [...candidatePatternKeys].map(patternPkFromKey);
        const routeCheckRows = await chunkedQuery(candidatePatternPks, SQL_CHUNK_SIZE, chunk =>
            db.getAllAsync<{ pattern_pk: number; route_short_name: string }>(
                `SELECT DISTINCT p.pattern_pk, r.route_short_name
                 FROM patterns p
                          JOIN routes r ON r.route_id = p.route_id AND r.agency = p.agency
                 WHERE p.pattern_pk IN (${placeholders(chunk.length)})`,
                chunk,
            ),
        );
        const matches = routeCheckRows.filter(r => r.route_short_name === DEBUG_CHECK_ROUTE_NAME);
        console.log(`[gtfsLoader]   [DIAGNOSTIC] route "${DEBUG_CHECK_ROUTE_NAME}" in corridor's ${candidatePatternKeys.size} candidate patterns: ` +
            (matches.length > 0 ? `YES (${matches.length} pattern(s): pk ${matches.map(m => m.pattern_pk).join(', ')})` : 'NO — never discovered by BFS/corridor'));
    }

    // ── 2b. Stage corridor stops into a temp table for later JOINs ──────────
    // Reused by step 8b below to filter stop_times by corridor membership
    // server-side. Populated once here (not per-query) since the corridor
    // is fixed for the whole search. Stored as stop_pk (matching stop_times'
    // actual schema — see gtfsRepo.ts) rather than stop_id text, which
    // stop_times doesn't carry at all.
    const stopIdList = [...allowedStopIds];
    const corridorStopPks = await getStopPksForStopKeys(db, stopIdList);
    await db.execAsync(
        `CREATE TEMP TABLE IF NOT EXISTS _corridor_stop_pks (stop_pk INTEGER PRIMARY KEY);
         DELETE FROM _corridor_stop_pks;`,
    );
    {
        const json = JSON.stringify(corridorStopPks);
        await db.runAsync(
            `INSERT
            OR IGNORE INTO _corridor_stop_pks (stop_pk)
            SELECT value
            FROM json_each(?)`,
            [json],
        );
    }
    t = lap(`corridor stops staged into temp table (${stopIdList.length} stop keys -> ${corridorStopPks.length} stop_pks)`, t);

    if (candidatePatternKeys.size === 0) {
        return {
            stopsByKey, allStops, corridorStopIds: allowedStopIds, patternsByKey: new Map(), patternStops: new Map(),
            stopTimesByStop: new Map(), stopTimesByStopAndTrip: new Map(), shapePoints: new Map(), serviceDate: dateStr,
            noServiceFound: true,
            debugSeedPaths: [],
            debugBfsLevels: [],
            debugBfsTreeEdges: [],
            debugWalkRadiusM: ORIGIN_DEST_WALK_RADIUS_M,
            debugCorridorBoundary: [],
        };
    }

    const candidatePatternPks = [...candidatePatternKeys].map(patternPkFromKey);

    // ── 4/5 REORDERED: resolve active services + trips BEFORE fetching full
    // pattern_stops / route metadata (previously steps 4-5, run against ALL
    // geographically-candidate patterns regardless of whether they run
    // today). A pattern that's in-corridor but has zero active trips today
    // (weekend-only routes hit on a weekday, seasonal/regional variants,
    // school-term-only services, etc) can never contribute a journey, so
    // there's no reason to pay for its full stop sequence or route metadata.
    // This step (active services) has NO dependency on candidatePatternKeys
    // at all — only on the search date — so it was always safe to hoist
    // above the pattern-metadata fetch; it just hadn't been until now.
    //
    // ── 4. Active service_ids for TODAY and TOMORROW ──────────────────────────
    // A search close to midnight can need trips that are only active under
    // TOMORROW's calendar entry (not today's) — e.g. searching at 11:50pm for
    // a trip departing at 12:15am. GTFS doesn't consistently roll late-night
    // trips into the previous day's service_id (that's a per-feed convention,
    // not a spec requirement), so the safe fix is to just treat both calendar
    // days as in-scope rather than trying to detect which convention this
    // feed uses. Doubling the date range roughly doubles this step's own
    // cost (still under 300ms per the logs) but is what actually lets us push
    // the filter into the trips query below instead of just checking it
    // client-side after fetching everything.
    const tomorrow = new Date(forDate.getTime() + 24 * 60 * 60 * 1000);
    const dateStrs = [dateStr, todayYYYYMMDD(tomorrow)];
    const dows = [dow, DOW_COLUMNS[tomorrow.getDay()]];

    const activeServices = new Set<string>();
    for (let i = 0; i < dateStrs.length; i++) {
        const [calRows, calDateRows] = await Promise.all([
            db.getAllAsync<{ service_id: string; agency: number }>(
                `SELECT service_id, agency
                 FROM calendar
                 WHERE ${dows[i]} = 1
                   AND start_date <= ?
                   AND end_date >= ?`,
                [dateStrs[i], dateStrs[i]],
            ),
            db.getAllAsync<{ service_id: string; agency: number; exception_type: number }>(
                `SELECT service_id, agency, exception_type
                 FROM calendar_dates
                 WHERE date = ?`,
                [dateStrs[i]],
            ),
        ]);
        for (const r of calRows) activeServices.add(makeKey(r.agency, r.service_id));
        for (const r of calDateRows) {
            const key = makeKey(r.agency, r.service_id);
            if (r.exception_type === 1) activeServices.add(key);
            else if (r.exception_type === 2) activeServices.delete(key);
        }
    }
    t = lap(`active services (today + tomorrow, ${activeServices.size} total)`, t);

    // ── 5. Trips for candidate patterns, pre-filtered to active services ─────
    // service_id (without agency) is used as the SQL-side filter — a looser
    // check than the exact (agency, service_id) match, but that exact check
    // still runs client-side below via activeServices.has(...), so this is
    // purely a row-count reduction, not a correctness dependency.
    // Single statement via json_each instead of a chunked multi-round-trip
    // query. The old version needed BOTH the pattern-id chunk AND the full
    // active-service-id list bound together (hence the awkward
    // MAX_COMBINED_PARAMS/TRIPS_QUERY_PATTERN_CHUNK math above), which for
    // 1343 candidate patterns meant ~27 separate round trips (profiled at
    // 1.3-2.3s total, mostly round-trip overhead rather than SQLite's own
    // work — individual chunks ran in 20-300ms regardless of row count).
    // json_each expands BOTH lists server-side from two bound JSON-array
    // parameters, so the whole query becomes ONE round trip no matter how
    // many candidate patterns or active services there are.
    const activeServiceIdList = [...new Set([...activeServices].map(k => parseKey(k).id))];
    const patternPksJson = JSON.stringify(candidatePatternPks);
    const serviceIdsJson = JSON.stringify(activeServiceIdList);
    const tripRows = activeServiceIdList.length > 0
        ? await db.getAllAsync<{
            trip_pk: number;
            trip_id: string;
            agency: number;
            pattern_pk: number;
            service_id: string
        }>(
            `SELECT t.trip_pk, t.trip_id, t.agency, t.pattern_pk, t.service_id
             FROM trips t
             WHERE t.pattern_pk IN (SELECT value FROM json_each(?))
               AND t.service_id IN (SELECT value FROM json_each(?))`,
            [patternPksJson, serviceIdsJson],
        )
        : [];
    t = lap(`trips for candidates, pre-filtered (${tripRows.length} rows)`, t);

    const activeTripKeys = new Set<string>();
    const activeTripPks = new Set<number>();
    const patternKeysWithActiveTrip = new Set<string>();
    /** trip_pk -> (trip_id, agency, patternKey), needed to translate
     *  stop_times rows back to the identity the rest of the app expects.
     *  Built here from trips rows already in memory — no extra query
     *  needed. patternKey is included because stop_times itself no longer
     *  stores pattern_pk (removed from the schema — see preprocess-
     *  gtfs.ts's stop_times comment: it was a pure repeated-column cost,
     *  fully derivable via this same trip_pk -> pattern_pk relationship,
     *  and nothing queries stop_times filtered by pattern_pk). */
    const tripPkToInfo = new Map<number, { trip_id: string; agency: number; patternKey: string }>();
    for (const tr of tripRows) {
        const patKey = patternKeyFor(tr.pattern_pk, tr.agency);
        if (!candidatePatternKeys.has(patKey)) continue;
        if (!activeServices.has(makeKey(tr.agency, tr.service_id))) continue;
        activeTripKeys.add(makeKey(tr.agency, tr.trip_id));
        activeTripPks.add(tr.trip_pk);
        tripPkToInfo.set(tr.trip_pk, {trip_id: tr.trip_id, agency: tr.agency, patternKey: patKey});
        patternKeysWithActiveTrip.add(patKey);
    }
    t = lap(`active trips filtered (${activeTripKeys.size} active, ` +
        `${patternKeysWithActiveTrip.size}/${candidatePatternKeys.size} candidate patterns actually run today)`, t);
    // If NOTHING runs today, there's no point fetching pattern_stops/route
    // metadata for any candidate pattern — bail out the same way the
    // zero-candidate-patterns branch above does.
    if (patternKeysWithActiveTrip.size === 0) {
        return {
            stopsByKey, allStops, corridorStopIds: allowedStopIds, patternsByKey: new Map(), patternStops: new Map(),
            stopTimesByStop: new Map(), stopTimesByStopAndTrip: new Map(), shapePoints: new Map(), serviceDate: dateStr,
            noServiceFound: true,
            debugSeedPaths,
            debugBfsLevels,
            debugBfsTreeEdges,
            debugWalkRadiusM: ORIGIN_DEST_WALK_RADIUS_M,
            debugCorridorBoundary,
        };
    }

    // Narrow to only the patterns that actually run today — this is the set
    // steps 6/7 below now fetch full metadata for, instead of every
    // geographically-candidate pattern.
    const patternPksRunningToday = [...new Set(
        [...patternKeysWithActiveTrip].map(patternPkFromKey),
    )];

    // ── 6. Full pattern_stops for patterns running today (need whole
    //      sequence, not just in-corridor stops, so stop_sequence numbering
    //      stays intact) — narrowed set, per the reorder above.
    //
    //      patternKeysWithActiveTrip is always a SUBSET of the patterns
    //      corridorResolver.ts already fetched pattern_stops for during its
    //      own coverage check (patternStopRowsFromCorridor) — on the normal
    //      seed-path-derived path, that means the rows we need here were
    //      already pulled across the JS<->native bridge once; querying
    //      pattern_stops AGAIN for an overlapping-but-smaller pattern set
    //      would be pure duplicate work. Filter the already-fetched rows
    //      instead when they're available, and only fall back to a fresh
    //      query on the bbox-fallback path (where corridorResolver.ts never
    //      populates patternStopRows) or benchmark mode (which skips
    //      corridor resolution — and this data — entirely). ─────────────
    const patternStopRows = patternStopRowsFromCorridor.length > 0
        ? patternStopRowsFromCorridor.filter(r => patternKeysWithActiveTrip.has(r.patternKey))
        : await getPatternStopsForPatternKeys(db, patternKeysWithActiveTrip);
    t = lap(`pattern_stops for patterns running today (${patternStopRows.length} rows` +
        `${patternStopRowsFromCorridor.length > 0 ? ', reused from corridor resolution' : ', fresh query'})`, t);

    const patternStops = new Map<string, PatternStopEntry[]>();
    for (const r of patternStopRows) {
        if (!patternStops.has(r.patternKey)) patternStops.set(r.patternKey, []);
        patternStops.get(r.patternKey)!.push({stop_id: parseKey(r.stopKey).id, stop_sequence: r.stop_sequence});
    }

    // ── 7. Pattern + route metadata, same narrowed set — single json_each
    //      statement instead of chunking. patterns has no pattern_id column
    //      (see gtfsRepo.ts's module doc — pattern_pk IS the identity), so
    //      this filters on that directly and PatternMeta.pattern_id below is
    //      just String(pattern_pk). ──────────────────────────────────────
    const patternRows = await db.getAllAsync<{
        pattern_pk: number; route_id: string; agency: number; shape_id: string | null;
        route_short_name: string; route_long_name: string; route_type: number;
        route_color: string; route_text_color: string;
    }>(
        `SELECT p.pattern_pk,
                p.route_id,
                p.agency,
                p.shape_id,
                r.route_short_name,
                r.route_long_name,
                r.route_type,
                r.route_color,
                r.route_text_color
         FROM patterns p
                  JOIN routes r ON r.route_id = p.route_id AND r.agency = p.agency
         WHERE p.pattern_pk IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(patternPksRunningToday)],
    );
    t = lap(`patterns+routes for patterns running today (${patternRows.length} rows)`, t);

    const patternsByKey = new Map<string, PatternMeta>();
    for (const p of patternRows) {
        const key = patternKeyFor(p.pattern_pk, p.agency);
        if (!patternKeysWithActiveTrip.has(key)) continue;
        patternsByKey.set(key, {
            pattern_id: String(p.pattern_pk), route_id: p.route_id, agency: p.agency, shape_id: p.shape_id,
            route_name: p.route_short_name || p.route_long_name || '?',
            route_type: p.route_type,
            route_color: p.route_color || '',
            route_text_color: p.route_text_color || '#FFFFFF',
        });
    }

    // ── 7b. Push activeTripPks into a temp table so step 8's window query
    // can filter server-side instead of fetching everything and discarding
    // most of it in JS. This is the actual fix for the ~12.8s "stage 0"
    // cost seen in profiling: that query was returning 51K+ rows by stop
    // + time range alone, then throwing away 92% of them client-side
    // against candidatePatternKeys/activeTripKeys — the marshal cost of
    // those discarded rows across the JS<->native bridge was the real
    // expense, not SQLite's own query time. activeTripPks is the tightest
    // set we have at this point (already both pattern- and service-active
    // filtered), so joining against it directly (rather than the broader
    // candidatePatternKeys) prunes as much as possible before any row ever
    // reaches JS. Repopulated fresh each search (temp tables persist on the
    // shared db connection across calls, so must be cleared, not just
    // created) — cheap relative to what it saves, and the table itself
    // never needs to survive past this one loadGtfsIndexForTrip() call.
    // A single INTEGER trip_pk column now — no more (trip_id,agency) pair
    // to reconstruct/stage, since activeTripPks already gives us the exact
    // column stop_times joins on.
    await db.execAsync(
        `CREATE TEMP TABLE IF NOT EXISTS _active_trip_pks (trip_pk INTEGER PRIMARY KEY);
         DELETE FROM _active_trip_pks;`,
    );
    {
        // Single statement via json_each instead of chunked multi-row
        // INSERTs — same round-trip-elimination reasoning as elsewhere in
        // this file: one bound JSON-array parameter, one bridge crossing,
        // regardless of row count.
        const json = JSON.stringify([...activeTripPks]);
        await db.runAsync(
            `INSERT
            OR IGNORE INTO _active_trip_pks (trip_pk)
            SELECT value
            FROM json_each(?)`,
            [json],
        );
    }
    t = lap(`active trips staged into temp table (${activeTripPks.size} rows)`, t);

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
    // See routingSettings.ts for WINDOW_DISTANCE_SCALE_SEC_PER_KM /
    // WINDOW_DISTANCE_BUFFER_SEC / INITIAL_WINDOW_MIN_SEC /
    // INITIAL_WINDOW_MAX_SEC / WINDOW_BOARD_BUFFER_SEC /
    // WINDOW_WIDENING_STAGES_SEC — all "how long would a rider wait"
    // tuning, centralized alongside the walk-distance constants for the
    // same reason (future settings-screen candidates).
    const straightLineM = haversineMeters(
        {lat: origin.latitude, lon: origin.longitude},
        {lat: destination.latitude, lon: destination.longitude},
    );
    const distanceScaledSec = (straightLineM / 1000) * WINDOW_DISTANCE_SCALE_SEC_PER_KM + WINDOW_DISTANCE_BUFFER_SEC;
    const initialWindowSec = opts?.forceWindowSec ?? Math.min(INITIAL_WINDOW_MAX_SEC, Math.max(INITIAL_WINDOW_MIN_SEC, distanceScaledSec));
    console.log(`[gtfsLoader] window sizing: straightLine=${(straightLineM / 1000).toFixed(1)}km, ` +
        `distanceScaled=${(distanceScaledSec / 3600).toFixed(2)}h, initial=${(initialWindowSec / 3600).toFixed(2)}h` +
        `${opts?.forceWindowSec ? ' (forced)' : ''}, departSec=${departSec}`);

    // If the initial window finds no usable trips — most commonly because
    // it's off-peak/overnight and the next real departure is hours away —
    // widen and retry rather than silently returning an empty result.
    const WINDOW_STAGES_SEC = [initialWindowSec, ...WINDOW_WIDENING_STAGES_SEC];

    let windowLo = 0, windowHi = 0;
    let windowedTripPks: number[] = [];
    let usedWindowStageIdx = -1;

    for (let stageIdx = 0; stageIdx < WINDOW_STAGES_SEC.length; stageIdx++) {
        const windowSec = WINDOW_STAGES_SEC[stageIdx];
        windowLo = Math.max(0, departSec - WINDOW_BOARD_BUFFER_SEC);
        windowHi = departSec + windowSec;

        // Query by STOP_PK (matches idx_st_stop_dep-equivalent range scan on
        // stop_times' actual columns) AND joins against _active_trip_pks so
        // SQLite filters to the active+candidate-pattern trip set BEFORE
        // returning any rows — previously this fetched every trip touching a
        // corridor stop in the time window (51K+ rows in testing) and
        // discarded ~92% of them in JS afterward; the discarded rows'
        // bridge-marshal cost was the actual bottleneck (~12.8s), not
        // SQLite's query time itself. Single json_each statement instead of
        // chunking over the stop_pk list — same round-trip-elimination
        // reasoning as the other queries above.
        const windowedRows = await db.getAllAsync<{ trip_pk: number }>(
            `SELECT DISTINCT st.trip_pk
             FROM stop_times st
                      JOIN _active_trip_pks atk ON atk.trip_pk = st.trip_pk
             WHERE st.stop_pk IN (SELECT value FROM json_each(?))
               AND st.departure_sec BETWEEN ? AND ?`,
            [JSON.stringify(corridorStopPks), windowLo, windowHi],
        );
        t = lap(`time-windowed trip discovery, stage ${stageIdx} (${(windowSec / 3600).toFixed(1)}h -> ${windowedRows.length} candidate trips, pre-filtered)`, t);

        // No client-side filtering needed anymore — the JOIN above already
        // guarantees every row is both an active trip and on a candidate
        // pattern, so this is just a dedup, not a correctness filter.
        windowedTripPks = [...new Set(windowedRows.map(r => r.trip_pk))];

        usedWindowStageIdx = stageIdx;
        if (windowedTripPks.length > 0) break;
        if (stageIdx < WINDOW_STAGES_SEC.length - 1) {
            console.log(`[gtfsLoader] no active trips in ${(windowSec / 3600).toFixed(1)}h window — widening to ${(WINDOW_STAGES_SEC[stageIdx + 1] / 3600).toFixed(1)}h and retrying`);
        }
    }

    // Surfaced to the caller so the UI can distinguish "genuinely no service
    // today within a day+ of this time" from a normal result, and show
    // something like "no more services until tomorrow" instead of a bare
    // empty journey list.
    const noServiceFound = windowedTripPks.length === 0;
    if (noServiceFound) {
        console.log(`[gtfsLoader] no active trips found even after widening to ${(WINDOW_STAGES_SEC[WINDOW_STAGES_SEC.length - 1] / 3600).toFixed(1)}h — likely genuinely no service in this window`);
    }

    // Single json_each statement instead of chunking over windowedTripPks —
    // same round-trip-elimination reasoning as the other queries above.
    // (Earlier COUNT(*)-only diagnostic confirmed ~85% of this query's cost
    // was JS<->native row marshaling, not SQLite execution — removed now
    // that its purpose is served.)
    const stopTimeRows = windowedTripPks.length > 0
        ? await db.getAllAsync<{
            trip_pk: number; stop_pk: number; stop_sequence: number;
            arrival_sec: number; departure_sec: number;
        }>(
            // JOINed against the corridor stop set (see step 2b) instead of
            // fetching every stop of every trip. Safe because gtfsRouter's
            // trip-riding loop already does `if (!tripMap) continue` for any
            // stop it has no data for — a long trip that only briefly
            // passes through the corridor (e.g. a regional service mostly
            // running elsewhere) previously had its ENTIRE stop sequence
            // fetched; now only the corridor-relevant stops are. No
            // pattern_pk column to select — stop_times doesn't carry one
            // (see preprocess-gtfs.ts); pattern identity comes from
            // tripPkToInfo below instead.
            `SELECT st.trip_pk, st.stop_pk, st.stop_sequence, st.arrival_sec, st.departure_sec
             FROM stop_times st
                      JOIN _corridor_stop_pks csp ON csp.stop_pk = st.stop_pk
             WHERE st.trip_pk IN (SELECT value FROM json_each(?))`,
            [JSON.stringify(windowedTripPks)],
        )
        : [];
    t = lap(`stop_times for windowed trips (${stopTimeRows.length} rows)`, t);

    // Resolve stop_pk back to real (agency,id) keys in bulk, once, rather
    // than per-row — stopKeys come from gtfsRepo's already-warm cache
    // (populated by getAllStopsCached at step 1). Pattern identity no
    // longer needs its own resolution pass: tripPkToInfo already carries
    // patternKey per trip (see its construction above), since stop_times
    // itself has no pattern_pk column to resolve.
    const stopKeysByPk = await getStopKeysForPks(db, new Set(stopTimeRows.map(r => r.stop_pk)));

    const stopTimesByStop = new Map<string, StopTimeEntry[]>();
    const stopTimesByStopAndTrip = new Map<string, Map<string, StopTimeEntry>>();
    for (const st of stopTimeRows) {
        const tripInfo = tripPkToInfo.get(st.trip_pk);
        if (!tripInfo) continue; // shouldn't happen (JOIN already filtered to _active_trip_pks) — defensive only
        const stopKey = stopKeysByPk.get(st.stop_pk);
        if (!stopKey) continue;
        const patternId = parseKey(tripInfo.patternKey).id;

        const entry: StopTimeEntry = {
            trip_id: tripInfo.trip_id, pattern_id: patternId, stop_sequence: st.stop_sequence,
            arrival_sec: st.arrival_sec, departure_sec: st.departure_sec,
        };

        if (!stopTimesByStop.has(stopKey)) stopTimesByStop.set(stopKey, []);
        stopTimesByStop.get(stopKey)!.push(entry);

        if (!stopTimesByStopAndTrip.has(stopKey)) stopTimesByStopAndTrip.set(stopKey, new Map());
        stopTimesByStopAndTrip.get(stopKey)!.set(tripInfo.trip_id, entry);
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
        debugSeedPaths, debugBfsLevels,
        debugBfsTreeEdges, debugWalkRadiusM: ORIGIN_DEST_WALK_RADIUS_M,
        debugCorridorBoundary,
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
    if (shapeIds.length === 0) return new Map();
    const db = await getDb();
    // Delegated to gtfsRepo.ts: shapes are now keyed by shape_pk with the
    // real shape_id/agency living in shape_meta (see preprocess-gtfs.ts —
    // shape_id used to be repeated on every point row of a huge table,
    // exactly the pattern stop_pk/pattern_pk exist to avoid elsewhere).
    // Also fixes coordinate unpacking (COORD_SCALE), which this function
    // was previously skipping entirely.
    return getShapePointsForShapeIds(db, shapeIds);
}