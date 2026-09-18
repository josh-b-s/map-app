//! lib.rs — UniFFI boundary for the full Rust GTFS routing port.
//!
//! Lifecycle mirrors the JS version's module-scope caches
//! (gtfsWarmup.ts / getCoarseGraph() / gtfsRepo.ts's stopsCache): construct
//! one `GtfsRouterEngine`, call `warm_up(db_path)` once (e.g. at app
//! launch, fire-and-forget), then call `compute_route(...)` per search —
//! stops/routes/patterns/coarse-graph are all loaded once and reused.
//!
//! SCOPE CUTS from this first port (flagged here, not hidden):
//!   - No cancellation token yet — a search runs to completion or error.
//!   - No general progress/logging callback — only `DebugSink` for the
//!     round-by-round marked-stop / seed-path / corridor-boundary events,
//!     since that's what a debug polyline overlay actually needs.
//!   - Transit segment polylines are stop-to-stop (pattern_stops order),
//!     not the smoother GTFS `shapes` polyline — see raptor.rs's header.

mod geo;
mod settings;
mod repo;
mod graph;
mod corridor;
mod loader;
mod raptor;
mod freq_raptor;
mod fxhash;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use rusqlite::Connection;
use crate::geo::haversine_meters;

uniffi::setup_scaffolding!();

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct LatLng {
    pub latitude: f64,
    pub longitude: f64,
}

