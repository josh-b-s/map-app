/**
 * seedRouteBfs.ts — iterative-deepening BFS over the coarse graph.
 *
 * Finds the full FAMILY of seed paths from origin to destination, not just
 * one. Per the spec, the load-bearing correctness rule is: once destination
 * is first reached at level n, fully finish expanding every remaining node
 * at level n (never stop mid-level) before collecting paths — otherwise
 * sibling routes that also arrive at level n get silently dropped. Path
 * COLLECTION then keeps every destination arrival from level n through
 * n + SAFETY_MARGIN_LEVELS (not just arrivals at exactly n) — the margin is
 * there specifically so a genuinely valid alternative needing one extra
 * transfer (e.g. tram -> train -> bus, discovered one level after a direct
 * bus) is actually returned as a seed path instead of being explored and
 * then discarded.
 *
 * LEVEL DEFINITION (changed): a level advances only on a TRANSIT edge — i.e.
 * "boarded a different line." Walking is folded into a free same-level
 * closure before each transit hop (see WALK-CLOSURE below), so `level` is a
 * genuine real-world transfer count, not an edge count.
 *
 * WHY THIS MATTERS: previously every edge (walk or transit) advanced the
 * level by one, so a walk-assisted transfer (ride line A -> walk to a
 * different stop -> ride line B) cost 2 levels for what a rider experiences
 * as ONE transfer, while a same-stop transfer (ride line A -> ride line B
 * from the same stop, no walk needed) only cost 1. Combined with
 * SAFETY_MARGIN_LEVELS stopping shortly after the first destination hit,
 * this meant a direct one-seat ride (e.g. one bus, 1 level) could starve out
 * a genuinely 1-transfer alternative that happened to need a short walk
 * between stops (e.g. train + walk + bus, previously 3 levels) even though
 * both are the "same number of transfers" to a real rider — the walk was
 * being double-counted as if it were itself a transfer. Folding walking
 * into a free closure fixes that: both options now land at level 1 and are
 * compared fairly (including by whatever downstream Pareto/RAPTOR logic
 * ultimately picks between them), instead of the walk-assisted one being
 * discovered two levels "too late" to even be considered.
 */

import type {CoarseGraph} from './coarseGraph';
import {MAX_TRANSFERS as DEFAULT_MAX_TRANSFERS} from './routingSettings';

export interface SeedPathResult {
    paths: string[][];   // each is a list of stopKeys, origin -> destination
    levelsExpanded: number;
    /** Snapshot of the full reachable set (transit-hop arrivals PLUS their
     *  free walk-closure) at the END of each level, in order — level 0 is
     *  the origin seed set plus its own walk-closure. Purely for debug
     *  visualization; routing never reads this. */
    levelFrontiers: string[][];
    /** Every (parent, child) edge actually traversed while building the BFS
     *  tree — both transit hops and free walk-closure hops — in discovery
     *  order. Purely for debug visualization — lets an overlay draw the
     *  exploration as a connected "web" (merged polylines along tree
     *  branches) instead of a scatter of per-stop points. Not read by
     *  routing itself; this is just parentsOf flattened into pairs, which
     *  the search already builds anyway. */
    treeEdges: [string, string][];
}

const SAFETY_MARGIN_LEVELS = 1; // expand one extra full level past first hit

