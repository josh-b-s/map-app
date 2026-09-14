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
    level_cap_for, DEPTH_BUCKET_RANKING_ENABLED, MAX_SEED_PATHS, SAFETY_MARGIN_LEVELS,
    SEED_MEET_DEPTH_BUCKET_WEIGHT, TOP_N_SEED_MEETS,
};
use crate::fxhash::{FxHashMap, FxHashSet};
use crate::repo::StopsCache;
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
    /// Depth (relative to the shortest meet, `0..=SAFETY_MARGIN_LEVELS`) of
    /// the meeting node that produced the matching entry in `paths` — lets
    /// a debug/visualization consumer color candidate seed paths by depth
    /// (fewer transfers vs. more) instead of every candidate looking the
    /// same regardless of how many extra hops it took to find it.
    pub path_depths: Vec<u32>,
    pub levels_expanded: u32,
    pub level_frontiers: Vec<(SearchDir, Vec<i64>)>,
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
    /// meet, ranked by distance-sum straightness (see `rank_meets`) —
    /// FULL list, not batch-limited. `materialize_seed_paths` slices a
    /// prefix of this per attempt.
    pub ordered_meets: Vec<(i64, u32)>,
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
type HalfPath = (Vec<i64>, Vec<i64>);

fn backtrack_to_origin(
    node: i64,
    path_so_far: &mut Vec<i64>,
    pattern_so_far: &mut Vec<i64>,
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
        out.push((full, sig));
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
        backtrack_to_origin(p, path_so_far, pattern_so_far, in_path, origin_set, parents_of_fwd, out, cap);
        if via_pattern.is_some() { pattern_so_far.pop(); }
    }
    in_path.remove(&node);
    path_so_far.pop();
}

fn backtrack_to_dest(
    node: i64,
    path_so_far: &mut Vec<i64>,
    pattern_so_far: &mut Vec<i64>,
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
        out.push((path_so_far.clone(), pattern_so_far.clone()));
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
        backtrack_to_dest(p, path_so_far, pattern_so_far, in_path, dest_set, parents_of_bwd, out, cap);
        if via_pattern.is_some() { pattern_so_far.pop(); }
    }
    in_path.remove(&node);
    path_so_far.pop();
}

/// Ranks meeting nodes by distance-sum straightness, WITHIN depth buckets
/// first — does NOT truncate. Truncation now happens per-attempt in
/// `materialize_seed_paths` (see its doc comment), so a caller that needs
/// a bigger batch after a first attempt came back empty can re-slice this
/// SAME ranked list without re-running BFS at all.
///
/// distance_sum_m is the BOTTLENECK score at the meeting node itself:
/// `haversine(origin, meet) + haversine(meet, destination)` — how much
/// total ground riding through this one transfer point covers. (The
/// origin-destination straight-line distance isn't subtracted: it's the
/// same constant for every candidate in a given search, so it wouldn't
/// change the relative ranking — this is the plain point-to-point sum.)
/// Deliberately NOT summed or averaged across every stop on the path —
/// one bad connection should sink a candidate's ranking on its own, not
/// get diluted by otherwise-fine stops, and scoring every ridden stop
/// (rather than just the transfer point) would mean walking full per-line
/// stop sequences for every candidate before any filtering has happened,
/// which is real added cost for a metric that would also unfairly
/// penalize a single wiggly bus line a rider has no way to avoid.
///
/// DEPTH SEPARATION: a single global straightness sort lets a very
/// straight-line-but-deep (near L + SAFETY_MARGIN_LEVELS) meeting node
/// outrank every meeting node at the true shortest-transfer depth L — but
/// straightness on the coarse graph is only a proxy; transfer count is the
/// thing that's actually cheap to get right. So candidates are first
/// bucketed by `depth = combined_level - first_meet_total_level`, one
/// bucket per depth in `0..=SAFETY_MARGIN_LEVELS` (SAFETY_MARGIN_LEVELS+1
/// buckets total), each bucket sorted by straightness independently, then
/// the buckets are merged via smooth weighted round-robin
/// (`weighted_round_robin_merge`) — shallower depths get more weight (see
/// `depth_bucket_weight` / `SEED_MEET_DEPTH_BUCKET_WEIGHT`). This keeps a `batch_size` prefix —
/// including a small first-attempt TOP_N_SEED_MEETS slice — populated
/// mostly from the fewest-transfer bucket while still letting some
/// deeper-but-straighter alternatives through, rather than either extreme
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

