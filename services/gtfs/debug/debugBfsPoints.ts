// debugBfsPoints.ts
// Location: services/gtfs/debug/debugBfsPoints.ts

import type { GtfsDebugInfo } from '@/services/gtfs/router/raptorRouter';

export type Pt = { latitude: number; longitude: number };

export function keyOfPt(p: Pt): string {
    return `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
}

/**
 * One entry per individual RAPTOR route-check step (NOT per round — a
 * round can contain several checks, one per pattern examined that round).
 * Flattening like this is the single source of truth for "what does
 * stepIndex mean during the raptor phase" — used by debug.slice.ts (to
 * know how many steps the phase has) and DebugMapOverlay.tsx (to know
 * which round's route to actually draw for a given stepIndex). Keeping it
 * in one place means the two can't drift out of sync on what a "step" is.
 *
 * `coords` is the FULL journey-so-far chain (origin-side boarding history
 * through earlier rounds, not just this round's own segment) — see
 * raptor.rs's backtrack_stop_chain. `routeColor`/`routeName` are the
 * pattern's real GTFS route color/name when the feed provides them; falls
 * back to a default color in DebugMapOverlay.tsx when absent, and no label
 * is shown when routeName is absent.
 */
export type RaptorStep = { round: number; coords: Pt[]; routeColor?: string; routeName?: string };

export function flattenRaptorSteps(routeChecks: GtfsDebugInfo['routeChecks']): RaptorStep[] {
    const steps: RaptorStep[] = [];
    (routeChecks ?? []).forEach((checksThisRound, round) => {
        checksThisRound.forEach(check => steps.push({
            round, coords: check.coords, routeColor: check.routeColor, routeName: check.routeName,
        }));
    });
    return steps;
}

/** Total step count for the raptor phase — just `flattenRaptorSteps(...).length`,
 *  but exposed directly so callers that only need the count (debug.slice.ts)
 *  don't have to build (and immediately discard) the whole array. */
export function raptorStepCount(data: GtfsDebugInfo): number {
    let total = 0;
    for (const checks of data.routeChecks ?? []) total += checks.length;
    return total;
}

/**
 * One entry per candidate seed path, in "discovery order" — the round at
 * which its destination stop first showed up in `bfsLevels` (i.e. the
 * earliest round BFS reached the far end of that candidate). This is the
 * bfs phase's equivalent of RaptorStep/flattenRaptorSteps: the single
 * source of truth for one-at-a-time candidate stepping, used by both
 * debug.slice.ts (step count) and DebugMapOverlay.tsx (which round's hull
 * to pair with a given candidate, and which single path to draw).
 *
 * A path whose destination never appears in bfsLevels (shouldn't normally
 * happen — it's how the path was found in the first place) falls back to
 * the last round, so it still shows up rather than silently vanishing.
 */
export type BfsCandidateStep = { round: number; path: Pt[] };

export function flattenBfsCandidates(seedPaths: GtfsDebugInfo['seedPaths'], bfsLevels: GtfsDebugInfo['bfsLevels']): BfsCandidateStep[] {
    const lastRound = Math.max(0, (bfsLevels?.length ?? 1) - 1);
    return (seedPaths ?? []).map(path => {
        const dest = path[path.length - 1];
        if (!dest) return { round: lastRound, path };
        const destKey = keyOfPt(dest);
        const round = (bfsLevels ?? []).findIndex(level => level.some(p => keyOfPt(p) === destKey));
        return { round: round === -1 ? lastRound : round, path };
    });
}
