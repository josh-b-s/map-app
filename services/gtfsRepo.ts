/**
 * gtfsRepo.ts — the ONLY module that writes raw SQL against pattern_stops,
 * stop_times, patterns, or trips' surrogate-key columns. Every other module
 * (coarseGraph, corridorResolver, corridorTagging, gtfsLoader, gtfsRouter)
 * goes through here instead of touching those tables directly.
 *
 * WHY THIS EXISTS: preprocess-gtfs.ts's schema stores pattern_stops and
 * stop_times keyed ONLY by integer surrogate pks (stop_pk, trip_pk,
 * pattern_pk) — there's no stop_id/pattern_id/agency text column on either
 * table, by design (see preprocess-gtfs.ts: repeating a 10-20 char string
 * across millions of rows was the single biggest size cost in the old
 * schema). The rest of the app thinks in terms of the (agency, real-id)
 * keys makeKey()/parseKey() produce. This module is the translation
 * boundary: it resolves pk <-> (agency,id) via small cached lookup maps
 * (stops/patterns are tens-of-thousands of rows per feed — cheap to hold
 * in memory) rather than SQL-joining through millions of
 * stop_times/pattern_stops rows, which would reintroduce exactly the
 * per-row string-repetition cost the surrogate-key schema exists to avoid.
 *
 * PATTERN IDENTITY: GTFS itself has no "pattern" concept — patterns are
 * synthesized during preprocessing by grouping trips on their actual stop
 * sequence. There is no independent pattern_id string anywhere to look up;
 * the surrogate pattern_pk IS the pattern's identity. A pattern KEY is
 * therefore just makeKey(agency, String(pattern_pk)) — see patternKeyFor().
 *
 * MULTI-FEED READINESS: every cache here is keyed by the real (agency, id)
 * identity, and `agency` already partitions one feed from another (each
 * GTFS feed occupies its own agency id range from preprocessing — see
 * preprocess-gtfs.ts's `agencyId = i + 1` per source). When multiple feeds
 * are active at once later, nothing about the CALLER side of this module
 * changes — a pattern/stop key already carries its agency. The only thing
 * that will need to change is which agencies' rows get pulled into these
 * caches (e.g. scoping ensure*Maps() to a set of "currently loaded"
 * agencies instead of the whole DB) — a change entirely local to this
 * file, which is the point of having it.
 */

import type {QueryableDb} from './sqlChunkUtil';
import {chunkedQuery, placeholders, SQL_CHUNK_SIZE} from './sqlChunkUtil';
import {makeKey, parseKey} from './gtfsKeyUtil';

/**
 * Must match preprocess-gtfs.ts's own COORD_SCALE exactly — coordinates are
 * packed there as INTEGER degrees*COORD_SCALE (see that file's comment on
 * why: SQLite INTEGER's variable-length encoding beats a fixed 8-byte REAL
 * for values in this range). Every stop_lat/stop_lon and
 * shape_pt_lat/shape_pt_lon column in the DB is packed this way and MUST be
 * divided back out here — this was previously being skipped entirely
 * (stops/shapes were read as if they were raw-degree REALs), which would
 * have made every distance/haversine calculation in the app off by a
 * factor of ~1,000,000.
 */
export const COORD_SCALE = 1_000_000;

export interface RepoStop {
    stop_pk: number;
    stop_id: string;
    stop_name: string;
    stop_lat: number; // real degrees — already unpacked
    stop_lon: number; // real degrees — already unpacked
    agency: number;
}

// ── Caches ──────────────────────────────────────────────────────────────────
// stop_pk and pattern_pk are assigned once per DB build and never change
// without a full feed reload, so these are safe to cache for the process
// lifetime — invalidated the same moment/place every other GTFS cache is
// (see invalidateGtfsRepoCaches(), call alongside
// invalidateCoarseGraphCache()/invalidateCorridorCache() after a feed update).
let stopPkToKey: Map<number, string> | null = null;
let stopKeyToPk: Map<string, number> | null = null;
/** unqualified stop_id (no agency) -> every stop_pk sharing that id text,
 *  across all agencies. Needed for callers that only have a plain stop_id
 *  (no agency) on hand — e.g. a corridor's bbox-fallback stop list. */
let stopIdToPks: Map<string, number[]> | null = null;
let patternPkToAgency: Map<number, number> | null = null;
let patternPkToRouteKey: Map<number, string> | null = null;

