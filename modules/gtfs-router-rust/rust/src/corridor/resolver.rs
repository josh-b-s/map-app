//! corridor/resolver.rs — port of services/gtfs/corridor/corridorResolver.ts.
//!
//! Resolves "which patterns and stops make up this trip's corridor,"
//! independent of date/time — cached by (origin, destination, maxTransfers)
//! so a repeat search that only changes departure time skips straight to a
//! cache hit, same as the TS version.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use rusqlite::Connection;
use crate::geo::{bbox_scaled, haversine_meters, LatLon};
use crate::graph::coarse::CoarseGraph;
use crate::repo::{get_pattern_stops_for_patterns, get_route_ids_for_stops, nearest_stop_pks_in_bbox, PatternStopRow, PatternsCache, StopRow, StopsCache, COORD_SCALE};
use crate::corridor::tagging::{compute_seed_path_corridor, CorridorBoundary, CorridorCandidate};
use crate::corridor::seed_bfs::{run_seed_bfs, SearchDir, SeedBfsRun};
use crate::settings::{
    MAX_RTREE_RADIUS_M, MAX_SEED_STOPS, MAX_TRANSFERS, MIN_SEED_STOPS, ORIGIN_DEST_WALK_RADIUS_M,
    SEED_RADIUS_M, STOP_SEQUENCE_MARGIN,
};

pub struct ResolvedCorridor {
    pub pattern_pks: HashSet<i64>,
    pub allowed_stop_pks: HashSet<i64>,
    /// Raw pattern_stops rows for pattern_pks, already fetched during the
    /// coverage check. loader.rs reuses this instead of re-querying
    /// pattern_stops for overlapping patterns.
    pub pattern_stop_rows: Vec<PatternStopRow>,
    pub seed_path_count: usize,
    /// Total meeting nodes BFS found within SAFETY_MARGIN_LEVELS, ranked,
    /// BEFORE this attempt's batch_size slice — i.e. how many candidates
    /// existed to choose from, independent of how many this particular
    /// attempt actually used. Same for every batch_size tried against the
    /// same BFS run (the run itself doesn't change, only how much of its
    /// ranked list gets materialized) — logged so a NoRoute can be told
    /// apart from "BFS genuinely found nothing" vs "BFS found plenty but
    /// this attempt's batch_size didn't reach the one with real service."
    pub total_seed_meets_found: usize,
    pub debug_seed_paths: Vec<Vec<i64>>,
    /// Depth (relative to shortest meet) of the matching entry in
    /// `debug_seed_paths` — lets a debug/visualization consumer color
    /// candidate seed paths by depth instead of every candidate looking
    /// identical regardless of transfer count.
    pub debug_seed_path_depths: Vec<u32>,
    /// Each entry tagged with which side of the bidirectional search
    /// produced it (see corridor/seed_bfs.rs), in expansion order.
    pub debug_bfs_levels: Vec<(SearchDir, Vec<i64>)>,
    pub debug_corridor_boundary: Vec<CorridorBoundary>,
    /// (label, elapsed_ms) breakdown of resolve_corridor's own work —
    /// EMPTY on a cache hit (there's no work to break down), so loader.rs
    /// merging this into its own timings naturally shows ~0ms total for
    /// cached corridors and a real breakdown on cache misses.
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

/// Caches the raw BFS output (see seed_bfs.rs's SeedBfsRun) separately from
/// the final ResolvedCorridor. Keyed WITHOUT batch_size, unlike
/// CorridorCache — different batch sizes against the same origin/
/// destination/max_transfers are the same BFS run, just materialized
/// differently, so they should share one cache entry here even though they
/// produce different ResolvedCorridor cache entries above.
pub struct SeedBfsCache {
    order: std::collections::VecDeque<String>,
    entries: HashMap<String, Arc<SeedBfsRun>>,
}

impl SeedBfsCache {
    pub fn new() -> Self {
        Self { order: std::collections::VecDeque::new(), entries: HashMap::new() }
    }

