/**
 * corridorTagging.ts — turns seed paths (from seedRouteBfs) into a tapered
 * buffer around each path, and tags every candidate stop as in/out of the
 * union corridor. Also owns the "widen and retry" fallback from the spec.
 *
 * This replaces the single fixed ellipse between origin/destination: instead
 * of one static shape, the corridor hugs the actual path(s) BFS found, so it
 * stays narrow along long straight stretches but doesn't clip real branching
 * near the ends, and — crucially — it doesn't falsely exclude a stop just
 * because it's geographically close to the straight line but not actually on
 * any plausible route (or vice versa: doesn't falsely include a "small
 * world" stop that's close as the crow flies but topologically unrelated).
 */

import { getCoarseGraph } from './coarseGraph';
import { findSeedPaths } from './seedRouteBfs';
import { parseKey } from './gtfsKeyUtil';
import { haversineMeters, type LatLon } from './geoUtil';
export type { LatLon };

/** Tapered-buffer outline for one seed path, as two parallel polylines (one
 *  per side) sampled at even arc-length steps along the path. Concatenating
 *  `left` followed by `right` reversed gives a single closed ring suitable
 *  for a map Polygon — this is purely a debug-visualization convenience;
 *  routing itself only ever needs the stopIds set, never this shape. */
export interface CorridorBoundary {
    left: LatLon[];
    right: LatLon[];
}

export interface CorridorResult {
    stopIds: Set<string>;   // unqualified stop_id, matches ellipseFilterStops' old return shape
    widened: boolean;       // true if the fallback (widen or full-network) kicked in
    seedPathCount: number;
    /** The raw seed paths BFS found (stop-key sequences, origin->destination),
     *  one per distinct path. Not used by routing itself — exposed purely so
     *  a debug overlay can draw exactly what the corridor was built from,
     *  without recomputing anything. Cheap to include: these already exist
     *  in memory by the time runOnce returns, this just stops discarding them. */
    seedPaths: string[][];
    /** BFS's per-level frontier snapshots (see seedRouteBfs.ts) — passed
     *  straight through for the debug replay. */
    levelFrontiers: string[][];
    /** BFS's exploration-tree edges (see seedRouteBfs.ts's treeEdges) —
     *  passed straight through so a debug overlay can render the search as
     *  a connected "web" instead of a scatter of per-stop points. */
    bfsTreeEdges: [string, string][];
    /** One tapered-buffer outline per seed path, in the same order as
     *  seedPaths. Lets a debug overlay draw the actual corridor SHAPE (the
     *  taper this module computes) as a single Polygon per path, instead of
     *  approximating it by scattering a Circle over every tagged stop —
     *  cheaper to render (one native map object per path vs. hundreds) and
     *  a more honest picture of what the taper actually looks like. */
    corridorBoundaries: CorridorBoundary[];
}

const MIN_WIDTH_M = 350;
const TAPER_K_M = 900;           // width(t) = MIN_WIDTH_M + TAPER_K_M * sin(pi * t)
const WIDEN_MIN_WIDTH_M = 700;
const WIDEN_TAPER_K_M = 1600;
const MIN_ACCEPTABLE_STOPS = 8;  // below this, treat as "suspiciously small" per spec step 5

// How far someone will plausibly walk to/from a stop, independent of the
// path-taper width. These used to be the same number (minWidthM, 350m on
// the first pass) which is tighter than a realistic walk radius — a station
// sitting 400-700m from the origin, just outside the taper floor, would get
// silently excluded from candidates even though it's an obviously better
// boarding point than something further away that happened to fall inside
// the tapered buffer along a seed path. This is a fixed walk-tolerance
// circle around each endpoint, applied on every pass regardless of taper.
export const ORIGIN_DEST_WALK_RADIUS_M = 900;

/** Perpendicular distance (meters) from `p` to segment a->b, plus how far
 *  along the segment (0..1) the closest point falls — needed for the taper. */
function distanceToSegment(p: LatLon, a: LatLon, b: LatLon): { distM: number; t: number } {
    // Local equirectangular projection around `a` — fine at city scale (a few
    // tens of km), far cheaper than proper great-circle projection per point.
    const latRef = toRadSafe(a.lat);
    const mPerDegLat = 111_320;
    const mPerDegLon = 111_320 * Math.cos(latRef);

    const toXY = (q: LatLon) => ({
        x: (q.lon - a.lon) * mPerDegLon,
        y: (q.lat - a.lat) * mPerDegLat,
    });
    const A = { x: 0, y: 0 };
    const B = toXY(b);
    const P = toXY(p);

    const abx = B.x - A.x, aby = B.y - A.y;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq === 0 ? 0 : ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = { x: A.x + t * abx, y: A.y + t * aby };
    const dx = P.x - closest.x, dy = P.y - closest.y;
    return { distM: Math.sqrt(dx * dx + dy * dy), t };
}