/**
 * Canonical, coordinate-unpacked stops cache — the ONE place in the app
 * that queries the `stops` table. Previously gtfsLoader.ts and
 * coarseGraph.ts each ran their own independent (uncached-against-each-
 * other, and un-unpacked) copy of this same query; folding it here means
 * every caller shares one cache AND gets correctly unpacked lat/lon.
 * Populates the pk<->key maps below as a side effect of the same query —
 * no separate round trip needed to build them.
 */
let stopsCache: RepoStop[] | null = null;
let stopsCachePromise: Promise<RepoStop[]> | null = null;

async function loadStops(db: QueryableDb): Promise<RepoStop[]> {
    const rows = await db.getAllAsync<{
        stop_pk: number; stop_id: string; stop_name: string;
        stop_lat: number; stop_lon: number; agency: number;
    }>(`SELECT stop_pk, stop_id, stop_name, stop_lat, stop_lon, agency
        FROM stops`);

    const out: RepoStop[] = [];
    const pkToKey = new Map<number, string>();
    const keyToPk = new Map<string, number>();
    const idToPks = new Map<string, number[]>();
    for (const r of rows) {
        out.push({
            stop_pk: r.stop_pk, stop_id: r.stop_id, stop_name: r.stop_name,
            stop_lat: r.stop_lat / COORD_SCALE, stop_lon: r.stop_lon / COORD_SCALE,
            agency: r.agency,
        });
        const key = makeKey(r.agency, r.stop_id);
        pkToKey.set(r.stop_pk, key);
        keyToPk.set(key, r.stop_pk);
        const list = idToPks.get(r.stop_id);
        if (list) list.push(r.stop_pk); else idToPks.set(r.stop_id, [r.stop_pk]);
    }
    stopPkToKey = pkToKey;
    stopKeyToPk = keyToPk;
    stopIdToPks = idToPks;
    return out;
}

/** Call this instead of ever running `SELECT ... FROM stops` directly.
 *  Cached for the process lifetime — invalidate via
 *  invalidateGtfsRepoCaches() after a feed update, same as every other
 *  cache in this file. */
export async function getAllStopsCached(db: QueryableDb): Promise<RepoStop[]> {
    if (stopsCache) return stopsCache;
    if (stopsCachePromise) return stopsCachePromise;
    stopsCachePromise = loadStops(db).then(rows => {
        stopsCache = rows;
        return rows;
    });
    return stopsCachePromise;
}

/** Purely for callers' own timing/diagnostic logs (e.g. gtfsLoader.ts
 *  distinguishing "cold fetch" from "cached" in its own lap() logging) —
 *  routing logic should never branch on this. */
export function isStopsCacheWarm(): boolean {
    return stopsCache !== null;
}

async function ensureStopMaps(db: QueryableDb): Promise<void> {
    if (stopPkToKey) return;
    await getAllStopsCached(db); // populates the maps as a side effect
}

async function ensurePatternAgencyMap(db: QueryableDb): Promise<void> {
    if (patternPkToAgency) return;
    const rows = await db.getAllAsync<{ pattern_pk: number; agency: number; route_id: string }>(
        `SELECT pattern_pk, agency, route_id
         FROM patterns`,
    );
    patternPkToAgency = new Map(rows.map(r => [r.pattern_pk, r.agency]));
    patternPkToRouteKey = new Map(rows.map(r => [r.pattern_pk, makeKey(r.agency, r.route_id)]));
}

/** Call alongside invalidateCoarseGraphCache()/invalidateCorridorCache()
 *  after loading a new/updated GTFS feed — every cache in this file is
 *  keyed off pks or rows a feed reload can reassign entirely. */
export function invalidateGtfsRepoCaches(): void {
    stopPkToKey = null;
    stopKeyToPk = null;
    stopIdToPks = null;
    patternPkToAgency = null;
    patternPkToRouteKey = null;
    stopsCache = null;
    stopsCachePromise = null;
    shapeIdToPk = null;
}

/**
 * Every pattern in the DB, as agency-qualified keys — the whole network,
 * no filtering at all. Used only by gtfsLoader.ts's skipCorridorScoping
 * benchmark path (see that function's step 2) to build a "no corridor"
 * comparison baseline; a real search never needs the entire network's
 * pattern set at once.
 */
export async function getAllPatternKeys(db: QueryableDb): Promise<Set<string>> {
    await ensurePatternAgencyMap(db);
    const out = new Set<string>();
    for (const [pk, agency] of patternPkToAgency!) out.add(patternKeyFor(pk, agency));
    return out;
}