impl From<LatLng> for geo::LatLon {
    fn from(v: LatLng) -> Self { geo::LatLon { lat: v.latitude, lon: v.longitude } }
}
impl From<geo::LatLon> for LatLng {
    fn from(v: geo::LatLon) -> Self { LatLng { latitude: v.lat, longitude: v.lon } }
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct RouteSegment {
    pub coords: Vec<LatLng>,
    pub route_name: String,
    pub route_type: i32,
    pub route_color: Option<String>,
    pub route_text_color: Option<String>,
    pub origin_stop_name: String,
    pub dest_stop_name: String,
    pub is_walk: bool,
    pub departure_time_sec: Option<i32>,
    pub arrival_time_sec: Option<i32>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct Leg {
    pub route_name: String,
    pub route_type: i32,
    pub route_color: Option<String>,
    pub route_text_color: Option<String>,
    pub origin_stop_name: String,
    pub dest_stop_name: String,
    pub departure_time_sec: Option<i32>,
    pub arrival_time_sec: Option<i32>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct Journey {
    pub coords: Vec<LatLng>,
    pub segments: Vec<RouteSegment>,
    pub legs: Vec<Leg>,
    pub route_name: String,
    pub route_type: i32,
    pub route_color: Option<String>,
    pub route_text_color: Option<String>,
    pub origin_stop_name: String,
    pub dest_stop_name: String,
    pub transfer_stop_name: Option<String>,
    pub total_duration_min: i32,
    pub total_walking_meters: i32,
    pub transfer_count: i32,
    pub departure_time_sec: i32,
    pub arrival_time_sec: i32,
}

/// Diagnostic-only per-stage timing, surfaced so the JS side can profile
/// against gtfsLoader.ts's own console.log breakdown without guessing —
/// see loader.rs's `mark!` macro for where these come from.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TimingEntry {
    pub label: String,
    pub ms: i64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct RouteResult {
    pub journeys: Vec<Journey>,
    pub timings: Vec<TimingEntry>,
}

/// Which end of the bidirectional seed BFS a `SeedBfsLevel` event came
/// from — see corridor/seed_bfs.rs's module doc. `level` in that event is
/// that side's OWN level counter, not a combined/global step number, since
/// the two sides now advance independently (whichever has the smaller
/// current frontier expands next).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SeedBfsDir {
    Forward,
    Backward,
}

impl From<corridor::seed_bfs::SearchDir> for SeedBfsDir {
    fn from(d: corridor::seed_bfs::SearchDir) -> Self {
        match d {
            corridor::seed_bfs::SearchDir::Forward => SeedBfsDir::Forward,
            corridor::seed_bfs::SearchDir::Backward => SeedBfsDir::Backward,
        }
    }
}

/// "Currently evaluating" events for a debug polyline overlay — fired
/// live during a search, not batched into the final result, so the caller
/// can throttle rendering (e.g. to 60fps) at the receiving end.
/// One hop (one transit boarding, or one walk leg) within a candidate seed
/// path — see SeedPath below. `hop_index` is 0-based position within the
/// path (board -> alight #1 is hop 0, the next transit/walk leg is hop 1,
/// etc.), meant purely for the debug view's per-hop color palette — it has
/// no relation to RAPTOR round numbers. `route_color` is the pattern's real
/// GTFS color when this hop is a transit leg with one; `None` for a walk
/// hop or an uncolored pattern (the frontend falls back to a synthetic
/// hop-index palette in that case).
#[derive(Debug, Clone, uniffi::Record)]
pub struct SeedPathHop {
    pub hop_index: u32,
    pub coords: Vec<LatLng>,
    pub is_walk: bool,
    pub route_color: Option<String>,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum DebugEvent {
    SeedBfsLevel { dir: SeedBfsDir, level: u32, stops: Vec<LatLng> },
    // CHANGED: was `SeedPath { path: Vec<LatLng> }` — one flattened
    // polyline per candidate with no hop boundary. Now emits each hop as
    // its own segment (`hops`) so the frontend can color hop 1 vs hop 2
    // differently instead of only being able to draw one flat color per
    // candidate. `path_index` identifies which of the (up to
    // MAX_SEED_PATHS) candidates these hops belong to, since hops from
    // different candidates now arrive as separate events instead of one
    // pre-joined polyline each. `depth` (relative to the shortest meet
    // BFS found, 0..=SAFETY_MARGIN_LEVELS) is NEW — lets the frontend
    // color/toggle candidates by depth (transfer-count tier) instead of
    // every candidate defaulting to the same appearance.
    SeedPath { path_index: u32, depth: u32, hops: Vec<SeedPathHop> },
    CorridorBoundary { left: Vec<LatLng>, right: Vec<LatLng> },
    RaptorRound { round: u32, marked_stops: Vec<LatLng> },
    // One per pattern examined within a round — the stops actually ridden
    // on that pattern this round (board stop through furthest relaxed
    // stop), meant to be shown one-at-a-time rather than accumulated. See
    // raptor::run_search's on_route_check doc comment. `coords` includes
    // the journey-so-far back through earlier rounds' boarding chain (not
    // just this round's own segment). `route_color`/`route_name` are the
    // pattern's real GTFS route color (hex, "#RRGGBB") and short/long name
    // when the feed has them.
    RaptorRouteCheck { round: u32, coords: Vec<LatLng>, route_color: Option<String>, route_name: Option<String> },
}

#[uniffi::export(with_foreign)]
pub trait DebugSink: Send + Sync {
    fn on_event(&self, event: DebugEvent);
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum RouterError {
    #[error("Database error: {0}")]
    Db(String),
    #[error("Not warmed up — call warm_up() first")]
    NotWarmedUp,
    #[error("No route found: {0}")]
    NoRoute(String),
    #[error("No service found in the search window near this time")]
    NoServiceFound,
}

impl From<rusqlite::Error> for RouterError {
    fn from(e: rusqlite::Error) -> Self { RouterError::Db(e.to_string()) }
}

struct WarmState {
    stops: Arc<repo::StopsCache>,
    routes: Arc<repo::RoutesCache>,
    patterns: Arc<repo::PatternsCache>,
    shapes_index: Arc<repo::ShapesIndex>,
    graph: Arc<graph::coarse::CoarseGraph>,
    /// Resident frequency-graph precompute — see repo.rs's doc on both.
    /// Loaded fully once here, same tier as patterns/routes, consumed by
    /// loader.rs's freq_raptor pre-filter stage.
    hops: Arc<repo::PatternHopsCache>,
    headway: Arc<repo::PatternHeadwayCache>,
    /// Network-wide, resident — see repo.rs's doc on PatternCumulativeCache
    /// for why this can't just be corridor-scoped the way freq_raptor's
    /// old per-search version was: rank_meets needs it BEFORE any corridor
    /// has been materialized.
    pattern_cumulative: Arc<repo::PatternCumulativeCache>,
}

#[derive(uniffi::Object)]
pub struct GtfsRouterEngine {
    conn: Mutex<Option<Connection>>,
    state: RwLock<Option<WarmState>>,
    corridor_cache: Mutex<corridor::resolver::CorridorCache>,
    /// Raw BFS output cache, separate from corridor_cache — see
    /// corridor::resolver::SeedBfsCache's doc. Lets a same-search retry
    /// with a bigger batch_size (see load_gtfs_index_for_trip's retry
    /// ladder) reuse the BFS run instead of re-walking the graph.
    bfs_cache: Mutex<corridor::resolver::SeedBfsCache>,
    /// See loader.rs's step-2 doc: active_services depends only on
    /// (today_date, tomorrow_date), so it's cached here across searches
    /// instead of recomputed from calendar/calendar_dates every call.
    active_services_cache: Mutex<Option<loader::ActiveServicesCacheEntry>>,
    /// Stage timings from the most recent `warm_up` call — see that
    /// method's own doc for why this exists (added after a fresh index
    /// build turned "native engine warmed" into 54s with zero visibility
    /// into where the time went). Read via `warm_up_timings()` right after
    /// `warm_up` returns; `Mutex` rather than needing `&mut self` since
    /// `warm_up` itself only takes `&self`.
    last_warmup_timings: Mutex<Vec<(String, i64)>>,
}

#[uniffi::export]
impl GtfsRouterEngine {
    #[uniffi::constructor]
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            state: RwLock::new(None),
            corridor_cache: Mutex::new(corridor::resolver::CorridorCache::new()),
            bfs_cache: Mutex::new(corridor::resolver::SeedBfsCache::new()),
            active_services_cache: Mutex::new(None),
            last_warmup_timings: Mutex::new(Vec::new()),
        }
    }

    /// Stage timings for the most recently completed `warm_up` call —
    /// call this right after `warm_up` returns and log it the same way
    /// `compute_route`'s `RouteResult.timings` already gets logged.
    /// Empty if `warm_up` hasn't completed yet.
    pub fn warm_up_timings(&self) -> Vec<TimingEntry> {
        self.last_warmup_timings.lock().unwrap().iter()
            .map(|(label, ms)| TimingEntry { label: label.clone(), ms: *ms })
            .collect()
    }

    /// Opens `db_path` and loads/builds everything reusable across
    /// searches: stops, routes, patterns, shape index, and the coarse
    /// topology graph (loaded from `rust_coarse_graph_*` if a matching
    /// persisted copy exists, built fresh and persisted otherwise — same
    /// ~12-14s from-scratch cost the TS version documents, paid once).
    /// Safe to call again after a feed update; it re-opens and rebuilds.
    ///
    /// PERF NOTE: `stop_times`'s indexing/clustering is now entirely a
    /// schema-level property of the DB the importer produces (WITHOUT
    /// ROWID, keyed by `(stop_pk, departure_sec, trip_pk, stop_sequence)`
    /// — see gtfs-importer's schema.sql) rather than something warm_up
    /// patches in at runtime, so there's no first-run index-build cost
    /// here to worry about any more. If a `warm_up` call against a given
    /// DB file is surprisingly slow, check `warm_up_timings()`'s
    /// `load_stops`/`graph_build_from_scratch` entries — those are the
    /// remaining legitimate one-time-per-DB costs.
    pub fn warm_up(&self, db_path: String) -> Result<(), RouterError> {
        let t_total = Instant::now();
        let mut timings: Vec<(String, i64)> = Vec::new();
        macro_rules! mark {
            ($t:expr, $label:expr) => {
                timings.push(($label.to_string(), $t.elapsed().as_millis() as i64));
            };
        }

        let t = Instant::now();
        let mut conn = Connection::open(&db_path)?;
        mark!(t, "open_connection");

        // PERF NOTE: `cache_size = -8000` is only an 8MB page cache — trivial
        // against an ~11.86M-row `stop_times` table, so every
        // windowed_trip_discovery/stop_times_fetch query was mostly paying
        // for disk I/O SQLite would otherwise have cached. Bumped to 128MB
        // (still small next to typical phone RAM) and added `mmap_size` so
        // the OS page cache can serve pages SQLite's own cache evicted,
        // instead of round-tripping through read() syscalls. `temp_store =
        // MEMORY` keeps the TEMP TABLEs `stage_ids` creates (corridor_stop_
        // pks / active_trip_pks_staged / windowed_trip_pks) off disk too —
        // by default SQLite may spill temp tables to a file, which would
        // otherwise silently tax every search's staging step.
        let t = Instant::now();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; \
             PRAGMA cache_size = -131072; \
             PRAGMA mmap_size = 268435456; \
             PRAGMA temp_store = MEMORY;"
        )?;
        mark!(t, "pragmas");

        // REMOVED (was here): runtime `CREATE INDEX IF NOT EXISTS` for
        // stop_times(stop_pk, departure_sec), stop_times(trip_pk), and
        // trips(pattern_pk).
        //
        // Superseded by a schema-level fix in the importer crate instead of
        // a router-side workaround: `stop_times` is now WITHOUT ROWID
        // clustered by `(stop_pk, departure_sec, trip_pk, stop_sequence)` —
        // see gtfs-importer's schema.sql for why — so stop_times' own
        // physical row order already IS what
        // idx_stop_times_stop_departure used to just duplicate, and
        // idx_trips_pattern already exists via the importer's indexes.sql.
        // idx_stop_times_trip was flat-out unnecessary — nothing anywhere
        // queries stop_times by trip_pk alone — and building it from
        // scratch over ~11.86M rows was the actual cause of the 54s
        // warm_up spike a profiling run surfaced earlier; removing it here
        // both avoids redoing work the importer already guarantees AND
        // removes a genuinely wasted index build.
        //
        // If this engine ever needs to run against a DB built by an OLDER
        // importer version (pre this schema change), route it through a
        // migration/re-import step instead of re-adding defensive
        // CREATE INDEX calls here — patching the symptom back in at the
        // router level is exactly the workaround this fix replaced.

        // ANALYZE-equivalent maintenance pass so the query planner has
        // up-to-date statistics for the DB's actual index set (now defined
        // entirely by the importer's schema.sql/indexes.sql, not by
        // anything created here). Timed separately since it can itself
        // scan a meaningful chunk of a multi-million-row table.
        let t = Instant::now();
        conn.execute_batch("PRAGMA optimize;")?;
        mark!(t, "pragma_optimize");

        let t = Instant::now();
        let stops = repo::load_stops(&conn)?;
        mark!(t, "load_stops");
        let t = Instant::now();
        let routes = repo::load_routes(&conn)?;
        mark!(t, "load_routes");
        let t = Instant::now();
        let patterns = repo::load_patterns(&conn, &routes)?;
        mark!(t, "load_patterns");
        let t = Instant::now();
        let shapes_index = repo::load_shape_index(&conn)?;
        mark!(t, "load_shape_index");
        let t = Instant::now();
        let hops = repo::load_pattern_hops(&conn)?;
        mark!(t, "load_pattern_hops");
        let t = Instant::now();
        let headway = repo::load_pattern_headway(&conn)?;
        mark!(t, "load_pattern_headway");

        let t = Instant::now();
        let signature = graph::store::compute_graph_signature(&conn)?;
        mark!(t, "graph_signature");

        // Fetched unconditionally now (previously only inside the
        // persisted-graph-miss branch below) — PatternCumulativeCache needs
        // these same rows regardless of whether the coarse graph itself
        // needed rebuilding, and re-querying separately would just be the
        // same small `pattern_stops` table scan twice for no reason.
        let t = Instant::now();
        let pattern_stop_rows = repo::get_all_pattern_stops_ordered(&conn)?;
        mark!(t, "load_pattern_stops");

        let t = Instant::now();
        let adjacency = match graph::store::load_persisted_graph(&conn, &signature)? {
            Some(adj) => { mark!(t, "graph_load_persisted"); adj }
            None => {
                let adj = graph::coarse::build_adjacency_from_scratch(&stops, &pattern_stop_rows);
                graph::store::save_persisted_graph(&mut conn, &signature, &adj)?;
                mark!(t, "graph_build_from_scratch");
                adj
            }
        };

        let t = Instant::now();
        let pattern_cumulative = repo::load_pattern_cumulative(&pattern_stop_rows, &hops, &stops);
        mark!(t, "build_pattern_cumulative");

        *self.state.write().unwrap() = Some(WarmState {
            stops: Arc::new(stops),
            routes: Arc::new(routes),
            patterns: Arc::new(patterns),
            shapes_index: Arc::new(shapes_index),
            graph: Arc::new(graph::coarse::CoarseGraph::new(adjacency)),
            hops: Arc::new(hops),
            headway: Arc::new(headway),
            pattern_cumulative: Arc::new(pattern_cumulative),
        });
        *self.conn.lock().unwrap() = Some(conn);
        *self.corridor_cache.lock().unwrap() = corridor::resolver::CorridorCache::new();
        *self.bfs_cache.lock().unwrap() = corridor::resolver::SeedBfsCache::new();
        *self.active_services_cache.lock().unwrap() = None;

        mark!(t_total, "total");
        *self.last_warmup_timings.lock().unwrap() = timings;

        Ok(())
    }

    /// Drops all in-memory caches (stops/routes/patterns/graph/corridor) and
    /// the open connection. Call after a GTFS feed re-import, then call
    /// `warm_up` again — the persisted coarse graph will also be rebuilt,
    /// since its signature (stop/pattern_stop row counts) will have changed.
    pub fn invalidate(&self) {
        *self.state.write().unwrap() = None;
        *self.conn.lock().unwrap() = None;
        *self.corridor_cache.lock().unwrap() = corridor::resolver::CorridorCache::new();
        *self.bfs_cache.lock().unwrap() = corridor::resolver::SeedBfsCache::new();
        *self.active_services_cache.lock().unwrap() = None;
    }

    #[allow(clippy::too_many_arguments)]
    pub fn compute_route(
        &self,
        origin: LatLng,
        destination: LatLng,
        depart_sec_of_day: i32,
        today_date: String,
        today_dow: u8,
        tomorrow_date: String,
        tomorrow_dow: u8,
        walking_speed_mps: f64,
        debug: Option<Arc<dyn DebugSink>>,
    ) -> Result<RouteResult, RouterError> {
        let conn_guard = self.conn.lock().unwrap();
        let Some(conn) = conn_guard.as_ref() else { return Err(RouterError::NotWarmedUp) };
        let state_guard = self.state.read().unwrap();
        let Some(state) = state_guard.as_ref() else { return Err(RouterError::NotWarmedUp) };

        let origin_ll: geo::LatLon = origin.into();
        let dest_ll: geo::LatLon = destination.into();

        let mut corridor_cache = self.corridor_cache.lock().unwrap();
        let mut bfs_cache = self.bfs_cache.lock().unwrap();

        let mut index = loader::load_gtfs_index_for_trip(
            conn, &state.stops, &state.patterns, &state.routes, &state.graph, &state.hops, &state.headway, &state.pattern_cumulative,
            &mut corridor_cache, &mut bfs_cache,
            &self.active_services_cache,
            origin_ll, dest_ll, depart_sec_of_day as i64,
            &today_date, today_dow, &tomorrow_date, tomorrow_dow, walking_speed_mps, None,
        )?;

        if index.no_service_found {
            return Err(RouterError::NoServiceFound);
        }

        let mut debug_emit_ms: i64 = 0;

        let opts = raptor::RaptorOptions { walking_speed_mps, ..Default::default() };
        let stops_for_cb = state.stops.clone();
        let debug_for_cb = debug.clone();
        let mut on_round = move |round: u32, marked: &[i64]| {
            if let Some(sink) = &debug_for_cb {
                let pts: Vec<LatLng> = marked.iter().filter_map(|&pk| stops_for_cb.get(pk).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon })).collect();
                sink.on_event(DebugEvent::RaptorRound { round, marked_stops: pts });
            }
        };

