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
use crate::settings::{
    level_cap_for, ASSUMED_TRANSIT_SPEED_MPS, DEPTH_BUCKET_RANKING_ENABLED, ENABLE_SEED_PATH_MARGIN, FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC,
    MAX_SEED_PATHS, RANK_MEETS_WALKING_SPEED_MPS, SAFETY_MARGIN_LEVELS, SEED_MEET_DEPTH_BUCKET_WEIGHT, SEED_PATH_MARGIN_FLOOR_SEC,
    SEED_PATH_MARGIN_RELATIVE_PCT,
    ENABLE_SEED_MEET_SELECT_MARGIN_PRUNE, margin_threshold, SEED_MEET_SELECT_MARGIN_FLOOR_SEC,
    SEED_MEET_SELECT_MARGIN_RELATIVE_PCT, SEED_MEET_SELECT_TOP_K, TOP_N_SEED_MEETS,
};
use crate::fxhash::{FxHashMap, FxHashSet};
use crate::repo::{PatternCumulativeCache, PatternHeadwayCache, StopsCache};
use crate::geo::{haversine_meters, LatLon};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchDir { Forward, Backward }

pub struct SeedPathResult {
    pub paths: Vec<Vec<i64>>,
    /// The ordered list of distinct `pattern_pk`s ridden by the matching
    /// entry in `paths` (walk hops contribute nothing, so an all-walk path
    /// has an empty signature here). This is what a debug/visualization
    /// consumer should use to fetch the real shape polyline + route color
    /// (`repo::get_shape_points` / `PatternMeta` / `routes.route_color`) —
    /// the same lookup RAPTOR's own final result rendering already does —
    /// rather than recomputing an approximate tapered-buffer polygon from
    /// stop coordinates. See tagging.rs's `compute_seed_path_corridor`,
    /// which used to compute `CorridorBoundary` geometry for exactly this
    /// purpose and no longer does.
    pub path_pattern_pks: Vec<Vec<i64>>,
    /// Whole-trip estimated real duration for the matching entry in
    /// `paths` (root walk + ride/wait cost along `path_pattern_pks`'
    /// per-hop sequence — see `score_seed_path`), `f64::MAX` if any hop
    /// couldn't be scored. NOT the same number as summing two
    /// `meet_scores` entries — this walks the ACTUAL assembled path's
    /// hops, whereas `meet_scores` is the best-over-all-parents DP value
    /// for a node, which need not be the path this specific `paths` entry
    /// took to reach it. Exists so a caller can rank/top-K whole
    /// candidate trips directly (see `ENABLE_SEED_PATH_MARGIN`), not just
    /// the meeting nodes that produced them.
    pub path_scores: Vec<f64>,
    /// `paths.len()` BEFORE the `ENABLE_SEED_PATH_MARGIN` filter (equal
    /// to `paths.len()` when that toggle is off, since nothing gets cut).
    /// Logged so the actual pre-filter candidate volume is visible on
    /// real queries — `MAX_SEED_PATHS` only bounds fanout WITHIN one
    /// meeting node's half-path enumeration, not the total across every
    /// meeting node in the batch, so this number isn't derivable from
    /// settings alone and needs measuring.
    pub path_count_before_margin: usize,
    /// Every stop_pk that lies on SOME real origin-to-destination path
    /// within budget — i.e. every ancestor (in either tree) of a meeting
    /// node kept within `SAFETY_MARGIN_LEVELS` AND within whatever batch
    /// size `materialize_seed_paths` was called with (see its doc
    /// comment). This is the correctness-relevant output: computed by a
    /// single visited-once traversal (`ancestor_stop_union`), NOT by
    /// flattening `paths`, so within the batch it's exact and
    /// combinatorially uncapped — unlike `paths`, it never gets thinned by
    /// `MAX_SEED_PATHS`'s enumeration cap. Callers that need "which
    /// stops/patterns are in scope for RAPTOR" (e.g.
    /// `compute_seed_path_corridor`) should use this, not `paths`.
    pub core_stop_pks: FxHashSet<i64>,
    /// Same union as `core_stop_pks`, but split by which depth bucket
    /// (see `meet_depth`) first reached each stop — a stop reachable from
    /// both a depth-0 and depth-1 meet lands in the depth-0 bucket only
    /// (shallowest-wins, same tie-break `rank_meets` uses for meeting
    /// nodes). Index i is depth i, length is always
    /// `SAFETY_MARGIN_LEVELS + 1`. Exists so a per-depth-bucket cross-track
    /// filter (see tagging.rs) can rank/cap stops within each depth
    /// independently, instead of one flat straightness sort silently
    /// starving a deeper-but-necessary bucket (e.g. a real 3-transfer
    /// train+tram+bus option losing every one of its stops to a shorter,
    /// straighter 2-transfer tram+bus alternative in a flat cross-track
    /// sort).
    pub core_stop_pks_by_depth: Vec<FxHashSet<i64>>,
    /// Depth (relative to the shortest meet, `0..=SAFETY_MARGIN_LEVELS`) of
    /// the meeting node that produced the matching entry in `paths` — lets
    /// a debug/visualization consumer color candidate seed paths by depth
    /// (fewer transfers vs. more) instead of every candidate looking the
    /// same regardless of how many extra hops it took to find it.
    pub path_depths: Vec<u32>,
    pub levels_expanded: u32,
    pub level_frontiers: Vec<(SearchDir, Vec<i64>)>,
    /// How many meeting nodes per depth bucket actually survived BOTH the
    /// `batch_size` count cap AND the `SEED_MEET_SELECT_MARGIN_*` real-time
    /// filter — the true "after" counterpart to `SeedBfsRun::
    /// bucket_sizes_before`. Computed here (not by the caller re-slicing
    /// `run.ordered_meets` itself) because the margin filter is applied
    /// inside this function — a caller counting from the raw
    /// `batch_size`-sliced prefix would over-count relative to what
    /// actually got backtracked into `core_stop_pks`.
    pub after_counts: Vec<usize>,
}

