import React, { useMemo } from 'react';
import { Polygon, Polyline, Marker, LatLng as MapLatLng } from 'react-native-maps';
import { View, Text } from 'react-native';
import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import { keyOfPt, flattenRaptorSteps, flattenBfsCandidates } from '@/services/gtfs/debug/debugBfsPoints';

const BFS_HULL_COLOR = '#3b82f6';
// Amber — deliberately far from BFS_HULL_COLOR's blue and RAPTOR_COLOR's
// red, so a "found route" pop reads instantly against whichever phase it
// appears in. Thicker stroke (see usage below) does the rest of the work.
const BFS_CANDIDATE_COLOR = '#f59e0b';
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
 * mode). Two phases:
 *
 *  - bfs: corridor-finding. Candidate display has two modes
 *    (state.bfsCandidateMode, toggled in DebugControls.tsx):
 *      - 'cumulative': stepIndex = round. Shows that round's frontier hull
 *        (bfsLevels[stepIndex]) plus every seed-path candidate whose
 *        destination has been reached by this round or earlier —
 *        "everything found so far."
 *      - 'single': stepIndex = candidate index (see flattenBfsCandidates).
 *        Shows exactly ONE candidate as a single full polyline (no
 *        per-leg/per-pattern coloring — kept simple), paired with the hull
 *        for whichever round that candidate was first found in.
 *    Either way, candidates are drawn with each pattern's real GTFS shape
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
 *    alongside it for context.
 *
 * Must be rendered as a child of <MapView>. Renders nothing when debug mode
 * is off or there's no data yet.
 */
export default function DebugMapOverlay() {
    const { enabled, data, phase, stepIndex, bfsCandidateMode } = useSelector((s: RootState) => s.debug);

    const bfsCandidateSteps = useMemo(() => {
        if (!data) return [];
        return flattenBfsCandidates(data.seedPaths, data.bfsLevels);
    }, [data]);

    const bfsView = useMemo(() => {
        if (!data || phase !== 'bfs') return null;
        const levels = data.bfsLevels ?? [];

        if (bfsCandidateMode === 'single') {
            if (bfsCandidateSteps.length === 0) return null;
            const candidate = bfsCandidateSteps[Math.min(stepIndex, bfsCandidateSteps.length - 1)];
            const hull = convexHull(levels[candidate.round] ?? []);
            return { hull, candidates: candidate.path.length >= 2 ? [candidate.path] : [] };
        }

        // 'cumulative' — stepIndex is a round number here.
        const round = Math.min(stepIndex, Math.max(0, levels.length - 1));
        const hull = convexHull(levels[round] ?? []);

        // Union of every round's stops up to and including the current one,
        // so "candidates found so far" only grows as stepIndex advances —
        // matches bfs's round-by-round exploration semantics instead of
        // showing everything at once.
        const revealedKeys = new Set<string>();
        for (let r = 0; r <= round; r++) {
            for (const p of levels[r] ?? []) revealedKeys.add(keyOfPt(p));
        }
        const candidates = (data.seedPaths ?? []).filter(path => {
            const dest = path[path.length - 1];
            return dest && path.length > 1 && revealedKeys.has(keyOfPt(dest));
        });

        return { hull, candidates };
    }, [data, phase, stepIndex, bfsCandidateMode, bfsCandidateSteps]);

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

            {/* A candidate route "pops" against the blue hull — thicker and
                amber, whether it's the whole cumulative set or the single
                one being stepped through right now. */}
            {phase === 'bfs' && bfsView?.candidates.map((path, i) => (
                path.length >= 2 && (
                    <Polyline
                        key={`bfs-candidate-${i}`}
                        coordinates={path as MapLatLng[]}
                        strokeWidth={4}
                        strokeColor={BFS_CANDIDATE_COLOR}
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
