import React, { useMemo } from 'react';
import { Polygon, Polyline, Circle, LatLng as MapLatLng } from 'react-native-maps';
import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import { CORRIDOR_CHUNK_COUNT, MAX_BFS_DEBUG_POINTS } from '@/store/debug.slice';
import { getBfsDiscoveryPoints, keyOfPt } from '@/services/gtfs/debug/debugBfsPoints';

const BFS_FRONTIER_COLOR = '#3b82f6';
// Amber — deliberately far from BFS_FRONTIER_COLOR's blue and RAPTOR_COLOR's
// red, so a "found route" pop reads instantly against whichever phase it
// appears in. Thicker stroke (see usage below) does the rest of the work.
const BFS_CANDIDATE_COLOR = '#f59e0b';
const CORRIDOR_COLOR = 'rgba(148, 163, 184, 0.5)';
const CORRIDOR_STROKE = 'rgba(148, 163, 184, 0.9)';
const RAPTOR_COLOR = '#ef4444';

type Pt = { latitude: number; longitude: number };

/**
 * Minimal convex hull (monotone chain / Andrew's algorithm) over a small
 * set of lat/lon points. Used to render a RAPTOR frontier as ONE polygon
 * instead of one Circle per stop.
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
 *  - bfs: a single continuous polyline through discovery order (see
 *    debugBfsPoints.ts), revealed one real point at a time at
 *    BFS_STEP_INTERVAL_MS (~30fps by default) — reads as "watch it explore
 *    in the order it actually happened." Any seed path whose destination
 *    stop has already been reached gets drawn on top, thicker and in
 *    amber, as an emphasized "candidate route found" overlay.
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

    // Recomputed only when the underlying data or step changes, not on every
    // unrelated re-render (e.g. map pan/zoom triggering a parent re-render).
    //
    // Single continuous polyline through BFS discovery order, instead of the
    // old merged-chain-of-edges approach — a lot simpler, and since a
    // Polyline is ONE native object regardless of point count, chain-merging
    // was solving a problem (native object count) that a single polyline
    // doesn't have in the first place. MAX_BFS_DEBUG_POINTS below is just a
    // sane ceiling on coordinate-array/bridge payload size for a very large
    // exploration, not a correctness requirement.
    //
    // candidates: any seedPath whose destination stop's key is already
    // among the revealed BFS points — i.e. "BFS just reached the far end of
    // a real route," rendered as an emphasized overlay so a found candidate
    // visibly pops against the still-exploring line around it.
    const bfsReveal = useMemo(() => {
        if (!data || phase !== 'bfs') return null;
        const allPoints = getBfsDiscoveryPoints(data);
        if (allPoints.length === 0) return { points: [] as Pt[], candidates: [] as Pt[][] };

        const revealCount = Math.min(allPoints.length, stepIndex + 1);
        let points = allPoints.slice(0, revealCount);

        if (points.length > MAX_BFS_DEBUG_POINTS) {
            const stride = points.length / MAX_BFS_DEBUG_POINTS;
            const sampled: Pt[] = [];
            for (let i = 0; i < MAX_BFS_DEBUG_POINTS; i++) sampled.push(points[Math.floor(i * stride)]);
            // Keep the true leading edge exact — don't let sampling lag behind
            // where discovery has actually reached.
            sampled[sampled.length - 1] = points[points.length - 1];
            points = sampled;
        }

        const revealedKeys = new Set(allPoints.slice(0, revealCount).map(keyOfPt));
        const candidates = (data.seedPaths ?? []).filter(path => {
            const dest = path[path.length - 1];
            return dest && path.length > 1 && revealedKeys.has(keyOfPt(dest));
        });

        return { points, candidates };
    }, [data, phase, stepIndex]);

    const raptorHull = useMemo(() => {
        if (!data || phase !== 'raptor') return null;
        return convexHull(data.roundMarkedStops[stepIndex] ?? []);
    }, [data, phase, stepIndex]);

    if (!enabled || !data) return null;

    return (
        <>
            {phase === 'bfs' && bfsReveal && bfsReveal.points.length >= 2 && (
                <Polyline
                    coordinates={bfsReveal.points as MapLatLng[]}
                    strokeWidth={2}
                    strokeColor={BFS_FRONTIER_COLOR}
                />
            )}

            {/* A candidate route "pops" the moment BFS reaches its destination
                stop — drawn thicker and in amber so it visibly stands out from
                the still-exploring blue line around it. */}
            {phase === 'bfs' && bfsReveal?.candidates.map((path, i) => (
                path.length >= 2 && (
                    <Polyline
                        key={`bfs-candidate-${i}`}
                        coordinates={path as MapLatLng[]}
                        strokeWidth={4}
                        strokeColor={BFS_CANDIDATE_COLOR}
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