function toRadSafe(d: number): number { return (d * Math.PI) / 180; }

/**
 * Cheap lat/lon bounding-box pre-filter, run once per path before the
 * per-point distanceToSegment loop. Without this, tagStopsForPath was doing
 * `paths x segments x ALL candidate stops` — with a full 29K-stop candidate
 * list and ~24 seed paths that's several million distance calls (the
 * corridor-tagging step measured at ~11s). A path's tapered buffer can never
 * extend past its own bbox + max possible width, so any candidate outside
 * that box can be skipped for the whole path in O(1), before the expensive
 * per-segment geometry even starts.
 */
function bboxFilterCandidates(
    path: LatLon[],
    candidates: Array<{ stop_id: string; lat: number; lon: number }>,
    maxWidthM: number,
): Array<{ stop_id: string; lat: number; lon: number }> {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of path) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
    }
    // Convert the margin from meters to degrees using the path's own latitude
    // — fine at city scale, same approximation distanceToSegment already uses.
    const latRef = toRadSafe((minLat + maxLat) / 2);
    const marginLat = maxWidthM / 111_320;
    const marginLon = maxWidthM / (111_320 * Math.max(0.1, Math.cos(latRef)));

    const loLat = minLat - marginLat, hiLat = maxLat + marginLat;
    const loLon = minLon - marginLon, hiLon = maxLon + marginLon;

    return candidates.filter(c => c.lat >= loLat && c.lat <= hiLat && c.lon >= loLon && c.lon <= hiLon);
}

/**
 * Tags stops as in-corridor for one seed path (a polyline of lat/lon points).
 * Walks the path segment by segment, accumulating cumulative arc-length so
 * `t` (0..1 normalized progress) is continuous across the whole path, not
 * reset per segment — that's what makes the taper actually taper end-to-end
 * instead of oscillating per hop.
 */
function tagStopsForPath(
    path: LatLon[],
    candidates: Array<{ stop_id: string; lat: number; lon: number }>,
    minWidthM: number,
    taperKM: number,
): Set<string> {
    if (path.length < 2) return new Set();

    const segLengths: number[] = [];
    let totalLength = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const d = haversineMeters(path[i], path[i + 1]);
        segLengths.push(d);
        totalLength += d;
    }
    if (totalLength === 0) return new Set();

    const tagged = new Set<string>();
    let cumBefore = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const segLen = segLengths[i];

        for (const c of candidates) {
            if (tagged.has(c.stop_id)) continue;
            const { distM, t: localT } = distanceToSegment({ lat: c.lat, lon: c.lon }, a, b);
            const globalT = totalLength > 0 ? (cumBefore + localT * segLen) / totalLength : 0;
            const width = minWidthM + taperKM * Math.sin(Math.PI * globalT);
            if (distM <= width) tagged.add(c.stop_id);
        }
        cumBefore += segLen;
    }
    return tagged;
}

// How many points to sample along each seed path when building its taper
// outline. Purely a rendering-smoothness knob — has no effect on which
// stops get tagged (tagStopsForPath's own per-segment loop is unaffected).
// 20 is plenty for a Polygon at map zoom levels a phone screen can show.
const BOUNDARY_SAMPLES_PER_PATH = 20;

/**
 * Computes the tapered-buffer outline for one seed path: at each of
 * BOUNDARY_SAMPLES_PER_PATH evenly-arc-length-spaced points along the path,
 * finds the local direction, offsets perpendicular to it by the taper width
 * at that point (same minWidthM + taperKM*sin(pi*t) formula tagStopsForPath
 * uses), and records a point on each side. This is purely a debug-viz
 * convenience derived from the same taper the tagging pass already computes
 * — it changes nothing about which stops get included in the corridor.
 */