export function patternKeyFor(patternPk: number, agency: number): string {
    return makeKey(agency, String(patternPk));
}

/** Inverse of patternKeyFor — pulls the pk back out as a number, ready for
 *  a `WHERE pattern_pk IN (...)` query. */
export function patternPkFromKey(patternKey: string): number {
    return Number(parseKey(patternKey).id);
}

/** Bulk stop_pk -> stopKey, for translating a batch of stop_times/
 *  pattern_stops rows back to (agency,id) keys without a per-row query. */
export async function getStopKeysForPks(db: QueryableDb, stopPks: Iterable<number>): Promise<Map<number, string>> {
    await ensureStopMaps(db);
    const out = new Map<number, string>();
    for (const pk of stopPks) {
        const k = stopPkToKey!.get(pk);
        if (k !== undefined) out.set(pk, k);
    }
    return out;
}

/** Every stop_pk (across all agencies) sharing the given unqualified
 *  stop_id text — same "no agency filter" breadth the app's original,
 *  pre-surrogate-key queries had (see getPatternKeysForUnqualifiedStopIds'
 *  doc comment; this is the same tradeoff, just factored out for reuse).
 *  Prefer getStopPksForStopKeys when the caller has real (agency,id) keys —
 *  this one only exists for callers stuck with bare ids. */
export async function getStopPksForUnqualifiedStopIds(db: QueryableDb, stopIds: Iterable<string>): Promise<number[]> {
    await ensureStopMaps(db);
    const out: number[] = [];
    for (const id of stopIds) {
        const pks = stopIdToPks!.get(id);
        if (pks) out.push(...pks);
    }
    return out;
}

/** Exact stop_pk lookup for agency-qualified stop keys — no cross-agency
 *  ambiguity, unlike getStopPksForUnqualifiedStopIds above. Use this
 *  whenever the caller already has real keys (which, after corridorTagging/
 *  corridorResolver's move to qualified keys, is now the normal case). */
export async function getStopPksForStopKeys(db: QueryableDb, stopKeys: Iterable<string>): Promise<number[]> {
    await ensureStopMaps(db);
    const out: number[] = [];
    for (const key of stopKeys) {
        const pk = stopKeyToPk!.get(key);
        if (pk !== undefined) out.push(pk);
    }
    return out;
}

/** Bulk pattern_pk -> patternKey. Currently unused internally — gtfsLoader.ts
 *  used to call this to resolve stop_times.pattern_pk in bulk, but that
 *  column was removed from stop_times (fully derivable via trip_pk instead;
 *  see preprocess-gtfs.ts). Kept as a generic utility for any future caller
 *  that has raw pattern_pks and needs real keys. */
export async function getPatternKeysForPks(db: QueryableDb, patternPks: Iterable<number>): Promise<Map<number, string>> {
    await ensurePatternAgencyMap(db);
    const out = new Map<number, string>();
    for (const pk of patternPks) {
        const agency = patternPkToAgency!.get(pk);
        if (agency !== undefined) out.set(pk, patternKeyFor(pk, agency));
    }
    return out;
}

/**
 * Which routes (as agency-qualified (agency,route_id) keys) serve each of
 * the given stop keys — one bulk query, not one per stop. Built for
 * corridorResolver.ts's seed selection: picking "the N nearest stops"
 * with no line awareness tends to fill the whole seed budget with several
 * poles/directions of the SAME route (a tram stop on both sides of an
 * intersection, say) while a more useful but slightly farther line (a
 * train station a few hundred meters past a wall of closer tram stops)
 * never gets a seed slot at all. Knowing which route(s) each nearby stop
 * belongs to lets seed selection skip a stop that adds no NEW route to the
 * seed set, freeing that slot for a genuinely different line instead.
 */
export async function getRouteKeysForStopKeys(
    db: QueryableDb,
    stopKeys: Iterable<string>,
): Promise<Map<string, Set<string>>> {
    await ensureStopMaps(db);
    await ensurePatternAgencyMap(db);

    const keyList = [...stopKeys];
    const pkToKey = new Map<number, string>();
    for (const key of keyList) {
        const pk = stopKeyToPk!.get(key);
        if (pk !== undefined) pkToKey.set(pk, key);
    }
    const stopPks = [...pkToKey.keys()];

    const out = new Map<string, Set<string>>();
    if (stopPks.length === 0) return out;

    const rows = await chunkedQuery(stopPks, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ stop_pk: number; pattern_pk: number }>(
            `SELECT DISTINCT stop_pk, pattern_pk
             FROM pattern_stops
             WHERE stop_pk IN (${placeholders(chunk.length)})`,
            chunk,
        ),
    );
    for (const r of rows) {
        const stopKey = pkToKey.get(r.stop_pk);
        const routeKey = patternPkToRouteKey!.get(r.pattern_pk);
        if (!stopKey || !routeKey) continue;
        if (!out.has(stopKey)) out.set(stopKey, new Set());
        out.get(stopKey)!.add(routeKey);
    }
    return out;
}