    pub fn get(&self, key: &str) -> Option<Arc<SeedBfsRun>> {
        self.entries.get(key).cloned()
    }

    pub fn insert(&mut self, key: String, value: Arc<SeedBfsRun>) {
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
///
/// Candidate stops come from a stops_rtree bbox query (see repo.rs /
/// geo::bbox_scaled), progressively widened, instead of sorting every stop
/// in the network by haversine distance — that used to mean two full
/// O(n log n) sorts over the entire stops table per corridor resolution
/// (once for origin, once for destination). Falls back to a genuine full
/// scan only if MAX_RTREE_RADIUS_M's widening still doesn't turn up
/// MIN_SEED_STOPS candidates (in practice: a search sitting well outside
/// the network's actual service area) — same guarantee the old
/// brute-force version always gave, just paid only in that rare case.
fn nearest_for_seed(
    conn: &Connection,
    stops: &StopsCache,
    center: LatLon,
    patterns: &PatternsCache,
) -> rusqlite::Result<Vec<i64>> {
    let mut radius_m = SEED_RADIUS_M;
    let mut candidate_pks: Vec<i64> = Vec::new();
    loop {
        let (min_lat, max_lat, min_lon, max_lon) = bbox_scaled(center, radius_m, COORD_SCALE);
        candidate_pks = nearest_stop_pks_in_bbox(conn, min_lat, max_lat, min_lon, max_lon)?;
        if candidate_pks.len() >= MIN_SEED_STOPS || radius_m >= MAX_RTREE_RADIUS_M {
            break;
        }
        radius_m *= 4.0;
    }

    let mut ranked: Vec<(&StopRow, f64)> = if candidate_pks.len() >= MIN_SEED_STOPS {
        candidate_pks.iter()
            .filter_map(|&pk| stops.get(pk))
            .map(|s| (s, haversine_meters(center, LatLon { lat: s.stop_lat, lon: s.stop_lon })))
            .collect()
    } else {
        stops.iter()
            .map(|s| (s, haversine_meters(center, LatLon { lat: s.stop_lat, lon: s.stop_lon })))
            .collect()
    };
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

/// Candidate stops within `ORIGIN_DEST_WALK_RADIUS_M` of `center`, via a
/// single stops_rtree bbox query rather than scanning every stop in the
/// network. Unlike `nearest_for_seed`, there's no progressive widening or
/// MIN-count floor here: a bbox with genuinely zero stops within walking
/// distance of an endpoint is a legitimate answer (not a "try wider"
/// signal), and the bbox is already refined against the real radius by the
/// caller (`walk_radius_stop_pks`'s haversine check) since the box is a
/// rectangle, not a circle.
fn walk_radius_candidates(
    conn: &Connection,
    stops: &StopsCache,
    center: LatLon,
) -> rusqlite::Result<Vec<CorridorCandidate>> {
    let (min_lat, max_lat, min_lon, max_lon) = bbox_scaled(center, ORIGIN_DEST_WALK_RADIUS_M, COORD_SCALE);
    let pks = nearest_stop_pks_in_bbox(conn, min_lat, max_lat, min_lon, max_lon)?;
    Ok(pks.iter()
        .filter_map(|&pk| stops.get(pk))
        .map(|s| CorridorCandidate { stop_pk: s.stop_pk, lat: s.stop_lat, lon: s.stop_lon })
        .collect())
}

/// Resolves the corridor for an origin -> destination trip. Cached — see
/// module doc. Callers (loader.rs) should treat the returned sets as
/// read-only.
/// Trims each matched pattern's stop list down to the ordinal window
/// around where it was actually touched by the corridor, instead of a
/// geometric distance buffer. `pattern_stop_rows` is already grouped by
/// pattern_pk and ordered by stop_sequence (see repo::
/// get_pattern_stops_for_patterns). For each pattern, finds the min/max
/// stop_sequence index among stops that are IN `core_stop_pks` (the seed
/// BFS's own exact traversed-stop set), then keeps every stop of that
/// pattern within `[min_idx - margin, max_idx + margin]`. A pattern with no
/// stop in `core_stop_pks` at all (shouldn't normally happen — pattern_pks
/// itself is derived from core_stop_pks membership) keeps all its stops
/// rather than silently vanishing, same "don't drop on a lookup miss"
/// reasoning as rank_meets' stops.get() fallback.
fn trim_pattern_stops_by_sequence(
    pattern_stop_rows: &[PatternStopRow],
    core_stop_pks: &HashSet<i64>,
    margin: usize,
) -> HashSet<i64> {
    let mut by_pattern: HashMap<i64, Vec<&PatternStopRow>> = HashMap::new();
    for row in pattern_stop_rows {
        by_pattern.entry(row.pattern_pk).or_default().push(row);
    }

    let mut keep: HashSet<i64> = HashSet::new();
    for rows in by_pattern.values() {
        // rows are already ordered by stop_sequence per
        // get_pattern_stops_for_patterns, but sort defensively rather than
        // assume the DB query's ORDER BY survives every future refactor.
        let mut rows = rows.clone();
        rows.sort_by_key(|r| r.stop_sequence);

        let touched: Vec<usize> = rows.iter().enumerate()
            .filter(|(_, r)| core_stop_pks.contains(&r.stop_pk))
            .map(|(i, _)| i)
            .collect();

        if touched.is_empty() {
            keep.extend(rows.iter().map(|r| r.stop_pk));
            continue;
        }

        let min_idx = touched.iter().min().copied().unwrap_or(0).saturating_sub(margin);
        let max_idx = (touched.iter().max().copied().unwrap_or(0) + margin).min(rows.len() - 1);
        keep.extend(rows[min_idx..=max_idx].iter().map(|r| r.stop_pk));
    }
    keep
}

pub fn resolve_corridor(
    conn: &Connection,
    stops: &StopsCache,
    patterns: &PatternsCache,
    graph: &CoarseGraph,
    cache: &mut CorridorCache,
    bfs_cache: &mut SeedBfsCache,
    origin: LatLon,
    destination: LatLon,
    batch_size: usize,
) -> rusqlite::Result<Arc<ResolvedCorridor>> {
    let bfs_key = cache_key(origin, destination, MAX_TRANSFERS);
    let key = format!("{bfs_key}|batch={batch_size}");
    if let Some(cached) = cache.get(&key) {
        return Ok(cached);
    }

    let mut sub_timings: Vec<(String, i64)> = Vec::new();
    let t = Instant::now();
    // Bbox-scoped to each endpoint instead of collecting every stop in the
    // network — same rtree-bbox approach `nearest_for_seed` already uses,
    // just for the walk-radius-tagging purpose instead of BFS seeding. A
    // stop can appear in both the origin and destination box (e.g. a short
    // trip), so dedupe by stop_pk.
    let mut candidates_by_pk: HashMap<i64, CorridorCandidate> = HashMap::new();
    for c in walk_radius_candidates(conn, stops, origin)?.into_iter().chain(walk_radius_candidates(conn, stops, destination)?) {
        candidates_by_pk.entry(c.stop_pk).or_insert(c);
    }
    let candidates: Vec<CorridorCandidate> = candidates_by_pk.into_values().collect();
    sub_timings.push(("candidates_build".to_string(), t.elapsed().as_millis() as i64));

    let t = Instant::now();
    // Sequential, not concurrent — mirrors the TS version's own note about
    // a single shared SQLite connection; here it's simply because rusqlite
    // Connection isn't Sync-shareable without its own locking anyway.
    let origin_seed_pks = nearest_for_seed(conn, stops, origin, patterns)?;
    let dest_seed_pks = nearest_for_seed(conn, stops, destination, patterns)?;
    sub_timings.push(("nearest_for_seed_x2".to_string(), t.elapsed().as_millis() as i64));

    // BFS itself — cached WITHOUT batch_size (see SeedBfsCache doc), so a
    // retry that only bumps batch_size after an empty result reuses this
    // instead of walking the graph again. This is the expensive part of
    // the whole pipeline; everything below it is cheap enough to redo per
    // attempt.
    let t = Instant::now();
    let run: Arc<SeedBfsRun> = if let Some(hit) = bfs_cache.get(&bfs_key) {
        hit
    } else {
        let run = Arc::new(run_seed_bfs(graph, origin, destination, stops, &origin_seed_pks, &dest_seed_pks, MAX_TRANSFERS));
        bfs_cache.insert(bfs_key.clone(), run.clone());
        run
    };
    sub_timings.push(("bfs".to_string(), t.elapsed().as_millis() as i64));
    // How many candidates BFS actually found, independent of batch_size —
    // logged so a thin/empty result downstream can be told apart from
    // "BFS found nothing at all" vs "BFS found plenty, this batch just
    // didn't include the one with real service."
    sub_timings.push(("count.seed_bfs_meets_total".to_string(), run.ordered_meets.len() as i64));

    let t = Instant::now();
    let seed_corridor = compute_seed_path_corridor(conn, stops, &run, batch_size, &candidates, origin, destination)?;
    let seed_corridor_wrapper_ms = t.elapsed().as_millis() as i64 - seed_corridor.sub_timings.iter().map(|(_, ms)| ms).sum::<i64>();
    sub_timings.extend(seed_corridor.sub_timings.clone());
    sub_timings.push(("seed_path_materialize_wrapper".to_string(), seed_corridor_wrapper_ms));

    let t = Instant::now();
    let mut pattern_stop_rows: Vec<PatternStopRow> = Vec::new();
    if !seed_corridor.pattern_pks.is_empty() {
        let pks: Vec<i64> = seed_corridor.pattern_pks.iter().copied().collect();
        pattern_stop_rows = get_pattern_stops_for_patterns(conn, &pks)?;
    }
    sub_timings.push(("pattern_stop_rows_fetch".to_string(), t.elapsed().as_millis() as i64));

    // Trims each matched pattern's stop list down to its OWN ridden
    // portion (by ordinal stop_sequence position, +/- a small margin)
    // instead of keeping every stop of its full route unconditionally.
    // Seed-path stops and the origin/destination walk radius are extended
    // in below regardless of this trim, so this can only narrow the
    // "extra" stops a matched pattern drags in from elsewhere on its
    // route — it can never drop a stop the seed BFS itself walked
    // through. See settings::STOP_SEQUENCE_MARGIN.
    let pattern_stops_to_keep: HashSet<i64> = trim_pattern_stops_by_sequence(
        &pattern_stop_rows, &seed_corridor.core_stop_pks, STOP_SEQUENCE_MARGIN,
    );

    let mut allowed_stop_pks: HashSet<i64> = pattern_stops_to_keep;
    allowed_stop_pks.extend(seed_corridor.walk_radius_stop_pks.iter().copied());
    for path in &seed_corridor.seed_paths {
        allowed_stop_pks.extend(path.iter().copied());
    }

    let result = ResolvedCorridor {
        pattern_pks: seed_corridor.pattern_pks,
        allowed_stop_pks,
        pattern_stop_rows,
        seed_path_count: seed_corridor.seed_path_count,
        total_seed_meets_found: run.ordered_meets.len(),
        debug_seed_paths: seed_corridor.seed_paths,
        debug_seed_path_depths: seed_corridor.path_depths,
        debug_bfs_levels: seed_corridor.level_frontiers,
        debug_corridor_boundary: seed_corridor.corridor_boundaries,
        sub_timings,
    };

    let arc = Arc::new(result);
    cache.insert(key, arc.clone());
    Ok(arc)
}