function boundaryForPath(path: LatLon[], minWidthM: number, taperKM: number): CorridorBoundary {
    const left: LatLon[] = [];
    const right: LatLon[] = [];
    if (path.length < 2) return { left, right };

    const segLengths: number[] = [];
    let totalLength = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const d = haversineMeters(path[i], path[i + 1]);
        segLengths.push(d);
        totalLength += d;
    }
    if (totalLength === 0) return { left, right };

    for (let s = 0; s <= BOUNDARY_SAMPLES_PER_PATH; s++) {
        const targetLen = (s / BOUNDARY_SAMPLES_PER_PATH) * totalLength;

        // Walk forward to find which segment contains targetLen.
        let acc = 0, segIdx = 0;
        while (segIdx < segLengths.length - 1 && acc + segLengths[segIdx] < targetLen) {
            acc += segLengths[segIdx];
            segIdx++;
        }
        const segLen = segLengths[segIdx];
        const segFrac = segLen > 0 ? (targetLen - acc) / segLen : 0;
        const a = path[segIdx];
        const b = path[segIdx + 1] ?? path[segIdx];

        const lat = a.lat + (b.lat - a.lat) * segFrac;
        const lon = a.lon + (b.lon - a.lon) * segFrac;

        const globalT = totalLength > 0 ? targetLen / totalLength : 0;
        const width = minWidthM + taperKM * Math.sin(Math.PI * globalT);

        // Local bearing of this segment, in the same equirectangular
        // approximation distanceToSegment already uses — fine at city scale.
        const mPerDegLat = 111_320;
        const mPerDegLon = 111_320 * Math.cos(toRadSafe(lat));
        const dxM = (b.lon - a.lon) * mPerDegLon;
        const dyM = (b.lat - a.lat) * mPerDegLat;
        const segLenM = Math.sqrt(dxM * dxM + dyM * dyM) || 1;
        // Unit perpendicular (rotate direction vector 90 degrees).
        const perpXM = -dyM / segLenM;
        const perpYM = dxM / segLenM;

        const dLat = (perpYM * width) / mPerDegLat;
        const dLon = (perpXM * width) / mPerDegLon;

        left.push({ lat: lat + dLat, lon: lon + dLon });
        right.push({ lat: lat - dLat, lon: lon - dLon });
    }

    return { left, right };
}

async function runOnce(
    origin: LatLon,
    destination: LatLon,
    originStopKeys: string[],
    destStopKeys: string[],
    candidates: Array<{ stop_id: string; lat: number; lon: number }>,
    minWidthM: number,
    taperKM: number,
    maxTransfers: number,
): Promise<CorridorResult> {
    const tGraph0 = Date.now();
    const graph = await getCoarseGraph();
    const tGraph1 = Date.now();
    const { paths, levelFrontiers, treeEdges: bfsTreeEdges } = findSeedPaths(graph, originStopKeys, destStopKeys, maxTransfers);
    const tBfs1 = Date.now();
    console.log(`[corridorTagging] getCoarseGraph: ${tGraph1 - tGraph0}ms, BFS: ${tBfs1 - tGraph1}ms (${paths.length} paths)`);

    if (paths.length === 0) {
        return { stopIds: new Set(), widened: false, seedPathCount: 0, seedPaths: [], levelFrontiers: [], bfsTreeEdges: [], corridorBoundaries: [] };
    }

    const union = new Set<string>();
    const corridorBoundaries: CorridorBoundary[] = [];
    for (const stopKeyPath of paths) {
        const polyline: LatLon[] = stopKeyPath.map(key => {
            const node = graph.nodesByKey.get(key);
            return node ? { lat: node.stop_lat, lon: node.stop_lon } : { lat: origin.lat, lon: origin.lon };
        });
        const maxWidthM = minWidthM + taperKM; // sin() peaks at 1, so this is the true max buffer width
        const localCandidates = bboxFilterCandidates(polyline, candidates, maxWidthM);
        const tagged = tagStopsForPath(polyline, localCandidates, minWidthM, taperKM);
        for (const s of tagged) union.add(s);
        corridorBoundaries.push(boundaryForPath(polyline, minWidthM, taperKM));
    }

    // Always keep the immediate origin/destination neighborhoods in-corridor,
    // regardless of taper — matches the spec's "never taper to zero" floor.
    // Uses a fixed walk-tolerance radius, NOT minWidthM, so this floor stays
    // consistent (and realistic) across both the narrow first pass and the
    // widened retry — see ORIGIN_DEST_WALK_RADIUS_M above.
    for (const c of candidates) {
        if (haversineMeters(origin, { lat: c.lat, lon: c.lon }) <= ORIGIN_DEST_WALK_RADIUS_M) union.add(c.stop_id);
        if (haversineMeters(destination, { lat: c.lat, lon: c.lon }) <= ORIGIN_DEST_WALK_RADIUS_M) union.add(c.stop_id);
    }
    console.log(`[corridorTagging] tagging (${paths.length} paths x ${candidates.length} candidates, bbox-filtered): ${Date.now() - tBfs1}ms -> ${union.size} stops`);

    return { stopIds: union, widened: false, seedPathCount: paths.length, seedPaths: paths, levelFrontiers, bfsTreeEdges, corridorBoundaries };
}

