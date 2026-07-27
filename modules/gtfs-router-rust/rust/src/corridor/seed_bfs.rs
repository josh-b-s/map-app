//! corridor/seed_bfs.rs — balanced bidirectional layer BFS.
//!
//! Finds the full family of seed paths from origin to destination, not just
//! one. Two independent BFS trees grow at once — forward from the origin
//! stops, backward from the destination stops — and at every step we
//! advance whichever side's CURRENT level frontier (not cumulative visited
//! set) is smaller, so neither side runs away exploring a sparse area while
//! the other sits idle in a dense one. A "level" on either side advances
//! only on a TRANSIT edge — one real-world transfer — with walking folded
//! into a free same-level closure before each transit hop, same as before.
//!
//! DIRECTIONALITY: transit edges in the coarse graph are one-way
//! (`graph/coarse.rs` only ever emits `i -> j` for `i < j` in a pattern's
//! real stop order). The forward side walks `graph.adjacency` exactly like
//! a normal BFS. The backward side walks `graph.reverse_transit` instead —
//! a lookup of "who has a real forward edge landing on me" — so it only
//! ever discovers genuine predecessors along real lines, never invents a
//! way to ride a one-way line backwards. Walk edges are inserted both ways
//! at graph-build time, so both sides share the same walk closure logic
//! unchanged.
//!
//! MEETING & BUDGET: the two trees "meet" when a node has been assigned a
//! level by both sides. The transfer budget (`level_cap_for`) is spent on
//! the SUM of forward-level + backward-level for a path through the
//! meeting node — that sum is the real number of transfers a rider would
//! make, not either side's level in isolation. Once first met at combined
//! level L, both sides keep expanding (still balanced by frontier size)
//! until the combined level exceeds L + SAFETY_MARGIN_LEVELS, so sibling
//! routes / one-more-transfer alternatives aren't silently dropped — same
//! rationale as the original single-direction version.
//!
//! PATH RECONSTRUCTION: a full path through meeting node M is a forward
//! prefix (origin -> ... -> M, backtracking through the forward tree's
//! parent pointers same as before) glued to a backward suffix (M -> ... ->
//! dest). The backward tree's parent pointers already point TOWARD the
//! destination (parents_of_bwd[child] = the closer-to-dest node that
//! discovered it), so walking that chain from M needs no final reversal —
//! unlike the forward side, which discovers away from the origin and has
//! to reverse once collected.
//!
//! PERF NOTE: `level_of`, `parents_of`, `meeting_nodes`, the frontier sets,
//! and `in_path` are all keyed by i64 stop_pk and entirely internal to this
//! function — none of them cross a trust boundary, so they use the FxHash
//! hasher (crate::fxhash) instead of std's default SipHash. SipHash is
//! DoS-resistant, which matters for e.g. a HashMap keyed by
//! attacker-controlled strings; it's wasted cost here where keys are our
//! own dense i64 ids. `graph.adjacency`/`graph.reverse_transit` are left on
//! std HashMap since that's a bigger, shared, persisted structure — not
//! touched by this change.