// ── Shapes ────────────────────────────────────────────────────────────────
// shape_id -> shape_pk, agency-qualified (see preprocess-gtfs.ts's
// shape_meta table — shapes were the one place still repeating a text id
// on every row of a huge table; shape_meta holds the id once per shape).
let shapeIdToPk: Map<string, number> | null = null;

async function ensureShapeMaps(db: QueryableDb): Promise<void> {
    if (shapeIdToPk) return;
    const rows = await db.getAllAsync<{ shape_pk: number; shape_id: string; agency: number }>(
        `SELECT shape_pk, shape_id, agency
         FROM shape_meta`,
    );
    shapeIdToPk = new Map(rows.map(r => [makeKey(r.agency, r.shape_id), r.shape_pk]));
}

/** Loads shape polylines for a small set of (shape_id, agency) pairs —
 *  the counterpart to preprocess-gtfs.ts's shape_meta/shapes split.
 *  Coordinates are unpacked from COORD_SCALE here, same as stops. */
export async function getShapePointsForShapeIds(
    db: QueryableDb,
    shapeIds: Array<{ shape_id: string; agency: number }>,
): Promise<Map<string, { latitude: number; longitude: number }[]>> {
    await ensureShapeMaps(db);

    const pkToKey = new Map<number, string>();
    for (const s of shapeIds) {
        const pk = shapeIdToPk!.get(makeKey(s.agency, s.shape_id));
        if (pk !== undefined) pkToKey.set(pk, makeKey(s.agency, s.shape_id));
    }

    const result = new Map<string, { latitude: number; longitude: number }[]>();
    const pks = [...pkToKey.keys()];
    if (pks.length === 0) return result;

    const rows = await chunkedQuery(pks, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ shape_pk: number; shape_pt_lat: number; shape_pt_lon: number; shape_pt_sequence: number }>(
            `SELECT shape_pk, shape_pt_lat, shape_pt_lon, shape_pt_sequence
             FROM shapes
             WHERE shape_pk IN (${placeholders(chunk.length)})
             ORDER BY shape_pk, shape_pt_sequence`,
            chunk,
        ),
    );
    for (const r of rows) {
        const key = pkToKey.get(r.shape_pk)!;
        if (!result.has(key)) result.set(key, []);
        result.get(key)!.push({latitude: r.shape_pt_lat / COORD_SCALE, longitude: r.shape_pt_lon / COORD_SCALE});
    }
    return result;
}

export interface RepoPatternStop {
    patternKey: string;
    stopKey: string;
    stop_sequence: number;
}

/** Every pattern_stops row for the given pattern pks, resolved to
 *  (agency,id) keys. Ordered by pattern then sequence. */
export async function getPatternStopsForPatternKeys(
    db: QueryableDb,
    patternKeys: Iterable<string>,
): Promise<RepoPatternStop[]> {
    await ensureStopMaps(db);
    await ensurePatternAgencyMap(db);
    const patternPks = [...patternKeys].map(patternPkFromKey);
    const rows = await chunkedQuery(patternPks, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ pattern_pk: number; stop_pk: number; stop_sequence: number }>(
            `SELECT pattern_pk, stop_pk, stop_sequence
             FROM pattern_stops
             WHERE pattern_pk IN (${placeholders(chunk.length)})
             ORDER BY pattern_pk, stop_sequence`,
            chunk,
        ),
    );
    return rows.map(r => ({
        patternKey: patternKeyFor(r.pattern_pk, patternPkToAgency!.get(r.pattern_pk)!),
        stopKey: stopPkToKey!.get(r.stop_pk)!,
        stop_sequence: r.stop_sequence,
    }));
}

/** Every pattern_stops row in the whole DB, ordered by pattern then
 *  sequence — used by coarseGraph.ts's from-scratch build, which needs
 *  every pattern's complete stop sequence, not a filtered subset. */