// A level is now genuinely one transit boarding (see module doc above), so a
// level cap of maxTransfers + 1 is a real transfer-count budget, not an
// arbitrary stop-count guess. This is only correct because transit edges are
// per-line cliques (see coarseGraph.ts); if that ever regresses back to
// per-stop edges, this cap needs to grow back to a stop-count-scaled number.
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
    // preserved instead of collapsed to one. A node's parent can now be
    // either a transit-hop predecessor (parent at level-1) OR a
    // walk-closure predecessor (parent at the SAME level) — backtrack()
    // below doesn't need to know which, it just follows parentsOf.
    const levelOf = new Map<string, number>();
    const parentsOf = new Map<string, Set<string>>();

    // `transitFrontier` holds only stops just reached by a TRANSIT edge (or
    // the origin set, for level 0) — the boarding candidates a walk-closure
    // expands from. `boardable` (built fresh each level, see below) is
    // transitFrontier plus everything reachable from it on foot, and is
    // what actually takes the next transit hop.
    let transitFrontier = new Set(originKeys);
    for (const k of originKeys) levelOf.set(k, 0);

    const levelFrontiers: string[][] = [];

    let firstHitLevel = -1;
    let level = 0;

    /** Free same-level walk closure: from the given frontier, take exactly
     *  ONE walk hop to reach the next line — NOT a transitive chain of
     *  walk edges. Every stop discovered this way is assigned the SAME
     *  level as its walk-parent (walking never advances the level — see
     *  module doc). Returns the full boardable set (input frontier plus
     *  everything reached by a single walk hop).
     *
     *  CAPPED AT ONE HOP DELIBERATELY: an earlier version of this function
     *  queue-drove the walk edges transitively (A -walk-> B -walk-> C
     *  -walk-> D ...), on the reasoning that "however many stops you can
     *  reach on foot before boarding" should all count as the same
     *  transfer. In practice this has no natural stopping point — in a
     *  dense stop cluster (CBD-style spacing, well within the ~450m
     *  walk-edge threshold) that chain can transitively reach a large
     *  fraction of the whole network in ONE level, and phase 2 then fires a
     *  full transit-clique expansion from every one of those stops. That
     *  turned "expand one level" into "traverse most of the graph, possibly
     *  several times over," which is what caused the search to hang/freeze
     *  on a real device. A single walk hop is both cheap (bounded by each
     *  stop's own walk-edge degree) and matches how a real transfer works —
     *  get off, walk to the nearby stop, board the next line — without
     *  needing an arbitrary chain-length cap to stay bounded.
     */
    function walkClosure(startFrontier: Set<string>): Set<string> {
        const boardable = new Set(startFrontier);
        for (const key of startFrontier) {
            const edges = graph.adjacency.get(key);
            if (!edges) continue;
            for (const e of edges) {
                if (e.kind !== 'walk') continue;
                const existingLevel = levelOf.get(e.to);
                if (existingLevel === undefined) {
                    levelOf.set(e.to, level);
                    parentsOf.set(e.to, new Set([key]));
                    boardable.add(e.to);
                } else if (existingLevel === level && e.to !== key) {
                    // Another walk-parent reaching the same stop at the same
                    // level — sibling walking-transfer route, keep it (same
                    // multi-parent semantics as the transit case below).
                    // NOTE: e.to may be an ORIGIN stop (level 0 is seeded via
                    // levelOf only, never parentsOf.set — origin stops have
                    // no predecessor by definition), so parentsOf may not
                    // have an entry yet here; guard before .add().
                    if (!parentsOf.has(e.to)) parentsOf.set(e.to, new Set());
                    parentsOf.get(e.to)!.add(key);
                }
            }
        }
        return boardable;
    }

    while (transitFrontier.size > 0 && level < MAX_LEVELS) {
        // Stop only after fully expanding levels up to firstHitLevel + margin.
        if (firstHitLevel >= 0 && level > firstHitLevel + SAFETY_MARGIN_LEVELS) break;

        // ── Phase 1: free walk-closure at this level ────────────────────
        const boardable = walkClosure(transitFrontier);
        levelFrontiers.push([...boardable]); // level `level`'s full reachable set (transit arrivals + walk closure)

        if (firstHitLevel < 0) {
            for (const k of boardable) {
                if (destSet.has(k)) {
                    firstHitLevel = level;
                    break;
                }
            }
        }
        // Re-check the break condition now that firstHitLevel may have just
        // been set by this level's walk-closure — otherwise a destination
        // reached only via walking (not a fresh transit arrival) wouldn't
        // correctly cap the margin from THIS level.
        if (firstHitLevel >= 0 && level > firstHitLevel + SAFETY_MARGIN_LEVELS) break;

        // ── Phase 2: one transit hop from every boardable stop ──────────
        const nextTransitFrontier = new Set<string>();
        for (const key of boardable) {
            const edges = graph.adjacency.get(key);
            if (!edges) continue;
            for (const e of edges) {
                if (e.kind !== 'transit') continue;
                const existingLevel = levelOf.get(e.to);
                if (existingLevel === undefined) {
                    levelOf.set(e.to, level + 1);
                    parentsOf.set(e.to, new Set([key]));
                    nextTransitFrontier.add(e.to);
                } else if (existingLevel === level + 1) {
                    // Another parent reaching the same node at the same level —
                    // keep it, this is exactly the sibling-route case.
                    parentsOf.get(e.to)!.add(key);
                }
            }
        }

        level += 1;
        transitFrontier = nextTransitFrontier;
        if (transitFrontier.size === 0) break;
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
        return {paths: [], levelsExpanded: level, levelFrontiers, treeEdges};
    }

    // Reconstruct every distinct origin -> destination path by walking
    // parentsOf backward from each reached destination stop, branching at
    // every stop with multiple parents. Cap total paths so a very dense
    // network can't blow up combinatorially.
    const MAX_PATHS = 24;
    const paths: string[][] = [];

    // `inPath` guards against a stop appearing twice in one reconstructed
    // path. NOTE: levelOf is no longer strictly increasing along every
    // parent chain (a walk-closure parent sits at the SAME level as its
    // child), so this guard is now load-bearing for termination, not just
    // insurance — a walk-edge cycle between same-level stops (there
    // shouldn't be one, since walkClosure only ever links an undiscovered
    // stop to a discovered one) would otherwise be able to loop here.
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

    // Collect from every destination stop reached within the levels BFS
    // actually explored — firstHitLevel through firstHitLevel +
    // SAFETY_MARGIN_LEVELS — not just stops reached at EXACTLY
    // firstHitLevel. The margin's whole purpose is to keep expanding past
    // the first hit so genuinely valid alternatives that need one more
    // transfer aren't missed (e.g. a tram -> train -> bus path when a
    // direct bus is found one level earlier); an exact-equality filter here
    // was discarding exactly that exploration after paying for it — the
    // extra level got expanded, but its own destination arrivals were then
    // thrown away instead of turned into seed paths.
    const maxCollectLevel = firstHitLevel + SAFETY_MARGIN_LEVELS;
    for (const dKey of destKeys) {
        if (!destSet.has(dKey)) continue;
        const dLevel = levelOf.get(dKey);
        if (dLevel === undefined || dLevel > maxCollectLevel) continue;
        backtrack(dKey, [], new Set());
    }

    return {paths, levelsExpanded: level, levelFrontiers, treeEdges};
}