/**
 * gtfsRoute.ts — In-memory McRAPTOR (multi-criteria RAPTOR) transit router.
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
 * Ellipse pre-filter: before RAPTOR starts, stops whose combined distance from
 * origin + destination exceeds (straight-line origin→destination distance ×
 * margin) are excluded from consideration entirely. This is a needle-nose
 * ellipse with origin/destination as foci — computed with two haversine calls
 * and one comparison per stop, no trigonometry needed. It keeps every round's
 * candidate set roughly proportional to the journey's geographic footprint
 * instead of the whole network.
 */

import type { LatLng } from './gtfsDb';
import { loadGtfsIndexForTrip, type GtfsIndex, type StopTimeEntry } from './gtfsLoader';
import { fallbackRouteColor } from './routeTypeUtil';
import { makeKey, parseKey } from './gtfsKeyUtil';

// ─────────────────────────────────────────────────────────────────────────────
// Walking speed presets (m/s)
// ─────────────────────────────────────────────────────────────────────────────

export const WALK_SPEED_MPS = {
    SLOW:   0.8,
    NORMAL: 1.4,
    FAST:   1.8,
    JOG:    2.5,
    RUN:    4.0,
    SPRINT: 7.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 5;
const MAX_TRANSFER_WALK_SEC = 20 * 60; // was 7min (only ~588m at normal speed) — too tight for
// real cross-mode transfers (e.g. train station to a bus stop 1.8km away, as seen on Google
// Maps for the Mornington Peninsula trip). 20min covers ~1.68km at normal walking speed.
const NEARBY_STOPS = 50;
const BEST_MARKED_CAP = 400; // was 200 — raised as extra headroom now that trimming is goal-directed (see ASSUMED_TRANSIT_SPEED_MPS below), not just earliest-arrival-first

/**
 * Ellipse detour margin. A stop is considered "in play" if
 *   dist(origin, stop) + dist(stop, destination) <= straightLineDist * ELLIPSE_MARGIN
 * 1.0 = degenerate (only the direct line); higher = more permissive.
 * 1.4–1.6 comfortably absorbs real-world street/river/freeway detours.
 */
const ELLIPSE_BUFFER_RATIO = 0.5;
const ELLIPSE_BUFFER_CAP_M = 8000;
const ELLIPSE_BUFFER_MIN_M = 1500;

/** Below this straight-line distance, skip the ellipse filter entirely — for
 *  short hops the ellipse is nearly the whole search radius anyway, and the
 *  extra per-stop check isn't worth it. */
const ELLIPSE_MIN_DISTANCE_M = 1500;

const INF = Number.MAX_SAFE_INTEGER;

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

function haversineMeters(a: LatLng, b: { lat: number; lon: number }): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.latitude);
    const dLon = toRad(b.lon - a.longitude);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const x = s1 * s1 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.lat)) * s2 * s2;
    return R * 2 * Math.asin(Math.sqrt(x));
}

function walkTimeSec(meters: number, speedMps: number): number { return meters / speedMps; }
function walkTimeMin(meters: number, speedMps: number): number { return meters / speedMps / 60; }
function transferRadiusM(speedMps: number): number { return speedMps * MAX_TRANSFER_WALK_SEC; }
function toSecsMidnight(d: Date): number { return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); }
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
    | { type: 'transit'; tripId: string; patternId: string; agency: number;
    boardKey: StopKey; boardSeq: number; alightSeq: number };

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

export interface GtfsRouteResult {
    journeys: GtfsJourney[]; // sorted by arrival time ascending; caller can re-sort
}

// ─────────────────────────────────────────────────────────────────────────────
// Ellipse pre-filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns stops considered "in play" for this origin→destination pair: those
 * whose combined distance from both endpoints doesn't exceed the straight-line
 * distance by more than ELLIPSE_MARGIN. For short trips the filter is skipped
 * (not worth the pass over all stops when the whole network is already close).
 */