export async function getAllPatternStopsOrdered(db: QueryableDb): Promise<RepoPatternStop[]> {
    await ensureStopMaps(db);
    await ensurePatternAgencyMap(db);
    const rows = await db.getAllAsync<{ pattern_pk: number; stop_pk: number; stop_sequence: number }>(
        `SELECT pattern_pk, stop_pk, stop_sequence
         FROM pattern_stops
         ORDER BY pattern_pk, stop_sequence`,
    );
    return rows.map(r => ({
        patternKey: patternKeyFor(r.pattern_pk, patternPkToAgency!.get(r.pattern_pk)!),
        stopKey: stopPkToKey!.get(r.stop_pk)!,
        stop_sequence: r.stop_sequence,
    }));
}

/** Which stops (as agency-qualified keys) the given patterns actually
 *  visit — matches corridorResolver.ts's old `SELECT DISTINCT stop_id FROM
 *  pattern_stops WHERE pattern_id IN (...)` shape, minus the column that
 *  never existed, and qualified by agency so cross-agency stop_id
 *  collisions can't merge two different physical stops.
 *
 *  Currently unused internally — corridorResolver.ts now calls
 *  getPatternStopsForPatternKeys directly instead, so it can hang onto the
 *  raw rows (threaded through ResolvedCorridor.patternStopRows) for
 *  gtfsLoader.ts to reuse, rather than discarding them the way this helper
 *  does. Kept as a convenience for any caller that only wants the stop-key
 *  set and doesn't care about the rows themselves. */
export async function getStopKeysForPatternKeys(
    db: QueryableDb,
    patternKeys: Iterable<string>,
): Promise<Set<string>> {
    const rows = await getPatternStopsForPatternKeys(db, patternKeys);
    return new Set(rows.map(r => r.stopKey));
}

/** Which patterns (as keys) touch ANY stop whose (agency,id) matches one of
 *  the given stop keys. */
export async function getPatternKeysForStopKeys(
    db: QueryableDb,
    stopKeys: Iterable<string>,
): Promise<Set<string>> {
    await ensureStopMaps(db);
    await ensurePatternAgencyMap(db);
    const stopPks = [...stopKeys]
        .map(k => stopKeyToPk!.get(k))
        .filter((v): v is number => v !== undefined);
    const rows = await chunkedQuery(stopPks, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ pattern_pk: number }>(
            `SELECT DISTINCT pattern_pk
             FROM pattern_stops
             WHERE stop_pk IN (${placeholders(chunk.length)})`,
            chunk,
        ),
    );
    return new Set(rows.map(r => patternKeyFor(r.pattern_pk, patternPkToAgency!.get(r.pattern_pk)!)));
}

/**
 * Same as getPatternKeysForStopKeys, but for callers that only have plain
 * (unqualified, no-agency) stop_ids on hand. Matches EVERY agency's stop
 * sharing that id text — a stop_id colliding across two different agencies
 * pulls in both agencies' patterns.
 *
 * As of this pass, nothing in the app actually calls this anymore —
 * corridorResolver.ts's bbox fallback and corridorTagging.ts's seed-path
 * pattern lookup (the two former callers) were both tightened to carry
 * agency-qualified keys end-to-end and use getPatternKeysForStopKeys
 * instead, exactly to close the cross-agency collision risk this function
 * describes. Kept exported as a fallback utility for any future caller that
 * genuinely only has bare ids (e.g. ingesting an external id list with no
 * agency attached) — but if you're calling this on a set you built
 * yourself, prefer carrying the agency through instead of stripping it and
 * calling this.
 */
export async function getPatternKeysForUnqualifiedStopIds(
    db: QueryableDb,
    stopIds: Iterable<string>,
): Promise<Set<string>> {
    await ensureStopMaps(db);
    const stopPks: number[] = [];
    for (const id of stopIds) {
        const pks = stopIdToPks!.get(id);
        if (pks) stopPks.push(...pks);
    }
    await ensurePatternAgencyMap(db);
    const rows = await chunkedQuery(stopPks, SQL_CHUNK_SIZE, chunk =>
        db.getAllAsync<{ pattern_pk: number }>(
            `SELECT DISTINCT pattern_pk
             FROM pattern_stops
             WHERE stop_pk IN (${placeholders(chunk.length)})`,
            chunk,
        ),
    );
    return new Set(rows.map(r => patternKeyFor(r.pattern_pk, patternPkToAgency!.get(r.pattern_pk)!)));
}
