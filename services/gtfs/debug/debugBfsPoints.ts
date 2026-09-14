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
export type BfsCandidateStep = { round: number; path: Pt[]; depth: number; pathIndex: number };

// seedPath endpoints come from trimmed real GTFS shape geometry (see
// debugSinkCollector.ts), not the literal stop coordinate — so they're
// near a bfsLevels stop point but essentially never bit-for-bit equal to
// one. Exact keyOfPt() equality used to work back when both sides came
// from the same stop-coordinate source; now it doesn't, and silently
// matches nothing. ~0.0005deg is ~50m at most latitudes — comfortably
// bigger than a shape-trim gap, comfortably smaller than the distance
// between two distinct stops.
const MATCH_TOLERANCE_DEG = 0.0005;

function ptsNear(a: Pt, b: Pt): boolean {
    return Math.abs(a.latitude - b.latitude) < MATCH_TOLERANCE_DEG &&
        Math.abs(a.longitude - b.longitude) < MATCH_TOLERANCE_DEG;
}

export function flattenBfsCandidates(
    seedPaths: GtfsDebugInfo['seedPaths'],
    bfsLevels: GtfsDebugInfo['bfsLevels'],
    seedPathDepths?: GtfsDebugInfo['seedPathDepths'],
): BfsCandidateStep[] {
    const lastRound = Math.max(0, (bfsLevels?.length ?? 1) - 1);
    return (seedPaths ?? []).map((path, i) => {
        const dest = path[path.length - 1];
        const depth = seedPathDepths?.[i] ?? 0;
        if (!dest) return { round: lastRound, path, depth, pathIndex: i };
        const round = (bfsLevels ?? []).findIndex(level => level.some(p => ptsNear(p, dest)));
        return { round: round === -1 ? lastRound : round, path, depth, pathIndex: i };
    });
}

// ── Hop-colored candidate view ──────────────────────────────────────────
// Distinct from flattenBfsCandidates above: that one is about WHICH
// candidates are visible at a given step (single vs cumulative reveal).
// This is about HOW a candidate's own shape is colored once it's visible —
// an orthogonal axis, toggled independently (see debug.slice.ts's
// hopColorMode) and always showing every candidate's every hop at once
// regardless of stepIndex/bfsCandidateMode, per the "separate toggle for
// individual view already exists" call.

/** One hop (one transit boarding, or one walk leg) within a single
 *  candidate seed path — mirrors lib.rs's SeedPathHop record 1:1 after
 *  ubrn's camelCasing. `pathIndex` ties a hop back to which candidate it
 *  belongs to (kept even after flattening across all candidates, in case
 *  you want to e.g. dim/highlight one candidate's hops on tap later). */
export type SeedPathHop = {
    pathIndex: number;
    hopIndex: number;
    coords: Pt[];
    isWalk: boolean;
    routeColor?: string;
};

// Cycled by hopIndex % length — deliberately NOT reusing BFS_HULL_COLOR
// (#3b82f6, already the hull) or BFS_CANDIDATE_COLOR (#f59e0b, the
// existing flat-candidate color) as position 0/1, so the hop palette reads
// as visually distinct from both of those even on hop 0/1. Walk hops
// always render as a fixed neutral gray instead of a palette color (see
// hopColor below) — a footpath isn't a "line" worth its own palette slot.
const HOP_PALETTE = ['#ef4444', '#8b5cf6', '#10b981', '#f97316', '#0ea5e9', '#ec4899', '#14b8a6', '#eab308'];
export const WALK_HOP_COLOR = '#9ca3af';

/** Color for a given hop — real GTFS route_color if the hop has one (so a
 *  hop-colored view and a route-colored view agree on well-known lines),
 *  else a synthetic color cycled by hop_index, else the fixed walk color
 *  for a footpath leg. */
export function hopColor(hop: Pick<SeedPathHop, 'hopIndex' | 'isWalk' | 'routeColor'>): string {
    if (hop.routeColor) return `#${hop.routeColor.replace(/^#/, '')}`;
    if (hop.isWalk) return WALK_HOP_COLOR;
    return HOP_PALETTE[hop.hopIndex % HOP_PALETTE.length];
}

/** Flattens every candidate's hops into one array, across ALL candidates
 *  at once (not gated by discovery round or bfsCandidateMode) — this is
 *  the "show everything for this hop level" view. `seedPathHops` is
 *  `GtfsDebugInfo['seedPathHops']`: an array indexed by candidate
 *  (path_index), each entry the ordered hops for that candidate. */
export function flattenHopColoredCandidates(seedPathHops: GtfsDebugInfo['seedPathHops']): SeedPathHop[] {
    const out: SeedPathHop[] = [];
    (seedPathHops ?? []).forEach((hops, pathIndex) => {
        (hops ?? []).forEach(hop => out.push({ ...hop, pathIndex }));
    });
    return out;
}

// ── Depth-colored candidate view ────────────────────────────────────────
// Depth (relative to the shortest meet BFS found — see seed_bfs.rs's
// rank_meets/depth bucketing) is a THIRD, independent way to color a
// candidate, alongside the existing flat single-color view and the
// per-hop palette above. Distinct axis from hopColorMode: hopColorMode
// colors by WHICH LEG of a single candidate you're looking at; depth
// coloring colors by WHICH TRANSFER-COUNT TIER the whole candidate itself
// belongs to, so at a glance you can see "these are the shortest-transfer
// candidates, those are the ones needing an extra transfer" across the
// whole candidate set. This is the flat view's default now instead of
// one fixed amber for every candidate regardless of depth.

// Cycled by depth. Deliberately distinct from BFS_HULL_COLOR (#3b82f6)
// and the HOP_PALETTE above — depth 0 (fewest transfers, most likely to
// be the eventual corridor) gets the warmest/most attention-grabbing
// color, deeper tiers cool off, so "is this candidate a short or long
// shot" reads at a glance without needing a legend.
const DEPTH_PALETTE = ['#f59e0b', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#0ea5e9'];

/** Color for a given candidate depth — cycles through DEPTH_PALETTE by
 *  depth, so any SAFETY_MARGIN_LEVELS value still gets a distinct-enough
 *  color per tier without needing to know its exact max up front. */
export function depthColor(depth: number): string {
    return DEPTH_PALETTE[depth % DEPTH_PALETTE.length];
}