        // Separate clones from on_round's — both closures need their own
        // captured copies since they're both alive (and both re-borrowed
        // across the retry below) for the same run_search call.
        let stops_for_route_cb = state.stops.clone();
        let graph_for_route_cb = state.graph.clone();
        let patterns_for_route_cb = state.patterns.clone();
        let shapes_index_for_route_cb = state.shapes_index.clone();
        let debug_for_route_cb = debug.clone();
        // Populated on demand as new patterns show up in ridden chains —
        // shared across every call this search makes, so the same pattern
        // (very likely, since RAPTOR keeps re-riding the same handful of
        // corridor-restricted lines round after round) only costs one DB
        // fetch total instead of one per route-check. `conn` is borrowed
        // for the lifetime of this call (not stored past it), same as
        // every other closure here.
        let mut shape_cache_for_route_cb: HashMap<(i64, String), Vec<(f64, f64)>> = HashMap::new();
        let mut on_route_check = move |round: u32, ridden: &[i64], route_color: Option<&str>, route_name: Option<&str>| {
            if let Some(sink) = &debug_for_route_cb {
                // CHANGED: this used to be a straight stop-to-stop
                // polyline (one LatLng per ridden stop_pk, no shape
                // resolution at all — see shapes_index's old
                // #[allow(dead_code)] "reserved for follow-up shape-
                // polyline work" note, which this is). Now mirrors
                // emit_pre_search_debug's seed-path handling: walk each
                // consecutive pair in the ridden chain, resolve the real
                // GTFS shape for a transit edge via shaped_edge_coords
                // (fetching+caching the shape on first use), and fall back
                // to a straight segment only for walk edges or a pattern
                // with no shape — instead of every hop being a straight
                // line regardless of pattern.
                let mut pts: Vec<LatLng> = Vec::new();
                for w in ridden.windows(2) {
                    let (from, to) = (w[0], w[1]);
                    let (Some(from_ll), Some(to_ll)) = (
                        stops_for_route_cb.get(from).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon }),
                        stops_for_route_cb.get(to).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon }),
                    ) else { continue };

                    let edge = graph_for_route_cb.adjacency.get(&from).and_then(|edges| edges.iter().find(|e| e.to == to));
                    let seg: Vec<LatLng> = match edge {
                        Some(e) if e.kind == graph::coarse::EdgeKind::Transit => {
                            match e.via_pattern.and_then(|pk| patterns_for_route_cb.get(pk).map(|m| (pk, m))) {
                                Some((pattern_pk, meta)) => {
                                    if let Some(shape_id) = &meta.shape_id {
                                        let key = (meta.agency, shape_id.clone());
                                        if !shape_cache_for_route_cb.contains_key(&key) {
                                            if let Ok(fetched) = repo::get_shape_points(conn, &shapes_index_for_route_cb, std::slice::from_ref(&key)) {
                                                if let Some(points) = fetched.get(&key) {
                                                    shape_cache_for_route_cb.insert(key.clone(), points.clone());
                                                }
                                            }
                                        }
                                    }
                                    shaped_edge_coords(from_ll, to_ll, pattern_pk, &patterns_for_route_cb, &shape_cache_for_route_cb)
                                }
                                None => vec![from_ll, to_ll],
                            }
                        }
                        _ => vec![from_ll, to_ll], // walk edge, or edge not found — straight line
                    };

                    if !seg.is_empty() {
                        if let Some(last) = pts.last() {
                            if last.latitude == seg[0].latitude && last.longitude == seg[0].longitude {
                                pts.extend(seg.into_iter().skip(1));
                                continue;
                            }
                        }
                        pts.extend(seg);
                    }
                }
                if pts.len() >= 2 {
                    sink.on_event(DebugEvent::RaptorRouteCheck { round, coords: pts, route_color: route_color.map(String::from), route_name: route_name.map(String::from) });
                }
            }
        };

        let t_raptor = Instant::now();
        let mut pending_failed_attempt_timings: Vec<TimingEntry> = Vec::new();
        let result = raptor::run_search(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, &opts, Some(&mut on_round), Some(&mut on_route_check));
        let mut raptor_ms = t_raptor.elapsed().as_millis() as i64;

        let journeys = match result {
            Ok(j) => j,
            Err(_) => {
                // Capture the FAILED first attempt's own diagnostics before
                // `index` gets overwritten below — otherwise there's no way
                // to tell "narrowing excluded the trip that would've served
                // the narrow window" from "genuinely no service in that
                // window" after the fact, since only the eventually-
                // successful index's stats normally reach the log.
                let first_attempt_timings: Vec<TimingEntry> = index.timings.iter()
                    .map(|(label, ms)| TimingEntry { label: format!("failed_attempt.{label}"), ms: *ms })
                    .collect();

                // Same retry-with-a-forced-wide-window fallback as
                // computeGtfsRoute in the TS version: a window wide enough
                // to find SOME trips but not a later leg's boarding trip.
                index = loader::load_gtfs_index_for_trip(
                    conn, &state.stops, &state.patterns, &state.routes, &state.graph, &state.hops, &state.headway, &state.pattern_cumulative,
                    &mut corridor_cache, &mut bfs_cache,
                    &self.active_services_cache,
                    origin_ll, dest_ll, depart_sec_of_day as i64,
                    &today_date, today_dow, &tomorrow_date, tomorrow_dow, walking_speed_mps, Some(10 * 3600),
                )?;
                if index.no_service_found { return Err(RouterError::NoServiceFound); }
                let t_retry = Instant::now();
                let retried = raptor::run_search(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, &opts, Some(&mut on_round), Some(&mut on_route_check))
                    .map_err(RouterError::NoRoute)?;
                // Retry's own load + search time gets appended as separate
                // timing entries below rather than overwriting the first
                // attempt's — a retry happening at all is itself useful
                // diagnostic info, not something to hide by summing it in.
                raptor_ms += t_retry.elapsed().as_millis() as i64;
                pending_failed_attempt_timings = first_attempt_timings;
                retried
            }
        };

        // Emitted exactly ONCE, here, using whichever `index` actually ended
        // up producing `journeys` — NOT before the first raptor attempt.
        // Emitting pre-emptively (as this used to) meant a retry re-emitted
        // a full second copy of the seed-BFS/seed-path debug data (the
        // corridor doesn't depend on the departure-time window the retry
        // widens, so it's usually the SAME candidates re-sent under fresh
        // path_index numbers) — a debug consumer that doesn't explicitly
        // reset between emissions would show both attempts' candidates
        // overlaid as if they were one search.
        let t_debug_emit = Instant::now();
        emit_pre_search_debug(&debug, conn, &state.stops, &state.patterns, &state.routes, &state.shapes_index, &state.graph, &index);
        debug_emit_ms += t_debug_emit.elapsed().as_millis() as i64;

        // ── Real shapes for the FINAL journeys, not just the debug seed-path
        // view ── previously every journey's transit segments were straight
        // stop-to-stop lines (see reconstruct_path's own header comment,
        // "NOT the smoother GTFS shapes... a follow-up, not done here") —
        // this was that follow-up. Runs for every search (not gated behind
        // debug mode), since it's what the user actually sees on the map,
        // but it's the same "cheap because it's only the handful of
        // patterns THIS journey set rides, not the whole feed" shape as the
        // debug version — see resolve_journey_shapes below.
        let t_shape_resolve = Instant::now();
        let mut journeys = journeys;
        resolve_journey_shapes(&mut journeys, conn, &state.patterns, &state.shapes_index);
        let shape_resolve_ms = t_shape_resolve.elapsed().as_millis() as i64;

        let mut timings: Vec<TimingEntry> = index.timings.iter()
            .map(|(label, ms)| TimingEntry { label: label.clone(), ms: *ms })
            .collect();
        timings.push(TimingEntry { label: "raptor_search".to_string(), ms: raptor_ms });
        timings.push(TimingEntry { label: "debug_emit".to_string(), ms: debug_emit_ms });
        timings.push(TimingEntry { label: "journey_shape_resolve".to_string(), ms: shape_resolve_ms });
        // count.forced_wide_window_retry=1 means the narrow, distance-based
        // first attempt found NO route at all (raptor::run_search's own
        // Err — empty candidate set, not just an empty window) and this
        // response is entirely the forced-10hr-window retry's work.
        // failed_attempt.* entries (only present when this is 1) are that
        // FAILED first attempt's own stage timings/counts, preserved so a
        // narrowing-caused failure can be told apart from a
        // genuinely-narrow-window-had-no-service one after the fact —
        // normally only the eventually-successful attempt's stats survive
        // to this log line.
        timings.push(TimingEntry { label: "count.forced_wide_window_retry".to_string(), ms: !pending_failed_attempt_timings.is_empty() as i64 });
        timings.append(&mut pending_failed_attempt_timings);

        // ── Candidate-generation completeness check ───────────────────────
        // Uses McRAPTOR's own real result as ground truth: does the
        // seed-path margin's kept pattern set actually contain every
        // pattern the REAL best journey rode? Runs regardless of whether
        // ENABLE_SEED_PATH_MARGIN is the active narrowing strategy this
        // run — so this accumulates a completeness signal on every real
        // query, not just ones deliberately run in that mode. A `false`
        // here means: if this mode HAD been driving routing, it would
        // have missed the true best journey outright (wrong pattern
        // excluded), not just returned a slower one.
        {
            let best_score = index.seed_path_scores.iter().copied().filter(|&s| s < f64::MAX).fold(f64::MAX, f64::min);
            if best_score < f64::MAX {
                let margin = settings::margin_threshold(best_score, settings::SEED_PATH_MARGIN_FLOOR_SEC, settings::SEED_PATH_MARGIN_RELATIVE_PCT);
                let threshold = best_score + margin;
                let mut kept_patterns: std::collections::HashSet<i64> = std::collections::HashSet::new();
                for (i, pats) in index.seed_path_pattern_pks.iter().enumerate() {
                    let s = index.seed_path_scores.get(i).copied().unwrap_or(f64::MAX);
                    if s <= threshold || s >= f64::MAX { kept_patterns.extend(pats.iter().copied()); }
                }
                for j in &journeys {
                    let missing = j.used_pattern_pks.iter().filter(|pk| !kept_patterns.contains(pk)).count();
                    timings.push(TimingEntry { label: "count.seed_path_completeness_missing_patterns".to_string(), ms: missing as i64 });
                }
            }
        }

        Ok(RouteResult { journeys: journeys.into_iter().map(journey_to_ffi).collect(), timings })
    }
}

