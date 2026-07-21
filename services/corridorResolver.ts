/**
 * corridorResolver.ts — resolves "which patterns and stops make up this
 * trip's corridor," independent of date/time.
 *
 * WHY THIS IS ITS OWN FILE: gtfsLoader.ts's job is loading a SCOPED,
 * date/time-filtered GTFS index. Corridor resolution (BFS seed paths ->
 * candidate patterns -> candidate stops) has no dependency on date/time at
 * all — same schedule-agnostic reasoning coarseGraph.ts already documents
 * about itself. Mixing the two in one file made gtfsLoader.ts responsible
 * for both "what shape is this trip" (a one-time-per-origin/destination
 * question) and "what's running today" (a per-search question), which is
 * also exactly why the corridor used to get recomputed from scratch on
 * every single search even when only the departure time changed.
 *
 * CACHING: since this result doesn't depend on date/time, it's cached here
 * by (origin, destination, maxTransfers) — a repeat search for the same
 * trip with a different time only needs to re-run gtfsLoader.ts's
 * date/time-scoped steps (active services, trips, stop_times), not BFS +
 * pattern derivation. Invalidate alongside invalidateCoarseGraphCache() /
 * invalidateStopsCache() after a GTFS feed update — see
 * invalidateCorridorCache() below.
 */

import type {LatLng} from './gtfsDb';
import {makeKey} from './gtfsKeyUtil';
import {haversineMeters} from './geoUtil';
import {type QueryableDb} from './sqlChunkUtil';
import type {CorridorBoundary} from './corridorTagging';
import {computeCorridor, computeSeedPathCorridor, ORIGIN_DEST_WALK_RADIUS_M} from './corridorTagging';
import type {StopInfo} from './gtfsLoader';
import {
    getPatternKeysForStopKeys,
    getPatternStopsForPatternKeys,
    getRouteKeysForStopKeys,
    type RepoPatternStop
} from './gtfsRepo';
import {MAX_SEED_STOPS, MAX_TRANSFERS, MIN_ACCEPTABLE_PATTERNS, MIN_SEED_STOPS, SEED_RADIUS_M} from './routingSettings';

export interface ResolvedCorridor {
    patternKeys: Set<string>;
    /** Agency-qualified stop KEYS (makeKey(agency,stop_id)), not bare
     *  stop_id — matches gtfsLoader.ts's GtfsIndex.corridorStopIds shape,
     *  which was tightened the same way (see gtfsRouter.ts's corridor
     *  filters, updated alongside this). Qualifying by agency here is what
     *  lets every pattern/stop lookup downstream be an exact match instead
     *  of "any agency with this id text" — matters more as multiple feeds
     *  become simultaneously active, not just as a tidiness thing. */
    allowedStopIds: Set<string>;
    /** Raw pattern_stops rows for patternKeys, already fetched during
     *  corridor resolution's coverage check — see resolveCorridor's doc
     *  comment on why. Empty on the bbox-fallback path (which never needs
     *  pattern_stops for its own purposes); gtfsLoader.ts falls back to
     *  its own query when this is empty. */
    patternStopRows: RepoPatternStop[];
    widened: boolean;
    seedPathCount: number;
    debugSeedPaths: string[][];
    debugBfsLevels: string[][];
    debugBfsTreeEdges: [string, string][];
    debugCorridorBoundary: CorridorBoundary[];
}

// SEED_RADIUS_M / MIN_SEED_STOPS / MAX_SEED_STOPS / MAX_TRANSFERS /
// MIN_ACCEPTABLE_PATTERNS now live in routingSettings.ts — see that file's
// header comment for how these interact with WALK_EDGE_THRESHOLD_M and
// ORIGIN_DEST_WALK_RADIUS_M in the other routing files. All are still
// plain constants; centralizing them here is prep for a future
// user-facing walk-distance/wait-time settings screen, not a settings
// screen itself.

// ── Cache ───────────────────────────────────────────────────────────────────
// Keyed on rounded origin/destination coords (~11m precision — absorbs GPS
// jitter on a "current location" origin without missing real cache hits) +
// maxTransfers. Capped so a long session doing many different searches can't
// grow this unboundedly; a simple insertion-order eviction (Map preserves
// insertion order) is enough here — this is a small speed cache, not a
// correctness-critical store.
//
// NOTE ON SIZE: each cached ResolvedCorridor now also carries
// patternStopRows (thousands of small objects on a typical trip — see its
// doc comment for why). That's a deliberate memory-for-avoided-round-trip
// trade, made once per unique (origin,destination) rather than on every
// search against it (a cache hit skips corridor resolution — and this data
// — entirely; only a COLD corridor resolution pays to fetch and store it).
// 30 entries of a few thousand small objects each is still a modest
// absolute footprint, but worth knowing about if this cache's cap or
// lifetime ever changes.
const MAX_CACHE_ENTRIES = 30;
const corridorCache = new Map<string, ResolvedCorridor>();

