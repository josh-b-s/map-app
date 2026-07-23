//! corridor/resolver.rs — port of services/gtfs/corridor/corridorResolver.ts.
//!
//! Resolves "which patterns and stops make up this trip's corridor,"
//! independent of date/time — cached by (origin, destination, maxTransfers)
//! so a repeat search that only changes departure time skips straight to a
//! cache hit, same as the TS version.

use std::collections::{HashMap, HashSet};
use std::time::Instant;
use rusqlite::Connection;
use crate::geo::{haversine_meters, LatLon};
use crate::graph::coarse::CoarseGraph;
use crate::repo::{get_pattern_stops_for_patterns, get_route_ids_for_stops, PatternStopRow, PatternsCache, StopRow, StopsCache};
use crate::corridor::tagging::{compute_corridor, compute_seed_path_corridor, CorridorBoundary, CorridorCandidate};
use crate::settings::{MAX_SEED_STOPS, MAX_TRANSFERS, MIN_ACCEPTABLE_PATTERNS, MIN_SEED_STOPS, SEED_RADIUS_M};

pub struct ResolvedCorridor {
    pub pattern_pks: HashSet<i64>,
    pub allowed_stop_pks: HashSet<i64>,
    /// Raw pattern_stops rows for pattern_pks, already fetched during the
    /// coverage check — empty on the bbox-fallback path. loader.rs reuses
    /// this instead of re-querying pattern_stops for overlapping patterns.
    pub pattern_stop_rows: Vec<PatternStopRow>,
    pub widened: bool,
    pub seed_path_count: usize,
    pub debug_seed_paths: Vec<Vec<i64>>,
    pub debug_bfs_levels: Vec<Vec<i64>>,
    pub debug_bfs_tree_edges: Vec<(i64, i64)>,
    pub debug_corridor_boundary: Vec<CorridorBoundary>,
    /// (label, elapsed_ms) sub-stage breakdown of resolve_corridor's own
    /// work — EMPTY on a cache hit (there's no work to break down), so
    /// loader.rs merging this into its own timings naturally shows ~0ms
    /// total for cached corridors and a real breakdown on cache misses.
    pub sub_timings: Vec<(String, i64)>,
}

fn round_coord(n: f64) -> f64 { (n * 10_000.0).round() / 10_000.0 } // ~11m

fn cache_key(origin: LatLon, destination: LatLon, max_transfers: u32) -> String {
    format!(
        "{},{}|{},{}|{}",
        round_coord(origin.lat), round_coord(origin.lon),
        round_coord(destination.lat), round_coord(destination.lon),
        max_transfers,
    )
}

const MAX_CACHE_ENTRIES: usize = 30;

/// Small insertion-order-evicting cache — a speed cache, not a
/// correctness-critical store, same as the TS version's plain Map.
pub struct CorridorCache {
    order: std::collections::VecDeque<String>,
    entries: HashMap<String, std::sync::Arc<ResolvedCorridor>>,
}

impl CorridorCache {
    pub fn new() -> Self {
        Self { order: std::collections::VecDeque::new(), entries: HashMap::new() }
    }

    pub fn get(&self, key: &str) -> Option<std::sync::Arc<ResolvedCorridor>> {
        self.entries.get(key).cloned()
    }