/// Nearest point in `shape` (by index) to `target` — used to project a stop
/// onto its pattern's GTFS shape polyline so a seed-path edge can be
/// trimmed to the real ridden portion instead of drawn as a straight line.
/// Linear scan: shapes are at most a few hundred points and this only runs
/// for the small candidate seed-path set and the raptor debug route-check
/// callback, not every pattern in the feed.
fn nearest_shape_index(shape: &[(f64, f64)], target: geo::LatLon) -> Option<usize> {
    shape.iter()
        .enumerate()
        .map(|(i, &(lat, lon))| (i, haversine_meters(target, geo::LatLon { lat, lon })))
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .map(|(i, _)| i)
}

/// Builds the real ridden polyline for one seed-path edge (`from` -> `to`,
/// a transit hop on `pattern_pk`), trimmed from the pattern's full GTFS
/// shape via nearest-point projection at each end. Falls back to a straight
/// two-point line if the pattern has no shape, the shape lookup missed, or
/// projection degenerates (same point at both ends) — same fallback
/// raptor.rs's own segment-building already uses when pattern_stops is
/// empty, so a debug view is never worse off than before, just often better.
fn shaped_edge_coords(
    from_ll: LatLng,
    to_ll: LatLng,
    pattern_pk: i64,
    patterns: &repo::PatternsCache,
    shape_points: &HashMap<(i64, String), Vec<(f64, f64)>>,
) -> Vec<LatLng> {
    let straight = vec![from_ll, to_ll];
    let Some(meta) = patterns.get(pattern_pk) else { return straight };
    let Some(shape_id) = &meta.shape_id else { return straight };
    let Some(shape) = shape_points.get(&(meta.agency, shape_id.clone())) else { return straight };
    if shape.len() < 2 { return straight; }

    let from_ll_geo = geo::LatLon { lat: from_ll.latitude, lon: from_ll.longitude };
    let to_ll_geo = geo::LatLon { lat: to_ll.latitude, lon: to_ll.longitude };
    let (Some(i0), Some(i1)) = (nearest_shape_index(shape, from_ll_geo), nearest_shape_index(shape, to_ll_geo)) else { return straight };
    if i0 == i1 { return straight; }

    let (lo, hi) = (i0.min(i1), i0.max(i1));
    let mut slice: Vec<LatLng> = shape[lo..=hi].iter().map(|&(lat, lon)| LatLng { latitude: lat, longitude: lon }).collect();
    if i0 > i1 { slice.reverse(); } // keep from->to direction regardless of the shape's own point order
    slice
}

