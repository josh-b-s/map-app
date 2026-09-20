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
use crate::repo::{get_pattern_stops_for_patterns, get_patterns_by_stop, nearest_stop_pks_in_bbox, PatternCumulativeCache, PatternHeadwayCache, PatternStopRow, PatternsCache, StopRow, StopsCache, COORD_SCALE};
use crate::corridor::tagging::{compute_seed_path_corridor, CorridorBoundary, CorridorCandidate};
use crate::corridor::seed_bfs::{run_seed_bfs, SearchDir, SeedBfsRun};
use crate::settings::{
    bucket_walk_distance_m, MAX_RTREE_RADIUS_M, MAX_SEED_STOPS, MAX_TRANSFERS, MIN_SEED_STOPS,
    STOP_SEQUENCE_MARGIN, EDGE_CORRIDOR_POOL_PATTERNS,
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
    /// Pattern_pks ridden by the matching entry in `debug_seed_paths` —
    /// NOT debug-only despite the naming symmetry with `debug_seed_paths`:
    /// loader.rs reads this (unioned across every kept path) as the
    /// pattern candidate set when `ENABLE_SEED_PATH_MARGIN` is on, in
    /// place of freq_raptor's narrowing.
    pub seed_path_pattern_pks: Vec<Vec<i64>>,
    /// Patterns selected by the edge-based corridor (seed_bfs.rs
    /// `compute_edge_corridor`): every pattern on an edge that fits the level
    /// budget, ranked and capped. Loaded IN ADDITION to the kept seed paths'
    /// patterns (loader.rs unions them).
    pub edge_corridor_pattern_pks: Vec<i64>,
    /// Board/alight stops per pooled edge-corridor pattern (same keys as
    /// `edge_corridor_pattern_pks`), so the loader can rebuild the fetch
    /// stop set for whichever subset of the pool it ends up loading.
    pub edge_corridor_stops_by_pattern: HashMap<i64, Vec<i64>>,
    /// Board/alight stops of the SELECTED edge-corridor patterns' qualifying
    /// edges. The loader always fetches these even when it narrows the
    /// fetch stops to the loaded patterns' stops.
    pub edge_corridor_stop_pks: Vec<i64>,
    /// Whole-trip estimated score for the matching entry in
    /// `debug_seed_paths` — see `SeedPathResult::path_scores`.
    pub seed_path_scores: Vec<f64>,
    /// Per-hop pattern_pk for the matching entry in `debug_seed_paths` —
    /// see `SeedPathResult::path_edges`. Not debug-only: `verifier.rs`
    /// reads this to check each candidate against real stop_times.
    pub seed_path_edges: Vec<Vec<Option<i64>>>,
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

fn cache_key(origin: LatLon, destination: LatLon, max_transfers: u32, max_walk_distance_m: f64) -> String {
    format!(
        "{},{}|{},{}|{}|walk={}",
        round_coord(origin.lat), round_coord(origin.lon),
        round_coord(destination.lat), round_coord(destination.lon),
        max_transfers,
        bucket_walk_distance_m(max_walk_distance_m),
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

/// Selects BFS seed stops within `max_walk_distance_m` of `center`, skipping a stop
/// if every PATTERN (not just route) serving it is already covered by a
/// closer seed already picked, so the seed budget goes toward genuinely
/// different rides rather than being spent on several stops of the same
/// physical pattern. Pattern-level rather than route-level deliberately —
/// see `get_pattern_pks_for_stops`'s doc for why route-level dedup can
/// wrongly discard a farther stop that's the only seed for a genuinely
/// different pattern sharing that route number. Falls back to the nearest
/// MIN_SEED_STOPS (dedup still applied) if the radius alone doesn't reach
/// that floor.
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
    max_walk_distance_m: f64,
) -> rusqlite::Result<Vec<i64>> {
    let mut radius_m = max_walk_distance_m;
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

    let mut within_radius: Vec<(&StopRow, f64)> = ranked.iter().filter(|(_, d)| *d <= max_walk_distance_m).cloned().collect();
    if within_radius.len() < MIN_SEED_STOPS {
        within_radius = ranked.iter().take(MIN_SEED_STOPS).cloned().collect();
    }

    let raw_candidates: Vec<(&StopRow, f64)> = within_radius.into_iter().take(MAX_SEED_STOPS * 3).collect();
    let candidate_pks: Vec<i64> = raw_candidates.iter().map(|(s, _)| s.stop_pk).collect();

    let routes_by_stop = get_patterns_by_stop(conn, &candidate_pks)?;

    let mut covered_patterns: HashSet<i64> = HashSet::new();
    let mut selected: Vec<&StopRow> = Vec::new();
    for (s, _) in &raw_candidates {
        if selected.len() >= MAX_SEED_STOPS { break; }
        match routes_by_stop.get(&s.stop_pk) {
            None => { selected.push(s); continue; }
            Some(pats) if pats.is_empty() => { selected.push(s); continue; }
            Some(pats) => {
                let adds_new = pats.iter().any(|p| !covered_patterns.contains(p));
                if !adds_new { continue; }
                for &p in pats { covered_patterns.insert(p); }
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

/// Candidate stops within the caller's `max_walk_distance_m` of `center`, via a
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
    max_walk_distance_m: f64,
) -> rusqlite::Result<Vec<CorridorCandidate>> {
    let (min_lat, max_lat, min_lon, max_lon) = bbox_scaled(center, max_walk_distance_m, COORD_SCALE);
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
    // Formerly threaded through to nearest_for_seed for route-level seed
    // dedup — now unused here, since get_pattern_pks_for_stops (used by
    // nearest_for_seed) queries pattern_pk directly and no longer needs
    // PatternsCache's route_key lookup. Kept in the signature rather than
    // removed so this stays a purely additive change for loader.rs's
    // existing call site.
    _patterns: &PatternsCache,
    graph: &CoarseGraph,
    cache: &mut CorridorCache,
    bfs_cache: &mut SeedBfsCache,
    origin: LatLon,
    destination: LatLon,
    batch_size: usize,
    cumulative: &PatternCumulativeCache,
    headway: &PatternHeadwayCache,
    walking_speed_mps: f64,
    max_walk_distance_m: f64,
) -> rusqlite::Result<Arc<ResolvedCorridor>> {
    // Universal, caller-supplied max walk distance — see settings.rs
    // module header. Baked into the cache key (bucketed) so a materially
    // different walk tolerance gets its own correctly-filtered corridor
    // instead of silently reusing whichever value happened to populate the
    // cache first.
    let bfs_key = cache_key(origin, destination, MAX_TRANSFERS, max_walk_distance_m);
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
    for c in walk_radius_candidates(conn, stops, origin, max_walk_distance_m)?.into_iter().chain(walk_radius_candidates(conn, stops, destination, max_walk_distance_m)?) {
        candidates_by_pk.entry(c.stop_pk).or_insert(c);
    }
    let candidates: Vec<CorridorCandidate> = candidates_by_pk.into_values().collect();
    sub_timings.push(("candidates_build".to_string(), t.elapsed().as_millis() as i64));

    let t = Instant::now();
    // Sequential, not concurrent — mirrors the TS version's own note about
    // a single shared SQLite connection; here it's simply because rusqlite
    // Connection isn't Sync-shareable without its own locking anyway.
    let origin_seed_pks = nearest_for_seed(conn, stops, origin, max_walk_distance_m)?;
    let dest_seed_pks = nearest_for_seed(conn, stops, destination, max_walk_distance_m)?;
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
        let run = Arc::new(run_seed_bfs(graph, origin, destination, stops, &origin_seed_pks, &dest_seed_pks, MAX_TRANSFERS, cumulative, headway, max_walk_distance_m, walking_speed_mps));
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
    let seed_corridor = compute_seed_path_corridor(conn, stops, &run, batch_size, &candidates, origin, destination, cumulative, headway, walking_speed_mps, max_walk_distance_m)?;
    // Only sum entries that are actually milliseconds — every "count."-
    // prefixed entry in seed_corridor.sub_timings is a raw count (paths,
    // stops, whatever), not a duration, and summing those in here is what
    // made this go negative once enough count.* entries existed alongside
    // the real per-stage ms values.
    let seed_corridor_ms_sum: i64 = seed_corridor.sub_timings.iter()
        .filter(|(name, _)| !name.starts_with("count."))
        .map(|(_, ms)| ms)
        .sum();
    let seed_corridor_wrapper_ms = t.elapsed().as_millis() as i64 - seed_corridor_ms_sum;
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

    // Edge-based corridor: rank patterns by best slack, then by how many
    // qualifying edges use them, cap, and make sure their board/alight stops
    // are allowed (plus walk-edge endpoints).
    let mut edge_ranked: Vec<(i64, u32, u32)> = run.edge_corridor.patterns.iter()
        .map(|(&p, &(slack, count, _))| (p, slack, count))
        .collect();
    edge_ranked.sort_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    let edge_total = edge_ranked.len() as i64;
    edge_ranked.truncate(EDGE_CORRIDOR_POOL_PATTERNS);
    let edge_corridor_pattern_pks: Vec<i64> = edge_ranked.iter().map(|&(p, _, _)| p).collect();
    let mut edge_corridor_stop_set: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut edge_corridor_stops_by_pattern: HashMap<i64, Vec<i64>> = HashMap::new();
    for &(p, _, _) in &edge_ranked {
        if let Some((_, _, stops_of)) = run.edge_corridor.patterns.get(&p) {
            allowed_stop_pks.extend(stops_of.iter().copied());
            edge_corridor_stop_set.extend(stops_of.iter().copied());
            edge_corridor_stops_by_pattern.insert(p, stops_of.iter().copied().collect());
        }
    }
    let edge_corridor_stop_pks: Vec<i64> = edge_corridor_stop_set.into_iter().collect();
    allowed_stop_pks.extend(run.edge_corridor.walk_stop_pks.iter().copied());
    sub_timings.push(("edge_corridor_compute".to_string(), run.edge_corridor.elapsed_ms));
    sub_timings.push(("count.edge_corridor_edges_checked".to_string(), run.edge_corridor.edges_checked as i64));
    sub_timings.push(("count.edge_corridor_edges_kept".to_string(), run.edge_corridor.edges_kept as i64));
    sub_timings.push(("count.edge_corridor_patterns_total".to_string(), edge_total));
    sub_timings.push(("count.edge_corridor_patterns_pooled".to_string(), edge_corridor_pattern_pks.len() as i64));

    let result = ResolvedCorridor {
        pattern_pks: seed_corridor.pattern_pks,
        allowed_stop_pks,
        pattern_stop_rows,
        seed_path_count: seed_corridor.seed_path_count,
        total_seed_meets_found: run.ordered_meets.len(),
        debug_seed_paths: seed_corridor.seed_paths,
        seed_path_pattern_pks: seed_corridor.path_pattern_pks,
        edge_corridor_pattern_pks,
        edge_corridor_stops_by_pattern,
        edge_corridor_stop_pks,
        seed_path_scores: seed_corridor.path_scores,
        seed_path_edges: seed_corridor.path_edges,
        debug_seed_path_depths: seed_corridor.path_depths,
        debug_bfs_levels: seed_corridor.level_frontiers,
        debug_corridor_boundary: seed_corridor.corridor_boundaries,
        sub_timings,
    };

    let arc = Arc::new(result);
    cache.insert(key, arc.clone());
    Ok(arc)
}