/// The reusable output of running BFS once — everything `materialize_
/// seed_paths` needs to turn a batch of meeting nodes into a real
/// `SeedPathResult`, WITHOUT re-running BFS. Exists so a caller that gets
/// an empty/thin result back can retry with a bigger `batch_size` against
/// the SAME run (see resolver.rs's retry loop) — BFS is the expensive
/// part of this whole pipeline; ranking/ancestor-union/backtracking are
/// comparatively cheap and fine to redo per attempt.
pub struct SeedBfsRun {
    /// Every meeting node found within `SAFETY_MARGIN_LEVELS` of the first
    /// meet, ranked by real estimated hop-time (see `rank_meets`) — FULL
    /// list, not batch-limited. `materialize_seed_paths` slices a prefix
    /// of this per attempt, then further trims by `meet_scores` margin
    /// (see that fn's doc).
    pub ordered_meets: Vec<(i64, u32)>,
    /// Real estimated hop-time score for every node in `ordered_meets`
    /// (lower is better; `f64::MAX` means unreachable/unscoreable) — same
    /// values `rank_meets` computed to sort `ordered_meets` in the first
    /// place, kept around so `materialize_seed_paths` can margin-filter a
    /// batch without recomputing `real_time_from_root` a second time.
    pub(crate) meet_scores: FxHashMap<i64, f64>,
    /// The BFS level at which the first meeting node was found — same
    /// value `rank_meets` bucketed against. Kept on the run (not just used
    /// locally in `run_seed_bfs`) so `materialize_seed_paths` can compute
    /// each individual path's depth the same way, for debug/visualization.
    pub(crate) first_meet_total_level: i64,
    pub(crate) parents_of_fwd: FxHashMap<i64, FxHashSet<ParentEdge>>,
    pub(crate) parents_of_bwd: FxHashMap<i64, FxHashSet<ParentEdge>>,
    pub(crate) origin_set: FxHashSet<i64>,
    pub(crate) dest_set: FxHashSet<i64>,
    pub levels_expanded: u32,
    pub level_frontiers: Vec<(SearchDir, Vec<i64>)>,
    /// How many meeting nodes fell into each depth bucket (`0..=SAFETY_
    /// MARGIN_LEVELS`, depth 0 = shallowest/fewest-extra-transfers) BEFORE
    /// `rank_meets`'s weighted interleave and before any `batch_size`
    /// truncation — i.e. the raw supply available at each depth. Empty if
    /// BFS found no meet at all. See `corridor/tagging.rs`'s
    /// `compute_seed_path_corridor` for the "after" counterpart (how many
    /// per depth actually survived into the materialized batch).
    pub bucket_sizes_before: Vec<usize>,
    /// Query origin/destination points, kept on the run so a later
    /// `materialize_seed_paths` call can score whole assembled paths
    /// (`score_seed_path`) the same "last mile" way `rank_meets`/
    /// `real_time_from_root` already score individual meeting nodes,
    /// without the caller having to re-thread them through separately.
    pub(crate) origin_point: LatLon,
    pub(crate) destination_point: LatLon,
}

/// Union of every ancestor of every node in `starts`, walked through
/// `parents_of` — a plain visited-once traversal, so a node with N
/// parents costs N extra stack pushes, NOT a multiplicative branch
/// through the rest of the chain the way `backtrack_to_origin`/
/// `backtrack_to_dest`'s combinatorial path enumeration does. Used to get
/// the exact set of on-path stops without ever materializing individual
/// enumerated paths — see `SeedPathResult::core_stop_pks`'s doc comment.
fn ancestor_stop_union(
    starts: impl Iterator<Item = i64>,
    parents_of: &FxHashMap<i64, FxHashSet<ParentEdge>>,
) -> FxHashSet<i64> {
    let mut seen: FxHashSet<i64> = FxHashSet::default();
    let mut stack: Vec<i64> = starts.collect();
    while let Some(n) = stack.pop() {
        if !seen.insert(n) { continue; }
        if let Some(parents) = parents_of.get(&n) {
            for &(p, _via_pattern) in parents { stack.push(p); }
        }
    }
    seen
}

/// Free same-level walk closure: from `start_frontier`, take exactly one
/// walk hop to reach the next line (NOT a transitive chain — bounded on
/// purpose). Shared by both directions since walk edges are symmetric in
/// `graph.adjacency`. Takes `start_frontier` BY VALUE and mutates it in
/// place — the caller's copy is about to be discarded anyway (overwritten
/// by the next transit frontier), so this avoids a clone of what's usually
/// the largest set allocated per level.
/// A parent edge, kept alongside the parent's stop_pk: `via_pattern` is
/// `None` for a walk hop and `Some(pk)` for a real transit boarding. This
/// is the piece the old code discarded — `parents_of` used to be
/// `FxHashSet<i64>`, just the parent stop, with no record of *how* that
/// parent was reached. Keeping it lets path reconstruction later dedupe on
/// "which lines did this path actually ride" instead of "which exact
/// stop_pks did it touch", so two candidates that differ only in which
/// sibling platform got walked to collapse into one instead of both
/// surviving as distinct enumerated paths.
pub(crate) type ParentEdge = (i64, Option<i64>);

fn walk_closure(
    graph: &CoarseGraph,
    mut start_frontier: FxHashSet<i64>,
    level_of: &mut FxHashMap<i64, u32>,
    parents_of: &mut FxHashMap<i64, FxHashSet<ParentEdge>>,
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
                    parents_of.entry(e.to).or_default().insert((key, None));
                    start_frontier.insert(e.to);
                }
                Some(&existing_level) if existing_level == level && e.to != key => {
                    parents_of.entry(e.to).or_default().insert((key, None));
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
    parents_of: &mut FxHashMap<i64, FxHashSet<ParentEdge>>,
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
                    parents_of.entry(e.to).or_default().insert((key, e.via_pattern));
                    next.insert(e.to);
                }
                Some(&existing_level) if existing_level == level + 1 => {
                    parents_of.entry(e.to).or_default().insert((key, e.via_pattern));
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
    parents_of: &mut FxHashMap<i64, FxHashSet<ParentEdge>>,
    level: u32,
) -> FxHashSet<i64> {
    let mut next = FxHashSet::default();
    for &key in boardable {
        let Some(edges): Option<&Vec<CoarseEdge>> = graph.reverse_transit.get(&key) else { continue };
        for e in edges {
            match level_of.get(&e.to) {
                None => {
                    level_of.insert(e.to, level + 1);
                    parents_of.entry(e.to).or_default().insert((key, e.via_pattern));
                    next.insert(e.to);
                }
                Some(&existing_level) if existing_level == level + 1 => {
                    parents_of.entry(e.to).or_default().insert((key, e.via_pattern));
                }
                _ => {}
            }
        }
    }
    next
}

/// A reconstructed half-path: the literal stop_pk sequence, plus the
/// "pattern signature" — the ordered list of real transit patterns
/// ridden, with walk hops dropped entirely (they carry `None` and
/// contribute nothing). Two half-paths that ride the exact same patterns
/// in the exact same order are the same route from a rider's perspective
/// even if they touch different intermediate platforms via a walk closure
/// — the signature is what path assembly dedupes on below, instead of the
/// raw stops.
type HalfPath = (Vec<i64>, Vec<i64>, Vec<Option<i64>>);

fn backtrack_to_origin(
    node: i64,
    path_so_far: &mut Vec<i64>,
    pattern_so_far: &mut Vec<i64>,
    edges_so_far: &mut Vec<Option<i64>>,
    in_path: &mut FxHashSet<i64>,
    origin_set: &FxHashSet<i64>,
    parents_of_fwd: &FxHashMap<i64, FxHashSet<ParentEdge>>,
    out: &mut Vec<HalfPath>,
    cap: usize,
) {
    if out.len() >= cap { return; }
    if in_path.contains(&node) { return; }

    path_so_far.push(node);

    if origin_set.contains(&node) {
        let mut full = path_so_far.clone();
        full.reverse();
        let mut sig = pattern_so_far.clone();
        sig.reverse();
        let mut edges = edges_so_far.clone();
        edges.reverse();
        out.push((full, sig, edges));
        path_so_far.pop();
        return;
    }

    let parents = parents_of_fwd.get(&node);
    let Some(parents) = parents else { path_so_far.pop(); return };
    if parents.is_empty() { path_so_far.pop(); return; }

    in_path.insert(node);
    for &(p, via_pattern) in parents {
        if out.len() >= cap { break; }
        if let Some(pat) = via_pattern { pattern_so_far.push(pat); }
        edges_so_far.push(via_pattern);
        backtrack_to_origin(p, path_so_far, pattern_so_far, edges_so_far, in_path, origin_set, parents_of_fwd, out, cap);
        if via_pattern.is_some() { pattern_so_far.pop(); }
        edges_so_far.pop();
    }
    in_path.remove(&node);
    path_so_far.pop();
}