function roundCoord(n: number): number {
    return Math.round(n * 10_000) / 10_000; // ~11m at Melbourne's latitude
}

function cacheKeyFor(origin: LatLng, destination: LatLng, maxTransfers: number): string {
    return `${roundCoord(origin.latitude)},${roundCoord(origin.longitude)}` +
        `|${roundCoord(destination.latitude)},${roundCoord(destination.longitude)}` +
        `|${maxTransfers}`;
}

/** Call after loading a new/updated GTFS feed, alongside
 *  invalidateCoarseGraphCache() / invalidateStopsCache() — a feed update can
 *  change which patterns/stops a given origin/destination resolves to. */
export function invalidateCorridorCache(): void {
    corridorCache.clear();
}

/**
 * Selects BFS seed stops within SEED_RADIUS_M of `center`, but skips a stop
 * if every route serving it is already covered by a closer seed already
 * picked — so the fixed-ish seed budget goes toward genuinely DIFFERENT
 * lines instead of being consumed by, say, both directional poles of the
 * same tram route at one intersection. Falls back to the MIN_SEED_STOPS
 * nearest stops (dedup still applied) if the radius alone doesn't reach
 * that floor.
 */
async function nearestForSeed(
    allStops: StopInfo[],
    center: LatLng,
    db: QueryableDb,
    debugLabel?: string,
): Promise<string[]> {
    const ranked = allStops
        .map(s => ({
            s,
            d: haversineMeters({lat: center.latitude, lon: center.longitude}, {lat: s.stop_lat, lon: s.stop_lon})
        }))
        .sort((a, b) => a.d - b.d);

    let withinRadius = ranked.filter(x => x.d <= SEED_RADIUS_M);
    if (withinRadius.length < MIN_SEED_STOPS) withinRadius = ranked.slice(0, MIN_SEED_STOPS);

    // Cap the RAW candidate list (pre-dedup) so a pathologically dense area
    // can't blow up the route-lookup query below — generous relative to
    // MAX_SEED_STOPS since dedup only ever shrinks from here.
    const rawCandidates = withinRadius.slice(0, MAX_SEED_STOPS * 3);
    const candidateKeys = rawCandidates.map(x => makeKey(x.s.agency, x.s.stop_id));

    const routesByStopKey = await getRouteKeysForStopKeys(db, candidateKeys);

    const coveredRoutes = new Set<string>();
    const selected: typeof rawCandidates = [];
    for (const c of rawCandidates) {
        if (selected.length >= MAX_SEED_STOPS) break;
        const key = makeKey(c.s.agency, c.s.stop_id);
        const routes = routesByStopKey.get(key);
        // No route data at all (shouldn't normally happen for a real stop) —
        // err toward including it rather than silently dropping a stop we
        // can't evaluate.
        if (!routes || routes.size === 0) {
            selected.push(c);
            continue;
        }
        let addsNewRoute = false;
        for (const r of routes) {
            if (!coveredRoutes.has(r)) {
                addsNewRoute = true;
                break;
            }
        }
        if (!addsNewRoute) continue; // every route here already has a closer seed — skip, free the slot
        for (const r of routes) coveredRoutes.add(r);
        selected.push(c);
    }
    // Floor guarantee applies AFTER dedup too — if aggressive deduping ever
    // left us under MIN_SEED_STOPS (only plausible with very sparse/odd
    // route data), top back up from the closest remaining candidates rather
    // than under-seed BFS.
    if (selected.length < MIN_SEED_STOPS) {
        const selectedKeys = new Set(selected.map(c => makeKey(c.s.agency, c.s.stop_id)));
        for (const c of rawCandidates) {
            if (selected.length >= MIN_SEED_STOPS) break;
            const key = makeKey(c.s.agency, c.s.stop_id);
            if (!selectedKeys.has(key)) {
                selected.push(c);
                selectedKeys.add(key);
            }
        }
    }

    if (debugLabel) {
        console.log(`[corridorResolver] seed stops for ${debugLabel} (${selected.length} kept, ` +
            `${rawCandidates.length} within radius, ${coveredRoutes.size} distinct routes): ` +
            selected.map(x => `"${x.s.stop_name}" (${Math.round(x.d)}m)`).join(', '));
    }

    return selected.map(x => makeKey(x.s.agency, x.s.stop_id));
}