/**
 * Full entry point: builds the corridor, retrying with a wider buffer once
 * if the result looks too small (spec step 5). If even the widened corridor
 * comes back empty/tiny, returns widened:true with whatever it found — the
 * caller (gtfsLoader) can decide whether to fall back to the full network.
 *
 * KEPT ONLY as the fallback path now — see computeSeedPathCorridor below,
 * which is the normal path. This full bbox-tag-every-candidate-stop pass
 * (~800-1500ms per call, tagging all ~29K stops against the tapered buffer)
 * is only worth paying when the seed-path-derived approach can't find
 * enough patterns to work with (e.g. BFS came back with very few/no paths).
 */
const DEFAULT_MAX_TRANSFERS = 5;

export async function computeCorridor(
    origin: LatLon,
    destination: LatLon,
    originStopKeys: string[],
    destStopKeys: string[],
    candidates: Array<{ stop_id: string; lat: number; lon: number }>,
    maxTransfers: number = DEFAULT_MAX_TRANSFERS,
): Promise<CorridorResult> {
    const first = await runOnce(origin, destination, originStopKeys, destStopKeys, candidates, MIN_WIDTH_M, TAPER_K_M, maxTransfers);
    if (first.stopIds.size >= MIN_ACCEPTABLE_STOPS) return first;

    console.log(`[corridorTagging] first pass gave only ${first.stopIds.size} stops (${first.seedPathCount} seed paths) — widening and retrying`);
    const widened = await runOnce(origin, destination, originStopKeys, destStopKeys, candidates, WIDEN_MIN_WIDTH_M, WIDEN_TAPER_K_M, maxTransfers);
    return { ...widened, widened: true };
}

/** Minimal DB shape this module needs — avoids importing gtfsDb's concrete
 *  SQLiteDatabase class here (would be a layering inversion: gtfsDb is
 *  lower-level than corridorTagging). Structurally compatible with the real
 *  SQLiteDatabase passed in from gtfsLoader.ts. */
interface QueryableDb {
    getAllAsync<T>(sql: string, params?: any[]): Promise<T[]>;
}

export interface SeedPathCorridorResult {
    /** Patterns that actually contain a consecutive stop-pair from some seed
     *  path, per the DB (authoritative — not coarseGraph's lossy
     *  viaPatternKey). Typically ~99% fewer than the old bbox-tag-then-query
     *  approach, since it's bounded by "lines BFS actually found," not
     *  "every pattern that geographically passes near the buffer." */
    patternKeys: Set<string>;
    /** Stops within the fixed walk-tolerance radius of origin/destination —
     *  see ORIGIN_DEST_WALK_RADIUS_M. Unioned into the caller's final
     *  allowedStopIds alongside every stop the kept patterns actually visit,
     *  so a nearby-but-off-pattern boarding stop still isn't silently
     *  dropped. This is the ONLY per-stop geometry pass this path does —
     *  no tagStopsForPath, no bbox pre-filter, no taper. */
    walkRadiusStopIds: Set<string>;
    seedPathCount: number;
    seedPaths: string[][];
    levelFrontiers: string[][];
    bfsTreeEdges: [string, string][];
    /** Same taper-outline shape as CorridorBoundary — computed directly from
     *  the seed paths for debug display only, no relation to which stops/
     *  patterns get kept. */
    corridorBoundaries: CorridorBoundary[];
}

/**
 * Normal path (replaces computeCorridor for the common case): skips bbox
 * tagging of every candidate stop entirely. Instead of "which stops fall in
 * a tapered buffer around the seed paths, then which patterns touch those
 * stops," this asks directly "which patterns actually run along the seed
 * paths' consecutive stop-pairs" — the same authoritative DB check
 * gtfsLoader.ts used to run only as a comparison diagnostic. Falls back to
 * the caller invoking computeCorridor's bbox approach when this comes back
 * too thin (see gtfsLoader.ts's MIN_ACCEPTABLE_PATTERNS check).
 */