fn backtrack_to_dest(
    node: i64,
    path_so_far: &mut Vec<i64>,
    pattern_so_far: &mut Vec<i64>,
    edges_so_far: &mut Vec<Option<i64>>,
    in_path: &mut FxHashSet<i64>,
    dest_set: &FxHashSet<i64>,
    parents_of_bwd: &FxHashMap<i64, FxHashSet<ParentEdge>>,
    out: &mut Vec<HalfPath>,
    cap: usize,
) {
    if out.len() >= cap { return; }
    if in_path.contains(&node) { return; }

    path_so_far.push(node);

    if dest_set.contains(&node) {
        out.push((path_so_far.clone(), pattern_so_far.clone(), edges_so_far.clone()));
        path_so_far.pop();
        return;
    }

    let parents = parents_of_bwd.get(&node);
    let Some(parents) = parents else { path_so_far.pop(); return };
    if parents.is_empty() { path_so_far.pop(); return; }

    in_path.insert(node);
    for &(p, via_pattern) in parents {
        if out.len() >= cap { break; }
        if let Some(pat) = via_pattern { pattern_so_far.push(pat); }
        edges_so_far.push(via_pattern);
        backtrack_to_dest(p, path_so_far, pattern_so_far, edges_so_far, in_path, dest_set, parents_of_bwd, out, cap);
        if via_pattern.is_some() { pattern_so_far.pop(); }
        edges_so_far.pop();
    }
    in_path.remove(&node);
    path_so_far.pop();
}

/// Memoized real-time-from-root score for one BFS tree (forward from
/// origin via `parents_of_fwd`/`origin_set`, or backward from destination
/// via `parents_of_bwd`/`dest_set` — same shape, called once per side).
/// A node can have several parents (a DAG, not a tree — see `ParentEdge`'s
/// doc above), so this is a min-over-parents recursion, not a single
/// lookup; memoized because ancestor chains overlap heavily across the
/// candidate meeting nodes sharing these same two BFS trees — without
/// memoizing, scoring N candidates whose chains overlap by depth D would
/// redo the same sub-walk up to N times.
///
/// Per-edge cost: a transit edge (`via_pattern = Some`) looks up
/// `PatternCumulativeCache`'s real cumulative-time difference between the
/// two stops on that pattern — this corrects for `CoarseGraph`'s transit
/// edges being a clique/stride-sampled simplification (an edge can skip
/// real intermediate stops, so "real time for this edge" isn't
/// recoverable from the edge alone; see `PatternCumulativeCache`'s own doc
/// in repo.rs). Falls back to straight-line distance at
/// `ASSUMED_TRANSIT_SPEED_MPS` when either endpoint has no cumulative-time
/// data, same "don't treat a data gap as a free hop" reasoning used
/// everywhere else this fallback appears (import.rs, freq_raptor.rs). A
/// walk edge (`via_pattern = None`) uses straight-line distance at
/// `RANK_MEETS_WALKING_SPEED_MPS` — real `distance_m` is available on the
/// matching `CoarseEdge`, but finding that specific edge back out of the
/// adjacency list per hop is more work than just recomputing haversine
/// here, and the fallback path already does exactly that anyway.
///
/// TRANSFER/WAIT COST: the memo carries `(time, arrival_pattern)`, not
/// just a scalar time — `arrival_pattern` is whichever pattern the BEST
/// path into this node was riding when it got here (`None` if it arrived
/// by walking, or is a root stop with no boarding yet). This is what lets
/// a NEW boarding be told apart from CONTINUING along the same pattern: a
/// transit edge whose `via_pattern` differs from the arriving path's
/// `arrival_pattern` (including the "wasn't riding anything yet" case) is
/// a real boarding, and gets `PatternHeadwayCache`'s `headway/2` wait
/// added — same reasoning `freq_raptor` already uses for every boarding.
/// Without this, a 2-ride journey's estimate silently treats every
/// transfer as instant, which systematically UNDER-prices it relative to
/// a genuinely-faster 1-ride alternative (the two estimators disagreeing
/// on this was a real, found inconsistency — see the corridor-resolution
/// design discussion). A walk edge never needs this: waiting doesn't apply
/// to walking, and it resets `arrival_pattern` to `None` so whatever
/// boarding comes after a walk is correctly treated as fresh.
#[allow(clippy::too_many_arguments)]
fn real_time_from_root(
    node: i64,
    parents_of: &FxHashMap<i64, FxHashSet<ParentEdge>>,
    root_set: &FxHashSet<i64>,
    root_point: LatLon,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
    stops: &StopsCache,
    memo: &mut FxHashMap<i64, (f64, Option<i64>)>,
) -> (f64, Option<i64>) {
    if let Some(&v) = memo.get(&node) { return v; }

    if root_set.contains(&node) {
        // Base case: the "last mile" from the literal origin/destination
        // point to this seed stop — the old distance_sum_m scored the
        // WHOLE journey this way (pure straight-line, start to finish);
        // here it's only this one leg, with everything past the seed stop
        // now real transit/walk time instead of more straight-line. No
        // pattern ridden yet, so `arrival_pattern` is `None` — the first
        // real boarding from here still gets its own wait charged below.
        let v: (f64, Option<i64>) = match stops.get(node) {
            None => (f64::MAX, None), // can't locate — treat as maximally far, same as the old version's None arm, rather than vanish the candidate outright
            Some(row) => (haversine_meters(root_point, LatLon { lat: row.stop_lat, lon: row.stop_lon }) / RANK_MEETS_WALKING_SPEED_MPS, None),
        };
        memo.insert(node, v);
        return v;
    }

    // Sentinel inserted before recursing: level_of strictly increases
    // across a transit hop, and walk_closure only ever links same-level
    // nodes without creating a parent cycle — so this should never
    // actually get hit — but this guards against infinite recursion
    // instead of silently trusting that invariant to hold forever.
    memo.insert(node, (f64::MAX, None));

    let Some(parents) = parents_of.get(&node) else {
        memo.insert(node, (f64::MAX, None));
        return (f64::MAX, None);
    };
    let Some(node_row) = stops.get(node) else {
        memo.insert(node, (f64::MAX, None));
        return (f64::MAX, None);
    };
    let node_ll = LatLon { lat: node_row.stop_lat, lon: node_row.stop_lon };

    let mut best = f64::MAX;
    let mut best_pattern: Option<i64> = None;
    for &(p, via_pattern) in parents {
        let (t_p, p_arrival_pattern) = real_time_from_root(p, parents_of, root_set, root_point, cumulative, headway, stops, memo);
        if t_p >= f64::MAX { continue; }
        let Some(p_row) = stops.get(p) else { continue };
        let p_ll = LatLon { lat: p_row.stop_lat, lon: p_row.stop_lon };

        let (ride_cost, arrival_pattern) = match via_pattern {
            Some(pattern_pk) => {
                let ride = match (cumulative.cumulative_sec(pattern_pk, p), cumulative.cumulative_sec(pattern_pk, node)) {
                    (Some(cp), Some(cn)) if cn >= cp => (cn - cp) as f64,
                    _ => haversine_meters(p_ll, node_ll) / ASSUMED_TRANSIT_SPEED_MPS,
                };
                (ride, Some(pattern_pk))
            }
            None => (haversine_meters(p_ll, node_ll) / RANK_MEETS_WALKING_SPEED_MPS, None),
        };

        // A boarding happens whenever this edge rides a pattern the
        // arriving path wasn't already on — covers both a genuine
        // transfer (was on a different pattern) and a first boarding (was
        // on none, e.g. straight off the origin or after a walk). A walk
        // edge (arrival_pattern = None here) never incurs this.
        let wait_cost = match arrival_pattern {
            Some(pk) if p_arrival_pattern != Some(pk) => match headway.headway_for(pk, t_p as i64) {
                Some(h) => h as f64 / 2.0,
                None => FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC as f64,
            },
            _ => 0.0,
        };

        let total = t_p + wait_cost + ride_cost;
        if total < best {
            best = total;
            best_pattern = arrival_pattern;
        }
    }
    let result = (best, best_pattern);
    memo.insert(node, result);
    result
}

