import React, { useMemo } from 'react';
import { Polygon, Polyline, Marker, LatLng as MapLatLng } from 'react-native-maps';
import { View, Text } from 'react-native';
import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import { flattenRaptorSteps, flattenHopColoredCandidates, hopColor, depthColor } from '@/services/gtfs/debug/debugBfsPoints';
import { useDebugData, useBfsCandidateSteps } from '@/services/gtfs/debug/debugDataStore';

const BFS_HULL_COLOR = '#3b82f6';
// NOTE: was a single fixed amber for every bfs candidate regardless of
// depth — replaced by depthColor() (debugBfsPoints.ts) below, so this
// constant is gone rather than left unused.
const RAPTOR_HULL_COLOR = '#ef4444';
// Fallback only — the actual route-check polyline uses the pattern's real
// GTFS route_color (see raptorView below) when the feed provides one; this
// is just what shows for the rare pattern with no color set.
const RAPTOR_ROUTE_COLOR_FALLBACK = '#ef4444';

type Pt = { latitude: number; longitude: number };

/**
 * Minimal convex hull (monotone chain / Andrew's algorithm) over a small
 * set of lat/lon points. Used for BOTH phases now: BFS's per-round
 * frontier and RAPTOR's per-round marked-stop frontier — same shape of
 * data (a round -> set-of-stops snapshot), same reason to hull it instead
 * of drawing N Circles (see the original rationale below).
 *
 * Why this replaces the old per-stop Circle rendering: react-native-maps
 * backs every <Circle> with a real native Google Maps object, so N stops
 * meant N native allocations + N bridge crossings per render — that's what
 * forced the old MAX_DEBUG_MARKERS sampling cap (corridor stops hit 1359,
 * RAPTOR rounds hit 2000-3000 marked stops, both OOM'd unsampled). A
 * Polygon/Polyline is ONE native object regardless of point count, so
 * there's no cap needed here at all.
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

/** Middle point (by point count, not distance) of a polyline — good enough
 *  for "roughly where to put a label," not meant to be the geometric
 *  midpoint by length. */
function midpoint(coords: Pt[]): Pt {
    return coords[Math.floor(coords.length / 2)];
}

/**
 * Shared route-name label — a small pill anchored at a route's midpoint.
 * The ONE place both debug phases and (eventually) normal route rendering
 * can pull this from, per the ask to keep the rendering approach
 * consistent rather than each spot reinventing its own label. Currently
 * only wired up for the raptor phase, since that's the one place a single
 * pattern (and therefore a single unambiguous name) is guaranteed — see
 * this file's header note on why bfs candidates don't use it yet.
 */
