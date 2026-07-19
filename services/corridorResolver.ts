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

import type { LatLng } from './gtfsDb';
import { makeKey, parseKey } from './gtfsKeyUtil';
import { haversineMeters } from './geoUtil';
import { chunkedQuery, placeholders, SQL_CHUNK_SIZE } from './sqlChunkUtil';
import { computeCorridor, computeSeedPathCorridor, ORIGIN_DEST_WALK_RADIUS_M } from './corridorTagging';
import type { CorridorBoundary } from './corridorTagging';
import type { StopInfo } from './gtfsLoader';

/** Minimal DB shape this module needs (same pattern as corridorTagging.ts's
 *  QueryableDb) — avoids a concrete dependency on gtfsDb's SQLiteDatabase
 *  class here. */
interface QueryableDb {
    getAllAsync<T>(sql: string, params?: any[]): Promise<T[]>;
    execAsync(sql: string): Promise<void>;
    runAsync(sql: string, params?: any[]): Promise<{ lastInsertRowId: number; changes: number }>;
}

export interface ResolvedCorridor {
    patternKeys: Set<string>;
    /** Unqualified stop_ids — matches gtfsLoader.ts's GtfsIndex.corridorStopIds shape. */
    allowedStopIds: Set<string>;
    widened: boolean;
    seedPathCount: number;
    debugSeedPaths: string[][];
    debugBfsLevels: string[][];
    debugBfsTreeEdges: [string, string][];
    debugCorridorBoundary: CorridorBoundary[];
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

/** Below this many seed-path-derived patterns, treat the result as
 *  suspiciously thin and fall back to the bbox corridor instead. */
const MIN_ACCEPTABLE_PATTERNS = 3;

// ── Cache ───────────────────────────────────────────────────────────────────
// Keyed on rounded origin/destination coords (~11m precision — absorbs GPS
// jitter on a "current location" origin without missing real cache hits) +
// maxTransfers. Capped so a long session doing many different searches can't
// grow this unboundedly; a simple insertion-order eviction (Map preserves
// insertion order) is enough here — this is a small speed cache, not a
// correctness-critical store.
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

function nearestForSeed(allStops: StopInfo[], center: LatLng, limit: number): string[] {
    return allStops
        .map(s => ({ s, d: haversineMeters({ lat: center.latitude, lon: center.longitude }, { lat: s.stop_lat, lon: s.stop_lon }) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit)
        .map(x => makeKey(x.s.agency, x.s.stop_id));
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

    const candidateAll = allStops.map(s => ({ stop_id: s.stop_id, lat: s.stop_lat, lon: s.stop_lon, agency: s.agency }));
    const originSeedKeys = nearestForSeed(allStops, origin, NEAREST_FOR_CORRIDOR_SEED);
    const destSeedKeys = nearestForSeed(allStops, destination, NEAREST_FOR_CORRIDOR_SEED);

    const originLatLon = { lat: origin.latitude, lon: origin.longitude };
    const destLatLon = { lat: destination.latitude, lon: destination.longitude };

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
    let patternDerivedStopIds = new Set<string>();
    if (seedCorridor.patternKeys.size > 0) {
        const patternIdList = [...seedCorridor.patternKeys].map(k => parseKey(k).id);
        const patternStopIdRows = await chunkedQuery(patternIdList, SQL_CHUNK_SIZE, chunk =>
            db.getAllAsync<{ stop_id: string }>(
                `SELECT DISTINCT stop_id FROM pattern_stops WHERE pattern_id IN (${placeholders(chunk.length)})`,
                chunk,
            ),
        );
        patternDerivedStopIds = new Set(patternStopIdRows.map(r => r.stop_id));
    }

    // Coverage check: "enough patterns" alone isn't sufficient — the
    // Mornington -> Clayton case had 66 patterns yet RAPTOR stalled just
    // short of the destination (round 1 marked=589 but 7929m from
    // destination, then round 2 marked=0). All 66 patterns can cluster
    // around the origin/middle of the trip and leave the destination end
    // essentially unreachable by any of them — pattern COUNT doesn't catch
    // that, only checking whether the kept patterns actually touch a stop
    // near each endpoint does.
    const originStopIdsPlain = new Set(originSeedKeys.map(k => parseKey(k).id));
    const destStopIdsPlain = new Set(destSeedKeys.map(k => parseKey(k).id));
    const originCovered = [...originStopIdsPlain].some(id => patternDerivedStopIds.has(id));
    const destCovered = [...destStopIdsPlain].some(id => patternDerivedStopIds.has(id));

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
        const allowedStopIds = new Set(patternDerivedStopIds);
        for (const s of seedCorridor.walkRadiusStopIds) allowedStopIds.add(s);
        for (const path of seedCorridor.seedPaths) {
            for (const stopKey of path) allowedStopIds.add(parseKey(stopKey).id);
        }
        t = lap(`corridor stops derived from kept patterns + walk radius + seed path stops (${allowedStopIds.size} stops)`, t);

        result = {
            patternKeys: seedCorridor.patternKeys,
            allowedStopIds,
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
            allowedStopIds = new Set(allStops.map(s => s.stop_id));
        }
        t = lap(
            `corridor filter, bbox fallback (${allowedStopIds.size}/${allStops.length} stops kept, ` +
            `${corridor.seedPathCount} seed paths, widened=${corridor.widened})`,
            t,
        );

        const candidatePatternRows = await db.getAllAsync<{ pattern_id: string; agency: number }>(
            `SELECT DISTINCT pattern_id, agency FROM pattern_stops WHERE stop_id IN (SELECT value FROM json_each(?))`,
            [JSON.stringify([...allowedStopIds])],
        );
        const patternKeys = new Set<string>(candidatePatternRows.map(r => makeKey(r.agency, r.pattern_id)));
        t = lap(`candidate patterns discovery, bbox fallback (${patternKeys.size} patterns)`, t);

        result = {
            patternKeys,
            allowedStopIds,
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

export { ORIGIN_DEST_WALK_RADIUS_M };