/// Scores ONE already-assembled candidate path (a full `paths` entry, plus
/// its per-hop `edges` from `backtrack_to_origin`/`backtrack_to_dest`),
/// walked linearly hop-by-hop — as opposed to `real_time_from_root`, which
/// finds the best-over-all-parents time TO a node via memoized DP. Those
/// two numbers can legitimately differ for the same node: `meet_scores`
/// answers "what's the best possible time to reach this meeting node,
/// via whichever parent chain is fastest", while this answers "what's the
/// time along THIS SPECIFIC assembled path", which backtracking may not
/// have taken via that fastest chain (it enumerates ALL parent
/// combinations up to `MAX_SEED_PATHS`, not just the DP-optimal one).
/// `path` and `edges` must satisfy `edges.len() == path.len() - 1` — every
/// caller here builds them in lockstep, so this is a contract, not a
/// runtime check to survive gracefully.
fn score_seed_path(
    path: &[i64],
    edges: &[Option<i64>],
    origin_point: LatLon,
    destination_point: LatLon,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
    stops: &StopsCache,
) -> f64 {
    if path.is_empty() { return f64::MAX; }
    let Some(first_row) = stops.get(path[0]) else { return f64::MAX };
    let mut total = haversine_meters(
        origin_point,
        LatLon { lat: first_row.stop_lat, lon: first_row.stop_lon },
    ) / RANK_MEETS_WALKING_SPEED_MPS;

    // Same "a boarding happens whenever this edge rides a pattern the
    // arriving path wasn't already on" rule real_time_from_root uses —
    // kept in sync deliberately, see that function's doc.
    let mut riding_pattern: Option<i64> = None;
    for (i, &via_pattern) in edges.iter().enumerate() {
        let Some(from_row) = stops.get(path[i]) else { return f64::MAX };
        let Some(to_row) = stops.get(path[i + 1]) else { return f64::MAX };
        let from_ll = LatLon { lat: from_row.stop_lat, lon: from_row.stop_lon };
        let to_ll = LatLon { lat: to_row.stop_lat, lon: to_row.stop_lon };

        let ride_cost = match via_pattern {
            Some(pattern_pk) => match (cumulative.cumulative_sec(pattern_pk, path[i]), cumulative.cumulative_sec(pattern_pk, path[i + 1])) {
                (Some(cp), Some(cn)) if cn >= cp => (cn - cp) as f64,
                _ => haversine_meters(from_ll, to_ll) / ASSUMED_TRANSIT_SPEED_MPS,
            },
            None => haversine_meters(from_ll, to_ll) / RANK_MEETS_WALKING_SPEED_MPS,
        };

        let wait_cost = match via_pattern {
            Some(pk) if riding_pattern != Some(pk) => match headway.headway_for(pk, total as i64) {
                Some(h) => h as f64 / 2.0,
                None => FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC as f64,
            },
            _ => 0.0,
        };

        total += wait_cost + ride_cost;
        riding_pattern = via_pattern;
    }

    let Some(last_row) = stops.get(*path.last().unwrap()) else { return f64::MAX };
    total += haversine_meters(
        destination_point,
        LatLon { lat: last_row.stop_lat, lon: last_row.stop_lon },
    ) / RANK_MEETS_WALKING_SPEED_MPS;

    total
}

/// Ranks meeting nodes by REAL estimated hop-time, WITHIN depth buckets
/// first — does NOT truncate. Truncation now happens per-attempt in
/// `materialize_seed_paths` (see its doc comment), so a caller that needs
/// a bigger batch after a first attempt came back empty can re-slice this
/// SAME ranked list without re-running BFS at all.
///
/// REPLACED (previously straight-line distance_sum_m — see git history if
/// you need the old version): scores each meeting node by real time,
/// walking `parents_of_fwd`/`parents_of_bwd` back to the nearest seed stop
/// via `real_time_from_root` — see that fn's doc for the per-edge cost
/// model and why a straight lookup isn't enough. Straight-line distance
/// was always a PROXY for "how fast can transit get you through this
/// transfer point" — this scores that directly, using the same precomputed
/// hop-time data `freq_raptor.rs`'s post-materialization narrowing already
/// relies on, just applied one stage earlier, before any pattern has been
/// materialized via SQL at all.
///
/// DEPTH SEPARATION: a single global score lets a very
/// straight-line-but-deep (near L + SAFETY_MARGIN_LEVELS) meeting node
/// outrank every meeting node at the true shortest-transfer depth L — but
/// straightness on the coarse graph is only a proxy; transfer count is the
/// thing that's actually cheap to get right. So candidates are first
/// bucketed by `depth = combined_level - first_meet_total_level`, one
/// bucket per depth in `0..=SAFETY_MARGIN_LEVELS` (SAFETY_MARGIN_LEVELS+1
/// buckets total), each bucket sorted by real-time score independently,
/// then the buckets are merged via smooth weighted round-robin
/// (`weighted_round_robin_merge`) — shallower depths get more weight (see
/// `depth_bucket_weight` / `SEED_MEET_DEPTH_BUCKET_WEIGHT`). This keeps a `batch_size` prefix —
/// including a small first-attempt TOP_N_SEED_MEETS slice — populated
/// mostly from the fewest-transfer bucket while still letting some
/// deeper-but-faster alternatives through, rather than either extreme
/// (a pure global sort that can bury the shortest transfer count, or a
/// strict depth-first cutoff that admits zero deeper alternatives until
/// the shallow bucket is fully exhausted).
/// Bucket index (`0..=SAFETY_MARGIN_LEVELS`) for a meeting node's combined
/// BFS level relative to `first_meet_total_level` — depth 0 is the
/// shallowest (fewest extra transfers past the shortest meet), deeper
/// buckets cost progressively more transfers. Shared between `rank_meets`
/// (which builds the buckets) and any caller that wants to recompute which
/// bucket a given already-ranked meet fell into (e.g. before/after logging
/// once a `batch_size` has truncated `ordered_meets`), so both sides always
/// agree on the same bucketing.
pub(crate) fn meet_depth(combined: u32, first_meet_total_level: i64, num_buckets: usize) -> usize {
    ((combined as i64 - first_meet_total_level).max(0) as usize).min(num_buckets - 1)
}

