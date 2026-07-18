import React, { useMemo } from 'react';
import { Polygon, Polyline, LatLng as MapLatLng } from 'react-native-maps';
import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import { CORRIDOR_CHUNK_COUNT } from '@/store/debug.slice';

const BFS_FRONTIER_COLOR = '#3b82f6';
const CORRIDOR_COLOR = 'rgba(148, 163, 184, 0.5)';
const CORRIDOR_STROKE = 'rgba(148, 163, 184, 0.9)';
const RAPTOR_COLOR = '#ef4444';

type Pt = { latitude: number; longitude: number };

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
    const bfsHull = useMemo(() => {
        if (!data || phase !== 'bfs') return null;
        return convexHull(data.bfsLevels[stepIndex] ?? []);
    }, [data, phase, stepIndex]);

    const raptorHull = useMemo(() => {
        if (!data || phase !== 'raptor') return null;
        return convexHull(data.roundMarkedStops[stepIndex] ?? []);
    }, [data, phase, stepIndex]);

    if (!enabled || !data) return null;

    return (
        <>
            {phase === 'bfs' && bfsHull && bfsHull.length >= 3 && (
                <Polygon
                    coordinates={bfsHull as MapLatLng[]}
                    strokeWidth={1.5}
                    strokeColor={BFS_FRONTIER_COLOR}
                    fillColor={`${BFS_FRONTIER_COLOR}33`}
                />
            )}

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