/// Replaces each transit segment's straight stop-to-stop `coords` with the
/// pattern's real GTFS shape (trimmed to board->alight via
/// `shaped_edge_coords`, same nearest-point-projection approach the debug
/// seed-path view already uses) where the feed has one. Walk segments
/// (`pattern_pk: None`) are left untouched — there's no GTFS shape for a
/// footpath. Runs for every returned journey, not just under debug mode —
/// see this function's call site in compute_route for why that's fine
/// (only resolves shapes for the handful of patterns THIS result set
/// rides, same "cheap for a few, not the whole feed" reasoning as the
/// debug version, not "shape every pattern" work).
///
/// Also rebuilds each journey's whole-route `coords` (the single flattened
/// polyline used for map-fitting/fallback rendering) by concatenating the
/// now-shaped segments, so it stays consistent with the per-segment
/// polylines instead of reverting to the old straight-line version.
fn resolve_journey_shapes(
    journeys: &mut [raptor::Journey],
    conn: &Connection,
    patterns: &repo::PatternsCache,
    shapes_index: &repo::ShapesIndex,
) {
    let mut needed: Vec<(i64, String)> = Vec::new();
    for j in journeys.iter() {
        for seg in &j.segments {
            let Some(pk) = seg.pattern_pk else { continue };
            let Some(meta) = patterns.get(pk) else { continue };
            let Some(shape_id) = &meta.shape_id else { continue };
            needed.push((meta.agency, shape_id.clone()));
        }
    }
    needed.sort();
    needed.dedup();
    if needed.is_empty() { return; }
    let shape_points = repo::get_shape_points(conn, shapes_index, &needed).unwrap_or_default();
    if shape_points.is_empty() { return; }

    for j in journeys.iter_mut() {
        for seg in j.segments.iter_mut() {
            let Some(pk) = seg.pattern_pk else { continue };
            if seg.coords.len() < 2 { continue };
            let from_ll: LatLng = (*seg.coords.first().unwrap()).into();
            let to_ll: LatLng = (*seg.coords.last().unwrap()).into();
            let shaped = shaped_edge_coords(from_ll, to_ll, pk, patterns, &shape_points);
            if shaped.len() >= 2 {
                seg.coords = shaped.into_iter().map(geo::LatLon::from).collect();
            }
        }

        // Rebuild the whole-journey polyline from the (now possibly
        // shaped) segments, dropping the duplicate point at each join.
        let mut coords: Vec<geo::LatLon> = Vec::new();
        for seg in &j.segments {
            match (coords.last(), seg.coords.first()) {
                (Some(a), Some(b)) if (a.lat - b.lat).abs() < 1e-9 && (a.lon - b.lon).abs() < 1e-9 => {
                    coords.extend(seg.coords.iter().skip(1).cloned());
                }
                _ => coords.extend(seg.coords.iter().cloned()),
            }
        }
        if !coords.is_empty() { j.coords = coords; }
    }
}