#[allow(clippy::too_many_arguments)]
fn rank_meets(
    meets: Vec<(i64, u32)>,
    origin: LatLon,
    destination: LatLon,
    stops: &StopsCache,
    first_meet_total_level: i64,
    parents_of_fwd: &FxHashMap<i64, FxHashSet<ParentEdge>>,
    parents_of_bwd: &FxHashMap<i64, FxHashSet<ParentEdge>>,
    origin_set: &FxHashSet<i64>,
    dest_set: &FxHashSet<i64>,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
) -> (Vec<(i64, u32)>, Vec<usize>, FxHashMap<i64, f64>) {
    // Shared across EVERY candidate scored in this whole call, both
    // buckets included — see real_time_from_root's doc for why this is
    // what makes memoizing actually pay off here (heavily overlapping
    // ancestor chains across candidates, not just within one).
    let mut memo_fwd: FxHashMap<i64, (f64, Option<i64>)> = FxHashMap::default();
    let mut memo_bwd: FxHashMap<i64, (f64, Option<i64>)> = FxHashMap::default();
    // node -> combined real-time score, recorded as a side effect of
    // sorting below — returned to the caller so materialize_seed_paths can
    // margin-filter a batch without recomputing real_time_from_root.
    let mut scores: FxHashMap<i64, f64> = FxHashMap::default();

    let mut sort_by_real_time = |bucket: &mut Vec<(i64, u32)>, scores: &mut FxHashMap<i64, f64>| {
        bucket.sort_by_cached_key(|&(node, _)| {
            let (t_fwd, _) = real_time_from_root(node, parents_of_fwd, origin_set, origin, cumulative, headway, stops, &mut memo_fwd);
            let (t_bwd, _) = real_time_from_root(node, parents_of_bwd, dest_set, destination, cumulative, headway, stops, &mut memo_bwd);
            let score = if t_fwd >= f64::MAX || t_bwd >= f64::MAX { f64::MAX } else { t_fwd + t_bwd };
            scores.insert(node, score);
            (score.to_bits(), node)
        });
    };

    if !DEPTH_BUCKET_RANKING_ENABLED {
        // Single bucket, no depth separation, no weighted interleave —
        // pure global real-time sort. bucket_sizes_before still comes
        // back length-1 so the seed_bucket{depth}_before/after logging in
        // tagging.rs keeps working unchanged, just with one bucket to log.
        let mut all: Vec<(i64, u32)> = meets;
        let bucket_sizes_before = vec![all.len()];
        sort_by_real_time(&mut all, &mut scores);
        return (all, bucket_sizes_before, scores);
    }

    let num_buckets = SAFETY_MARGIN_LEVELS as usize + 1;
    let mut buckets: Vec<Vec<(i64, u32)>> = vec![Vec::new(); num_buckets];
    for (node, combined) in meets {
        // Depth is relative to the first meet, clamped into range defensively
        // — `combined` is already filtered to `<= max_collect_combined_level`
        // by the caller, so this should always land in `0..num_buckets`, but
        // clamping means a future caller change can't panic here.
        let depth = meet_depth(combined, first_meet_total_level, num_buckets);
        buckets[depth].push((node, combined));
    }
    let bucket_sizes_before: Vec<usize> = buckets.iter().map(|b| b.len()).collect();
    for bucket in &mut buckets {
        sort_by_real_time(bucket, &mut scores);
    }

    let weights: Vec<i64> = (0..num_buckets)
        .map(|depth| depth_bucket_weight(depth, num_buckets))
        .collect();
    (weighted_round_robin_merge(buckets, &weights), bucket_sizes_before, scores)
}

/// Bucket weight for depth-separated ranking: shallower depths (fewer
/// transfers past the shortest meet) get a bigger effective bucket, so a
/// truncated `batch_size` prefix is still dominated by the fewest-transfer
/// candidates. Linear taper — depth 0 gets `num_buckets`, the deepest depth
/// gets `1` — keeps the ratio simple and proportional to how many
/// SAFETY_MARGIN_LEVELS-worth of "extra" transfers a candidate costs.
fn depth_bucket_weight(depth: usize, num_buckets: usize) -> i64 {
    // Linear taper: depth 0 (the shallowest, fewest-extra-transfers bucket
    // — where BFS first found a meet) gets weight `num_buckets *
    // SEED_MEET_DEPTH_BUCKET_WEIGHT`, and each deeper depth gets
    // proportionally less, down to `SEED_MEET_DEPTH_BUCKET_WEIGHT` at the
    // deepest bucket. This means a truncated `batch_size` prefix is
    // dominated by the fewest-transfer candidates first, with deeper
    // buckets only filling in the remainder — rather than every depth
    // getting an equal slice regardless of how many "extra" transfers it
    // costs. Straightness ranking still happens WITHIN each depth bucket;
    // this only controls how the buckets are interleaved.
    (num_buckets - depth) as i64 * SEED_MEET_DEPTH_BUCKET_WEIGHT
}

/// Smooth weighted round-robin merge: interleaves several already-sorted
/// buckets into one list so that any PREFIX of the output — not just the
/// full merge — approximates the buckets' weight ratio. This is what makes
/// depth separation actually work under truncation: `materialize_seed_paths`
/// slices `ordered_meets[..batch_size]` for an arbitrary `batch_size` (the
/// first-attempt TOP_N_SEED_MEETS, or a bigger retry slice), so a naive
/// "all of bucket 0 then all of bucket 1" concatenation would only pay off
/// once `batch_size` was large enough to spill into bucket 1 at all — a
/// small first-attempt batch would see the depth split as an all-or-nothing
/// cliff rather than a preference.
///
/// Classic scheduler algorithm (as used e.g. by nginx's smooth weighted
/// round robin): each round, every non-empty bucket's running `current`
/// credit increases by its own weight; the bucket with the highest `current`
/// is picked, contributes one item, and has the round's total active weight
/// subtracted back off. Exhausted buckets drop out of the weight sum for
/// subsequent rounds instead of forcing empty picks.
fn weighted_round_robin_merge(
    mut buckets: Vec<Vec<(i64, u32)>>,
    weights: &[i64],
) -> Vec<(i64, u32)> {
    use std::collections::VecDeque;
    let mut queues: Vec<VecDeque<(i64, u32)>> = buckets.drain(..).map(VecDeque::from).collect();
    let mut current: Vec<i64> = vec![0; queues.len()];
    let total_len: usize = queues.iter().map(|q| q.len()).sum();
    let mut out = Vec::with_capacity(total_len);

    loop {
        let active: Vec<usize> = (0..queues.len()).filter(|&i| !queues[i].is_empty()).collect();
        if active.is_empty() { break; }
        let active_total_weight: i64 = active.iter().map(|&i| weights[i]).sum();
        for &i in &active { current[i] += weights[i]; }
        let best = active.into_iter().max_by_key(|&i| current[i]).unwrap();
        current[best] -= active_total_weight;
        if let Some(item) = queues[best].pop_front() { out.push(item); }
    }
    out
}