    pub fn insert(&mut self, key: String, value: std::sync::Arc<ResolvedCorridor>) {
        if self.entries.len() >= MAX_CACHE_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

/// Selects BFS seed stops within SEED_RADIUS_M of `center`, skipping a stop
/// if every route serving it is already covered by a closer seed already
/// picked, so the seed budget goes toward genuinely different lines. Falls
/// back to the nearest MIN_SEED_STOPS (dedup still applied) if the radius
/// alone doesn't reach that floor.
fn nearest_for_seed(
    conn: &Connection,
    all_stops: &[StopRow],
    center: LatLon,
    patterns: &PatternsCache,
) -> rusqlite::Result<Vec<i64>> {
    let mut ranked: Vec<(&StopRow, f64)> = all_stops.iter()
        .map(|s| (s, haversine_meters(center, LatLon { lat: s.stop_lat, lon: s.stop_lon })))
        .collect();
    ranked.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

    let mut within_radius: Vec<(&StopRow, f64)> = ranked.iter().filter(|(_, d)| *d <= SEED_RADIUS_M).cloned().collect();
    if within_radius.len() < MIN_SEED_STOPS {
        within_radius = ranked.iter().take(MIN_SEED_STOPS).cloned().collect();
    }

    let raw_candidates: Vec<(&StopRow, f64)> = within_radius.into_iter().take(MAX_SEED_STOPS * 3).collect();
    let candidate_pks: Vec<i64> = raw_candidates.iter().map(|(s, _)| s.stop_pk).collect();

    let routes_by_stop = get_route_ids_for_stops(conn, &candidate_pks, patterns)?;

    let mut covered_routes: HashSet<u32> = HashSet::new();
    let mut selected: Vec<&StopRow> = Vec::new();
    for (s, _) in &raw_candidates {
        if selected.len() >= MAX_SEED_STOPS { break; }
        match routes_by_stop.get(&s.stop_pk) {
            None => { selected.push(s); continue; }
            Some(routes) if routes.is_empty() => { selected.push(s); continue; }
            Some(routes) => {
                let adds_new = routes.iter().any(|r| !covered_routes.contains(r));
                if !adds_new { continue; }
                for &r in routes { covered_routes.insert(r); }
                selected.push(s);
            }
        }
    }

    if selected.len() < MIN_SEED_STOPS {
        let selected_pks: HashSet<i64> = selected.iter().map(|s| s.stop_pk).collect();
        for (s, _) in &raw_candidates {
            if selected.len() >= MIN_SEED_STOPS { break; }
            if !selected_pks.contains(&s.stop_pk) { selected.push(s); }
        }
    }

    Ok(selected.into_iter().map(|s| s.stop_pk).collect())
}

/// Resolves the corridor for an origin -> destination trip. Cached — see
/// module doc. Callers (loader.rs) should treat the returned sets as
/// read-only.
pub fn resolve_corridor(
    conn: &Connection,
    stops: &StopsCache,
    patterns: &PatternsCache,
    graph: &CoarseGraph,
    cache: &mut CorridorCache,
    origin: LatLon,
    destination: LatLon,
) -> rusqlite::Result<std::sync::Arc<ResolvedCorridor>> {
    let key = cache_key(origin, destination, MAX_TRANSFERS);
    if let Some(cached) = cache.get(&key) {
        return Ok(cached);
    }

    let mut sub_timings: Vec<(String, i64)> = Vec::new();
    let t = Instant::now();
    let all_stops: Vec<StopRow> = stops.iter().cloned().collect();
    let candidates: Vec<CorridorCandidate> = all_stops.iter()
        .map(|s| CorridorCandidate { stop_pk: s.stop_pk, lat: s.stop_lat, lon: s.stop_lon })
        .collect();

    // Sequential, not concurrent — mirrors the TS version's own note about
    // a single shared SQLite connection; here it's simply because rusqlite
    // Connection isn't Sync-shareable without its own locking anyway.
    sub_timings.push(("all_stops_clone".to_string(), t.elapsed().as_millis() as i64));

    let t = Instant::now();
    let origin_seed_pks = nearest_for_seed(conn, &all_stops, origin, patterns)?;
    let dest_seed_pks = nearest_for_seed(conn, &all_stops, destination, patterns)?;
    sub_timings.push(("nearest_for_seed_x2".to_string(), t.elapsed().as_millis() as i64));

    let t = Instant::now();
    let seed_corridor = compute_seed_path_corridor(
        conn, stops, graph, origin, destination, &origin_seed_pks, &dest_seed_pks, &candidates, MAX_TRANSFERS,
    )?;
    sub_timings.push(("seed_path_bfs_and_tagging".to_string(), t.elapsed().as_millis() as i64));

    let t = Instant::now();
    let mut pattern_stop_rows: Vec<PatternStopRow> = Vec::new();
    if !seed_corridor.pattern_pks.is_empty() {
        let pks: Vec<i64> = seed_corridor.pattern_pks.iter().copied().collect();
        pattern_stop_rows = get_pattern_stops_for_patterns(conn, &pks)?;
    }
    sub_timings.push(("pattern_stop_rows_fetch".to_string(), t.elapsed().as_millis() as i64));
    let pattern_derived_stop_pks: HashSet<i64> = pattern_stop_rows.iter().map(|r| r.stop_pk).collect();

    let origin_covered = origin_seed_pks.iter().any(|k| pattern_derived_stop_pks.contains(k));
    let dest_covered = dest_seed_pks.iter().any(|k| pattern_derived_stop_pks.contains(k));

    let result = if seed_corridor.pattern_pks.len() >= MIN_ACCEPTABLE_PATTERNS && origin_covered && dest_covered {
        let mut allowed_stop_pks: HashSet<i64> = pattern_derived_stop_pks.clone();
        allowed_stop_pks.extend(seed_corridor.walk_radius_stop_pks.iter().copied());
        for path in &seed_corridor.seed_paths {
            allowed_stop_pks.extend(path.iter().copied());
        }

        ResolvedCorridor {
            pattern_pks: seed_corridor.pattern_pks,
            allowed_stop_pks,
            pattern_stop_rows,
            widened: false,
            seed_path_count: seed_corridor.seed_path_count,
            debug_seed_paths: seed_corridor.seed_paths,
            debug_bfs_levels: seed_corridor.level_frontiers,
            debug_bfs_tree_edges: seed_corridor.bfs_tree_edges,
            debug_corridor_boundary: seed_corridor.corridor_boundaries,
            sub_timings: sub_timings.clone(),
        }
    } else {
        // Too thin — fall back to the bbox-tag-then-query approach.
        let corridor = compute_corridor(stops, graph, origin, destination, &origin_seed_pks, &dest_seed_pks, &candidates, MAX_TRANSFERS);

        let allowed_stop_pks = if !corridor.stop_pks.is_empty() {
            corridor.stop_pks
        } else {
            all_stops.iter().map(|s| s.stop_pk).collect()
        };

        let pattern_pks = if allowed_stop_pks.is_empty() {
            HashSet::new()
        } else {
            let pks: Vec<i64> = allowed_stop_pks.iter().copied().collect();
            crate::repo::get_pattern_pks_for_stops(conn, &pks)?
        };

        ResolvedCorridor {
            pattern_pks,
            allowed_stop_pks,
            pattern_stop_rows: Vec::new(),
            widened: corridor.widened,
            seed_path_count: corridor.seed_path_count,
            debug_seed_paths: corridor.seed_paths,
            debug_bfs_levels: corridor.level_frontiers,
            debug_bfs_tree_edges: corridor.bfs_tree_edges,
            debug_corridor_boundary: corridor.corridor_boundaries,
            sub_timings,
        }
    };

    let arc = std::sync::Arc::new(result);
    cache.insert(key, arc.clone());
    Ok(arc)
}