fn emit_pre_search_debug(
    debug: &Option<Arc<dyn DebugSink>>,
    conn: &rusqlite::Connection,
    stops: &repo::StopsCache,
    patterns: &repo::PatternsCache,
    routes: &repo::RoutesCache,
    shapes_index: &repo::ShapesIndex,
    graph: &graph::coarse::CoarseGraph,
    index: &loader::GtfsIndex,
) {
    // A pattern's real GTFS route_color, if it has one — PatternMeta itself
    // only carries `route_key` (see repo.rs), the color lives on
    // RoutesCache::info_by_id, same indirection raptor.rs's own route_color
    // lookups already go through (there via loader::PatternMetaFull, which
    // bakes the color straight onto the pattern; this cache doesn't, so the
    // lookup is spelled out here instead).
    let pattern_route_color = |pattern_pk: i64| -> Option<String> {
        let meta = patterns.get(pattern_pk)?;
        let route_id = meta.route_key?;
        let info = routes.info_by_id.get(route_id as usize)?;
        if info.route_color.is_empty() { None } else { Some(format!("#{}", info.route_color.trim_start_matches('#').to_uppercase())) }
    };
    let Some(sink) = debug else { return };
    let to_ll = |pk: i64| stops.get(pk).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon });

    // BUGFIX: this used to track fwd_level/bwd_level SEPARATELY (each
    // restarting at 0), on the theory that the frontend would want to know
    // "which forward step" vs "which backward step" a snapshot was. But
    // debugSinkCollector.ts (TS side) writes these into ONE flat array by
    // `level` alone (`bfsLevels[event.inner.level] = event.inner.stops`),
    // with no awareness of `dir` at all — so a Forward level-0 event and a
    // Backward level-0 event collided in the same array slot, and whichever
    // one arrived second silently won. Since debug_bfs_levels is already in
    // expansion order (see resolver.rs's own doc comment on the field),
    // the fix is to use each entry's OWN position in that list as `level`
    // — a single shared step count — matching what the frontend already
    // assumes instead of quietly fighting it.
    for (i, (dir, stop_pks)) in index.debug_bfs_levels.iter().enumerate() {
        let level = i as u32;
        let pts: Vec<LatLng> = stop_pks.iter().filter_map(|&pk| to_ll(pk)).collect();
        sink.on_event(DebugEvent::SeedBfsLevel { dir: (*dir).into(), level, stops: pts });
    }

    // ── Resolve real GTFS shapes for the candidate seed paths ────────────
    // Cheap because it's only for the small MAX_SEED_PATHS candidate set,
    // not every pattern in the feed — see repo::get_shape_points's own doc
    // comment, which describes exactly this use case ("only fetch shapes
    // for patterns the surviving journeys actually use"). Walk edges (no
    // via_pattern) are left as straight lines — there's no GTFS shape for a
    // footpath, and they're usually short anyway.
    let mut needed_shapes: Vec<(i64, String)> = Vec::new();
    for path in &index.debug_seed_paths {
        for w in path.windows(2) {
            let (from, to) = (w[0], w[1]);
            let Some(edges) = graph.adjacency.get(&from) else { continue };
            let Some(edge) = edges.iter().find(|e| e.to == to && e.kind == graph::coarse::EdgeKind::Transit) else { continue };
            let Some(pattern_pk) = edge.via_pattern else { continue };
            let Some(meta) = patterns.get(pattern_pk) else { continue };
            let Some(shape_id) = &meta.shape_id else { continue };
            needed_shapes.push((meta.agency, shape_id.clone()));
        }
    }
    needed_shapes.sort();
    needed_shapes.dedup();
    let shape_points = if needed_shapes.is_empty() {
        HashMap::new()
    } else {
        repo::get_shape_points(conn, shapes_index, &needed_shapes).unwrap_or_default()
    };

    for (path_index, path) in index.debug_seed_paths.iter().enumerate() {
        // CHANGED: previously concatenated every hop's points into one flat
        // `pts` buffer and lost the hop boundary in the process. Now each
        // hop becomes its own SeedPathHop — no more accumulation across the
        // loop, and no more "duplicate point at the join" handling since
        // hops are no longer joined together at all (that's now the
        // frontend's call, if/when it wants one flattened polyline back —
        // see debugSinkCollector.ts's rebuildFlatSeedPaths).
        let depth = index.debug_seed_path_depths.get(path_index).copied().unwrap_or(0);
        let mut hops: Vec<SeedPathHop> = Vec::new();
        for (hop_index, w) in path.windows(2).enumerate() {
            let (from, to) = (w[0], w[1]);
            let (Some(from_ll), Some(to_ll)) = (to_ll(from), to_ll(to)) else { continue };
            let edge = graph.adjacency.get(&from).and_then(|edges| edges.iter().find(|e| e.to == to));
            let (coords, is_walk, route_color) = match edge {
                Some(e) if e.kind == graph::coarse::EdgeKind::Transit => {
                    match e.via_pattern {
                        Some(pattern_pk) => {
                            let coords = shaped_edge_coords(from_ll, to_ll, pattern_pk, patterns, &shape_points);
                            (coords, false, pattern_route_color(pattern_pk))
                        }
                        None => (vec![from_ll, to_ll], false, None),
                    }
                }
                _ => (vec![from_ll, to_ll], true, None), // walk edge, or edge not found — straight line
            };
            hops.push(SeedPathHop { hop_index: hop_index as u32, coords, is_walk, route_color });
        }
        sink.on_event(DebugEvent::SeedPath { path_index: path_index as u32, depth, hops });
    }

    for boundary in &index.debug_corridor_boundary {
        let left: Vec<LatLng> = boundary.left.iter().map(|p| LatLng { latitude: p.lat, longitude: p.lon }).collect();
        let right: Vec<LatLng> = boundary.right.iter().map(|p| LatLng { latitude: p.lat, longitude: p.lon }).collect();
        sink.on_event(DebugEvent::CorridorBoundary { left, right });
    }
}