fn rank_meets(
    meets: Vec<(i64, u32)>,
    origin: LatLon,
    destination: LatLon,
    stops: &StopsCache,
    first_meet_total_level: i64,
) -> (Vec<(i64, u32)>, Vec<usize>) {
    let distance_sum_m = |node: i64| -> f64 {
        match stops.get(node) {
            // A stop we can't locate can't be scored — rather than
            // silently dropping a possibly-good journey, treat it as
            // maximally-far so it sorts last instead of vanishing outright.
            None => f64::MAX,
            Some(row) => {
                let ll = LatLon { lat: row.stop_lat, lon: row.stop_lon };
                haversine_meters(origin, ll) + haversine_meters(ll, destination)
            }
        }
    };

    // Precompute each node's distance once (O(n)) instead of recomputing it
    // from inside the comparator, which sort_by would call O(n log n) times
    // — cheap here (bounded by SEED_MEETS_RETRY_CEILING) but a one-line fix.
    let sort_by_straightness = |bucket: &mut Vec<(i64, u32)>| {
        bucket.sort_by_cached_key(|&(node, _)| (distance_sum_m(node).to_bits(), node));
    };

    if !DEPTH_BUCKET_RANKING_ENABLED {
        // Single bucket, no depth separation, no weighted interleave —
        // pure global straightness sort. bucket_sizes_before still comes
        // back length-1 so the seed_bucket{depth}_before/after logging in
        // tagging.rs keeps working unchanged, just with one bucket to log.
        let mut all: Vec<(i64, u32)> = meets;
        let bucket_sizes_before = vec![all.len()];
        sort_by_straightness(&mut all);
        return (all, bucket_sizes_before);
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
        sort_by_straightness(bucket);
    }

    let weights: Vec<i64> = (0..num_buckets)
        .map(|depth| depth_bucket_weight(depth, num_buckets))
        .collect();
    (weighted_round_robin_merge(buckets, &weights), bucket_sizes_before)
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
            first_meet_total_level: -1,
            parents_of_fwd,
            parents_of_bwd,
            origin_set,
            dest_set,
            levels_expanded: level_fwd + level_bwd,
            level_frontiers,
            bucket_sizes_before: Vec::new(),
        };
    }

    let max_collect_combined_level = first_meet_total_level + SAFETY_MARGIN_LEVELS as i64;

    let mut ordered_meets: Vec<(i64, u32)> = meeting_nodes.into_iter()
        .filter(|&(_, combined)| combined as i64 <= max_collect_combined_level)
        .collect();
    ordered_meets.sort_by_key(|&(node, combined)| (combined, node));
    let (ordered_meets, bucket_sizes_before) = rank_meets(ordered_meets, origin, destination, stops, first_meet_total_level);

    SeedBfsRun {
        ordered_meets,
        first_meet_total_level,
        parents_of_fwd,
        parents_of_bwd,
        origin_set,
        dest_set,
        levels_expanded: level_fwd + level_bwd,
        level_frontiers,
        bucket_sizes_before,
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
pub fn materialize_seed_paths(run: &SeedBfsRun, batch_size: usize) -> SeedPathResult {
    if run.ordered_meets.is_empty() {
        return SeedPathResult {
            paths: Vec::new(),
            path_pattern_pks: Vec::new(),
            core_stop_pks: FxHashSet::default(),
            path_depths: Vec::new(),
            levels_expanded: run.levels_expanded,
            level_frontiers: run.level_frontiers.clone(),
        };
    }

    let batch = &run.ordered_meets[..batch_size.min(run.ordered_meets.len())];

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

    let mut seen_paths: HashSet<SeedPathKey> = HashSet::new();
    let mut paths: Vec<Vec<i64>> = Vec::new();
    let mut path_pattern_pks: Vec<Vec<i64>> = Vec::new();
    let mut path_depths: Vec<u32> = Vec::new();
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
            let mut in_path = FxHashSet::default();
            // MAX_SEED_PATHS here is purely an internal guard against
            // combinatorial fanout WITHIN one meet's half-path enumeration
            // (e.g. several parent branches at the same level) — unrelated
            // to how many total candidates get shown in the debug view,
            // which is no longer capped below.
            backtrack_to_origin(m, &mut path_so_far, &mut pattern_so_far, &mut in_path, &run.origin_set, &run.parents_of_fwd, &mut fwd_paths, MAX_SEED_PATHS);
        }
        let mut bwd_paths: Vec<HalfPath> = Vec::new();
        {
            let mut path_so_far = Vec::new();
            let mut pattern_so_far = Vec::new();
            let mut in_path = FxHashSet::default();
            backtrack_to_dest(m, &mut path_so_far, &mut pattern_so_far, &mut in_path, &run.dest_set, &run.parents_of_bwd, &mut bwd_paths, MAX_SEED_PATHS);
        }

        if fwd_paths.is_empty() && run.origin_set.contains(&m) { fwd_paths.push((vec![m], vec![])); }
        if bwd_paths.is_empty() && run.dest_set.contains(&m) { bwd_paths.push((vec![m], vec![])); }

        for (fp, fpat) in &fwd_paths {
            for (bp, bpat) in &bwd_paths {
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
                    paths.push(full);
                    path_pattern_pks.push(sig);
                    path_depths.push(depth);
                }
            }
        }
    }

    SeedPathResult {
        paths,
        path_pattern_pks,
        core_stop_pks,
        path_depths,
        levels_expanded: run.levels_expanded,
        level_frontiers: run.level_frontiers.clone(),
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
) -> SeedPathResult {
    let run = run_seed_bfs(graph, origin, destination, stops, origin_pks, dest_pks, max_transfers);
    materialize_seed_paths(&run, TOP_N_SEED_MEETS)
}
