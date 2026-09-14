//! corridor/tagging.rs — port of services/gtfs/corridor/corridorTagging.ts.
//!
//! Single path now: `compute_seed_path_corridor` takes an already-run
//! `SeedBfsRun` (see seed_bfs.rs) plus a `batch_size`, and asks directly
//! "which patterns actually touch a stop the batch's seed paths pass
//! through" via the DB — no per-candidate-stop geometry pass at all.
//!
//! The old bbox-tag-every-candidate-stop fallback (`compute_corridor`/
//! `run_once`, plus `distance_to_segment`/`bbox_filter_candidates`/
//! `tag_stops_for_path`/`boundary_for_path`) is gone. It used to exist for
//! the case where the seed-path corridor came back too thin — now that
//! case is handled by retrying with a bigger `batch_size` against the SAME
//! BFS run (see resolver.rs's retry ladder), which stays exact/graph-based
//! throughout instead of falling back to approximate buffer geometry.

use std::collections::HashSet;
use std::time::Instant;
use rusqlite::Connection;
use crate::geo::{haversine_meters, LatLon};
use crate::corridor::seed_bfs::{materialize_seed_paths, meet_depth, SearchDir, SeedBfsRun};
use crate::repo::get_pattern_pks_for_stops;
use crate::settings::{MAX_TRANSFERS, ORIGIN_DEST_WALK_RADIUS_M, SAFETY_MARGIN_LEVELS};

#[derive(Debug, Clone, Copy)]
pub struct CorridorCandidate {
    pub stop_pk: i64,
    pub lat: f64,
    pub lon: f64,
}

/// Tapered-buffer outline for one seed path — two parallel polylines, left
/// and right of the path. Debug-visualization only; routing never reads it.
/// Always empty now (nothing here computes it anymore — see module doc);
/// kept as a type so the FFI/debug plumbing that still threads an (empty)
/// Vec<CorridorBoundary> through doesn't need its own separate change.
#[derive(Debug, Clone)]
pub struct CorridorBoundary {
    pub left: Vec<LatLon>,
    pub right: Vec<LatLon>,
}

fn walk_radius_stop_pks(candidates: &[CorridorCandidate], origin: LatLon, destination: LatLon) -> HashSet<i64> {
    let mut out = HashSet::new();
    for c in candidates {
        let p = LatLon { lat: c.lat, lon: c.lon };
        if haversine_meters(origin, p) <= ORIGIN_DEST_WALK_RADIUS_M { out.insert(c.stop_pk); }
        if haversine_meters(destination, p) <= ORIGIN_DEST_WALK_RADIUS_M { out.insert(c.stop_pk); }
    }
    out
}

pub struct SeedPathCorridorResult {
    pub pattern_pks: HashSet<i64>,
    pub walk_radius_stop_pks: HashSet<i64>,
    pub seed_path_count: usize,
    pub seed_paths: Vec<Vec<i64>>,
    /// Ordered pattern_pks ridden by the matching entry in `seed_paths` —
    /// use this + repo::get_shape_points/PatternMeta for debug rendering
    /// instead of `corridor_boundaries` (now always empty; see seed_bfs.rs).
    pub path_pattern_pks: Vec<Vec<i64>>,
    /// Depth (relative to the shortest meet) of the matching entry in
    /// `seed_paths` — see `SeedPathResult::path_depths` in seed_bfs.rs.
    pub path_depths: Vec<u32>,
    pub level_frontiers: Vec<(SearchDir, Vec<i64>)>,
    pub corridor_boundaries: Vec<CorridorBoundary>,
    /// Exact, uncapped ancestor-stop union from THIS BATCH of ranked seed
    /// BFS meeting nodes — same set `pattern_pks` itself was derived from.
    /// Exposed here so `resolve_corridor` can trim each matched pattern's
    /// OWN stop list by ordinal stop_sequence position against this set
    /// (see settings::STOP_SEQUENCE_MARGIN) instead of geometric distance.
    pub core_stop_pks: HashSet<i64>,
    /// (label, elapsed_ms) breakdown of this function's own stages.
    pub sub_timings: Vec<(String, i64)>,
}