fn journey_to_ffi(j: raptor::Journey) -> Journey {
    Journey {
        coords: j.coords.into_iter().map(LatLng::from).collect(),
        segments: j.segments.into_iter().map(segment_to_ffi).collect(),
        legs: j.legs.into_iter().map(leg_to_ffi).collect(),
        route_name: j.route_name,
        route_type: j.route_type as i32,
        route_color: j.route_color,
        route_text_color: j.route_text_color,
        origin_stop_name: j.origin_stop_name,
        dest_stop_name: j.dest_stop_name,
        transfer_stop_name: j.transfer_stop_name,
        total_duration_min: j.total_duration_min as i32,
        total_walking_meters: j.total_walking_meters as i32,
        transfer_count: j.transfer_count as i32,
        departure_time_sec: j.departure_time_sec as i32,
        arrival_time_sec: j.arrival_time_sec as i32,
    }
}

fn segment_to_ffi(s: raptor::RouteSegment) -> RouteSegment {
    RouteSegment {
        coords: s.coords.into_iter().map(LatLng::from).collect(),
        route_name: s.route_name,
        route_type: s.route_type as i32,
        route_color: s.route_color,
        route_text_color: s.route_text_color,
        origin_stop_name: s.origin_stop_name,
        dest_stop_name: s.dest_stop_name,
        is_walk: s.is_walk,
        departure_time_sec: s.departure_time_sec.map(|v| v as i32),
        arrival_time_sec: s.arrival_time_sec.map(|v| v as i32),
    }
}

fn leg_to_ffi(l: raptor::Leg) -> Leg {
    Leg {
        route_name: l.route_name,
        route_type: l.route_type as i32,
        route_color: l.route_color,
        route_text_color: l.route_text_color,
        origin_stop_name: l.origin_stop_name,
        dest_stop_name: l.dest_stop_name,
        departure_time_sec: l.departure_time_sec.map(|v| v as i32),
        arrival_time_sec: l.arrival_time_sec.map(|v| v as i32),
    }
}