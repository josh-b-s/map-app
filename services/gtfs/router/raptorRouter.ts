/**
 * raptorRouter.ts — In-memory McRAPTOR (multi-criteria RAPTOR) transit router.
 *
 * Two changes from the previous version:
 *
 * 1. ZERO SQLite queries during search. All timetable data is pre-loaded by
 *    gtfsLoader.ts into flat JS structures. This is what actually fixes the
 *    Caulfield → Clayton slowness — the old version did 4 async DB round-trips
 *    per RAPTOR round, each crossing the JS↔native bridge.
 *
 * 2. Multiple journeys are returned, not just the single fastest one. We keep
 *    every journey to the destination that isn't strictly dominated by another
 *    on all of: (arrival time, walking distance, transfers). This is the
 *    "keep a Pareto frontier at the destination" simplification of full
 *    McRAPTOR (which keeps a frontier at every stop — much more expensive and
 *    unnecessary here since we only care about journeys that actually finish).
 *
 * Corridor pre-filter: gtfsLoader.ts computes which stops are in-scope for
 * this trip (index.corridorStopIds) BEFORE this file ever runs — via a
 * schedule-agnostic BFS over stop topology, not a geometric ellipse (that
 * was an earlier version's approach). RAPTOR here just consumes that
 * pre-computed stop set; see corridorResolver.ts / corridorTagging.ts for
 * how it's derived.
 */

import type {LatLng} from '../../db/sqliteDb';
import {type GtfsIndex, loadGtfsIndexForTrip, loadShapesForShapeIds, type StopTimeEntry} from '../loader/gtfsLoader';
import {fallbackRouteColor} from '@/services/gtfs/config/routeTypeUtil';
import {makeKey, parseKey} from '../core/gtfsKeyUtil';
import {haversineMeters as haversineMetersShared} from '../../geo/geoUtil';
import {MAX_TRANSFER_WALK_SEC, NEARBY_STOPS} from '@/services/gtfs/config/routingSettings';

// ─────────────────────────────────────────────────────────────────────────────
// Walking speed presets (m/s)
// ─────────────────────────────────────────────────────────────────────────────