/// Materializes a batch of `run.ordered_meets` into a real corridor —
/// `core_stop_pks`/`pattern_pks` (correctness-relevant, what RAPTOR is
/// allowed to search) plus `seed_paths`/`path_pattern_pks` (debug-display
/// only, capped by MAX_SEED_PATHS — see seed_bfs.rs). Does NOT run BFS —
/// `run` is built once by the caller (resolver.rs) and can be reused
/// across a retry with a bigger `batch_size` at effectively zero extra
/// BFS cost, only the cheap ancestor-union/backtrack/DB-lookup work below.
pub fn compute_seed_path_corridor(
    conn: &Connection,
    run: &SeedBfsRun,
    batch_size: usize,
    candidates: &[CorridorCandidate],
    origin: LatLon,
    destination: LatLon,
) -> rusqlite::Result<SeedPathCorridorResult> {
    let mut sub_timings: Vec<(String, i64)> = Vec::new();

    // Before/after bucket-size logging: "before" is the raw supply BFS
    // found at each transfer-depth (pre-interleave, pre-batch_size — see
    // SeedBfsRun::bucket_sizes_before); "after" is how many from each depth
    // actually survived this attempt's batch_size truncation of
    // run.ordered_meets. Comparing the two per depth is what shows whether
    // a shallow-but-scarce depth (e.g. a single train option) got crowded
    // out by a deep-but-plentiful one (e.g. dozens of bus siblings) once
    // truncated, rather than only ever seeing the merged total.
    let num_buckets = SAFETY_MARGIN_LEVELS as usize + 1;
    for (depth, &before) in run.bucket_sizes_before.iter().enumerate() {
        sub_timings.push((format!("seed_bucket{depth}_before"), before as i64));
    }
    if !run.bucket_sizes_before.is_empty() {
        let mut after_counts = vec![0usize; num_buckets];
        let batch = &run.ordered_meets[..batch_size.min(run.ordered_meets.len())];
        for &(_, combined) in batch {
            after_counts[meet_depth(combined, run.first_meet_total_level, num_buckets)] += 1;
        }
        for (depth, count) in after_counts.into_iter().enumerate() {
            sub_timings.push((format!("seed_bucket{depth}_after"), count as i64));
        }
    }

    let t = Instant::now();
    let seed = materialize_seed_paths(run, batch_size);
    let walk_radius = walk_radius_stop_pks(candidates, origin, destination);
    sub_timings.push(("materialize".to_string(), t.elapsed().as_millis() as i64));

    if seed.paths.is_empty() {
        return Ok(SeedPathCorridorResult {
            pattern_pks: HashSet::new(), walk_radius_stop_pks: walk_radius, seed_path_count: 0,
            seed_paths: Vec::new(), path_pattern_pks: Vec::new(), path_depths: Vec::new(), level_frontiers: seed.level_frontiers,
            corridor_boundaries: Vec::new(), core_stop_pks: HashSet::new(), sub_timings,
        });
    }

    // Debug/visualization payload: which patterns each seed path actually
    // rode, so a debug view can fetch the REAL shape polyline + route color
    // (repo::get_shape_points / PatternMeta / routes.route_color — the same
    // lookup RAPTOR's own result rendering does) instead of computing an
    // approximate tapered-buffer polygon from stop coordinates.
    let path_pattern_pks = seed.path_pattern_pks.clone();

    // Any pattern touching ANY stop the seed paths pass through — not just
    // exact consecutive-pair matches — so sibling pattern variants
    // (express/local, direction variants) at an interchange are kept.
    //
    // Uses `seed.core_stop_pks` — an exact, uncapped union of every stop
    // that's an ancestor of a kept meeting node in THIS BATCH — rather than
    // flattening `seed.paths`, which is thinned by MAX_SEED_PATHS.
    let t = Instant::now();
    let pattern_pks = if seed.core_stop_pks.is_empty() {
        HashSet::new()
    } else {
        let pks: Vec<i64> = seed.core_stop_pks.iter().copied().collect();
        get_pattern_pks_for_stops(conn, &pks)?
    };
    sub_timings.push(("pattern_pks_query".to_string(), t.elapsed().as_millis() as i64));

    Ok(SeedPathCorridorResult {
        pattern_pks, walk_radius_stop_pks: walk_radius, seed_path_count: seed.paths.len(),
        seed_paths: seed.paths, path_pattern_pks, path_depths: seed.path_depths, level_frontiers: seed.level_frontiers,
        corridor_boundaries: Vec::new(), core_stop_pks: seed.core_stop_pks.iter().copied().collect(), sub_timings,
    })
}

pub fn default_max_transfers() -> u32 { MAX_TRANSFERS }
