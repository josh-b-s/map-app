import React, { useMemo } from 'react';
import { Polygon, Polyline, Circle, LatLng as MapLatLng } from 'react-native-maps';
import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import { CORRIDOR_CHUNK_COUNT, BFS_REVEAL_STEPS, MAX_BFS_DEBUG_EDGES } from '@/store/debug.slice';

const BFS_FRONTIER_COLOR = '#3b82f6';
const CORRIDOR_COLOR = 'rgba(148, 163, 184, 0.5)';
const CORRIDOR_STROKE = 'rgba(148, 163, 184, 0.9)';
const RAPTOR_COLOR = '#ef4444';

type Pt = { latitude: number; longitude: number };

/**
 * Merges a set of tree edges (parent -> child pairs) into the SMALLEST
 * number of continuous polylines that still draw every edge exactly once.
 * This is the "web" alternative to both the original per-stop Circles and
 * the convex-hull Polygon: instead of approximating the frontier's shape,
 * it draws the actual connections BFS discovered — but merged along
 * branches so a deep, mostly-linear exploration (a long single branch with
 * occasional forks) still costs only a handful of native Polyline objects,
 * not one per edge.
 *
 * How it works: build an adjacency map from the edge list, then repeatedly
 * walk from any not-yet-visited node along its unvisited outgoing edges,
 * extending the current chain until every reachable unused edge from the
 * current node is exhausted, then start a new chain from the next
 * unvisited edge. A tree with B "leaf branches" produces at most B chains
 * — far fewer than the total edge count for a typical BFS tree shape (a
 * handful of deep branches, not one edge fanning out independently).
 */
function mergeEdgesIntoChains(edges: { from: Pt; to: Pt }[]): Pt[][] {
    if (edges.length === 0) return [];

    const keyOf = (p: Pt) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;

    const adjacency = new Map<string, { point: Pt; neighbor: string; edgeId: number }[]>();
    const pointByKey = new Map<string, Pt>();
    edges.forEach((e, i) => {
        const fromKey = keyOf(e.from);
        const toKey = keyOf(e.to);
        pointByKey.set(fromKey, e.from);
        pointByKey.set(toKey, e.to);
        if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
        if (!adjacency.has(toKey)) adjacency.set(toKey, []);
        adjacency.get(fromKey)!.push({ point: e.to, neighbor: toKey, edgeId: i });
        adjacency.get(toKey)!.push({ point: e.from, neighbor: fromKey, edgeId: i });
    });

    const usedEdges = new Set<number>();
    const chains: Pt[][] = [];

    for (const [startKey, startPoint] of pointByKey) {
        let current = startKey;
        let currentPoint = startPoint;
        const chain: Pt[] = [];
        let extended = false;

        while (true) {
            const options = (adjacency.get(current) ?? []).filter(o => !usedEdges.has(o.edgeId));
            if (options.length === 0) break;
            const next = options[0];
            usedEdges.add(next.edgeId);
            if (chain.length === 0) chain.push(currentPoint);
            chain.push(next.point);
            current = next.neighbor;
            currentPoint = next.point;
            extended = true;
        }

        if (extended) chains.push(chain);
    }

    return chains;
}

/**
 * Minimal convex hull (monotone chain / Andrew's algorithm) over a small
 * set of lat/lon points. Used to render a BFS/RAPTOR frontier as ONE
 * polygon instead of one Circle per stop.
 *
 * Why this replaces the old per-stop Circle rendering: react-native-maps
 * backs every <Circle> with a real native Google Maps object, so N stops
 * meant N native allocations + N bridge crossings per render — that's what
 * forced the old MAX_DEBUG_MARKERS sampling cap (corridor stops hit 1359,
 * RAPTOR rounds hit 2000-3000 marked stops, both OOM'd unsampled). A
 * Polygon/Polyline is ONE native object regardless of point count, so
 * there's no cap needed here at all — the whole frontier can be included
 * exactly, no sampling required. For a "watch the search happen" debug
 * viz, a hull outline reads as "the region currently being explored,"
 * which fits the goal at least as well as a scatter of dots did, at a
 * fraction of the render cost.
 *
 * Falls back to returning the points as-is for <3 points (no polygon is
 * meaningful yet).
 */
function convexHull(points: Pt[]): Pt[] {
    if (points.length < 3) return points;

    // Sort by longitude then latitude — arbitrary but consistent axis choice.
    const sorted = [...points].sort((a, b) => a.longitude - b.longitude || a.latitude - b.latitude);

    const cross = (o: Pt, a: Pt, b: Pt) =>
        (a.longitude - o.longitude) * (b.latitude - o.latitude) -
        (a.latitude - o.latitude) * (b.longitude - o.longitude);

    const lower: Pt[] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
        }
        lower.push(p);
    }

    const upper: Pt[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
        }
        upper.push(p);
    }

    // Last point of each list is the first point of the other — drop the
    // duplicates before concatenating into the closed ring.
    upper.pop();
    lower.pop();
    return [...lower, ...upper];
}

/**
 * Renders the CURRENT active unit of the last debug-mode search — not a
 * cumulative replay. Each phase shows only what's happening right now:
 *  - bfs: hull outline of the current level's frontier (the "active leg"
 *    being explored)
 *  - seed: the settled seed paths (single-shot, these ARE the result)
 *  - corridor: the tapered-buffer shape assembling in chunks, one more
 *    seed path's boundary revealed per step
 *  - raptor: hull outline of the current round's marked-stop frontier
 *
 * Must be rendered as a child of <MapView>. Renders nothing when debug mode
 * is off or there's no data yet.
 */