function RouteNameLabel({ coords, name, color }: { coords: Pt[]; name?: string; color: string }) {
    if (!name || coords.length === 0) return null;
    const at = midpoint(coords);
    return (
        <Marker coordinate={at as MapLatLng} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={{ backgroundColor: color, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{name}</Text>
            </View>
        </Marker>
    );
}

/**
 * Renders the CURRENT active unit of the last debug-mode search — not a
 * cumulative replay, except where noted (bfs's 'cumulative' candidate
 * mode, and hopColorMode below). Two phases:
 *
 *  - bfs: corridor-finding. Candidate display has two INDEPENDENT toggles
 *    (both in DebugControls.tsx):
 *      - state.bfsCandidateMode ('cumulative' | 'single') — WHICH
 *        candidates are visible, gated by stepIndex/round-discovery. See
 *        bfsView below, unchanged from before.
 *      - state.hopColorMode (boolean) — HOW a visible candidate's shape is
 *        colored. When true, this OVERRIDES bfsView's flat-amber
 *        candidate rendering for whichever candidate(s) bfsCandidateMode/
 *        stepIndex currently makes visible (the current candidate alone in
 *        'single' mode, the round-gated set in 'cumulative' mode) — each of
 *        THOSE candidates' every hop is drawn, colored by hopColor() (real
 *        route_color when the hop has one, else a synthetic per-hop-index
 *        palette, else a fixed gray for walk legs). It does not change
 *        WHICH candidates are visible, only how the visible one(s) are
 *        colored. The round hull still renders underneath for context
 *        either way.
 *    Either mode draws candidates with each pattern's real GTFS shape
 *    (trimmed to the ridden portion) rather than a straight stop-to-stop
 *    line where the Rust side could resolve one — see lib.rs's
 *    shaped_edge_coords. No corridor-boundary polygon or walk-radius
 *    circles anymore — both were debug-visualization-only (routing never
 *    read them) and the app doesn't use geometric corridor filtering.
 *
 *  - raptor: stepped per individual candidate-route check (see RaptorStep),
 *    NOT accumulated — only the current step's route polyline is drawn,
 *    replaced each step, since RAPTOR here only walks the small
 *    corridor-restricted candidate set. That polyline is the FULL
 *    journey-so-far — connected back through earlier rounds' boarding
 *    history, not just this round's isolated segment — colored by the
 *    pattern's real GTFS route_color when the feed has one, with its name
 *    shown via RouteNameLabel. The round's marked-stop hull is drawn
 *    alongside it for context. hopColorMode has no effect here — it's
 *    bfs-only (see DebugControls.tsx, which only shows the toggle during
 *    the bfs phase).
 *
 * Must be rendered as a child of <MapView>. Renders nothing when debug mode
 * is off or there's no data yet.
 */
export default function DebugMapOverlay() {
    const { enabled, phase, stepIndex, bfsCandidateMode, hopColorMode } = useSelector((s: RootState) => s.debug);
    // Data lives outside Redux (see debugDataStore.ts); candidate steps are
    // computed once per search there, not on every render.
    const data = useDebugData();
    const bfsCandidateSteps = useBfsCandidateSteps();

    const bfsView = useMemo(() => {
        if (!data || phase !== 'bfs') return null;
        const levels = data.bfsLevels ?? [];

        if (bfsCandidateMode === 'single') {
            if (bfsCandidateSteps.length === 0) return null;
            const candidate = bfsCandidateSteps[Math.min(stepIndex, bfsCandidateSteps.length - 1)];
            const hull = convexHull(levels[candidate.round] ?? []);
            return { hull, candidates: candidate.path.length >= 2 ? [{ path: candidate.path, depth: candidate.depth, pathIndex: candidate.pathIndex }] : [] };
        }

        // 'cumulative' — stepIndex is a round number here.
        const round = Math.min(stepIndex, Math.max(0, levels.length - 1));
        const hull = convexHull(levels[round] ?? []);

        // "candidates found so far" only grows as stepIndex advances —
        // matches bfs's round-by-round exploration semantics instead of
        // showing everything at once. Reuses bfsCandidateSteps' per-
        // candidate round (flattenBfsCandidates, same helper 'single' mode
        // uses below) as the single source of truth for "what round was
        // this candidate discovered." An earlier version of this file
        // derived round-membership inline via exact keyOfPt() equality
        // against bfsLevels — that broke once seedPath endpoints started
        // coming from trimmed real GTFS shape geometry (see
        // debugSinkCollector.ts) instead of the literal stop coordinate,
        // since a shape-trimmed point is near a bfsLevels stop but almost
        // never bit-for-bit equal to it, so the exact match silently
        // matched nothing and this view showed zero candidates. See
        // flattenBfsCandidates' tolerance-based match in debugBfsPoints.ts.
        const candidates = bfsCandidateSteps
            .filter(c => c.round <= round && c.path.length > 1)
            .map(c => ({ path: c.path, depth: c.depth, pathIndex: c.pathIndex }));

        return { hull, candidates };
    }, [data, phase, stepIndex, bfsCandidateMode, bfsCandidateSteps]);

    // Hop-colored view: every hop of whichever candidate(s) are CURRENTLY
    // VISIBLE per bfsView — i.e. the same one candidate in 'single' mode,
    // or the same round-gated set in 'cumulative' mode. This used to ignore
    // stepIndex/bfsCandidateMode entirely and show every candidate's every
    // hop all at once regardless of which candidate you'd stepped to — in
    // 'single' mode that meant stepping through candidates did nothing
    // visually (still every candidate overlaid), which reads as "stuck
    // replaying the same handful of journeys" and "multiple lines in the
    // single-candidate view." Restricting to bfsView's own candidate set
    // keeps hopColorMode doing what it says on the tin — recolor the
    // visible candidate(s) by hop — without changing WHICH candidates are
    // visible, which is still bfsCandidateMode/stepIndex's job.
    const hopColoredHops = useMemo(() => {
        if (!data || phase !== 'bfs' || !hopColorMode || !bfsView) return [];
        const visiblePathIndices = new Set(bfsView.candidates.map(c => c.pathIndex));
        return flattenHopColoredCandidates(data.seedPathHops).filter(hop => visiblePathIndices.has(hop.pathIndex));
    }, [data, phase, hopColorMode, bfsView]);

    const raptorSteps = useMemo(() => {
        if (!data) return [];
        return flattenRaptorSteps(data.routeChecks ?? []);
    }, [data]);

    const raptorView = useMemo(() => {
        if (!data || phase !== 'raptor' || raptorSteps.length === 0) return null;
        const step = raptorSteps[Math.min(stepIndex, raptorSteps.length - 1)];
        const hull = convexHull(data.roundMarkedStops[step.round] ?? []);
        return { route: step.coords, hull, routeColor: step.routeColor ?? RAPTOR_ROUTE_COLOR_FALLBACK, routeName: step.routeName };
    }, [data, phase, stepIndex, raptorSteps]);

    if (!enabled || !data) return null;

    return (
        <>
            {phase === 'bfs' && bfsView && bfsView.hull.length >= 3 && (
                <Polygon
                    coordinates={bfsView.hull as MapLatLng[]}
                    strokeWidth={1.5}
                    strokeColor={BFS_HULL_COLOR}
                    fillColor={`${BFS_HULL_COLOR}22`}
                />
            )}

            {/* Flat candidate view — suppressed when hopColorMode is on
                (hopColoredHops below replaces it entirely rather than
                layering on top). Colored by DEPTH now (see depthColor) —
                shallower/fewer-transfer candidates read as warmer colors,
                deeper ones cooler — instead of every candidate being the
                same fixed amber regardless of how many transfers it took
                to find it. */}
            {phase === 'bfs' && !hopColorMode && bfsView?.candidates.map(({ path, depth }, i) => (
                path.length >= 2 && (
                    <Polyline
                        key={`bfs-candidate-${i}`}
                        coordinates={path as MapLatLng[]}
                        strokeWidth={4}
                        strokeColor={depthColor(depth)}
                    />
                )
            ))}

            {/* Hop-colored candidate view — every hop of whichever
                candidate(s) bfsView currently has visible, each hop colored
                by hopColor() (real route_color / per-hop-index palette /
                walk gray). See hopColorMode's doc comment above. */}
            {phase === 'bfs' && hopColorMode && hopColoredHops.map(hop => (
                hop.coords.length >= 2 && (
                    <Polyline
                        key={`bfs-hop-${hop.pathIndex}-${hop.hopIndex}`}
                        coordinates={hop.coords as MapLatLng[]}
                        strokeWidth={hop.isWalk ? 3 : 4}
                        lineDashPattern={hop.isWalk ? [6, 6] : undefined}
                        strokeColor={hopColor(hop)}
                    />
                )
            ))}

            {/* RAPTOR's marked-stop frontier for the round the current
                route-check belongs to — context for "where in the search
                this candidate sits," not the focus itself. */}
            {phase === 'raptor' && raptorView && raptorView.hull.length >= 3 && (
                <Polygon
                    coordinates={raptorView.hull as MapLatLng[]}
                    strokeWidth={1.5}
                    strokeColor={RAPTOR_HULL_COLOR}
                    fillColor={`${RAPTOR_HULL_COLOR}22`}
                />
            )}

            {/* The actual focus of the raptor phase: ONE candidate route,
                replaced each step rather than accumulated. Colored by the
                pattern's real GTFS route_color when the feed has one, with
                its name/number labeled via the shared RouteNameLabel. */}
            {phase === 'raptor' && raptorView && raptorView.route.length >= 2 && (
                <>
                    <Polyline
                        coordinates={raptorView.route as MapLatLng[]}
                        strokeWidth={4}
                        strokeColor={raptorView.routeColor}
                    />
                    <RouteNameLabel coords={raptorView.route} name={raptorView.routeName} color={raptorView.routeColor} />
                </>
            )}
        </>
    );
}
