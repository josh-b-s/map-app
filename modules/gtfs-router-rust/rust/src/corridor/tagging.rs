//! corridor/tagging.rs — port of services/gtfs/corridor/corridorTagging.ts.
//!
//! Two paths, same as the TS version:
//!   - `compute_seed_path_corridor`: the NORMAL path — patterns kept are
//!     whichever ones actually touch a stop the seed paths pass through, no
//!     per-candidate-stop geometry pass at all.
//!   - `compute_corridor`: the FALLBACK bbox-tag-every-candidate-stop path,
//!     only used when the seed-path corridor comes back too thin. Kept for
//!     parity but this is the rarely-hit path.

use std::collections::HashSet;
use rusqlite::Connection;
use crate::geo::{haversine_meters, LatLon};
use crate::graph::coarse::CoarseGraph;
use crate::corridor::seed_bfs::find_seed_paths;
use crate::repo::{get_pattern_pks_for_stops, StopsCache};
use crate::settings::{
    CORRIDOR_MIN_WIDTH_M, CORRIDOR_TAPER_K_M, CORRIDOR_MIN_ACCEPTABLE_STOPS,
    CORRIDOR_WIDEN_MIN_WIDTH_M, CORRIDOR_WIDEN_TAPER_K_M, MAX_TRANSFERS,
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
#[derive(Debug, Clone)]
pub struct CorridorBoundary {
    pub left: Vec<LatLon>,
    pub right: Vec<LatLon>,
}

pub struct CorridorResult {
    pub stop_pks: HashSet<i64>,
    pub widened: bool,
    pub seed_path_count: usize,
    pub seed_paths: Vec<Vec<i64>>,
    pub level_frontiers: Vec<Vec<i64>>,
    pub bfs_tree_edges: Vec<(i64, i64)>,
    pub corridor_boundaries: Vec<CorridorBoundary>,
}

fn to_rad(d: f64) -> f64 { d * std::f64::consts::PI / 180.0 }

/// Perpendicular distance (meters) from `p` to segment a->b, plus how far
/// along the segment (0..1) the closest point falls.
fn distance_to_segment(p: LatLon, a: LatLon, b: LatLon) -> (f64, f64) {
    let lat_ref = to_rad(a.lat);
    let m_per_deg_lat = 111_320.0;
    let m_per_deg_lon = 111_320.0 * lat_ref.cos();

    let to_xy = |q: LatLon| ((q.lon - a.lon) * m_per_deg_lon, (q.lat - a.lat) * m_per_deg_lat);
    let (bx, by) = to_xy(b);
    let (px, py) = to_xy(p);

    let len_sq = bx * bx + by * by;
    let mut t = if len_sq == 0.0 { 0.0 } else { (px * bx + py * by) / len_sq };
    t = t.clamp(0.0, 1.0);
    let (cx, cy) = (t * bx, t * by);
    let (dx, dy) = (px - cx, py - cy);
    ((dx * dx + dy * dy).sqrt(), t)
}

fn bbox_filter_candidates(path: &[LatLon], candidates: &[CorridorCandidate], max_width_m: f64) -> Vec<CorridorCandidate> {
    let (mut min_lat, mut max_lat, mut min_lon, mut max_lon) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in path {
        min_lat = min_lat.min(p.lat); max_lat = max_lat.max(p.lat);
        min_lon = min_lon.min(p.lon); max_lon = max_lon.max(p.lon);
    }
    let lat_ref = to_rad((min_lat + max_lat) / 2.0);
    let margin_lat = max_width_m / 111_320.0;
    let margin_lon = max_width_m / (111_320.0 * lat_ref.cos().max(0.1));

    let (lo_lat, hi_lat) = (min_lat - margin_lat, max_lat + margin_lat);
    let (lo_lon, hi_lon) = (min_lon - margin_lon, max_lon + margin_lon);

    candidates.iter().copied().filter(|c| c.lat >= lo_lat && c.lat <= hi_lat && c.lon >= lo_lon && c.lon <= hi_lon).collect()
}

/// Tags stops as in-corridor for one seed path — walks segment by segment,
/// accumulating cumulative arc-length so the taper is continuous end-to-end.
fn tag_stops_for_path(path: &[LatLon], candidates: &[CorridorCandidate], min_width_m: f64, taper_k_m: f64) -> HashSet<i64> {
    if path.len() < 2 { return HashSet::new(); }

    let mut seg_lengths = Vec::with_capacity(path.len() - 1);
    let mut total_length = 0.0;
    for w in path.windows(2) {
        let d = haversine_meters(w[0], w[1]);
        seg_lengths.push(d);
        total_length += d;
    }
    if total_length == 0.0 { return HashSet::new(); }

    let mut tagged = HashSet::new();
    let mut cum_before = 0.0;
    for (i, w) in path.windows(2).enumerate() {
        let (a, b) = (w[0], w[1]);
        let seg_len = seg_lengths[i];
        for c in candidates {
            if tagged.contains(&c.stop_pk) { continue; }
            let (dist_m, local_t) = distance_to_segment(LatLon { lat: c.lat, lon: c.lon }, a, b);
            let global_t = if total_length > 0.0 { (cum_before + local_t * seg_len) / total_length } else { 0.0 };
            let width = min_width_m + taper_k_m * (std::f64::consts::PI * global_t).sin();
            if dist_m <= width { tagged.insert(c.stop_pk); }
        }
        cum_before += seg_len;
    }
    tagged
}

const BOUNDARY_SAMPLES_PER_PATH: usize = 20;

fn boundary_for_path(path: &[LatLon], min_width_m: f64, taper_k_m: f64) -> CorridorBoundary {
    let mut left = Vec::new();
    let mut right = Vec::new();
    if path.len() < 2 { return CorridorBoundary { left, right }; }

    let mut seg_lengths = Vec::with_capacity(path.len() - 1);
    let mut total_length = 0.0;
    for w in path.windows(2) {
        let d = haversine_meters(w[0], w[1]);
        seg_lengths.push(d);
        total_length += d;
    }
    if total_length == 0.0 { return CorridorBoundary { left, right }; }

    for s in 0..=BOUNDARY_SAMPLES_PER_PATH {
        let target_len = (s as f64 / BOUNDARY_SAMPLES_PER_PATH as f64) * total_length;

        let mut acc = 0.0;
        let mut seg_idx = 0usize;
        while seg_idx < seg_lengths.len() - 1 && acc + seg_lengths[seg_idx] < target_len {
            acc += seg_lengths[seg_idx];
            seg_idx += 1;
        }
        let seg_len = seg_lengths[seg_idx];
        let seg_frac = if seg_len > 0.0 { (target_len - acc) / seg_len } else { 0.0 };
        let a = path[seg_idx];
        let b = *path.get(seg_idx + 1).unwrap_or(&a);

        let lat = a.lat + (b.lat - a.lat) * seg_frac;
        let lon = a.lon + (b.lon - a.lon) * seg_frac;

        let global_t = if total_length > 0.0 { target_len / total_length } else { 0.0 };
        let width = min_width_m + taper_k_m * (std::f64::consts::PI * global_t).sin();

        let m_per_deg_lat = 111_320.0;
        let m_per_deg_lon = 111_320.0 * to_rad(lat).cos();
        let dx_m = (b.lon - a.lon) * m_per_deg_lon;
        let dy_m = (b.lat - a.lat) * m_per_deg_lat;
        let seg_len_m = (dx_m * dx_m + dy_m * dy_m).sqrt().max(1.0);
        let perp_x_m = -dy_m / seg_len_m;
        let perp_y_m = dx_m / seg_len_m;

        let d_lat = (perp_y_m * width) / m_per_deg_lat;
        let d_lon = (perp_x_m * width) / m_per_deg_lon;

        left.push(LatLon { lat: lat + d_lat, lon: lon + d_lon });
        right.push(LatLon { lat: lat - d_lat, lon: lon - d_lon });
    }

    CorridorBoundary { left, right }
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

fn path_to_polyline(stops: &StopsCache, path: &[i64], fallback: LatLon) -> Vec<LatLon> {
    path.iter().map(|&pk| {
        stops.get(pk).map(|s| LatLon { lat: s.stop_lat, lon: s.stop_lon }).unwrap_or(fallback)
    }).collect()
}

/// NORMAL path: skips bbox tagging entirely — asks directly "which patterns
/// actually run along the seed paths' stops" via the DB, same authoritative
/// check the TS version's runtime diagnostic used to do as a comparison.
pub struct SeedPathCorridorResult {
    pub pattern_pks: HashSet<i64>,
    pub walk_radius_stop_pks: HashSet<i64>,
    pub seed_path_count: usize,
    pub seed_paths: Vec<Vec<i64>>,
    pub level_frontiers: Vec<Vec<i64>>,
    pub bfs_tree_edges: Vec<(i64, i64)>,
    pub corridor_boundaries: Vec<CorridorBoundary>,
}

pub fn compute_seed_path_corridor(
    conn: &Connection,
    stops: &StopsCache,
    graph: &CoarseGraph,
    origin: LatLon,
    destination: LatLon,
    origin_stop_pks: &[i64],
    dest_stop_pks: &[i64],
    candidates: &[CorridorCandidate],
    max_transfers: u32,
) -> rusqlite::Result<SeedPathCorridorResult> {
    let seed = find_seed_paths(graph, origin_stop_pks, dest_stop_pks, max_transfers);
    let walk_radius = walk_radius_stop_pks(candidates, origin, destination);

    if seed.paths.is_empty() {
        return Ok(SeedPathCorridorResult {
            pattern_pks: HashSet::new(), walk_radius_stop_pks: walk_radius, seed_path_count: 0,
            seed_paths: Vec::new(), level_frontiers: seed.level_frontiers, bfs_tree_edges: seed.tree_edges,
            corridor_boundaries: Vec::new(),
        });
    }

    let corridor_boundaries: Vec<CorridorBoundary> = seed.paths.iter()
        .map(|p| boundary_for_path(&path_to_polyline(stops, p, origin), CORRIDOR_MIN_WIDTH_M, CORRIDOR_TAPER_K_M))
        .collect();

    // Any pattern touching ANY stop the seed paths pass through — not just
    // exact consecutive-pair matches — so sibling pattern variants
    // (express/local, direction variants) at an interchange are kept, same
    // reasoning as the TS version's own long comment on this.
    let mut core_stop_pks: HashSet<i64> = HashSet::new();
    for path in &seed.paths {
        core_stop_pks.extend(path.iter().copied());
    }
    let pattern_pks = if core_stop_pks.is_empty() {
        HashSet::new()
    } else {
        let pks: Vec<i64> = core_stop_pks.into_iter().collect();
        get_pattern_pks_for_stops(conn, &pks)?
    };

    Ok(SeedPathCorridorResult {
        pattern_pks, walk_radius_stop_pks: walk_radius, seed_path_count: seed.paths.len(),
        seed_paths: seed.paths, level_frontiers: seed.level_frontiers, bfs_tree_edges: seed.tree_edges,
        corridor_boundaries,
    })
}

fn run_once(
    stops: &StopsCache,
    graph: &CoarseGraph,
    origin: LatLon,
    destination: LatLon,
    origin_stop_pks: &[i64],
    dest_stop_pks: &[i64],
    candidates: &[CorridorCandidate],
    min_width_m: f64,
    taper_k_m: f64,
    max_transfers: u32,
) -> CorridorResult {
    let seed = find_seed_paths(graph, origin_stop_pks, dest_stop_pks, max_transfers);

    if seed.paths.is_empty() {
        return CorridorResult {
            stop_pks: HashSet::new(), widened: false, seed_path_count: 0, seed_paths: Vec::new(),
            level_frontiers: seed.level_frontiers, bfs_tree_edges: seed.tree_edges, corridor_boundaries: Vec::new(),
        };
    }

    let mut union: HashSet<i64> = HashSet::new();
    let mut corridor_boundaries = Vec::new();
    for stop_pk_path in &seed.paths {
        let polyline = path_to_polyline(stops, stop_pk_path, origin);
        let max_width_m = min_width_m + taper_k_m;
        let local_candidates = bbox_filter_candidates(&polyline, candidates, max_width_m);
        let tagged = tag_stops_for_path(&polyline, &local_candidates, min_width_m, taper_k_m);
        union.extend(tagged);
        corridor_boundaries.push(boundary_for_path(&polyline, min_width_m, taper_k_m));
    }

    // Always keep the immediate origin/destination neighborhoods, regardless
    // of taper — fixed walk-tolerance radius, not min_width_m.
    for c in candidates {
        let p = LatLon { lat: c.lat, lon: c.lon };
        if haversine_meters(origin, p) <= ORIGIN_DEST_WALK_RADIUS_M { union.insert(c.stop_pk); }
        if haversine_meters(destination, p) <= ORIGIN_DEST_WALK_RADIUS_M { union.insert(c.stop_pk); }
    }

    CorridorResult {
        stop_pks: union, widened: false, seed_path_count: seed.paths.len(), seed_paths: seed.paths,
        level_frontiers: seed.level_frontiers, bfs_tree_edges: seed.tree_edges, corridor_boundaries,
    }
}

/// FALLBACK path only — full bbox-tag-every-candidate-stop pass, retried
/// once with a wider buffer if the result looks too small.
pub fn compute_corridor(
    stops: &StopsCache,
    graph: &CoarseGraph,
    origin: LatLon,
    destination: LatLon,
    origin_stop_pks: &[i64],
    dest_stop_pks: &[i64],
    candidates: &[CorridorCandidate],
    max_transfers: u32,
) -> CorridorResult {
    let first = run_once(stops, graph, origin, destination, origin_stop_pks, dest_stop_pks, candidates, CORRIDOR_MIN_WIDTH_M, CORRIDOR_TAPER_K_M, max_transfers);
    if first.stop_pks.len() >= CORRIDOR_MIN_ACCEPTABLE_STOPS {
        return first;
    }
    let mut widened = run_once(stops, graph, origin, destination, origin_stop_pks, dest_stop_pks, candidates, CORRIDOR_WIDEN_MIN_WIDTH_M, CORRIDOR_WIDEN_TAPER_K_M, max_transfers);
    widened.widened = true;
    widened
}

pub fn default_max_transfers() -> u32 { MAX_TRANSFERS }