export default function DebugMapOverlay() {
    const { enabled, data, phase, stepIndex } = useSelector((s: RootState) => s.debug);

    // Hulls only need recomputing when the underlying data or step changes,
    // not on every unrelated re-render (e.g. map pan/zoom triggering a
    // parent re-render) — cheap to compute (frontier sets are small), but
    // no reason to redo it needlessly.
    // BFS "web" — reveals bfsTreeEdges (already in true discovery order —
    // see seedRouteBfs.ts) progressively in small batches, instead of
    // jumping a whole level at a time. This is what makes the playback
    // read as "watch it explore in the order it actually happened" rather
    // than "frontier teleports outward in big jumps."
    //
    // CRASH NOTE: a prior version of this used ALL of a level's edges
    // unconditionally, which — combined with this app's per-pattern CLIQUE
    // coarse-graph edges and multi-parent BFS tracking — could produce a
    // large, densely-branched edge set that mergeEdgesIntoChains can't
    // collapse into few chains (a bushy tree merges into MANY short chains,
    // not a few long ones). That produced enough native Polyline objects to
    // OOM the native Google Maps GL rendering thread. MAX_BFS_DEBUG_EDGES
    // below is a hard, evenly-sampled cap applied BEFORE merging, so the
    // worst-case native object count is bounded regardless of how bushy any
    // particular search's tree turns out to be.
    const bfsChains = useMemo(() => {
        if (!data || phase !== 'bfs') return null;
        const allEdges = data.bfsTreeEdges ?? [];
        if (allEdges.length === 0) return [];

        const chunkSize = Math.ceil(allEdges.length / BFS_REVEAL_STEPS) || 1;
        const revealCount = Math.min(allEdges.length, (stepIndex + 1) * chunkSize);
        let edgesToRender = allEdges.slice(0, revealCount);

        if (edgesToRender.length > MAX_BFS_DEBUG_EDGES) {
            const stride = edgesToRender.length / MAX_BFS_DEBUG_EDGES;
            const sampled: typeof edgesToRender = [];
            for (let i = 0; i < MAX_BFS_DEBUG_EDGES; i++) sampled.push(edgesToRender[Math.floor(i * stride)]);
            edgesToRender = sampled;
        }

        return mergeEdgesIntoChains(edgesToRender);
    }, [data, phase, stepIndex]);

    const raptorHull = useMemo(() => {
        if (!data || phase !== 'raptor') return null;
        return convexHull(data.roundMarkedStops[stepIndex] ?? []);
    }, [data, phase, stepIndex]);

    if (!enabled || !data) return null;

    return (
        <>
            {phase === 'bfs' && bfsChains && bfsChains.map((chain, i) => (
                chain.length >= 2 && (
                    <Polyline
                        key={`bfs-${i}`}
                        coordinates={chain as MapLatLng[]}
                        strokeWidth={2}
                        strokeColor={BFS_FRONTIER_COLOR}
                    />
                )
            ))}

            {phase === 'seed' && data.seedPaths.map((path, i) => (
                path.length > 1 && (
                    <Polyline
                        key={`seed-${i}`}
                        coordinates={path as MapLatLng[]}
                        strokeWidth={2.5}
                        strokeColor="rgba(168, 85, 247, 0.85)"
                        lineDashPattern={[6, 6]}
                    />
                )
            ))}

            {phase === 'corridor' && (() => {
                // Reveal one more seed path's boundary per step, so the
                // corridor visibly "assembles" the same way the old
                // chunked-Circle version did — just as whole shapes now,
                // one Polygon per seed path, instead of dots.
                const boundaries = data.corridorBoundary ?? [];
                const chunkSize = Math.ceil(boundaries.length / CORRIDOR_CHUNK_COUNT) || 1;
                const visibleCount = Math.min(boundaries.length, (stepIndex + 1) * chunkSize);
                return boundaries.slice(0, visibleCount).map((b, i) => {
                    if (b.left.length < 2 || b.right.length < 2) return null;
                    // Ring = left side forward + right side reversed, closing
                    // the loop back to the start.
                    const ring = [...b.left, ...[...b.right].reverse()];
                    return (
                        <Polygon
                            key={`corridor-${i}`}
                            coordinates={ring as MapLatLng[]}
                            strokeWidth={1}
                            strokeColor={CORRIDOR_STROKE}
                            fillColor={CORRIDOR_COLOR}
                        />
                    );
                });
            })()}

            {/* The tapered boundary above only shows the sin()-tapered shape,
                which has a nonzero floor (MIN_WIDTH_M) at each end — but the
                REAL corridor also unions in every stop within a fixed radius
                of origin/destination regardless of the taper (see
                corridorTagging.ts's ORIGIN_DEST_WALK_RADIUS_M). Without these
                two circles, the debug view understates how far the actual
                corridor extends at both ends. Only 2 native objects
                regardless of corridor size, so no sampling/chunking needed. */}
            {phase === 'corridor' && (data.walkRadiusCircles ?? []).map((c, i) => (
                <Circle
                    key={`walk-radius-${i}`}
                    center={c.center as MapLatLng}
                    radius={c.radiusMeters}
                    strokeWidth={1}
                    strokeColor={CORRIDOR_STROKE}
                    fillColor="rgba(148, 163, 184, 0.15)"
                />
            ))}

            {phase === 'raptor' && raptorHull && raptorHull.length >= 3 && (
                <Polygon
                    coordinates={raptorHull as MapLatLng[]}
                    strokeWidth={1.5}
                    strokeColor={RAPTOR_COLOR}
                    fillColor={`${RAPTOR_COLOR}33`}
                />
            )}
        </>
    );
}
