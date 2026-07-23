//! corridor/seed_bfs.rs — port of services/gtfs/graph/seedRouteBfs.ts.
//!
//! Finds the full family of seed paths from origin to destination, not just
//! one. Once destination is first reached at level n, fully finishes
//! expanding every remaining node at level n + SAFETY_MARGIN_LEVELS before
//! collecting paths (so sibling routes / one-more-transfer alternatives
//! aren't silently dropped). A level advances only on a TRANSIT edge — one
//! real-world transfer — with walking folded into a free same-level
//! closure before each transit hop. See the TS version's header comment
//! for the full rationale (this is a direct logic port, not a rewrite).

use std::collections::{HashMap, HashSet};
use crate::graph::coarse::{CoarseGraph, EdgeKind};
use crate::settings::{level_cap_for, MAX_SEED_PATHS, SAFETY_MARGIN_LEVELS};

pub struct SeedPathResult {
    pub paths: Vec<Vec<i64>>, // each is origin -> destination, stop_pk sequence
    pub levels_expanded: u32,
    /// Full reachable set (transit arrivals + walk closure) at the end of
    /// each level, in order — purely for debug visualization.
    pub level_frontiers: Vec<Vec<i64>>,
    /// Every (parent, child) edge traversed while building the BFS tree —
    /// both transit hops and free walk-closure hops — for debug overlay.
    pub tree_edges: Vec<(i64, i64)>,
}

pub fn find_seed_paths(
    graph: &CoarseGraph,
    origin_pks: &[i64],
    dest_pks: &[i64],
    max_transfers: u32,
) -> SeedPathResult {
    let max_levels = level_cap_for(max_transfers);
    let dest_set: HashSet<i64> = dest_pks.iter().copied().collect();
    let origin_set: HashSet<i64> = origin_pks.iter().copied().collect();

    let mut level_of: HashMap<i64, u32> = HashMap::new();
    let mut parents_of: HashMap<i64, HashSet<i64>> = HashMap::new();
    for &k in origin_pks { level_of.insert(k, 0); }

    let mut transit_frontier: HashSet<i64> = origin_pks.iter().copied().collect();
    let mut level_frontiers: Vec<Vec<i64>> = Vec::new();

    let mut first_hit_level: i64 = -1;
    let mut level: u32 = 0;

    // Free same-level walk closure: from `start_frontier`, take exactly one
    // walk hop to reach the next line (NOT a transitive chain — see TS
    // header comment on why one hop is the deliberate, bounded choice).
    let walk_closure = |start_frontier: &HashSet<i64>,
                         level_of: &mut HashMap<i64, u32>,
                         parents_of: &mut HashMap<i64, HashSet<i64>>,
                         level: u32| -> HashSet<i64> {
        let mut boardable = start_frontier.clone();
        for &key in start_frontier {
            let Some(edges) = graph.adjacency.get(&key) else { continue };
            for e in edges {
                if e.kind != EdgeKind::Walk { continue; }
                match level_of.get(&e.to) {
                    None => {
                        level_of.insert(e.to, level);
                        parents_of.entry(e.to).or_default().insert(key);
                        boardable.insert(e.to);
                    }
                    Some(&existing_level) if existing_level == level && e.to != key => {
                        parents_of.entry(e.to).or_default().insert(key);
                    }
                    _ => {}
                }
            }
        }
        boardable
    };

    while !transit_frontier.is_empty() && level < max_levels {
        if first_hit_level >= 0 && level as i64 > first_hit_level + SAFETY_MARGIN_LEVELS as i64 {
            break;
        }

        // ── Phase 1: free walk-closure at this level ────────────────────
        let boardable = walk_closure(&transit_frontier, &mut level_of, &mut parents_of, level);
        level_frontiers.push(boardable.iter().copied().collect());

        if first_hit_level < 0 {
            if boardable.iter().any(|k| dest_set.contains(k)) {
                first_hit_level = level as i64;
            }
        }
        if first_hit_level >= 0 && level as i64 > first_hit_level + SAFETY_MARGIN_LEVELS as i64 {
            break;
        }

        // ── Phase 2: one transit hop from every boardable stop ──────────
        let mut next_transit_frontier: HashSet<i64> = HashSet::new();
        for &key in &boardable {
            let Some(edges) = graph.adjacency.get(&key) else { continue };
            for e in edges {
                if e.kind != EdgeKind::Transit { continue; }
                match level_of.get(&e.to) {
                    None => {
                        level_of.insert(e.to, level + 1);
                        parents_of.entry(e.to).or_default().insert(key);
                        next_transit_frontier.insert(e.to);
                    }
                    Some(&existing_level) if existing_level == level + 1 => {
                        parents_of.entry(e.to).or_default().insert(key);
                    }
                    _ => {}
                }
            }
        }

        level += 1;
        transit_frontier = next_transit_frontier;
        if transit_frontier.is_empty() { break; }
    }

    let mut tree_edges = Vec::new();
    for (&child, parents) in &parents_of {
        for &parent in parents {
            tree_edges.push((parent, child));
        }
    }

    if first_hit_level < 0 {
        return SeedPathResult { paths: Vec::new(), levels_expanded: level, level_frontiers, tree_edges };
    }

    let max_collect_level = first_hit_level + SAFETY_MARGIN_LEVELS as i64;
    let mut paths: Vec<Vec<i64>> = Vec::new();

    // DFS backtrack from a destination stop to any origin stop, following
    // parentsOf backward and branching at every multi-parent stop. Builds
    // `path_so_far` in dest -> ... -> current order (push on entry, pop on
    // exit) and reverses once an origin is reached to get the forward
    // origin -> ... -> dest order paths.push expects.
    fn backtrack(
        node: i64,
        path_so_far: &mut Vec<i64>,
        in_path: &mut HashSet<i64>,
        origin_set: &HashSet<i64>,
        parents_of: &HashMap<i64, HashSet<i64>>,
        paths: &mut Vec<Vec<i64>>,
    ) {
        if paths.len() >= MAX_SEED_PATHS { return; }
        if in_path.contains(&node) { return; }

        path_so_far.push(node);

        if origin_set.contains(&node) {
            let mut full = path_so_far.clone();
            full.reverse();
            paths.push(full);
            path_so_far.pop();
            return;
        }

        let parents = parents_of.get(&node);
        let Some(parents) = parents else { path_so_far.pop(); return };
        if parents.is_empty() { path_so_far.pop(); return; }

        in_path.insert(node);
        for &p in parents {
            if paths.len() >= MAX_SEED_PATHS { break; }
            backtrack(p, path_so_far, in_path, origin_set, parents_of, paths);
        }
        in_path.remove(&node);
        path_so_far.pop();
    }

    for &d in dest_pks {
        if !dest_set.contains(&d) { continue; }
        let Some(&d_level) = level_of.get(&d) else { continue };
        if d_level as i64 > max_collect_level { continue; }
        let mut path_so_far = Vec::new();
        let mut in_path = HashSet::new();
        backtrack(d, &mut path_so_far, &mut in_path, &origin_set, &parents_of, &mut paths);
    }

    SeedPathResult { paths, levels_expanded: level, level_frontiers, tree_edges }
}