export const WALK_SPEED_MPS = {
    SLOW: 0.8,
    NORMAL: 1.4,
    FAST: 1.8,
    JOG: 2.5,
    RUN: 4.0,
    SPRINT: 7.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 5;
// MAX_TRANSFER_WALK_SEC / NEARBY_STOPS now live in routingSettings.ts —
// imported below. See that file's header comment for how these relate to
// topologyGraph.ts's WALK_EDGE_THRESHOLD_M and corridorResolver.ts's
// SEED_RADIUS_M (three separate "how far would someone walk" radii serving
// three different purposes: topology-graph transfers, BFS seeding, and
// mid-journey RAPTOR transfers respectively).
const BEST_MARKED_CAP = 400; // was 200 — raised as extra headroom now that trimming is goal-directed (see ASSUMED_TRANSIT_SPEED_MPS below), not just earliest-arrival-first

const INF = Number.MAX_SAFE_INTEGER;

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

// Thin adapter over geoUtil.ts's config haversineMeters (single source of
// truth for the formula — see geoUtil.ts's header for why this used to be
// copy-pasted across files and the drift risk that caused). Kept as a local
// wrapper, rather than updating every call site in this file, purely so
// existing call sites here (which pass a LatLng {latitude,longitude} as `a`)
// don't all need to change shape.
function haversineMeters(a: LatLng, b: { lat: number; lon: number }): number {
    return haversineMetersShared({lat: a.latitude, lon: a.longitude}, b);
}

function walkTimeSec(meters: number, speedMps: number): number {
    return meters / speedMps;
}

function walkTimeMin(meters: number, speedMps: number): number {
    return meters / speedMps / 60;
}

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

function normalizeHexColor(color?: string | null): string | undefined {
    if (!color) return undefined;
    const hex = color.trim().replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : undefined;
}

function resolveRouteColor(c: string | undefined, type: number, name: string): string {
    return normalizeHexColor(c) ?? fallbackRouteColor(type, name);
}

function resolveTextColor(c: string | undefined): string {
    return normalizeHexColor(c) ?? '#FFFFFF';
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type StopKey = string; // makeKey(agency, stop_id) — agency FIRST, see gtfsKeyUtil.ts for why
const keyOf = (stopId: string, agency: number): StopKey => makeKey(agency, stopId);

type ParentInfo =
    | { type: 'origin-walk'; distM: number }
    | { type: 'footpath'; fromKey: StopKey; distM: number }
    | {
    type: 'transit'; tripId: string; patternId: string; agency: number;
    boardKey: StopKey; boardSeq: number; alightSeq: number
};

export interface RouteSegment {
    coords: LatLng[];
    routeName: string;
    routeType: number;
    routeColor?: string;
    routeTextColor?: string;
    originStopName: string;
    destStopName: string;
    type: 'transit' | 'walk';
    departureTime?: string;
    arrivalTime?: string;
}

export interface GtfsJourney {
    coords: LatLng[];
    segments: RouteSegment[];
    legs: Array<{
        routeName: string; routeType: number; routeColor?: string; routeTextColor?: string;
        originStopName: string; destStopName: string; departureTime?: string; arrivalTime?: string;
    }>;
    routeName: string;
    routeType: number;
    routeColor?: string;
    routeTextColor?: string;
    originStopName: string;
    destStopName: string;
    transferStopName?: string;
    totalDurationMin: number;
    totalWalkingMeters: number;
    transferCount: number;
    departureTime: string;
    arrivalTime: string;
}

export interface GtfsDebugInfo {
    /** Every stop the corridor filter kept, for drawing "here's the search
     *  space" on the map. */
    corridorStops: LatLng[];
    /** The raw BFS seed paths the corridor was tapered around — one
     *  polyline per path, in origin->destination order. */
    seedPaths: LatLng[][];
    /** BFS's frontier at the end of each level, in order — level 0 is the
     *  origin seed set. Lets a debug replay show the coarse-graph search
     *  expanding outward before any of the corridor/RAPTOR stages. */
    bfsLevels: LatLng[][];
    /** The BFS exploration tree's (parent, child) edges as LatLng pairs —
     *  lets a debug overlay draw the search as a connected "web" (merged
     *  polylines along tree branches) instead of per-stop dots. */
    bfsTreeEdges: { from: LatLng; to: LatLng }[];
    /** RAPTOR's marked-stop set at the END of each round, one entry per
     *  round actually run. Lets a debug overlay show the search frontier
     *  expanding round by round. */
    roundMarkedStops: LatLng[][];
    /** One tapered-buffer outline per seed path (left/right boundary
     *  polylines) — lets a debug overlay draw the corridor as a single
     *  shape instead of scattering a marker over every tagged stop. */
    corridorBoundary: { left: LatLng[]; right: LatLng[] }[];
    /** Fixed walk-tolerance radius circles at origin/destination — see
     *  corridorTagging.ts's ORIGIN_DEST_WALK_RADIUS_M. These get unioned
     *  into the real corridor regardless of the taper, so without drawing
     *  them explicitly the debug view understates the corridor's true
     *  extent at both ends. */
    walkRadiusCircles: { center: LatLng; radiusMeters: number }[];
}

export interface GtfsRouteResult {
    journeys: GtfsJourney[]; // sorted by arrival time ascending; caller can re-sort
    /** Only populated when computeGtfsRoute is called with debugMode=true —
     *  omitted entirely otherwise so normal searches pay zero cost for this. */
    debug?: GtfsDebugInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nearest-stops helper (in-memory linear scan — fine at ~20K stops)
// ─────────────────────────────────────────────────────────────────────────────

function nearestStops(index: GtfsIndex, center: LatLng, limit: number, allowedIds: Set<string> | null) {
    return index.allStops
        .filter(s => !allowedIds || allowedIds.has(makeKey(s.agency, s.stop_id)))
        .map(s => ({s, d: haversineMeters(center, {lat: s.stop_lat, lon: s.stop_lon})}))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary search: earliest stop_time entry with departure_sec >= minDepart
// ─────────────────────────────────────────────────────────────────────────────

function earliestDepartureIndex(entries: StopTimeEntry[], minDepart: number): number {
    let lo = 0, hi = entries.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (entries[mid].departure_sec < minDepart) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function computeGtfsRoute(
    origin: LatLng,
    destination: LatLng,
    departureTime: Date = new Date(),
    walkingSpeedMps: number = WALK_SPEED_MPS.NORMAL,
    debugMode: boolean = false,
): Promise<GtfsRouteResult> {
    // Captured BEFORE the load, not inside runSearchOnIndex — otherwise the
    // "TOTAL search time" logged at the end only measures post-load work,
    // silently dropping the load's cost (which was ~14s in testing) from
    // the reported total. This bit us directly: a 4.2s "TOTAL search time"
    // log next to a 14.4s "TOTAL scoped load time" log made a ~18.6s search
    // look like a 4.2s one.
    const overallStart = Date.now();
    let index = await loadGtfsIndexForTrip(origin, destination, departureTime);

    try {
        return await runSearchOnIndex(index, origin, destination, departureTime, walkingSpeedMps, debugMode, overallStart);
    } catch (err) {
        // Two different failure shapes, only one of which widening can fix:
        //  - index.noServiceFound: gtfsLoader already widened its own window
        //    up to 20h and found literally zero active trips. More widening
        //    won't help — genuinely no service in this window, rethrow as-is.
        //  - RAPTOR threw "no route found" despite trips existing: the
        //    window was wide enough to find SOME trips but a later leg's
        //    boarding trip (departing well after the first leg) fell outside
        //    it, so RAPTOR never had that trip's full timetable to connect
        //    through. This is exactly the Mornington->Werribee case — a 2h
        //    window is plenty for a short hop but not for a long corridor
        //    with multiple transfers spread over hours. Reload with a forced
        //    10h window and retry once before giving up.
        if (index.noServiceFound) throw err;

        console.log('[gtfsRoute] search failed despite active trips in window — retrying once with a forced-wide (10h) window');
        index = await loadGtfsIndexForTrip(origin, destination, departureTime, {forceWindowSec: 10 * 3600});
        return await runSearchOnIndex(index, origin, destination, departureTime, walkingSpeedMps, debugMode, overallStart);
    }
}

// computeGtfsRoute is the normal entry point; this is split out separately
// only so it can be called with an already-loaded GtfsIndex.
export async function runSearchOnIndex(
    index: GtfsIndex,
    origin: LatLng,
    destination: LatLng,
    departureTime: Date,
    walkingSpeedMps: number,
    debugMode: boolean,
    overallStart: number,
): Promise<GtfsRouteResult> {
    const tStart = Date.now();
    let t = tStart;
    const lap = (label: string) => {
        console.log(`[gtfsRoute] ${label}: ${Date.now() - t}ms`);
        t = Date.now();
    };
    lap(`post-load setup (load itself took ${tStart - overallStart}ms — see gtfsLoader's own TOTAL log for its breakdown)`);

    const departSec = toSecsMidnight(departureTime);
    const xferRadius = transferRadiusM(walkingSpeedMps);

    // ── Corridor (computed once, upstream, in gtfsLoader.ts) ──────────────────
    const allowedStopIds = index.corridorStopIds;
    lap(`corridor from loader (${allowedStopIds.size}/${index.allStops.length} stops kept)`);

    // ── Nearest stops at both ends (within the corridor) ──────────────────────
    // Pre-filter the stop list to the corridor ONCE. Footpath relaxation used to
    // iterate index.allStops (the full ~32K-stop network) and check ellipse
    // membership per-element inside the loop — with hundreds of newly-marked
    // stops per round, that was tens of millions of wasted iterations. Scanning
    // this much smaller pre-filtered array directly removes that cost.
    const corridorStops = index.allStops.filter(s => allowedStopIds.has(makeKey(s.agency, s.stop_id)));

    // ── Precomputed footpath neighbor grid ────────────────────────────────────
    // Footpath relaxation below used to scan ALL of corridorStops for every
    // newly-marked stop, every round — O(newlyMarked × corridorStops.length),
    // unconditionally. Bucketing stops into a grid (same approach as
    // topologyGraph.ts's walking-edge construction) lets each stop check only
    // its own cell + 8 neighbors once, instead of a flat scan per
    // newly-marked stop per round. Cell size must stay >= xferRadius or the
    // 3x3-neighbor-cell scan can miss real neighbors just outside a smaller
    // fixed cell — unlike topologyGraph.ts's fixed 450m WALK_EDGE_THRESHOLD_M,
    // xferRadius here scales with the rider's walking speed (e.g. ~1680m at
    // NORMAL/20min), so cell size is derived from it rather than hardcoded.
    const FOOTPATH_GRID_CELL_DEG = Math.max(0.006, (xferRadius / 111_000) * 1.1);
    const footpathGrid = new Map<string, typeof corridorStops>();
    const footpathCellOf = (lat: number, lon: number) =>
        `${Math.floor(lat / FOOTPATH_GRID_CELL_DEG)}:${Math.floor(lon / FOOTPATH_GRID_CELL_DEG)}`;
    for (const s of corridorStops) {
        const c = footpathCellOf(s.stop_lat, s.stop_lon);
        if (!footpathGrid.has(c)) footpathGrid.set(c, []);
        footpathGrid.get(c)!.push(s);
    }

    function nearbyForFootpath(lat: number, lon: number): typeof corridorStops {
        const [cy, cx] = footpathCellOf(lat, lon).split(':').map(Number);
        const out: typeof corridorStops = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const bucket = footpathGrid.get(`${cy + dy}:${cx + dx}`);
                if (bucket) out.push(...bucket);
            }
        }
        return out;
    }

    const originNearby = nearestStops(index, origin, NEARBY_STOPS, allowedStopIds);
    const destNearby = nearestStops(index, destination, NEARBY_STOPS, allowedStopIds);
    lap('nearest-stops scan (origin + destination)');

    if (originNearby.length === 0) throw new Error('No stops near your location.');
    if (destNearby.length === 0) throw new Error('No stops near destination.');

    // ── RAPTOR state ──────────────────────────────────────────────────────────
    const tau = new Map<StopKey, number>();
    const parent = new Map<StopKey, ParentInfo>();
    const transfersUsed = new Map<StopKey, number>(); // # transit legs taken to reach this stop
    const walkSoFar = new Map<StopKey, number>(); // cumulative walking metres to reach this stop

    let marked = new Set<StopKey>();
    for (const {s, d} of originNearby) {
        const key = keyOf(s.stop_id, s.agency);
        const arr = departSec + walkTimeSec(d, walkingSpeedMps);
        tau.set(key, arr);
        parent.set(key, {type: 'origin-walk', distM: d});
        transfersUsed.set(key, 0);
        walkSoFar.set(key, d);
        marked.add(key);
    }

    const destKeyMap = new Map<StopKey, number>(); // stopKey -> distance to actual destination point
    for (const {s, d} of destNearby) destKeyMap.set(keyOf(s.stop_id, s.agency), d);

    // Journeys collected at the destination, kept if non-dominated.
    interface Candidate {
        destKey: StopKey;
        finalWalkM: number;
        arrivalSec: number;
        totalWalkM: number;
        transfers: number;
    }

    const candidates: Candidate[] = [];

    function tryRecordDestination(stopKey: StopKey) {
        const distM = destKeyMap.get(stopKey);
        if (distM === undefined) return;
        const tauS = tau.get(stopKey);
        if (tauS === undefined) return;

        const arrivalSec = tauS + walkTimeSec(distM, walkingSpeedMps);
        const totalWalkM = (walkSoFar.get(stopKey) ?? 0) + distM;
        const transfers = transfersUsed.get(stopKey) ?? 0;

        candidates.push({destKey: stopKey, finalWalkM: distM, arrivalSec, totalWalkM, transfers});
    }

    // Assumed average transit speed (m/s) used ONLY to estimate remaining
    // travel time for trimming priority — not for actual arrival calculations.
    // ~36km/h accounts for a mix of stop-start suburban travel and faster
    // trunk services; doesn't need to be exact, just needs to roughly rank
    // "closer to destination" above "further from destination".
    const ASSUMED_TRANSIT_SPEED_MPS = 10;

    // Best confirmed arrival at ANY destination-area stop so far. Once set,
    // any marked stop whose tau + a lower-bound travel-time-to-destination
    // already exceeds this can be dropped — it CANNOT produce a better
    // journey than one already found, unlike BEST_MARKED_CAP's heuristic
    // trim below (which can and does discard genuinely-better candidates,
    // hence that trim's own protection logic). Safe because
    // ASSUMED_TRANSIT_SPEED_MPS is a generous (fast) estimate, making the
    // bound optimistic, never pessimistic.
    let bestDestArrivalSec = INF;

    function updateBestDestArrival() {
        for (const c of candidates) if (c.arrivalSec < bestDestArrivalSec) bestDestArrivalSec = c.arrivalSec;
    }

    for (const key of marked) tryRecordDestination(key);
    updateBestDestArrival();
    lap('seed + initial destination check');

    // Debug-only: snapshot marked-stop coordinates at the end of each round,
    // so a debug overlay can show the RAPTOR frontier expanding round by
    // round. Skipped entirely when !debugMode — this is otherwise a
    // per-round Set->Array->coord-lookup pass, cheap but not free, and
    // there's no reason to pay it on every normal search.
    const debugRoundMarkedStops: LatLng[][] = [];

    // Unconditional (not debug-gated) history of which stops were marked
    // entering each round — cheap (a few hundred keys, a handful of rounds)
    // and needed for the failure diagnostic below: it lets us check, for a
    // pattern that DOES serve the destination and DOES have loaded trips,
    // whether ANY of its stops were ever actually reached/marked at all —
    // distinguishing "topologically never reachable within the corridor/
    // round budget" from "reachable but RAPTOR's boarding logic missed it."
    const markedHistory: Set<StopKey>[] = [];
    // Snapshot BEFORE the trim block runs each round — needed to tell apart
    // "this stop was reached but the BEST_MARKED_CAP trim discarded it
    // before it could be used for boarding" from "this stop was never
    // reached by any round in the first place." markedHistory alone (below,
    // captured post-trim) can't distinguish these — both look like "never
    // marked" to it, but they point at completely different fixes (raising/
    // fixing the trim's protection logic vs a genuine corridor/reachability
    // gap upstream in BFS).
    const markedHistoryPreTrim: Set<StopKey>[] = [];

    // ── RAPTOR rounds ─────────────────────────────────────────────────────────
    // Reverse index: stopKey -> every pattern that serves it, built ONCE
    // before the round loop (a pattern's stop membership never changes
    // round to round, so re-deriving this from ALL of index.patternStops on
    // every round — as a previous version of this loop did — was pure
    // waste: it turned each round into an O(every candidate pattern's every
    // stop) scan instead of the O(marked stops) lookup RAPTOR is supposed
    // to cost. With a few hundred candidate patterns averaging dozens of
    // stops each, that was tens of thousands of wasted entry-scans PER
    // ROUND, repeated for every round — the actual reason a RAPTOR search
    // was taking ~5s on-device instead of the low tens of milliseconds it
    // should. Building this index costs the same O(total pattern_stops)
    // work, but exactly once per search, not once per round.
    const patternsByStop = new Map<StopKey, Array<{ patternKey: string; seq: number }>>();
    for (const [patternKey, seqList] of index.patternStops) {
        const {agency: patAgency} = parseKey(patternKey); // agency-first key, safe regardless of colons in pattern_id
        for (const entry of seqList) {
            const sk = keyOf(entry.stop_id, patAgency);
            if (!patternsByStop.has(sk)) patternsByStop.set(sk, []);
            patternsByStop.get(sk)!.push({patternKey, seq: entry.stop_sequence});
        }
    }

    for (let round = 0; round < MAX_ROUNDS && marked.size > 0; round++) {
        const roundStart = Date.now();

        markedHistoryPreTrim.push(new Set(marked));

        // Trim to bound per-round work — but NOT by raw arrival time alone.
        // Plain "earliest τ first" systematically discards long-distance trunk
        // routes in favor of numerous nearby local stops, since a train/bus
        // heading toward a far destination naturally has a LATER τ than dozens
        // of quick local hops reached in the same round — even though it's the
        // stop that's actually making progress. Score with an A*-style
        // heuristic instead: τ + estimated remaining time to destination. This
        // protects geographically-progressing stops from being pruned away.
        //
        // That heuristic alone still has a gap: a stop can be genuinely close
        // to the destination (small remainingSec) but have a LATE tau (e.g.
        // reached only after a long, roundabout first leg) — its combined
        // score can still lose to plenty of nearer-in-time-but-wrong-direction
        // stops, discarding it even though it's the one stop that actually
        // connects to the final local service. Reserve a fixed slice of the
        // trim budget for the stops nearest the destination BY DISTANCE ALONE
        // (ignoring tau), so a correct-but-late-arriving connector always
        // survives into the next round instead of being silently dropped —
        // this was the actual cause of a Mornington -> Clayton search failing
        // at the very last local-bus connection despite a valid, boardable
        // departure existing for it.
        // Provably-safe pruning: once any candidate journey to the
        // destination is known, drop any marked stop that cannot possibly
        // beat it (tau + optimistic remaining time already exceeds the best
        // confirmed arrival). Runs BEFORE the heuristic trim below so it
        // shrinks `marked` for free in the common case and reduces how much
        // work that trim's own protection logic has to do.
        if (bestDestArrivalSec < INF) {
            marked = new Set([...marked].filter(key => {
                const s = index.stopsByKey.get(key);
                if (!s) return true; // don't drop on missing data, just skip pruning it
                const tauS = tau.get(key) ?? INF;
                const lowerBoundRemaining = haversineMeters(destination, {
                    lat: s.stop_lat,
                    lon: s.stop_lon
                }) / ASSUMED_TRANSIT_SPEED_MPS;
                return tauS + lowerBoundRemaining <= bestDestArrivalSec;
            }));
        }

        if (marked.size > BEST_MARKED_CAP) {
            // Two layers of protection, tried in order of confidence:
            //
            // 1. Stops BFS itself confirmed are part of a verified seed path
            //    (index.debugSeedPaths — see corridorResolver.ts/seedRouteBfs.ts).
            //    This isn't a heuristic guess: coarseGraph's BFS already
            //    proved these specific stops connect via some existing
            //    pattern. Discarding one of them here would throw away a
            //    known-good link in the route, not just a plausible one — so
            //    they're exempt from trimming outright, independent of score.
            // 2. A distance-based fallback (nearest-to-destination stops,
            //    ignoring tau) for anything the seed paths don't cover — a
            //    correct-but-late-arriving connector (e.g. a local bus
            //    reached only after a long first leg) can still lose to
            //    nearer-in-time-but-wrong-direction stops on tau score alone.
            //
            // This was the actual cause of a Mornington -> Clayton search
            // failing at the very last local-bus connection: the trim (score
            // = tau + remaining distance) discarded the one stop with a
            // valid, boardable departure for the final leg, and neither
            // layer existed before this fix.
            const seedPathStopKeys = new Set<StopKey>();
            for (const path of index.debugSeedPaths) {
                for (const stopKey of path) seedPathStopKeys.add(stopKey as StopKey);
            }
            const seedProtected = new Set([...marked].filter(key => seedPathStopKeys.has(key)));

            const PROTECTED_NEAREST_DEST = Math.floor(BEST_MARKED_CAP * 0.25);
            const remainingForDistanceProtection = [...marked].filter(key => !seedProtected.has(key));
            const byDistance = remainingForDistanceProtection.map(key => {
                const s = index.stopsByKey.get(key);
                const d = s ? haversineMeters(destination, {lat: s.stop_lat, lon: s.stop_lon}) : Infinity;
                return {key, d};
            }).sort((a, b) => a.d - b.d).slice(0, PROTECTED_NEAREST_DEST);
            const distanceProtected = new Set(byDistance.map(x => x.key));

            const protectedKeys = new Set([...seedProtected, ...distanceProtected]);

            const scored = [...marked].filter(key => !protectedKeys.has(key)).map(key => {
                const tauS = tau.get(key) ?? INF;
                const s = index.stopsByKey.get(key);
                const remainingSec = s
                    ? haversineMeters(destination, {lat: s.stop_lat, lon: s.stop_lon}) / ASSUMED_TRANSIT_SPEED_MPS
                    : 0;
                return {key, score: tauS + remainingSec};
            });
            scored.sort((a, b) => a.score - b.score);
            const remainingBudget = Math.max(0, BEST_MARKED_CAP - protectedKeys.size);
            marked = new Set([...protectedKeys, ...scored.slice(0, remainingBudget).map(x => x.key)]);
        }

        // Snapshot AFTER trimming — this needs to reflect the stops actually
        // used for boarding this round, not whatever entered the round before
        // trimming. Snapshotting pre-trim (as an earlier version of this
        // diagnostic did) gave false "reachable" positives: a stop could show
        // up as "marked in round N" while having actually been discarded by
        // the trim above and never processed at all.
        markedHistory.push(new Set(marked));

        const newlyMarked = new Set<StopKey>();

        // For each marked stop, find every pattern serving it — O(marked
        // stops) lookup against the reverse index built once above, instead
        // of re-scanning every candidate pattern's every stop on every round.
        const patternsAtStop = new Map<StopKey, Array<{ patternKey: string; seq: number }>>();
        for (const sk of marked) {
            const patterns = patternsByStop.get(sk);
            if (patterns) patternsAtStop.set(sk, patterns);
        }

        // Group by pattern: which marked stops board it, and at what τ.
        const boardingsByPattern = new Map<string, Array<{ stopKey: StopKey; seq: number; tauAtStop: number }>>();
        for (const [stopKey, patterns] of patternsAtStop) {
            const tauAtStop = tau.get(stopKey) ?? INF;
            if (tauAtStop === INF) continue;
            for (const {patternKey, seq} of patterns) {
                if (!boardingsByPattern.has(patternKey)) boardingsByPattern.set(patternKey, []);
                boardingsByPattern.get(patternKey)!.push({stopKey, seq, tauAtStop});
            }
        }

        if (boardingsByPattern.size === 0) break;

        // For each pattern, pick the earliest boardable trip (binary search per
        // candidate boarding stop using pre-sorted stopTimesByStop), then ride
        // it forward updating τ at every downstream stop.
        for (const [patternKey, boardings] of boardingsByPattern) {
            const {id: patternIdOnly} = parseKey(patternKey); // real pattern_id, colons intact

            let bestTripId: string | null = null;
            let bestBoardKey: StopKey = '';
            let bestBoardSeq = -1;
            let bestDepartSec = INF;

            // IMPORTANT: pick the boarding candidate with the LOWEST stop_sequence
            // first, not the one with the earliest raw departure time. A loop or
            // bidirectional pattern can have two marked stops at wildly different
            // points in its stop_sequence — e.g. one just past where you're trying
            // to go (high seq) and one genuinely upstream of it (low seq). If the
            // downstream one happens to have an earlier next-departure, picking
            // "earliest departure overall" boards there — and riding forward from
            // a high seq can structurally never reach a lower-seq destination
            // stop, silently discarding the one boarding that would have worked.
            // Scanning candidates in ascending stop_sequence order and taking the
            // FIRST one that yields a valid trip guarantees bestBoardSeq is always
            // the lowest usable sequence number, so "ride forward" always has a
            // real destination ahead of it, not behind it.
            boardings.sort((a, b) => a.seq - b.seq);

            for (const b of boardings) {
                const entries = index.stopTimesByStop.get(b.stopKey);
                if (!entries || entries.length === 0) continue;

                const idx = earliestDepartureIndex(entries, b.tauAtStop);
                if (idx >= entries.length) continue;

                // Only consider entries belonging to this pattern (a stop can be
                // served by multiple patterns; stopTimesByStop mixes them).
                for (let i = idx; i < entries.length; i++) {
                    const e = entries[i];
                    if (e.pattern_id !== patternIdOnly) continue;
                    // First valid boarding found, in ascending-sequence order, wins —
                    // do NOT keep scanning later (higher-seq) candidates for an
                    // earlier raw departure time; that's exactly the comparison
                    // that caused the wrong-direction boarding bug above.
                    bestDepartSec = e.departure_sec;
                    bestTripId = e.trip_id;
                    bestBoardKey = b.stopKey;
                    bestBoardSeq = e.stop_sequence;
                    break; // entries sorted by time; first pattern match at/after idx is earliest for this stop
                }
                if (bestTripId) break; // lowest-sequence candidate with a valid trip found — stop scanning
            }

            if (!bestTripId) continue;

            // Ride the selected trip forward from bestBoardSeq. Uses the
            // trip-indexed map (O(1) per stop) instead of a linear .find()
            // over each stop's entries — with high marked-stop counts this
            // was previously the dominant cost of each RAPTOR round.
            const patternStopSeq = index.patternStops.get(patternKey);
            if (!patternStopSeq) continue;
            const agency = parseKey(patternKey).agency;

            let scanning = false;
            for (const ps of patternStopSeq) {
                if (ps.stop_sequence < bestBoardSeq) continue;
                if (ps.stop_sequence === bestBoardSeq) {
                    scanning = true;
                    continue;
                }
                if (!scanning) continue;

                const stopKey = keyOf(ps.stop_id, agency);
                const tripMap = index.stopTimesByStopAndTrip.get(stopKey);
                if (!tripMap) continue;

                const match = tripMap.get(bestTripId);
                if (!match || match.stop_sequence !== ps.stop_sequence) continue;

                const currentBest = tau.get(stopKey) ?? INF;
                if (match.arrival_sec < currentBest) {
                    tau.set(stopKey, match.arrival_sec);
                    parent.set(stopKey, {
                        type: 'transit', tripId: bestTripId, patternId: patternIdOnly,
                        agency, boardKey: bestBoardKey, boardSeq: bestBoardSeq, alightSeq: ps.stop_sequence,
                    });
                    transfersUsed.set(stopKey, (transfersUsed.get(bestBoardKey) ?? 0) + 1);
                    walkSoFar.set(stopKey, walkSoFar.get(bestBoardKey) ?? 0);
                    newlyMarked.add(stopKey);
                }
            }
        }

        // ── Footpath relaxation for newly reached stops ───────────────────────
        if (newlyMarked.size > 0) {
            for (const key of [...newlyMarked]) {
                const {agency, id: stopId} = parseKey(key);
                const stop = index.stopsByKey.get(key);
                if (!stop) continue;
                const tauS = tau.get(key) ?? INF;
                if (tauS === INF) continue;

                for (const other of nearbyForFootpath(stop.stop_lat, stop.stop_lon)) {
                    if (other.stop_id === stopId && other.agency === agency) continue;

                    const distM = haversineMeters(
                        {latitude: stop.stop_lat, longitude: stop.stop_lon},
                        {lat: other.stop_lat, lon: other.stop_lon},
                    );
                    if (distM > xferRadius) continue;

                    const nKey = keyOf(other.stop_id, other.agency);
                    const arrAtN = tauS + walkTimeSec(distM, walkingSpeedMps);
                    const currentBest = tau.get(nKey) ?? INF;
                    if (arrAtN < currentBest) {
                        tau.set(nKey, arrAtN);
                        parent.set(nKey, {type: 'footpath', fromKey: key, distM});
                        transfersUsed.set(nKey, transfersUsed.get(key) ?? 0);
                        walkSoFar.set(nKey, (walkSoFar.get(key) ?? 0) + distM);
                        newlyMarked.add(nKey);
                    }
                }
            }
        }

        for (const key of newlyMarked) tryRecordDestination(key);
        updateBestDestArrival();

        marked = newlyMarked;
        let closestToDestM = Infinity;
        for (const key of marked) {
            const s = index.stopsByKey.get(key);
            if (!s) continue;
            const d = haversineMeters(destination, {lat: s.stop_lat, lon: s.stop_lon});
            if (d < closestToDestM) closestToDestM = d;
        }
        if (debugMode) {
            const coords: LatLng[] = [];
            for (const key of marked) {
                const s = index.stopsByKey.get(key);
                if (s) coords.push({latitude: s.stop_lat, longitude: s.stop_lon});
            }
            debugRoundMarkedStops.push(coords);
        }
        console.log(`[gtfsRoute] round ${round}: ${Date.now() - roundStart}ms (marked=${marked.size}, closestToDestination=${Math.round(closestToDestM)}m)`);
    }
    t = Date.now();

    lap('RAPTOR rounds total');

    if (candidates.length === 0) {
        const oNames = originNearby.slice(0, 3).map(x => x.s.stop_name).join(', ');
        const dNames = destNearby.slice(0, 3).map(x => x.s.stop_name).join(', ');

        // Diagnostic: how close did the search actually get to any destination
        // stop, even if it never fully reached one? This distinguishes three
        // failure modes: (a) search reached NO destination-area stop at all,
        // (b) search reached a destination stop's general AREA but tau is
        // still undefined (never touched by a marked round — likely time-
        // window cutoff), or (c) some destKeyMap stop DOES have a tau, meaning
        // a candidate should have been recorded — which would point at a bug
        // in tryRecordDestination itself.
        let closestDistM = Infinity;
        let closestStopName = '';
        let anyDestStopTouched = false;
        for (const [dKey, distM] of destKeyMap) {
            if (tau.has(dKey)) {
                anyDestStopTouched = true;
                if (distM < closestDistM) {
                    closestDistM = distM;
                    const s = index.stopsByKey.get(dKey);
                    closestStopName = s?.stop_name ?? dKey;
                }
            }
        }

        // Case (a) diagnostic in detail: for each near-destination stop, is
        // there ANY pattern that physically serves it among the patterns
        // gtfsLoader actually loaded (index.patternStops — already scoped to
        // "in the corridor AND active today")? If yes, that pattern has stop
        // sequence data but log whether it also has any loaded stop_times
        // (index.stopTimesByStop) — a pattern can be in patternStops (its
        // stop sequence/geometry) while having zero trips actually running
        // in the search's time window, which looks identical to "no route"
        // from RAPTOR's perspective but has a completely different cause
        // (schedule/time-window vs corridor/pattern-discovery).
        if (!anyDestStopTouched) {
            for (const {s, d} of destNearby.slice(0, 5)) {
                const dKey = keyOf(s.stop_id, s.agency);
                const servingPatterns = patternsByStop.get(dKey) ?? [];
                if (servingPatterns.length === 0) {
                    console.log(`[gtfsRoute]   [DIAGNOSTIC] dest stop "${s.stop_name}" (${Math.round(d)}m from destination point): ` +
                        `NO pattern in the loaded corridor serves this stop at all — corridor/pattern-discovery excluded it.`);
                    continue;
                }
                const patternDetails = servingPatterns.map(({patternKey}) => {
                    const hasStopTimes = index.stopTimesByStop.has(dKey) &&
                        (index.stopTimesByStop.get(dKey) ?? []).some(st => st.pattern_id === parseKey(patternKey).id);
                    if (!hasStopTimes) return `${parseKey(patternKey).id} (NO loaded trips in window)`;

                    // This pattern DOES serve the destination stop AND has a
                    // loaded trip today. The alightSeq (destination's own
                    // stop_sequence on this pattern) is needed FIRST, before
                    // picking which marked stop to report — otherwise we
                    // report whichever marked stop happened to appear first
                    // in history order, even if it's downstream of the
                    // destination on a loop route and a genuinely-usable
                    // upstream stop was ALSO marked in some other round.
                    const patternStopSeq = index.patternStops.get(patternKey) ?? [];
                    const patternAgency = parseKey(patternKey).agency;
                    const alightSeqEntry = patternStopSeq.find(ps => keyOf(ps.stop_id, patternAgency) === dKey);
                    const alightSeq = alightSeqEntry?.stop_sequence;

                    // Scan every stop this pattern serves, across every
                    // round's marked history, and split into two buckets:
                    // "upstream" (seq < alightSeq — a legitimate boarding
                    // candidate for reaching the destination) and
                    // "downstream" (seq >= alightSeq — can never reach the
                    // destination by riding forward, regardless of how
                    // boarding-selection logic picks among candidates).
                    // Reporting whichever of these was EVER marked, in
                    // EITHER bucket, tells us definitively whether this is a
                    // "boarding-selection could have worked but didn't" case
                    // or a "the useful half of this pattern was never
                    // reached at all" case — the two look identical from a
                    // single first-marked-stop check, but need completely
                    // different fixes (RAPTOR round-loop bug vs corridor/
                    // BFS reachability gap upstream of this pattern).
                    let bestUpstreamStopName: string | null = null;
                    let bestUpstreamStopKey: StopKey | null = null;
                    let bestUpstreamSeq = Infinity;
                    let bestUpstreamRound = -1;
                    let anyDownstreamMarked = false;
                    let downstreamStopName: string | null = null;
                    let downstreamRound = -1;
                    for (let r = 0; r < markedHistory.length; r++) {
                        for (const ps of patternStopSeq) {
                            const psKey = keyOf(ps.stop_id, patternAgency);
                            if (!markedHistory[r].has(psKey)) continue;
                            const isUpstream = alightSeq !== undefined && ps.stop_sequence < alightSeq;
                            if (isUpstream) {
                                if (ps.stop_sequence < bestUpstreamSeq) {
                                    bestUpstreamSeq = ps.stop_sequence;
                                    bestUpstreamStopKey = psKey;
                                    bestUpstreamStopName = index.stopsByKey.get(psKey)?.stop_name ?? psKey;
                                    bestUpstreamRound = r;
                                }
                            } else if (!anyDownstreamMarked) {
                                anyDownstreamMarked = true;
                                downstreamStopName = index.stopsByKey.get(psKey)?.stop_name ?? psKey;
                                downstreamRound = r;
                            }
                        }
                    }

                    // If no upstream stop was ever marked POST-trim, check
                    // whether one existed PRE-trim — i.e. RAPTOR's search
                    // actually reached it, but the BEST_MARKED_CAP trim cut
                    // it before it could be used for boarding. This is a
                    // completely different fix (protection logic) than a
                    // genuine corridor/BFS reachability gap.
                    let trimmedAwayStopName: string | null = null;
                    let trimmedAwayRound = -1;
                    let trimmedAwaySeq = -1;
                    if (!bestUpstreamStopKey) {
                        outerPreTrim:
                            for (let r = 0; r < markedHistoryPreTrim.length; r++) {
                                for (const ps of patternStopSeq) {
                                    if (alightSeq === undefined || ps.stop_sequence >= alightSeq) continue;
                                    const psKey = keyOf(ps.stop_id, patternAgency);
                                    if (markedHistoryPreTrim[r].has(psKey) && !markedHistory[r].has(psKey)) {
                                        trimmedAwayStopName = index.stopsByKey.get(psKey)?.stop_name ?? psKey;
                                        trimmedAwayRound = r;
                                        trimmedAwaySeq = ps.stop_sequence;
                                        break outerPreTrim;
                                    }
                                }
                            }
                    }

                    if (!bestUpstreamStopKey && !anyDownstreamMarked && !trimmedAwayStopName) {
                        return `${parseKey(patternKey).id} (NEVER marked at any of its ${patternStopSeq.length} stops in any round, pre- or post-trim — this pattern's own boarding point was never reached; corridor/topology gap upstream of it)`;
                    }
                    if (!bestUpstreamStopKey && trimmedAwayStopName) {
                        return `${parseKey(patternKey).id} (upstream stop "${trimmedAwayStopName}" (seq ${trimmedAwaySeq}) WAS reached pre-trim in round ${trimmedAwayRound} but was DISCARDED by the BEST_MARKED_CAP trim before boarding could use it — this is a trim/protection bug, not a corridor gap)`;
                    }
                    if (!bestUpstreamStopKey) {
                        // Only downstream (post-destination) stops were ever
                        // marked — the genuinely useful, upstream-of-
                        // destination portion of this pattern was NEVER
                        // reached by any round. This is a reachability gap
                        // (corridor/BFS/transfer-budget), not a boarding-
                        // selection bug — no amount of re-ordering boarding
                        // candidates helps if the right candidate never
                        // existed in `marked` in the first place.
                        return `${parseKey(patternKey).id} (only DOWNSTREAM stop "${downstreamStopName}" (round ${downstreamRound}) was ever marked — the upstream-of-destination half of this pattern (seq < ${alightSeq}) was NEVER reached by any round, pre- or post-trim; this is a corridor/reachability gap, not a boarding-selection bug)`;
                    }

                    // A genuinely usable upstream stop WAS marked at some
                    // point — replay the EXACT boarding check RAPTOR itself
                    // does at that stop, for this pattern (same call —
                    // earliestDepartureIndex + pattern_id match — the main
                    // loop uses), to tell whether the miss is "no boardable
                    // departure existed" (real schedule/timing gap) vs "one
                    // existed and RAPTOR still didn't board it" (a genuine
                    // remaining bug in the round loop, e.g. this candidate
                    // got trimmed out of `marked` before its own round ran).
                    const boardKey = bestUpstreamStopKey;
                    const tauAtBoard = tau.get(boardKey);
                    const entries = index.stopTimesByStop.get(boardKey) ?? [];
                    const everMarkedStopName = bestUpstreamStopName;
                    const everMarkedRound = bestUpstreamRound;
                    const boardSeq = bestUpstreamSeq;

                    if (boardSeq !== undefined && alightSeq !== undefined && boardSeq >= alightSeq) {
                        return `${parseKey(patternKey).id} (STRUCTURAL: board stop's sequence=${boardSeq} is NOT before ` +
                            `destination stop's sequence=${alightSeq} on this pattern — this is a loop/direction issue, ` +
                            `not a marking or trimming bug. Need to board this pattern at an EARLIER stop, before ` +
                            `sequence ${alightSeq}, not at "${everMarkedStopName}".)`;
                    }

                    let replayResult: string;
                    if (tauAtBoard === undefined) {
                        replayResult = 'tau at that stop is now undefined (overwritten/cleared after the round it was marked in) — cannot replay';
                    } else {
                        const idx = earliestDepartureIndex(entries, tauAtBoard);
                        const match = entries.slice(idx).find(e => e.pattern_id === parseKey(patternKey).id);
                        replayResult = match
                            ? `a boardable departure DOES exist (trip ${match.trip_id} at ${formatSec(match.departure_sec)}) — this is a genuine RAPTOR boarding-logic bug, not a data/schedule gap`
                            : `NO entry for this pattern departs at/after tau=${formatSec(tauAtBoard)} at that stop (last entries there: ${entries.slice(-3).map(e => `${e.pattern_id}@${formatSec(e.departure_sec)}`).join(', ') || 'none loaded'}) — likely arrived too late for this pattern's remaining trips today`;
                    }
                    return `${parseKey(patternKey).id} (marked at "${everMarkedStopName}" in round ${everMarkedRound}; replay: ${replayResult})`;
                }).join(', ');
                console.log(`[gtfsRoute]   [DIAGNOSTIC] dest stop "${s.stop_name}" (${Math.round(d)}m from destination point): ` +
                    `served by pattern(s) [${patternDetails}] — if all say "NO loaded trips," the corridor is right but ` +
                    `those patterns aren't active/scheduled in this search's window; if patterns are listed WITHOUT that ` +
                    `suffix, the failure is inside RAPTOR's boarding/riding logic, not corridor scoping.`);
            }
        }

        console.log(
            `[gtfsRoute] search failure diagnostic: anyDestStopTouched=${anyDestStopTouched}` +
            (anyDestStopTouched ? `, closest touched dest stop="${closestStopName}" (${Math.round(closestDistM)}m from destination point)` : ', NO destination-area stop was ever reached by RAPTOR — see per-stop DIAGNOSTIC lines above for the specific cause.'),
        );

        throw new Error(`No route found within ${MAX_ROUNDS} transfers.\nNear origin: ${oNames}\nNear destination: ${dNames}`);
    }

    // ── DIAGNOSTIC: log every pre-Pareto candidate's actual route sequence ──
    // Answers "was an alternative (e.g. a train leg) ever found and then
    // correctly dominated, or did it never get discovered at all" — those
    // are very different bugs (one is a Pareto/RAPTOR outcome working as
    // intended, the other is a corridor/BFS gap) and this is the only way
    // to tell them apart from the outside. Walks the SAME `parent` chain
    // reconstructPath() uses below, just to pull route names instead of
    // building full segments — cheap (≤ MAX_ROUNDS hops per candidate) and
    // only runs for the handful of destination candidates that exist by
    // this point, not the whole search.
    for (const c of candidates) {
        const routeSeq: string[] = [];
        let cur: StopKey | undefined = c.destKey;
        let guard = 0;
        while (cur !== undefined && guard++ < MAX_ROUNDS + 2) {
            const p = parent.get(cur);
            if (!p) break;
            if (p.type === 'transit') {
                const meta = index.patternsByKey.get(makeKey(p.agency, p.patternId));
                routeSeq.unshift(meta ? `${meta.route_name} (${meta.pattern_id})` : p.patternId);
                cur = p.boardKey;
            } else if (p.type === 'footpath') {
                routeSeq.unshift('walk');
                cur = p.fromKey;
            } else {
                cur = undefined; // origin-walk — chain ends here
            }
        }
        console.log(`[gtfsRoute]   [DIAGNOSTIC] candidate: arrival=${formatSec(c.arrivalSec)}, ` +
            `walk=${Math.round(c.totalWalkM)}m, transfers=${c.transfers}, route=[${routeSeq.join(' -> ')}]`);
    }

    // ── Reduce to non-dominated set (Pareto frontier on arrival/walk/transfers) ─
    const nonDominated = candidates.filter((c, i) =>
        !candidates.some((o, j) =>
            j !== i &&
            o.arrivalSec <= c.arrivalSec &&
            o.totalWalkM <= c.totalWalkM &&
            o.transfers <= c.transfers &&
            (o.arrivalSec < c.arrivalSec || o.totalWalkM < c.totalWalkM || o.transfers < c.transfers)
        )
    );
    lap(`Pareto filter (${candidates.length} candidates -> ${nonDominated.length} kept)`);

    // ── Load shapes only for patterns the surviving journeys actually use ──
    // reconstructPath (below) reads index.shapePoints, but until now nothing
    // has populated it — gtfsLoader defers shape loading entirely (see
    // loadShapesForShapeIds there). We collect the pattern keys used by just
    // the ≤ a few kept journeys (not all ~1000+ candidate patterns) and load
    // those specific shape_ids, then mutate index.shapePoints in place before
    // reconstructing paths.
    const usedPatternKeys = new Set<string>();
    for (const c of nonDominated) {
        let cur = c.destKey;
        while (true) {
            const p = parent.get(cur);
            if (!p) break;
            if (p.type === 'transit') {
                usedPatternKeys.add(makeKey(p.agency, p.patternId));
                cur = p.boardKey;
            } else if (p.type === 'footpath') {
                cur = p.fromKey;
            } else {
                break; // origin-walk — chain terminates
            }
        }
    }
    const neededShapeIds = [...usedPatternKeys]
        .map(k => index.patternsByKey.get(k))
        .filter((p): p is NonNullable<typeof p> => !!p?.shape_id)
        .map(p => ({shape_id: p.shape_id as string, agency: p.agency}));
    const loadedShapes = await loadShapesForShapeIds(neededShapeIds);
    for (const [key, pts] of loadedShapes) index.shapePoints.set(key, pts);
    lap(`shapes for kept journeys (${usedPatternKeys.size} patterns, ${loadedShapes.size} shapes)`);

    // Reconstruct full path for each surviving candidate.
    const journeys: GtfsJourney[] = [];
    for (const c of nonDominated) {
        journeys.push(reconstructPath(
            index, origin, destination, c.destKey, c.finalWalkM, c.arrivalSec, departSec, parent, walkingSpeedMps,
        ));
    }
    journeys.sort((a, b) => a.arrivalTime.localeCompare(b.arrivalTime));
    lap(`path reconstruction (${journeys.length} journeys)`);

    let debug: GtfsDebugInfo | undefined;
    if (debugMode) {
        // corridorStopIds is now keyed the same way stopsByKey is
        // (agency-qualified, via makeKey) — tightened alongside
        // corridorResolver.ts/corridorTagging.ts to remove a cross-agency
        // stop_id collision risk. Same convention as the corridorStops
        // filter earlier in this function.
        const corridorStops: LatLng[] = index.allStops
            .filter(s => index.corridorStopIds.has(makeKey(s.agency, s.stop_id)))
            .map(s => ({latitude: s.stop_lat, longitude: s.stop_lon}));
        const seedPaths: LatLng[][] = index.debugSeedPaths.map(path =>
            path.map(key => {
                const s = index.stopsByKey.get(key); // seed path keys ARE composite (from coarseGraph)
                return s ? {latitude: s.stop_lat, longitude: s.stop_lon} : null;
            }).filter((p): p is LatLng => p !== null),
        );
        const bfsLevels: LatLng[][] = index.debugBfsLevels.map(level =>
            level.map(key => {
                const s = index.stopsByKey.get(key);
                return s ? {latitude: s.stop_lat, longitude: s.stop_lon} : null;
            }).filter((p): p is LatLng => p !== null),
        );
        const bfsTreeEdges = index.debugBfsTreeEdges.map(([fromKey, toKey]) => {
            const fromStop = index.stopsByKey.get(fromKey);
            const toStop = index.stopsByKey.get(toKey);
            if (!fromStop || !toStop) return null;
            return {
                from: {latitude: fromStop.stop_lat, longitude: fromStop.stop_lon},
                to: {latitude: toStop.stop_lat, longitude: toStop.stop_lon},
            };
        }).filter((e): e is { from: LatLng; to: LatLng } => e !== null);
        // lat/lon -> latitude/longitude naming convention swap only; no
        // computation happens here, corridorTagging.ts already did the work.
        const corridorBoundary = index.debugCorridorBoundary.map(b => ({
            left: b.left.map(p => ({latitude: p.lat, longitude: p.lon})),
            right: b.right.map(p => ({latitude: p.lat, longitude: p.lon})),
        }));
        const walkRadiusCircles = [
            {center: origin, radiusMeters: index.debugWalkRadiusM},
            {center: destination, radiusMeters: index.debugWalkRadiusM},
        ];
        debug = {
            corridorStops,
            seedPaths,
            bfsLevels,
            bfsTreeEdges,
            roundMarkedStops: debugRoundMarkedStops,
            corridorBoundary,
            walkRadiusCircles
        };
        lap(`debug payload assembled (${corridorStops.length} corridor stops, ${seedPaths.length} seed paths, ${bfsLevels.length} BFS levels, ${debugRoundMarkedStops.length} rounds, ${corridorBoundary.length} corridor boundaries)`);
    }

    console.log(`[gtfsRoute] post-load search time: ${Date.now() - tStart}ms | TRUE total (incl. load): ${Date.now() - overallStart}ms`);

    return {journeys, debug};
}

// ─────────────────────────────────────────────────────────────────────────────
// Path reconstruction
// ─────────────────────────────────────────────────────────────────────────────

function reconstructPath(
    index: GtfsIndex,
    origin: LatLng,
    destination: LatLng,
    destKey: StopKey,
    finalWalkM: number,
    arrivalSec: number,
    departureSec: number,
    parent: Map<StopKey, ParentInfo>,
    walkingSpeedMps: number,
): GtfsJourney {
    type Step =
        | { type: 'origin-walk'; toKey: StopKey; originWalkM: number }
        | { type: 'footpath'; fromKey: StopKey; fpToKey: StopKey; footpathM: number }
        | {
        type: 'transit'; tripId: string; patternId: string; agency: number;
        boardKey: StopKey; alightKey: StopKey; boardSeq: number; alightSeq: number
    };

    const steps: Step[] = [];
    let cur = destKey;

    while (true) {
        const p = parent.get(cur);
        if (!p) break;
        if (p.type === 'origin-walk') {
            steps.push({type: 'origin-walk', toKey: cur, originWalkM: p.distM});
            break;
        } else if (p.type === 'transit') {
            steps.push({
                type: 'transit', tripId: p.tripId, patternId: p.patternId, agency: p.agency,
                boardKey: p.boardKey, alightKey: cur, boardSeq: p.boardSeq, alightSeq: p.alightSeq,
            });
            cur = p.boardKey;
        } else {
            steps.push({type: 'footpath', fromKey: p.fromKey, fpToKey: cur, footpathM: p.distM});
            cur = p.fromKey;
        }
    }
    steps.reverse();

    const segments: RouteSegment[] = [];
    const legs: GtfsJourney['legs'] = [];
    const allCoords: LatLng[] = [origin];
    let transferStopName: string | undefined;
    let totalWalkingMeters = 0;
    let transferCount = 0;

    const walkSegment = (from: LatLng, to: LatLng, fromName: string, toName: string, distM: number): RouteSegment => ({
        coords: [from, to],
        routeName: `Walk (~${Math.max(1, Math.round(walkTimeMin(distM, walkingSpeedMps)))} min)`,
        routeType: -1, routeColor: '#666666', routeTextColor: '#FFFFFF',
        originStopName: fromName, destStopName: toName, type: 'walk',
    });

    for (const step of steps) {
        if (step.type === 'origin-walk') {
            const toStop = index.stopsByKey.get(step.toKey)!;
            const toLL = {latitude: toStop.stop_lat, longitude: toStop.stop_lon};
            if (step.originWalkM > 1) {
                segments.push(walkSegment(origin, toLL, 'Your location', toStop.stop_name, step.originWalkM));
                allCoords.push(toLL);
                totalWalkingMeters += step.originWalkM;
            }
            continue;
        }

        if (step.type === 'footpath') {
            const from = index.stopsByKey.get(step.fromKey)!;
            const to = index.stopsByKey.get(step.fpToKey)!;
            const fromLL = {latitude: from.stop_lat, longitude: from.stop_lon};
            const toLL = {latitude: to.stop_lat, longitude: to.stop_lon};
            const walkMin = Math.max(1, Math.round(walkTimeMin(step.footpathM, walkingSpeedMps)));
            transferStopName = from.stop_name === to.stop_name
                ? from.stop_name
                : `${from.stop_name} → ${to.stop_name} (~${walkMin} min walk)`;
            if (step.footpathM > 1) {
                segments.push(walkSegment(fromLL, toLL, from.stop_name, to.stop_name, step.footpathM));
                allCoords.push(toLL);
                totalWalkingMeters += step.footpathM;
            }
            continue;
        }

        // transit
        const {tripId, patternId, agency, boardKey, alightKey, boardSeq, alightSeq} = step;
        const boardStop = index.stopsByKey.get(boardKey)!;
        const alightStop = index.stopsByKey.get(alightKey)!;
        const patMeta = index.patternsByKey.get(makeKey(agency, patternId));

        const routeName = patMeta?.route_name ?? '?';
        const routeType = patMeta?.route_type ?? 3;
        const routeColor = resolveRouteColor(patMeta?.route_color, routeType, routeName);
        const routeTextColor = resolveTextColor(patMeta?.route_text_color);

        const boardEntry = index.stopTimesByStopAndTrip.get(boardKey)?.get(tripId);
        const alightEntry = index.stopTimesByStopAndTrip.get(alightKey)?.get(tripId);

        const departTimeStr = boardEntry ? formatSec(boardEntry.departure_sec) : undefined;
        const arriveTimeStr = alightEntry ? formatSec(alightEntry.arrival_sec) : undefined;

        let coords: LatLng[] = [];
        if (patMeta?.shape_id) {
            const shapeKey = makeKey(agency, patMeta.shape_id);
            const pts = index.shapePoints.get(shapeKey);
            if (pts && pts.length > 1) {
                // Trim the full shape polyline down to the board->alight segment by
                // finding the nearest shape point to each stop and slicing between
                // them. Without this, the whole route's shape gets drawn regardless
                // of where the rider actually boards/alights.
                const nearestIndex = (target: { latitude: number; longitude: number }) => {
                    let bestIdx = 0, bestDist = Infinity;
                    for (let i = 0; i < pts.length; i++) {
                        const d = haversineMeters(target, {lat: pts[i].latitude, lon: pts[i].longitude});
                        if (d < bestDist) {
                            bestDist = d;
                            bestIdx = i;
                        }
                    }
                    return bestIdx;
                };
                const boardLL = {latitude: boardStop.stop_lat, longitude: boardStop.stop_lon};
                const alightLL = {latitude: alightStop.stop_lat, longitude: alightStop.stop_lon};
                const startIdx = nearestIndex(boardLL);
                const endIdx = nearestIndex(alightLL);
                const lo = Math.min(startIdx, endIdx);
                const hi = Math.max(startIdx, endIdx);
                coords = pts.slice(lo, hi + 1);
            }
        }
        if (coords.length === 0) {
            const seqList = index.patternStops.get(makeKey(agency, patternId)) ?? [];
            const lo = Math.min(boardSeq, alightSeq), hi = Math.max(boardSeq, alightSeq);
            coords = seqList
                .filter(s => s.stop_sequence >= lo && s.stop_sequence <= hi)
                .map(s => {
                    const st = index.stopsByKey.get(keyOf(s.stop_id, agency));
                    return st ? {latitude: st.stop_lat, longitude: st.stop_lon} : null;
                })
                .filter((x): x is LatLng => x !== null);
        }
        if (coords.length === 0) {
            coords = [
                {latitude: boardStop.stop_lat, longitude: boardStop.stop_lon},
                {latitude: alightStop.stop_lat, longitude: alightStop.stop_lon},
            ];
        }

        segments.push({
            coords, routeName, routeType, routeColor, routeTextColor,
            originStopName: boardStop.stop_name, destStopName: alightStop.stop_name,
            type: 'transit', departureTime: departTimeStr, arrivalTime: arriveTimeStr,
        });
        legs.push({
            routeName, routeType, routeColor, routeTextColor,
            originStopName: boardStop.stop_name, destStopName: alightStop.stop_name,
            departureTime: departTimeStr, arrivalTime: arriveTimeStr,
        });

        for (const c of coords) allCoords.push(c);
        allCoords.push({latitude: alightStop.stop_lat, longitude: alightStop.stop_lon});
        transferCount++;
    }

    const destStop = index.stopsByKey.get(destKey)!;
    const destStopLL = {latitude: destStop.stop_lat, longitude: destStop.stop_lon};
    if (finalWalkM > 1) {
        segments.push(walkSegment(destStopLL, destination, destStop.stop_name, 'Your destination', finalWalkM));
        allCoords.push(destination);
        totalWalkingMeters += finalWalkM;
    }

    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    return {
        coords: allCoords,
        segments,
        legs,
        routeName: legs.length <= 1 ? (legs[0]?.routeName ?? '') : legs.map(l => l.routeName).join(' → '),
        routeType: firstLeg?.routeType ?? -1,
        routeColor: firstLeg?.routeColor,
        routeTextColor: firstLeg?.routeTextColor,
        originStopName: firstLeg?.originStopName ?? '',
        destStopName: lastLeg?.destStopName ?? '',
        transferStopName,
        totalDurationMin: Math.round((arrivalSec - departureSec) / 60),
        totalWalkingMeters: Math.round(totalWalkingMeters),
        transferCount: Math.max(0, transferCount - 1), // legs - 1 = actual transfers between vehicles
        departureTime: formatSec(departureSec),
        arrivalTime: formatSec(arrivalSec),
    };
}