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
use crate::corridor::seed_bfs::{materialize_seed_paths, SearchDir, SeedBfsRun};
use crate::geo::cross_track_distance_m;
use crate::repo::{get_pattern_pks_for_stops, PatternCumulativeCache, PatternHeadwayCache, StopsCache};
use crate::settings::{
    CROSS_TRACK_KEEP_FRACTION, CROSS_TRACK_KEEP_MAX_PER_BUCKET, CROSS_TRACK_STOP_FILTER_ENABLED, MAX_TRANSFERS,
    ORIGIN_DEST_WALK_RADIUS_M,
};

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
    /// Whole-trip estimated real duration for the matching entry in
    /// `seed_paths` — see `SeedPathResult::path_scores` in seed_bfs.rs.
    /// Real (not debug-only) when `ENABLE_SEED_PATH_MARGIN` is on: that's
    /// what resolve_corridor/loader.rs use to build the margin-based
    /// alternative to freq_raptor's narrowing.
    pub path_scores: Vec<f64>,
    /// Per-hop pattern_pk for the matching entry in `seed_paths` — see
    /// `SeedPathResult::path_edges` in seed_bfs.rs. What the verifier
    /// uses to check real boardability, since `path_pattern_pks` alone
    /// doesn't say which hop rode which pattern.
    pub path_edges: Vec<Vec<Option<i64>>>,
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
    stops: &StopsCache,
    run: &SeedBfsRun,
    batch_size: usize,
    candidates: &[CorridorCandidate],
    origin: LatLon,
    destination: LatLon,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
    walking_speed_mps: f64,
) -> rusqlite::Result<SeedPathCorridorResult> {
    let mut sub_timings: Vec<(String, i64)> = Vec::new();

    // "before" is the raw supply BFS found at each transfer-depth
    // (pre-interleave, pre-batch_size, pre-margin — see
    // SeedBfsRun::bucket_sizes_before). "after" (logged below, once
    // materialize_seed_paths has actually run) is how many from each depth
    // survived BOTH this attempt's batch_size truncation AND the
    // SEED_MEET_SELECT_MARGIN_* real-time filter — see SeedPathResult::
    // after_counts' doc for why this has to come from materialize_seed_paths
    // itself rather than being recomputed here from a raw ordered_meets
    // slice. Comparing the two per depth is what shows whether a
    // shallow-but-scarce depth (e.g. a single train option) got crowded out
    // by a deep-but-plentiful one (e.g. dozens of bus siblings), rather than
    // only ever seeing the merged total.
    for (depth, &before) in run.bucket_sizes_before.iter().enumerate() {
        sub_timings.push((format!("seed_bucket{depth}_before"), before as i64));
    }

    let t = Instant::now();
    let seed = materialize_seed_paths(run, batch_size, cumulative, headway, stops, walking_speed_mps);
    let walk_radius = walk_radius_stop_pks(candidates, origin, destination);
    sub_timings.push(("materialize".to_string(), t.elapsed().as_millis() as i64));

    // Pre-truncation candidate volume — see path_count_before_margin's doc
    // for why this needs measuring rather than assuming from settings.
    sub_timings.push(("count.seed_paths_before_margin".to_string(), seed.path_count_before_margin as i64));
    sub_timings.push(("count.seed_paths_after_margin".to_string(), seed.paths.len() as i64));

    for (depth, &count) in seed.after_counts.iter().enumerate() {
        sub_timings.push((format!("seed_bucket{depth}_after"), count as i64));
    }

    if seed.paths.is_empty() {
        return Ok(SeedPathCorridorResult {
            pattern_pks: HashSet::new(), walk_radius_stop_pks: walk_radius, seed_path_count: 0,
            seed_paths: Vec::new(), path_pattern_pks: Vec::new(), path_scores: Vec::new(), path_edges: Vec::new(), path_depths: Vec::new(), level_frontiers: seed.level_frontiers,
            corridor_boundaries: Vec::new(), core_stop_pks: HashSet::new(), sub_timings,
        });
    }

    // Debug/visualization payload: which patterns each seed path actually
    // rode, so a debug view can fetch the REAL shape polyline + route color
    // (repo::get_shape_points / PatternMeta / routes.route_color — the same
    // lookup RAPTOR's own result rendering does) instead of computing an
    // approximate tapered-buffer polygon from stop coordinates.
    let path_pattern_pks = seed.path_pattern_pks.clone();

    // Per-depth-bucket cross-track prefilter: within EACH BFS depth bucket
    // (see core_stop_pks_by_depth's doc comment) sort that bucket's stops
    // by perpendicular distance to the straight origin-destination line,
    // keep the straightest min(CROSS_TRACK_KEEP_FRACTION,
    // CROSS_TRACK_KEEP_MAX_PER_BUCKET) from EACH bucket, then union the
    // kept stops back together. Guarantees every depth (transfer count)
    // keeps a floor of representation regardless of how straight the
    // other depths score — a flat sort across every stop can otherwise
    // let a straighter-but-fewer-transfers alternative starve out every
    // stop of a real, faster, more-transfers option. A stop we can't
    // locate sorts last within its own bucket (kept only if the fraction/
    // cap is generous enough to reach it) rather than silently dropped.
    let core_stop_pks_before = seed.core_stop_pks.len();
    let t = Instant::now();
    let filtered_core_stop_pks: HashSet<i64> = if CROSS_TRACK_STOP_FILTER_ENABLED && !seed.core_stop_pks.is_empty() {
        let cross_track_of = |pk: i64| -> f64 {
            match stops.get(pk) {
                None => f64::MAX,
                Some(row) => cross_track_distance_m(
                    LatLon { lat: row.stop_lat, lon: row.stop_lon },
                    origin,
                    destination,
                ),
            }
        };
        let mut kept: HashSet<i64> = HashSet::new();
        for bucket in &seed.core_stop_pks_by_depth {
            let mut ranked: Vec<(i64, f64)> = bucket.iter().map(|&pk| (pk, cross_track_of(pk))).collect();
            ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
            let keep_n = (((ranked.len() as f64) * CROSS_TRACK_KEEP_FRACTION).ceil() as usize)
                .min(CROSS_TRACK_KEEP_MAX_PER_BUCKET);
            kept.extend(ranked.into_iter().take(keep_n).map(|(pk, _)| pk));
        }
        kept
    } else {
        seed.core_stop_pks.iter().copied().collect()
    };
    sub_timings.push(("cross_track_filter".to_string(), t.elapsed().as_millis() as i64));
    sub_timings.push(("count.core_stop_pks_before".to_string(), core_stop_pks_before as i64));
    sub_timings.push(("count.core_stop_pks_after".to_string(), filtered_core_stop_pks.len() as i64));

    // Any pattern touching ANY stop the seed paths pass through — not just
    // exact consecutive-pair matches — so sibling pattern variants
    // (express/local, direction variants) at an interchange are kept.
    //
    // Uses `filtered_core_stop_pks` — the (optionally cross-track-trimmed)
    // union of every stop that's an ancestor of a kept meeting node in
    // THIS BATCH — rather than flattening `seed.paths`, which is thinned
    // by MAX_SEED_PATHS.
    let t = Instant::now();
    let pattern_pks = if filtered_core_stop_pks.is_empty() {
        HashSet::new()
    } else {
        let pks: Vec<i64> = filtered_core_stop_pks.iter().copied().collect();
        get_pattern_pks_for_stops(conn, &pks)?
    };
    sub_timings.push(("pattern_pks_query".to_string(), t.elapsed().as_millis() as i64));

    Ok(SeedPathCorridorResult {
        pattern_pks, walk_radius_stop_pks: walk_radius, seed_path_count: seed.paths.len(),
        seed_paths: seed.paths, path_pattern_pks, path_scores: seed.path_scores, path_edges: seed.path_edges, path_depths: seed.path_depths, level_frontiers: seed.level_frontiers,
        corridor_boundaries: Vec::new(), core_stop_pks: filtered_core_stop_pks, sub_timings,
    })
}

pub fn default_max_transfers() -> u32 { MAX_TRANSFERS }
