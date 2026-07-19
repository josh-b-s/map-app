/**
 * seedRouteBfs.ts — iterative-deepening BFS over the coarse graph.
 *
 * Finds the full FAMILY of seed paths from origin to destination, not just
 * one. Per the spec, the load-bearing correctness rule is: once destination
 * is first reached at level n, fully finish expanding every remaining node
 * at level n (never stop mid-level) before collecting paths — otherwise
 * sibling routes that also arrive at level n get silently dropped.
 */

import type { CoarseGraph } from './coarseGraph';

export interface SeedPathResult {
    paths: string[][];   // each is a list of stopKeys, origin -> destination
    levelsExpanded: number;
    /** Snapshot of the frontier (stopKeys newly reached) at the END of each
     *  level, in order — level 0 is the origin seed set itself. Purely for
     *  debug visualization (replaying "BFS expanding outward level by
     *  level"); routing never reads this. */
    levelFrontiers: string[][];
    /** Every (parent, child) edge actually traversed while building the BFS
     *  tree, in discovery order. Purely for debug visualization — lets an
     *  overlay draw the exploration as a connected "web" (merged polylines
     *  along tree branches) instead of a scatter of per-stop points. Not
     *  read by routing itself; this is just parentsOf flattened into pairs,
     *  which the search already builds anyway. */
    treeEdges: [string, string][];
}

const SAFETY_MARGIN_LEVELS = 1; // expand one extra full level past first hit
const DEFAULT_MAX_TRANSFERS = 5;

// Each BFS level is now one "leg" (ride one line to any stop it serves, or
// one walking transfer) — see coarseGraph.ts. So a level cap of
// maxTransfers + 1 legs is a real transfer-count budget, not an arbitrary
// stop-count guess. This is only correct because transit edges are per-line
// cliques now; if that ever regresses back to per-stop edges, this cap needs
// to grow back to a stop-count-scaled number.
function levelCapFor(maxTransfers: number): number {
    return Math.max(1, maxTransfers) + 1;
}

export function findSeedPaths(
    graph: CoarseGraph,
    originKeys: string[],
    destKeys: string[],
    maxTransfers: number = DEFAULT_MAX_TRANSFERS,
): SeedPathResult {
    const MAX_LEVELS = levelCapFor(maxTransfers); // absolute ceiling so a disconnected graph can't spin forever
    const destSet = new Set(destKeys);

    // Multi-parent BFS: track ALL predecessors that reach a node at its
    // earliest level, so multiple sibling paths through a shared stop are
    // preserved instead of collapsed to one.
    const levelOf = new Map<string, number>();
    const parentsOf = new Map<string, Set<string>>(); // stopKey -> set of predecessor stopKeys at level-1

    let frontier = new Set(originKeys);
    for (const k of originKeys) levelOf.set(k, 0);

    const levelFrontiers: string[][] = [[...frontier]]; // level 0 = origin seed set

    let firstHitLevel = -1;
    let level = 0;

    while (frontier.size > 0 && level < MAX_LEVELS) {
        // Stop only after fully expanding levels up to firstHitLevel + margin.
        if (firstHitLevel >= 0 && level > firstHitLevel + SAFETY_MARGIN_LEVELS) break;

        const nextFrontier = new Set<string>();
        for (const key of frontier) {
            const edges = graph.adjacency.get(key);
            if (!edges) continue;
            for (const e of edges) {
                const existingLevel = levelOf.get(e.to);
                if (existingLevel === undefined) {
                    levelOf.set(e.to, level + 1);
                    parentsOf.set(e.to, new Set([key]));
                    nextFrontier.add(e.to);
                } else if (existingLevel === level + 1) {
                    // Another parent reaching the same node at the same level —
                    // keep it, this is exactly the sibling-route case.
                    parentsOf.get(e.to)!.add(key);
                }
            }
        }

        level += 1;
        for (const k of nextFrontier) {
            if (destSet.has(k) && firstHitLevel < 0) firstHitLevel = level;
        }
        frontier = nextFrontier;
        levelFrontiers.push([...frontier]);
        if (frontier.size === 0) break;
    }

    // Flatten parentsOf (child -> set of predecessors) into a plain edge
    // list once, after the search loop is done — cheap (one pass over the
    // same map the search already built) and purely for the debug overlay's
    // web-view rendering. Not used by routing/reconstruction below.
    const treeEdges: [string, string][] = [];
    for (const [child, parents] of parentsOf) {
        for (const parent of parents) treeEdges.push([parent, child]);
    }

    if (firstHitLevel < 0) {
        return { paths: [], levelsExpanded: level, levelFrontiers, treeEdges };
    }

    // Reconstruct every distinct origin -> destination path by walking
    // parentsOf backward from each reached destination stop, branching at
    // every stop with multiple parents. Cap total paths so a very dense
    // network can't blow up combinatorially.
    const MAX_PATHS = 24;
    const paths: string[][] = [];

    // `inPath` guards against a stop appearing twice in one reconstructed
    // path. levelOf is strictly increasing along any parent chain by
    // construction, so this should never trigger — but it's cheap insurance
    // against a future edge-construction bug turning into a stuck/looping
    // reconstruction rather than a silently wrong path.
    function backtrack(node: string, acc: string[], inPath: Set<string>) {
        if (paths.length >= MAX_PATHS) return;
        if (inPath.has(node)) return;
        if (originKeys.includes(node)) {
            paths.push([node, ...acc]); // node (origin) first, then acc already in forward order
            return;
        }
        const parents = parentsOf.get(node);
        if (!parents || parents.size === 0) return;
        const nextInPath = new Set(inPath);
        nextInPath.add(node);
        for (const p of parents) {
            if (paths.length >= MAX_PATHS) return;
            backtrack(p, [node, ...acc], nextInPath);
        }
    }

    for (const dKey of destKeys) {
        if (!destSet.has(dKey)) continue;
        if (levelOf.get(dKey) !== firstHitLevel) continue; // only seed from stops reached at the first hit level
        backtrack(dKey, [], new Set());
    }

    return { paths, levelsExpanded: level, levelFrontiers, treeEdges };
}