/**
 * Resolves the corridor for an origin -> destination trip: which patterns
 * plausibly serve it, and which stops need to be loaded. Cached — see the
 * module doc above. Callers (gtfsLoader.ts) should treat the returned sets
 * as read-only.
 */
export async function resolveCorridor(
    origin: LatLng,
    destination: LatLng,
    allStops: StopInfo[],
    db: QueryableDb,
    lap: (label: string, since: number) => number,
    tStart: number,
): Promise<ResolvedCorridor> {
    let t = tStart;

    const cacheKey = cacheKeyFor(origin, destination, MAX_TRANSFERS);
    const cached = corridorCache.get(cacheKey);
    if (cached) {
        t = lap(`corridor resolution (cache hit, ${cached.patternKeys.size} patterns, ${cached.allowedStopIds.size} stops)`, t);
        return cached;
    }

    const candidateAll = allStops.map(s => ({stop_id: s.stop_id, lat: s.stop_lat, lon: s.stop_lon, agency: s.agency}));
    // NOTE: origin/destination seed selection are logically independent and
    // tempting to Promise.all — deliberately NOT done here. gtfsDb.ts's own
    // doc comment documents a strict "exactly one shared connection used
    // serially" invariant for this op-sqlite wrapper; firing concurrent
    // queries against that one connection isn't confirmed safe (op-sqlite's
    // docs don't commit to internally queuing concurrent execute() calls),
    // so this stays sequential until that's verified.
    const originSeedKeys = await nearestForSeed(allStops, origin, db, 'origin');
    const destSeedKeys = await nearestForSeed(allStops, destination, db, 'destination');

    const originLatLon = {lat: origin.latitude, lon: origin.longitude};
    const destLatLon = {lat: destination.latitude, lon: destination.longitude};

    // ── Normal path: derive candidate patterns DIRECTLY from BFS seed paths ──
    // Previously this ran an expensive bbox-tag-every-candidate-stop pass
    // (~800-1500ms tagging all ~29K stops against a tapered buffer) just to
    // then ask "which patterns touch these tagged stops" — which for a
    // typical trip pulled in ~1300+ geographically-nearby patterns, most of
    // which the BFS never actually used. Instead: which patterns touch ANY
    // stop the seed paths actually pass through — still far fewer than the
    // bbox approach (bounded by stops BFS visits, not a geographic buffer),
    // but broad enough to include sibling pattern variants (express/local,
    // direction variants) at each interchange, which a real trip search
    // needs to transfer onto (an exact-consecutive-pair-only version of this
    // was tried and starved RAPTOR at transfers — see corridorTagging.ts's
    // computeSeedPathCorridor for the authoritative derivation).
    const seedCorridor = await computeSeedPathCorridor(
        originLatLon, destLatLon, originSeedKeys, destSeedKeys, candidateAll, MAX_TRANSFERS, db,
    );

    let result: ResolvedCorridor;

    // Which stops the kept patterns actually visit — computed up front (not
    // just inside the accept branch) because we need it BOTH to build
    // allowedStopIds AND to check the origin/destination coverage below.
    // Fetched as raw rows (not just the derived stop-key Set) because
    // gtfsLoader.ts needs this SAME pattern_stops data again later, scoped
    // to whichever of these patterns actually run today — which is always
    // a SUBSET of seedCorridor.patternKeys. Threading the rows through
    // ResolvedCorridor.patternStopRows lets gtfsLoader.ts filter this
    // already-fetched set instead of re-querying pattern_stops for
    // overlapping patterns a second time (see gtfsLoader.ts's step 6).
    let patternStopRows: RepoPatternStop[] = [];
    if (seedCorridor.patternKeys.size > 0) {
        patternStopRows = await getPatternStopsForPatternKeys(db, seedCorridor.patternKeys);
    }
    const patternDerivedStopIds = new Set(patternStopRows.map(r => r.stopKey));

    // Coverage check: "enough patterns" alone isn't sufficient — the
    // Mornington -> Clayton case had 66 patterns yet RAPTOR stalled just
    // short of the destination (round 1 marked=589 but 7929m from
    // destination, then round 2 marked=0). All 66 patterns can cluster
    // around the origin/middle of the trip and leave the destination end
    // essentially unreachable by any of them — pattern COUNT doesn't catch
    // that, only checking whether the kept patterns actually touch a stop
    // near each endpoint does. originSeedKeys/destSeedKeys are already
    // agency-qualified (see nearestForSeed), so this compares directly —
    // no more stripping down to bare ids first.
    const originCovered = originSeedKeys.some(k => patternDerivedStopIds.has(k));
    const destCovered = destSeedKeys.some(k => patternDerivedStopIds.has(k));

    if (seedCorridor.patternKeys.size >= MIN_ACCEPTABLE_PATTERNS && originCovered && destCovered) {
        t = lap(
            `candidate patterns discovery, seed-path-derived (${seedCorridor.patternKeys.size} patterns, ` +
            `${seedCorridor.seedPathCount} seed paths)`,
            t,
        );

        // allowedStopIds is derived from THREE sources, unioned:
        //  1. The kept patterns' own full stop lists (computed above as
        //     patternDerivedStopIds — needed for RAPTOR anyway).
        //  2. The fixed walk-radius floor around origin/destination.
        //  3. Every stop the seed paths themselves actually pass through —
        //     including walk-edge transfer stops that belong to no pattern
        //     at all (a seed path can hop between two lines via a walk edge
        //     where neither stop shares a pattern with the other, by
        //     definition — source 1 alone would silently drop that transfer
        //     stop if it isn't also on one of the kept patterns' footprints).
        // All three sources are already agency-qualified keys now, so this
        // is a plain union — no more stripping to bare stop_id.
        const allowedStopIds = new Set(patternDerivedStopIds);
        for (const s of seedCorridor.walkRadiusStopIds) allowedStopIds.add(s);
        for (const path of seedCorridor.seedPaths) {
            for (const stopKey of path) allowedStopIds.add(stopKey);
        }
        t = lap(`corridor stops derived from kept patterns + walk radius + seed path stops (${allowedStopIds.size} stops)`, t);

        result = {
            patternKeys: seedCorridor.patternKeys,
            allowedStopIds,
            patternStopRows,
            widened: false,
            seedPathCount: seedCorridor.seedPathCount,
            debugSeedPaths: seedCorridor.seedPaths,
            debugBfsLevels: seedCorridor.levelFrontiers,
            debugBfsTreeEdges: seedCorridor.bfsTreeEdges,
            debugCorridorBoundary: seedCorridor.corridorBoundaries,
        };
    } else {
        // Too thin — either not enough patterns, or one end isn't actually
        // reachable by any kept pattern — fall back to the old
        // bbox-tag-then-query approach rather than risk under-serving a
        // genuinely sparse or unusual trip.
        console.log(`[corridorResolver] seed-path corridor rejected (${seedCorridor.patternKeys.size} patterns, ` +
            `originCovered=${originCovered}, destCovered=${destCovered}) — falling back to bbox corridor tagging`);

        const corridor = await computeCorridor(
            originLatLon, destLatLon, originSeedKeys, destSeedKeys, candidateAll, MAX_TRANSFERS,
        );

        let allowedStopIds: Set<string>;
        if (corridor.stopIds.size > 0) {
            allowedStopIds = corridor.stopIds;
        } else {
            console.log('[corridorResolver] corridor came back empty even after widening — falling back to full network');
            allowedStopIds = new Set(allStops.map(s => makeKey(s.agency, s.stop_id)));
        }
        t = lap(
            `corridor filter, bbox fallback (${allowedStopIds.size}/${allStops.length} stops kept, ` +
            `${corridor.seedPathCount} seed paths, widened=${corridor.widened})`,
            t,
        );

        const patternKeys = await getPatternKeysForStopKeys(db, allowedStopIds);
        t = lap(`candidate patterns discovery, bbox fallback (${patternKeys.size} patterns)`, t);

        result = {
            patternKeys,
            allowedStopIds,
            patternStopRows: [],
            widened: corridor.widened,
            seedPathCount: corridor.seedPathCount,
            debugSeedPaths: corridor.seedPaths,
            debugBfsLevels: corridor.levelFrontiers,
            debugBfsTreeEdges: corridor.bfsTreeEdges,
            debugCorridorBoundary: corridor.corridorBoundaries,
        };
    }

    if (corridorCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = corridorCache.keys().next().value;
        if (oldestKey !== undefined) corridorCache.delete(oldestKey);
    }
    corridorCache.set(cacheKey, result);

    return result;
}

export {ORIGIN_DEST_WALK_RADIUS_M};