pub fn run_seed_bfs(
    graph: &CoarseGraph,
    origin: LatLon,
    destination: LatLon,
    stops: &StopsCache,
    origin_pks: &[i64],
    dest_pks: &[i64],
    max_transfers: u32,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
) -> SeedBfsRun {
    let max_levels = level_cap_for(max_transfers);
    let origin_set: FxHashSet<i64> = origin_pks.iter().copied().collect();
    let dest_set: FxHashSet<i64> = dest_pks.iter().copied().collect();

    let mut level_of_fwd: FxHashMap<i64, u32> = FxHashMap::default();
    let mut parents_of_fwd: FxHashMap<i64, FxHashSet<ParentEdge>> = FxHashMap::default();
    for &k in origin_pks { level_of_fwd.entry(k).or_insert(0); }

    let mut level_of_bwd: FxHashMap<i64, u32> = FxHashMap::default();
    let mut parents_of_bwd: FxHashMap<i64, FxHashSet<ParentEdge>> = FxHashMap::default();
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

            // Don't board a transit hop FROM a stop the backward tree has
            // already reached — it's already met, meaning the backward
            // tree's own parent chain already knows a within-budget way
            // from here to the destination. Continuing forward through it
            // can only rediscover ground the backward side covers on its
            // own (or arrive somewhere it never reaches at all), so it
            // just spends round budget — scarce, given SAFETY_MARGIN_LEVELS
            // — without adding real corridor coverage. Nodes NOT yet met
            // still expand normally, so sibling routes via other lines are
            // unaffected. walk_closure/note_meets above still ran on the
            // full boardable set — this only trims what goes on to board a
            // real line.
            let expandable: FxHashSet<i64> = boardable.iter()
                .filter(|k| !level_of_bwd.contains_key(k))
                .copied()
                .collect();
            let next = transit_hop_forward(graph, &expandable, &mut level_of_fwd, &mut parents_of_fwd, level_fwd);
            note_meets(&next, &level_of_fwd, &level_of_bwd, &mut meeting_nodes, &mut first_meet_total_level);

            level_fwd += 1;
            transit_frontier_fwd = next;
        } else {
            let boardable = walk_closure(graph, transit_frontier_bwd, &mut level_of_bwd, &mut parents_of_bwd, level_bwd);
            level_frontiers.push((SearchDir::Backward, boardable.iter().copied().collect()));
            note_meets(&boardable, &level_of_bwd, &level_of_fwd, &mut meeting_nodes, &mut first_meet_total_level);

            // Mirror of the forward-side skip above.
            let expandable: FxHashSet<i64> = boardable.iter()
                .filter(|k| !level_of_fwd.contains_key(k))
                .copied()
                .collect();
            let next = transit_hop_backward(graph, &expandable, &mut level_of_bwd, &mut parents_of_bwd, level_bwd);
            note_meets(&next, &level_of_bwd, &level_of_fwd, &mut meeting_nodes, &mut first_meet_total_level);

            level_bwd += 1;
            transit_frontier_bwd = next;
        }
    }

    if first_meet_total_level < 0 {
        return SeedBfsRun {
            ordered_meets: Vec::new(),
            meet_scores: FxHashMap::default(),
            first_meet_total_level: -1,
            parents_of_fwd,
            parents_of_bwd,
            origin_set,
            dest_set,
            levels_expanded: level_fwd + level_bwd,
            level_frontiers,
            bucket_sizes_before: Vec::new(),
            origin_point: origin,
            destination_point: destination,
        };
    }

    let max_collect_combined_level = first_meet_total_level + SAFETY_MARGIN_LEVELS as i64;

    let mut ordered_meets: Vec<(i64, u32)> = meeting_nodes.into_iter()
        .filter(|&(_, combined)| combined as i64 <= max_collect_combined_level)
        .collect();
    ordered_meets.sort_by_key(|&(node, combined)| (combined, node));
    let (ordered_meets, bucket_sizes_before, meet_scores) = rank_meets(
        ordered_meets, origin, destination, stops, first_meet_total_level,
        &parents_of_fwd, &parents_of_bwd, &origin_set, &dest_set, cumulative, headway,
    );

    SeedBfsRun {
        ordered_meets,
        meet_scores,
        first_meet_total_level,
        parents_of_fwd,
        parents_of_bwd,
        origin_set,
        dest_set,
        levels_expanded: level_fwd + level_bwd,
        level_frontiers,
        bucket_sizes_before,
        origin_point: origin,
        destination_point: destination,
    }
}