export async function computeSeedPathCorridor(
    origin: LatLon,
    destination: LatLon,
    originStopKeys: string[],
    destStopKeys: string[],
    candidates: Array<{ stop_id: string; lat: number; lon: number }>,
    maxTransfers: number,
    db: QueryableDb,
): Promise<SeedPathCorridorResult> {
    const tGraph0 = Date.now();
    const graph = await getCoarseGraph();
    const tGraph1 = Date.now();
    const { paths, levelFrontiers, treeEdges: bfsTreeEdges } = findSeedPaths(graph, originStopKeys, destStopKeys, maxTransfers);
    const tBfs1 = Date.now();
    console.log(`[corridorTagging] getCoarseGraph: ${tGraph1 - tGraph0}ms, BFS: ${tBfs1 - tGraph1}ms (${paths.length} paths)`);

    const walkRadiusStopIds = new Set<string>();
    for (const c of candidates) {
        if (haversineMeters(origin, { lat: c.lat, lon: c.lon }) <= ORIGIN_DEST_WALK_RADIUS_M) walkRadiusStopIds.add(c.stop_id);
        if (haversineMeters(destination, { lat: c.lat, lon: c.lon }) <= ORIGIN_DEST_WALK_RADIUS_M) walkRadiusStopIds.add(c.stop_id);
    }

    if (paths.length === 0) {
        return {
            patternKeys: new Set(), walkRadiusStopIds, seedPathCount: 0,
            seedPaths: [], levelFrontiers, bfsTreeEdges, corridorBoundaries: [],
        };
    }

    const corridorBoundaries: CorridorBoundary[] = paths.map(stopKeyPath => {
        const polyline: LatLon[] = stopKeyPath.map(key => {
            const node = graph.nodesByKey.get(key);
            return node ? { lat: node.stop_lat, lon: node.stop_lon } : { lat: origin.lat, lon: origin.lon };
        });
        return boundaryForPath(polyline, MIN_WIDTH_M, TAPER_K_M);
    });

    // Patterns to keep: any pattern that stops at ANY stop the seed paths
    // actually pass through — not just "patterns containing this exact
    // consecutive pair." The earlier, tighter version (exact-pair match)
    // only ever found the ONE pattern variant coarseGraph's clique-BFS
    // happened to traverse between two stops, silently excluding sibling
    // pattern variants (express/local, inbound/outbound stopping
    // differences, etc) that serve the SAME physical stops. Those sibling
    // variants are exactly what a real trip search needs to transfer onto
    // at an interchange — without them RAPTOR can board once, then stall.
    //
    // NOTE: an earlier version of this function ALSO swept a geometric
    // buffer around BFS's paths (first the whole path, then just
    // "suspiciously long" hops) to compensate for coarseGraph treating a
    // pattern's stops as a direction-agnostic clique — BFS could clique-jump
    // to a stop downstream of where you'd actually need to board, and the
    // sweep was a downstream patch to net in whatever correctly-directioned
    // connector happened to sit nearby. Both attempts either missed the
    // case or ballooned corridor size/search cost on unrelated long-haul
    // trips (regional rail routinely has genuine multi-km adjacent-stop
    // hops, indistinguishable from a clique-jump by distance alone). The
    // actual fix is upstream in coarseGraph.ts: transit clique edges are now
    // direction-respecting (only i -> j for i < j in real stop_sequence
    // order), so BFS can no longer construct a wrong-direction jump in the
    // first place — no sweep needed here anymore.
    const coreStopIds = new Set<string>();
    for (const path of paths) {
        for (const stopKey of path) coreStopIds.add(parseKey(stopKey).id);
    }

    const patternKeys = new Set<string>();
    if (coreStopIds.size > 0) {
        const rows = await db.getAllAsync<{ pattern_id: string; agency: number }>(
            `SELECT DISTINCT pattern_id, agency FROM pattern_stops WHERE stop_id IN (SELECT value FROM json_each(?))`,
            [JSON.stringify([...coreStopIds])],
        );
        for (const r of rows) patternKeys.add(`${r.agency}:${r.pattern_id}`);
    }
    console.log(`[corridorTagging] seed-path-derived patterns: ${patternKeys.size} from ${coreStopIds.size} core stops (${paths.length} paths): ${Date.now() - tBfs1}ms`);

    return {
        patternKeys, walkRadiusStopIds, seedPathCount: paths.length,
        seedPaths: paths, levelFrontiers, bfsTreeEdges, corridorBoundaries,
    };
}