use std::collections::HashSet;
use crate::graph::coarse::{CoarseGraph, CoarseEdge, EdgeKind};
use crate::settings::{level_cap_for, MAX_SEED_PATHS, SAFETY_MARGIN_LEVELS};
use crate::fxhash::{FxHashMap, FxHashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchDir { Forward, Backward }

pub struct SeedPathResult {
    pub paths: Vec<Vec<i64>>,
    pub levels_expanded: u32,
    pub level_frontiers: Vec<(SearchDir, Vec<i64>)>,
    pub tree_edges: Vec<(i64, i64)>,
}

/// Free same-level walk closure: from `start_frontier`, take exactly one
/// walk hop to reach the next line (NOT a transitive chain — bounded on
/// purpose). Shared by both directions since walk edges are symmetric in
/// `graph.adjacency`. Takes `start_frontier` BY VALUE and mutates it in
/// place — the caller's copy is about to be discarded anyway (overwritten
/// by the next transit frontier), so this avoids a clone of what's usually
/// the largest set allocated per level.
fn walk_closure(
    graph: &CoarseGraph,
    mut start_frontier: FxHashSet<i64>,
    level_of: &mut FxHashMap<i64, u32>,
    parents_of: &mut FxHashMap<i64, FxHashSet<i64>>,
    level: u32,
) -> FxHashSet<i64> {
    // Iterate a snapshot of the keys we started with — `start_frontier`
    // itself is about to grow in the loop below.
    let seed_keys: Vec<i64> = start_frontier.iter().copied().collect();
    for key in seed_keys {
        let Some(edges) = graph.adjacency.get(&key) else { continue };
        for e in edges {
            if e.kind != EdgeKind::Walk { continue; }
            match level_of.get(&e.to) {
                None => {
                    level_of.insert(e.to, level);
                    parents_of.entry(e.to).or_default().insert(key);
                    start_frontier.insert(e.to);
                }
                Some(&existing_level) if existing_level == level && e.to != key => {
                    parents_of.entry(e.to).or_default().insert(key);
                }
                _ => {}
            }
        }
    }
    start_frontier
}

fn transit_hop_forward(
    graph: &CoarseGraph,
    boardable: &FxHashSet<i64>,
    level_of: &mut FxHashMap<i64, u32>,
    parents_of: &mut FxHashMap<i64, FxHashSet<i64>>,
    level: u32,
) -> FxHashSet<i64> {
    let mut next = FxHashSet::default();
    for &key in boardable {
        let Some(edges) = graph.adjacency.get(&key) else { continue };
        for e in edges {
            if e.kind != EdgeKind::Transit { continue; }
            match level_of.get(&e.to) {
                None => {
                    level_of.insert(e.to, level + 1);
                    parents_of.entry(e.to).or_default().insert(key);
                    next.insert(e.to);
                }
                Some(&existing_level) if existing_level == level + 1 => {
                    parents_of.entry(e.to).or_default().insert(key);
                }
                _ => {}
            }
        }
    }
    next
}

fn transit_hop_backward(
    graph: &CoarseGraph,
    boardable: &FxHashSet<i64>,
    level_of: &mut FxHashMap<i64, u32>,
    parents_of: &mut FxHashMap<i64, FxHashSet<i64>>,
    level: u32,
) -> FxHashSet<i64> {
    let mut next = FxHashSet::default();
    for &key in boardable {
        let Some(edges): Option<&Vec<CoarseEdge>> = graph.reverse_transit.get(&key) else { continue };
        for e in edges {
            match level_of.get(&e.to) {
                None => {
                    level_of.insert(e.to, level + 1);
                    parents_of.entry(e.to).or_default().insert(key);
                    next.insert(e.to);
                }
                Some(&existing_level) if existing_level == level + 1 => {
                    parents_of.entry(e.to).or_default().insert(key);
                }
                _ => {}
            }
        }
    }
    next
}

fn backtrack_to_origin(
    node: i64,
    path_so_far: &mut Vec<i64>,
    in_path: &mut FxHashSet<i64>,
    origin_set: &FxHashSet<i64>,
    parents_of_fwd: &FxHashMap<i64, FxHashSet<i64>>,
    out: &mut Vec<Vec<i64>>,
    cap: usize,
) {
    if out.len() >= cap { return; }
    if in_path.contains(&node) { return; }

    path_so_far.push(node);

    if origin_set.contains(&node) {
        let mut full = path_so_far.clone();
        full.reverse();
        out.push(full);
        path_so_far.pop();
        return;
    }

    let parents = parents_of_fwd.get(&node);
    let Some(parents) = parents else { path_so_far.pop(); return };
    if parents.is_empty() { path_so_far.pop(); return; }

    in_path.insert(node);
    for &p in parents {
        if out.len() >= cap { break; }
        backtrack_to_origin(p, path_so_far, in_path, origin_set, parents_of_fwd, out, cap);
    }
    in_path.remove(&node);
    path_so_far.pop();
}

fn backtrack_to_dest(
    node: i64,
    path_so_far: &mut Vec<i64>,
    in_path: &mut FxHashSet<i64>,
    dest_set: &FxHashSet<i64>,
    parents_of_bwd: &FxHashMap<i64, FxHashSet<i64>>,
    out: &mut Vec<Vec<i64>>,
    cap: usize,
) {
    if out.len() >= cap { return; }
    if in_path.contains(&node) { return; }

    path_so_far.push(node);

    if dest_set.contains(&node) {
        out.push(path_so_far.clone());
        path_so_far.pop();
        return;
    }

    let parents = parents_of_bwd.get(&node);
    let Some(parents) = parents else { path_so_far.pop(); return };
    if parents.is_empty() { path_so_far.pop(); return; }

    in_path.insert(node);
    for &p in parents {
        if out.len() >= cap { break; }
        backtrack_to_dest(p, path_so_far, in_path, dest_set, parents_of_bwd, out, cap);
    }
    in_path.remove(&node);
    path_so_far.pop();
}

pub fn find_seed_paths(
    graph: &CoarseGraph,
    origin_pks: &[i64],
    dest_pks: &[i64],
    max_transfers: u32,
) -> SeedPathResult {
    let max_levels = level_cap_for(max_transfers);
    let origin_set: FxHashSet<i64> = origin_pks.iter().copied().collect();
    let dest_set: FxHashSet<i64> = dest_pks.iter().copied().collect();

    let mut level_of_fwd: FxHashMap<i64, u32> = FxHashMap::default();
    let mut parents_of_fwd: FxHashMap<i64, FxHashSet<i64>> = FxHashMap::default();
    for &k in origin_pks { level_of_fwd.entry(k).or_insert(0); }

    let mut level_of_bwd: FxHashMap<i64, u32> = FxHashMap::default();
    let mut parents_of_bwd: FxHashMap<i64, FxHashSet<i64>> = FxHashMap::default();
    for &k in dest_pks { level_of_bwd.entry(k).or_insert(0); }

    let mut transit_frontier_fwd: FxHashSet<i64> = origin_pks.iter().copied().collect();
    let mut transit_frontier_bwd: FxHashSet<i64> = dest_pks.iter().copied().collect();

    let mut level_fwd: u32 = 0;
    let mut level_bwd: u32 = 0;
    let mut level_frontiers: Vec<(SearchDir, Vec<i64>)> = Vec::new();

    let mut first_meet_total_level: i64 = -1;
    let mut meeting_nodes: FxHashMap<i64, u32> = FxHashMap::default();

    let note_meets = |newly_added: &FxHashSet<i64>,
                       this_level_of: &FxHashMap<i64, u32>,
                       other_level_of: &FxHashMap<i64, u32>,
                       meeting_nodes: &mut FxHashMap<i64, u32>,
                       first_meet_total_level: &mut i64| {
        for &n in newly_added {
            if let (Some(&lt), Some(&lo)) = (this_level_of.get(&n), other_level_of.get(&n)) {
                let combined = lt + lo;
                meeting_nodes.entry(n).or_insert(combined);
                if *first_meet_total_level < 0 || (combined as i64) < *first_meet_total_level {
                    *first_meet_total_level = combined as i64;
                }
            }
        }
    };

    for &k in origin_pks {
        if dest_set.contains(&k) {
            meeting_nodes.entry(k).or_insert(0);
            first_meet_total_level = 0;
        }
    }

    loop {
        if transit_frontier_fwd.is_empty() && transit_frontier_bwd.is_empty() { break; }
        if level_fwd + level_bwd >= max_levels { break; }
        if first_meet_total_level >= 0
            && (level_fwd + level_bwd) as i64 > first_meet_total_level + SAFETY_MARGIN_LEVELS as i64
        {
            break;
        }

        let expand_forward = if transit_frontier_bwd.is_empty() {
            true
        } else if transit_frontier_fwd.is_empty() {
            false
        } else {
            transit_frontier_fwd.len() <= transit_frontier_bwd.len()
        };

        if expand_forward {
            let boardable = walk_closure(graph, transit_frontier_fwd, &mut level_of_fwd, &mut parents_of_fwd, level_fwd);
            level_frontiers.push((SearchDir::Forward, boardable.iter().copied().collect()));
            note_meets(&boardable, &level_of_fwd, &level_of_bwd, &mut meeting_nodes, &mut first_meet_total_level);

            let next = transit_hop_forward(graph, &boardable, &mut level_of_fwd, &mut parents_of_fwd, level_fwd);
            note_meets(&next, &level_of_fwd, &level_of_bwd, &mut meeting_nodes, &mut first_meet_total_level);

            level_fwd += 1;
            transit_frontier_fwd = next;
        } else {
            let boardable = walk_closure(graph, transit_frontier_bwd, &mut level_of_bwd, &mut parents_of_bwd, level_bwd);
            level_frontiers.push((SearchDir::Backward, boardable.iter().copied().collect()));
            note_meets(&boardable, &level_of_bwd, &level_of_fwd, &mut meeting_nodes, &mut first_meet_total_level);

            let next = transit_hop_backward(graph, &boardable, &mut level_of_bwd, &mut parents_of_bwd, level_bwd);
            note_meets(&next, &level_of_bwd, &level_of_fwd, &mut meeting_nodes, &mut first_meet_total_level);

            level_bwd += 1;
            transit_frontier_bwd = next;
        }
    }

    let mut tree_edges = Vec::new();
    for (&child, parents) in &parents_of_fwd {
        for &parent in parents { tree_edges.push((parent, child)); }
    }
    for (&child, parents) in &parents_of_bwd {
        for &parent in parents { tree_edges.push((child, parent)); }
    }

    if first_meet_total_level < 0 {
        return SeedPathResult {
            paths: Vec::new(),
            levels_expanded: level_fwd + level_bwd,
            level_frontiers,
            tree_edges,
        };
    }

    let max_collect_combined_level = first_meet_total_level + SAFETY_MARGIN_LEVELS as i64;

    let mut ordered_meets: Vec<(i64, u32)> = meeting_nodes.into_iter()
        .filter(|&(_, combined)| combined as i64 <= max_collect_combined_level)
        .collect();
    ordered_meets.sort_by_key(|&(node, combined)| (combined, node));

    // A single edge straddling the frontier gets discovered as a "meeting
    // point" from both of its endpoints (forward lands on the far end the
    // same step backward lands on the near end) — dedupe by content, not
    // just by meeting node, or the same stop_pk sequence comes out twice.
    // (std HashSet here, not FxHash — keyed by Vec<i64>, small cardinality
    // capped at MAX_SEED_PATHS, not worth a specialized hasher.)
    let mut seen_paths: HashSet<Vec<i64>> = HashSet::new();
    let mut paths: Vec<Vec<i64>> = Vec::new();
    'meets: for (m, _combined) in ordered_meets {
        if paths.len() >= MAX_SEED_PATHS { break; }

        let mut fwd_paths = Vec::new();
        {
            let mut path_so_far = Vec::new();
            let mut in_path = FxHashSet::default();
            backtrack_to_origin(m, &mut path_so_far, &mut in_path, &origin_set, &parents_of_fwd, &mut fwd_paths, MAX_SEED_PATHS);
        }
        let mut bwd_paths = Vec::new();
        {
            let mut path_so_far = Vec::new();
            let mut in_path = FxHashSet::default();
            backtrack_to_dest(m, &mut path_so_far, &mut in_path, &dest_set, &parents_of_bwd, &mut bwd_paths, MAX_SEED_PATHS);
        }

        if fwd_paths.is_empty() && origin_set.contains(&m) { fwd_paths.push(vec![m]); }
        if bwd_paths.is_empty() && dest_set.contains(&m) { bwd_paths.push(vec![m]); }

        for fp in &fwd_paths {
            for bp in &bwd_paths {
                if paths.len() >= MAX_SEED_PATHS { break 'meets; }
                let mut full = fp.clone();
                full.extend_from_slice(&bp[1..]);
                if seen_paths.insert(full.clone()) {
                    paths.push(full);
                }
            }
        }
    }

    SeedPathResult {
        paths,
        levels_expanded: level_fwd + level_bwd,
        level_frontiers,
        tree_edges,
    }
}