/// Turns a batch of `run.ordered_meets` into an actual `SeedPathResult` —
/// `core_stop_pks` (ancestor union, exact/uncapped within the batch) and
/// `paths`/`path_pattern_pks`/`path_depths` (backtracked — no longer capped
/// at `MAX_SEED_PATHS` for the debug/visualization total; that constant is
/// now only an internal guard against combinatorial fanout WITHIN a single
/// meet's half-path enumeration, not a limit on how many candidates the
/// debug view sees overall). Cheap
/// relative to `run_seed_bfs`: no graph traversal here, just walking
/// already-built parent-pointer chains — so a caller can call this
/// repeatedly with a bigger `batch_size` against the SAME `run` (e.g. a
/// first attempt came back with no active trips, retry with a bigger
/// slice of the same ranked meets) without ever re-running BFS.
///
/// `batch_size` slices `run.ordered_meets[..batch_size]` (clamped to the
/// full length) — this is what used to be the fixed `TOP_N_SEED_MEETS`
/// truncation inside `rank_meets`; now the caller decides per
/// attempt instead of it being baked into the ranking step.
pub fn materialize_seed_paths(
    run: &SeedBfsRun,
    batch_size: usize,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
    stops: &StopsCache,
) -> SeedPathResult {
    if run.ordered_meets.is_empty() {
        return SeedPathResult {
            paths: Vec::new(),
            path_pattern_pks: Vec::new(),
            path_scores: Vec::new(),
            path_count_before_margin: 0,
            core_stop_pks: FxHashSet::default(),
            core_stop_pks_by_depth: Vec::new(),
            path_depths: Vec::new(),
            levels_expanded: run.levels_expanded,
            level_frontiers: run.level_frontiers.clone(),
            after_counts: Vec::new(),
        };
    }

    let capped = &run.ordered_meets[..batch_size.min(run.ordered_meets.len())];

    // MARGIN FILTER: `capped` is still a raw count-based slice (batch_size
    // remains the outer ceiling, and what the existing retry ladder
    // doubles — see resolver.rs). Within that ceiling, drop any meeting
    // node whose real-time score isn't within margin of the BEST score —
    // see SEED_MEET_SELECT_MARGIN_*'s doc in settings.rs.
    //
    // PER-DEPTH, not global: `capped` is already the product of
    // `rank_meets`'s weighted round-robin merge, which deliberately keeps
    // SOME deeper/transfer meeting nodes in the batch even when a
    // shallower one scores much better — that's the whole point of depth
    // bucketing (see rank_meets's doc: a strict global sort can bury a
    // real multi-transfer option under a merely-straighter one, now
    // merely-faster-looking one). A single global margin threshold applied
    // AFTER that merge would immediately undo it — every deep candidate
    // the merge preserved would likely fail a margin computed against the
    // shallowest bucket's best score, since a fair transfer inherently
    // costs more real time than a direct ride even when it's the right
    // choice. Computing margin separately per depth bucket keeps each
    // depth's own already-negotiated representation intact; only the hard
    // SEED_MEET_SELECT_TOP_K ceiling below stays global, since that one is
    // a pure backtracking-cost bound, not a fairness mechanism.
    let num_margin_buckets = SAFETY_MARGIN_LEVELS as usize + 1;
    let mut capped_by_depth: Vec<Vec<(i64, u32)>> = vec![Vec::new(); num_margin_buckets];
    for &(node, combined) in capped {
        capped_by_depth[meet_depth(combined, run.first_meet_total_level, num_margin_buckets)].push((node, combined));
    }
    let mut batch: Vec<(i64, u32)> = Vec::with_capacity(capped.len());
    for depth_group in &capped_by_depth {
        if depth_group.is_empty() { continue; }

        let best_score = depth_group.iter()
            .filter_map(|&(node, _)| run.meet_scores.get(&node).copied())
            .filter(|&s| s < f64::MAX)
            .fold(f64::MAX, f64::min);

        // Toggle off, no scoreable node in this depth at all, or the
        // path-level margin filter is doing the real selection instead
        // (ENABLE_SEED_PATH_MARGIN — see its doc): keep the whole group
        // rather than filtering against a threshold we can't meaningfully
        // compute, or against a gate this mode is meant to replace (same
        // fail-open reasoning as the per-node case below, applied at the
        // group level).
        if !ENABLE_SEED_MEET_SELECT_MARGIN_PRUNE || ENABLE_SEED_PATH_MARGIN || best_score >= f64::MAX {
            batch.extend(depth_group.iter().copied());
            continue;
        }

        let margin = margin_threshold(best_score, SEED_MEET_SELECT_MARGIN_FLOOR_SEC, SEED_MEET_SELECT_MARGIN_RELATIVE_PCT);
        let threshold = best_score + margin;
        // A node with no score on record (shouldn't happen — rank_meets
        // scores every node it ever sorts — but treated as "unscoreable,
        // keep it" rather than silently dropped, same fail-open reasoning
        // used everywhere else an f64::MAX sentinel appears in this file).
        batch.extend(depth_group.iter().filter(|&&(node, _)| run.meet_scores.get(&node).map(|&s| s <= threshold).unwrap_or(true)).copied());
    }
    // Hard ceiling on top of the margin filter — see SEED_MEET_SELECT_TOP_K's
    // doc in settings.rs. Only actually sorts/truncates when the margin
    // filter alone didn't already bring the batch under K. Skipped
    // entirely in path-margin mode, same reasoning as the margin filter
    // above — this ceiling exists to bound the OLD meet-level selection's
    // backtracking cost, and path-margin mode wants every meet's paths
    // backtracked so its own path-level margin has the full field to
    // choose from.
    if !ENABLE_SEED_PATH_MARGIN && batch.len() > SEED_MEET_SELECT_TOP_K {
        batch.sort_by_cached_key(|&(node, _)| run.meet_scores.get(&node).copied().unwrap_or(f64::MAX).to_bits());
        batch.truncate(SEED_MEET_SELECT_TOP_K);
    }
    let batch = batch.as_slice();

    // A single edge straddling the frontier gets discovered as a "meeting
    // point" from both of its endpoints (forward lands on the far end the
    // same step backward lands on the near end) — dedupe by content, not
    // just by meeting node, or the same path comes out twice.
    //
    // Dedup key is the PATTERN signature (which real lines were ridden, in
    // order) when the path has one, falling back to the raw stop sequence
    // only for the rare all-walk path (no transit boardings at all, so no
    // pattern to key on). Keying on stops instead of patterns was the
    // original design, and it's what let the walk-closure's platform
    // fanout (e.g. several stops of the same line, all reachable at the
    // same level) multiply out into many enumerated "different" paths
    // that were actually the same route via a different platform — this
    // collapses those back into one, while genuinely different lines or
    // junctions still produce distinct signatures and stay distinct.
    // (std HashSet here, not FxHash — small cardinality capped at
    // MAX_SEED_PATHS, not worth a specialized hasher.)
    #[derive(PartialEq, Eq, Hash)]
    enum SeedPathKey {
        ByPattern(Vec<i64>),
        ByStops(Vec<i64>),
    }

    // Correctness-relevant output: every stop that's an ancestor of a kept
    // meeting node, on EITHER side. Computed once, up front, from THIS
    // BATCH of ordered_meets — this is what `compute_seed_path_corridor`
    // should read for `pattern_pks`/`core_stop_pks`, not `paths`. A
    // meeting node outside this batch (worse straightness score) never
    // contributes its ancestors here, so pattern_pks/RAPTOR's corridor is
    // genuinely narrowed by batch_size — not just the debug path list
    // (see MAX_SEED_PATHS's doc comment in settings.rs).
    let meeting_pks: Vec<i64> = batch.iter().map(|&(m, _)| m).collect();
    let mut core_stop_pks = ancestor_stop_union(meeting_pks.iter().copied(), &run.parents_of_fwd);
    core_stop_pks.extend(ancestor_stop_union(meeting_pks.iter().copied(), &run.parents_of_bwd));

    // Same union, split by depth bucket — shallowest-wins for any stop
    // reachable from more than one depth (see the field's doc comment).
    // Recomputes ancestor_stop_union per depth instead of reusing the
    // flat pass above: cheap here since num_buckets is small
    // (SAFETY_MARGIN_LEVELS + 1) and it's the only way to know which
    // depth "claims" a stop first.
    let num_buckets = SAFETY_MARGIN_LEVELS as usize + 1;
    let mut meets_by_depth: Vec<Vec<i64>> = vec![Vec::new(); num_buckets];
    for &(m, combined) in batch {
        let depth = meet_depth(combined, run.first_meet_total_level, num_buckets);
        meets_by_depth[depth].push(m);
    }
    // The real "after" counterpart to SeedBfsRun::bucket_sizes_before —
    // from THIS (margin-filtered) batch, not the raw batch_size slice. See
    // SeedPathResult::after_counts' doc.
    let after_counts: Vec<usize> = meets_by_depth.iter().map(|d| d.len()).collect();
    let mut core_stop_pks_by_depth: Vec<FxHashSet<i64>> = Vec::with_capacity(num_buckets);
    let mut claimed: FxHashSet<i64> = FxHashSet::default();
    for depth_meets in &meets_by_depth {
        let mut this_depth = ancestor_stop_union(depth_meets.iter().copied(), &run.parents_of_fwd);
        this_depth.extend(ancestor_stop_union(depth_meets.iter().copied(), &run.parents_of_bwd));
        this_depth.retain(|pk| !claimed.contains(pk));
        claimed.extend(this_depth.iter().copied());
        core_stop_pks_by_depth.push(this_depth);
    }

    let mut seen_paths: HashSet<SeedPathKey> = HashSet::new();
    let mut paths: Vec<Vec<i64>> = Vec::new();
    let mut path_pattern_pks: Vec<Vec<i64>> = Vec::new();
    let mut path_depths: Vec<u32> = Vec::new();
    let mut path_scores: Vec<f64> = Vec::new();
    for &(m, combined) in batch {
        // Depth relative to the shortest meet, same computation `rank_meets`
        // uses for bucketing — kept here per-path (not just per-meet) so a
        // debug consumer can color EVERY candidate seed path by depth, not
        // just look it up via the meeting node.
        let depth = (combined as i64 - run.first_meet_total_level).max(0) as u32;

        let mut fwd_paths: Vec<HalfPath> = Vec::new();
        {
            let mut path_so_far = Vec::new();
            let mut pattern_so_far = Vec::new();
            let mut edges_so_far = Vec::new();
            let mut in_path = FxHashSet::default();
            // MAX_SEED_PATHS here is purely an internal guard against
            // combinatorial fanout WITHIN one meet's half-path enumeration
            // (e.g. several parent branches at the same level) — unrelated
            // to how many total candidates get shown in the debug view,
            // which is no longer capped below.
            backtrack_to_origin(m, &mut path_so_far, &mut pattern_so_far, &mut edges_so_far, &mut in_path, &run.origin_set, &run.parents_of_fwd, &mut fwd_paths, MAX_SEED_PATHS);
        }
        let mut bwd_paths: Vec<HalfPath> = Vec::new();
        {
            let mut path_so_far = Vec::new();
            let mut pattern_so_far = Vec::new();
            let mut edges_so_far = Vec::new();
            let mut in_path = FxHashSet::default();
            backtrack_to_dest(m, &mut path_so_far, &mut pattern_so_far, &mut edges_so_far, &mut in_path, &run.dest_set, &run.parents_of_bwd, &mut bwd_paths, MAX_SEED_PATHS);
        }

        if fwd_paths.is_empty() && run.origin_set.contains(&m) { fwd_paths.push((vec![m], vec![], vec![])); }
        if bwd_paths.is_empty() && run.dest_set.contains(&m) { bwd_paths.push((vec![m], vec![], vec![])); }

        for (fp, fpat, fedges) in &fwd_paths {
            for (bp, bpat, bedges) in &bwd_paths {
                let mut full = fp.clone();
                full.extend_from_slice(&bp[1..]);

                let mut sig = fpat.clone();
                sig.extend_from_slice(bpat);
                let key = if sig.is_empty() {
                    SeedPathKey::ByStops(full.clone())
                } else {
                    SeedPathKey::ByPattern(sig.clone())
                };

                if seen_paths.insert(key) {
                    let mut edges = fedges.clone();
                    edges.extend_from_slice(bedges);
                    let score = score_seed_path(&full, &edges, run.origin_point, run.destination_point, cumulative, headway, stops);
                    paths.push(full);
                    path_pattern_pks.push(sig);
                    path_depths.push(depth);
                    path_scores.push(score);
                }
            }
        }
    }

    let path_count_before_margin = paths.len();
    if ENABLE_SEED_PATH_MARGIN {
        // Global margin filter by whole-trip estimated duration — same
        // max(FLOOR, best*PCT) shape as every other margin filter in this
        // crate (see margin_threshold's doc), applied here to whole
        // ASSEMBLED PATHS rather than individual meeting nodes. This is
        // the real selection mechanism in this mode — the per-meet
        // margin/top-K filter above is bypassed entirely when
        // ENABLE_SEED_PATH_MARGIN is on, so every meet's paths reach this
        // point and get judged on their own real assembled-path score,
        // not on whichever meet happened to produce them.
        let best_score = path_scores.iter().copied().filter(|&s| s < f64::MAX).fold(f64::MAX, f64::min);
        if best_score < f64::MAX {
            let margin = margin_threshold(best_score, SEED_PATH_MARGIN_FLOOR_SEC, SEED_PATH_MARGIN_RELATIVE_PCT);
            let threshold = best_score + margin;
            // Same fail-open reasoning as every other f64::MAX sentinel in
            // this file: a path that couldn't be scored gets kept, not
            // silently dropped, since "couldn't score it" isn't evidence
            // it's a bad path.
            let mut order: Vec<usize> = (0..paths.len())
                .filter(|&i| path_scores[i] <= threshold || path_scores[i] >= f64::MAX)
                .collect();
            order.sort_by(|&a, &b| path_scores[a].partial_cmp(&path_scores[b]).unwrap_or(std::cmp::Ordering::Equal));
            paths = order.iter().map(|&i| paths[i].clone()).collect();
            path_pattern_pks = order.iter().map(|&i| path_pattern_pks[i].clone()).collect();
            path_depths = order.iter().map(|&i| path_depths[i]).collect();
            path_scores = order.iter().map(|&i| path_scores[i]).collect();
        }
        // best_score >= f64::MAX means nothing here was scoreable at all —
        // same fail-open reasoning, keep everything rather than filter
        // against a threshold that can't mean anything.
    }

    SeedPathResult {
        paths,
        path_pattern_pks,
        path_scores,
        path_count_before_margin,
        core_stop_pks,
        core_stop_pks_by_depth,
        path_depths,
        levels_expanded: run.levels_expanded,
        level_frontiers: run.level_frontiers.clone(),
        after_counts,
    }
}

/// Compatibility wrapper for callers that just want the old one-shot
/// behavior — runs BFS once and materializes the top `TOP_N_SEED_MEETS`
/// meets in a single call, same as the pre-retry-ladder version of this
/// function. Prefer `run_seed_bfs` + `materialize_seed_paths` directly if
/// you might need to retry with a bigger batch (see resolver.rs).
pub fn find_seed_paths(
    graph: &CoarseGraph,
    origin: LatLon,
    destination: LatLon,
    stops: &StopsCache,
    origin_pks: &[i64],
    dest_pks: &[i64],
    max_transfers: u32,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
) -> SeedPathResult {
    let run = run_seed_bfs(graph, origin, destination, stops, origin_pks, dest_pks, max_transfers, cumulative, headway);
    materialize_seed_paths(&run, TOP_N_SEED_MEETS, cumulative, headway, stops)
}