function ellipseFilterStops(
    index: GtfsIndex,
    origin: LatLng,
    destination: LatLng,
): Set<string> /* stop_id (unqualified) */ {
    const straightM = haversineMeters(origin, { lat: destination.latitude, lon: destination.longitude });

    if (straightM < ELLIPSE_MIN_DISTANCE_M) {
        return new Set(index.allStops.map(s => s.stop_id)); // no filtering — everything qualifies
    }

    const buffer = Math.min(Math.max(straightM * ELLIPSE_BUFFER_RATIO, ELLIPSE_BUFFER_MIN_M), ELLIPSE_BUFFER_CAP_M);
    const maxSum = straightM + buffer;
    const allowed = new Set<string>();

    for (const s of index.allStops) {
        const dO = haversineMeters(origin,      { lat: s.stop_lat, lon: s.stop_lon });
        const dD = haversineMeters(destination,  { lat: s.stop_lat, lon: s.stop_lon });
        if (dO + dD <= maxSum) allowed.add(s.stop_id);
    }
    return allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nearest-stops helper (in-memory linear scan — fine at ~20K stops)
// ─────────────────────────────────────────────────────────────────────────────

function nearestStops(index: GtfsIndex, center: LatLng, limit: number, allowedIds: Set<string> | null) {
    const withDist = index.allStops
        .filter(s => !allowedIds || allowedIds.has(s.stop_id))
        .map(s => ({ s, d: haversineMeters(center, { lat: s.stop_lat, lon: s.stop_lon }) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit);
    return withDist;
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
): Promise<GtfsRouteResult> {
    const tStart = Date.now();
    let t = tStart;
    const lap = (label: string) => { console.log(`[gtfsRoute] ${label}: ${Date.now() - t}ms`); t = Date.now(); };

    const index = await loadGtfsIndexForTrip(origin, destination, departureTime);
    lap('loadGtfsIndexForTrip (scoped to this search)');

    const departSec  = toSecsMidnight(departureTime);
    const xferRadius = transferRadiusM(walkingSpeedMps);

    // ── Ellipse pre-filter ────────────────────────────────────────────────────
    const allowedStopIds = ellipseFilterStops(index, origin, destination);
    lap(`ellipse filter (${allowedStopIds.size}/${index.allStops.length} stops kept)`);

    // ── Nearest stops at both ends (within the ellipse) ──────────────────────
    // Pre-filter the stop list to the ellipse ONCE. Footpath relaxation used to
    // iterate index.allStops (the full ~32K-stop network) and check ellipse
    // membership per-element inside the loop — with hundreds of newly-marked
    // stops per round, that was tens of millions of wasted iterations. Scanning
    // this much smaller pre-filtered array directly removes that cost.
    const ellipseStops = index.allStops.filter(s => allowedStopIds.has(s.stop_id));

    const originNearby = nearestStops(index, origin, NEARBY_STOPS, allowedStopIds);
    const destNearby    = nearestStops(index, destination, NEARBY_STOPS, allowedStopIds);
    lap('nearest-stops scan (origin + destination)');

    if (originNearby.length === 0) throw new Error('No stops near your location.');
    if (destNearby.length === 0) throw new Error('No stops near destination.');

    // ── RAPTOR state ──────────────────────────────────────────────────────────
    const tau     = new Map<StopKey, number>();
    const parent  = new Map<StopKey, ParentInfo>();
    const transfersUsed = new Map<StopKey, number>(); // # transit legs taken to reach this stop
    const walkSoFar      = new Map<StopKey, number>(); // cumulative walking metres to reach this stop

    let marked = new Set<StopKey>();
    for (const { s, d } of originNearby) {
        const key = keyOf(s.stop_id, s.agency);
        const arr = departSec + walkTimeSec(d, walkingSpeedMps);
        tau.set(key, arr);
        parent.set(key, { type: 'origin-walk', distM: d });
        transfersUsed.set(key, 0);
        walkSoFar.set(key, d);
        marked.add(key);
    }

    const destKeyMap = new Map<StopKey, number>(); // stopKey -> distance to actual destination point
    for (const { s, d } of destNearby) destKeyMap.set(keyOf(s.stop_id, s.agency), d);

    // Journeys collected at the destination, kept if non-dominated.
    interface Candidate {
        destKey: StopKey; finalWalkM: number; arrivalSec: number;
        totalWalkM: number; transfers: number;
    }
    const candidates: Candidate[] = [];

    function tryRecordDestination(stopKey: StopKey) {
        const distM = destKeyMap.get(stopKey);
        if (distM === undefined) return;
        const tauS = tau.get(stopKey);
        if (tauS === undefined) return;

        const arrivalSec = tauS + walkTimeSec(distM, walkingSpeedMps);
        const totalWalkM = (walkSoFar.get(stopKey) ?? 0) + distM;
        const transfers  = transfersUsed.get(stopKey) ?? 0;

        candidates.push({ destKey: stopKey, finalWalkM: distM, arrivalSec, totalWalkM, transfers });
    }

    // Assumed average transit speed (m/s) used ONLY to estimate remaining
    // travel time for trimming priority — not for actual arrival calculations.
    // ~36km/h accounts for a mix of stop-start suburban travel and faster
    // trunk services; doesn't need to be exact, just needs to roughly rank
    // "closer to destination" above "further from destination".
    const ASSUMED_TRANSIT_SPEED_MPS = 10;

    for (const key of marked) tryRecordDestination(key);
    lap('seed + initial destination check');

    // ── RAPTOR rounds ─────────────────────────────────────────────────────────
    for (let round = 0; round < MAX_ROUNDS && marked.size > 0; round++) {
        const roundStart = Date.now();

        // Trim to bound per-round work — but NOT by raw arrival time alone.
        // Plain "earliest τ first" systematically discards long-distance trunk
        // routes in favor of numerous nearby local stops, since a train/bus
        // heading toward a far destination naturally has a LATER τ than dozens
        // of quick local hops reached in the same round — even though it's the
        // stop that's actually making progress. Score with an A*-style
        // heuristic instead: τ + estimated remaining time to destination. This
        // protects geographically-progressing stops from being pruned away.
        if (marked.size > BEST_MARKED_CAP) {
            const scored = [...marked].map(key => {
                const tauS = tau.get(key) ?? INF;
                const s = index.stopsByKey.get(key);
                const remainingSec = s
                    ? haversineMeters(destination, { lat: s.stop_lat, lon: s.stop_lon }) / ASSUMED_TRANSIT_SPEED_MPS
                    : 0;
                return { key, score: tauS + remainingSec };
            });
            scored.sort((a, b) => a.score - b.score);
            marked = new Set(scored.slice(0, BEST_MARKED_CAP).map(x => x.key));
        }

        const newlyMarked = new Set<StopKey>();

        // For each marked stop, find every pattern serving it (via patternStops
        // reverse lookup — build once per round scoped to marked stops only).
        const patternsAtStop = new Map<StopKey, Array<{ patternKey: string; seq: number }>>();
        for (const [patternKey, seqList] of index.patternStops) {
            const { agency: patAgency } = parseKey(patternKey); // agency-first key, safe regardless of colons in pattern_id
            for (const entry of seqList) {
                const sk = keyOf(entry.stop_id, patAgency);
                if (!marked.has(sk)) continue;
                if (!patternsAtStop.has(sk)) patternsAtStop.set(sk, []);
                patternsAtStop.get(sk)!.push({ patternKey, seq: entry.stop_sequence });
            }
        }

        // Group by pattern: which marked stops board it, and at what τ.
        const boardingsByPattern = new Map<string, Array<{ stopKey: StopKey; seq: number; tauAtStop: number }>>();
        for (const [stopKey, patterns] of patternsAtStop) {
            const tauAtStop = tau.get(stopKey) ?? INF;
            if (tauAtStop === INF) continue;
            for (const { patternKey, seq } of patterns) {
                if (!boardingsByPattern.has(patternKey)) boardingsByPattern.set(patternKey, []);
                boardingsByPattern.get(patternKey)!.push({ stopKey, seq, tauAtStop });
            }
        }

        if (boardingsByPattern.size === 0) break;

        // For each pattern, pick the earliest boardable trip (binary search per
        // candidate boarding stop using pre-sorted stopTimesByStop), then ride
        // it forward updating τ at every downstream stop.
        for (const [patternKey, boardings] of boardingsByPattern) {
            const { id: patternIdOnly } = parseKey(patternKey); // real pattern_id, colons intact

            let bestTripId: string | null = null;
            let bestBoardKey: StopKey = '';
            let bestBoardSeq = -1;
            let bestDepartSec = INF;

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
                    if (e.departure_sec < bestDepartSec) {
                        bestDepartSec = e.departure_sec;
                        bestTripId    = e.trip_id;
                        bestBoardKey  = b.stopKey;
                        bestBoardSeq  = e.stop_sequence;
                    }
                    break; // entries sorted by time; first pattern match at/after idx is earliest for this stop
                }
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
                if (ps.stop_sequence === bestBoardSeq) { scanning = true; continue; }
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
                const { agency, id: stopId } = parseKey(key);
                const stop = index.stopsByKey.get(key);
                if (!stop) continue;
                const tauS = tau.get(key) ?? INF;
                if (tauS === INF) continue;

                for (const other of ellipseStops) {
                    if (other.stop_id === stopId && other.agency === agency) continue;

                    const distM = haversineMeters(
                        { latitude: stop.stop_lat, longitude: stop.stop_lon },
                        { lat: other.stop_lat, lon: other.stop_lon },
                    );
                    if (distM > xferRadius) continue;

                    const nKey = keyOf(other.stop_id, other.agency);
                    const arrAtN = tauS + walkTimeSec(distM, walkingSpeedMps);
                    const currentBest = tau.get(nKey) ?? INF;
                    if (arrAtN < currentBest) {
                        tau.set(nKey, arrAtN);
                        parent.set(nKey, { type: 'footpath', fromKey: key, distM });
                        transfersUsed.set(nKey, transfersUsed.get(key) ?? 0);
                        walkSoFar.set(nKey, (walkSoFar.get(key) ?? 0) + distM);
                        newlyMarked.add(nKey);
                    }
                }
            }
        }

        for (const key of newlyMarked) tryRecordDestination(key);

        marked = newlyMarked;
        let closestToDestM = Infinity;
        for (const key of marked) {
            const s = index.stopsByKey.get(key);
            if (!s) continue;
            const d = haversineMeters(destination, { lat: s.stop_lat, lon: s.stop_lon });
            if (d < closestToDestM) closestToDestM = d;
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
        // failure modes: (a) search reached NO destination-area stop at all
        // (ellipse/pattern-discovery excluded the corridor), (b) search reached
        // a destination stop's general AREA but tau is still undefined (never
        // touched by a marked round — likely time-window cutoff), or (c) some
        // destKeyMap stop DOES have a tau, meaning a candidate should have been
        // recorded — which would point at a bug in tryRecordDestination itself.
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
        console.log(
            `[gtfsRoute] search failure diagnostic: anyDestStopTouched=${anyDestStopTouched}` +
            (anyDestStopTouched ? `, closest touched dest stop="${closestStopName}" (${Math.round(closestDistM)}m from destination point)` : ', NO destination-area stop was ever reached by RAPTOR — likely ellipse excluded the corridor, or the connecting pattern never appeared in candidatePatternKeys'),
        );

        throw new Error(`No route found within ${MAX_ROUNDS} transfers.\nNear origin: ${oNames}\nNear destination: ${dNames}`);
    }

    // ── Reduce to non-dominated set (Pareto frontier on arrival/walk/transfers) ─
    const nonDominated = candidates.filter((c, i) =>
        !candidates.some((o, j) =>
            j !== i &&
            o.arrivalSec   <= c.arrivalSec &&
            o.totalWalkM   <= c.totalWalkM &&
            o.transfers    <= c.transfers &&
            (o.arrivalSec < c.arrivalSec || o.totalWalkM < c.totalWalkM || o.transfers < c.transfers)
        )
    );
    lap(`Pareto filter (${candidates.length} candidates -> ${nonDominated.length} kept)`);

    // Reconstruct full path for each surviving candidate.
    const journeys: GtfsJourney[] = [];
    for (const c of nonDominated) {
        journeys.push(reconstructPath(
            index, origin, destination, c.destKey, c.finalWalkM, c.arrivalSec, departSec, parent, walkingSpeedMps,
        ));
    }
    journeys.sort((a, b) => a.arrivalTime.localeCompare(b.arrivalTime));
    lap(`path reconstruction (${journeys.length} journeys)`);

    console.log(`[gtfsRoute] TOTAL search time: ${Date.now() - tStart}ms`);

    return { journeys };
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
        | { type: 'transit'; tripId: string; patternId: string; agency: number;
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
                type: 'transit', tripId: p.tripId, patternId: p.patternId, agency: p.agency,
                boardKey: p.boardKey, alightKey: cur, boardSeq: p.boardSeq, alightSeq: p.alightSeq,
            });
            cur = p.boardKey;
        } else {
            steps.push({ type: 'footpath', fromKey: p.fromKey, fpToKey: cur, footpathM: p.distM });
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
            const toLL = { latitude: toStop.stop_lat, longitude: toStop.stop_lon };
            if (step.originWalkM > 1) {
                segments.push(walkSegment(origin, toLL, 'Your location', toStop.stop_name, step.originWalkM));
                allCoords.push(toLL);
                totalWalkingMeters += step.originWalkM;
            }
            continue;
        }

        if (step.type === 'footpath') {
            const from = index.stopsByKey.get(step.fromKey)!;
            const to   = index.stopsByKey.get(step.fpToKey)!;
            const fromLL = { latitude: from.stop_lat, longitude: from.stop_lon };
            const toLL   = { latitude: to.stop_lat, longitude: to.stop_lon };
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
        const { tripId, patternId, agency, boardKey, alightKey, boardSeq, alightSeq } = step;
        const boardStop  = index.stopsByKey.get(boardKey)!;
        const alightStop = index.stopsByKey.get(alightKey)!;
        const patMeta = index.patternsByKey.get(makeKey(agency, patternId));

        const routeName      = patMeta?.route_name ?? '?';
        const routeType      = patMeta?.route_type ?? 3;
        const routeColor     = resolveRouteColor(patMeta?.route_color, routeType, routeName);
        const routeTextColor = resolveTextColor(patMeta?.route_text_color);

        const boardEntry  = index.stopTimesByStopAndTrip.get(boardKey)?.get(tripId);
        const alightEntry = index.stopTimesByStopAndTrip.get(alightKey)?.get(tripId);

        const departTimeStr = boardEntry  ? formatSec(boardEntry.departure_sec) : undefined;
        const arriveTimeStr = alightEntry ? formatSec(alightEntry.arrival_sec)  : undefined;

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
                        const d = haversineMeters(target, { lat: pts[i].latitude, lon: pts[i].longitude });
                        if (d < bestDist) { bestDist = d; bestIdx = i; }
                    }
                    return bestIdx;
                };
                const boardLL  = { latitude: boardStop.stop_lat,  longitude: boardStop.stop_lon };
                const alightLL = { latitude: alightStop.stop_lat, longitude: alightStop.stop_lon };
                const startIdx = nearestIndex(boardLL);
                const endIdx   = nearestIndex(alightLL);
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
                    return st ? { latitude: st.stop_lat, longitude: st.stop_lon } : null;
                })
                .filter((x): x is LatLng => x !== null);
        }
        if (coords.length === 0) {
            coords = [
                { latitude: boardStop.stop_lat, longitude: boardStop.stop_lon },
                { latitude: alightStop.stop_lat, longitude: alightStop.stop_lon },
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
        allCoords.push({ latitude: alightStop.stop_lat, longitude: alightStop.stop_lon });
        transferCount++;
    }

    const destStop = index.stopsByKey.get(destKey)!;
    const destStopLL = { latitude: destStop.stop_lat, longitude: destStop.stop_lon };
    if (finalWalkM > 1) {
        segments.push(walkSegment(destStopLL, destination, destStop.stop_name, 'Your destination', finalWalkM));
        allCoords.push(destination);
        totalWalkingMeters += finalWalkM;
    }

    const firstLeg = legs[0];
    const lastLeg  = legs[legs.length - 1];

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