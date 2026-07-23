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

use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use rusqlite::Connection;

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

/// "Currently evaluating" events for a debug polyline overlay — fired
/// live during a search, not batched into the final result, so the caller
/// can throttle rendering (e.g. to 60fps) at the receiving end.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum DebugEvent {
    SeedBfsLevel { level: u32, stops: Vec<LatLng> },
    SeedPath { path: Vec<LatLng> },
    CorridorBoundary { left: Vec<LatLng>, right: Vec<LatLng> },
    RaptorRound { round: u32, marked_stops: Vec<LatLng> },
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
    #[allow(dead_code)] // reserved for follow-up shape-polyline work — see raptor.rs's scope note
    shapes_index: Arc<repo::ShapesIndex>,
    graph: Arc<graph::coarse::CoarseGraph>,
}

#[derive(uniffi::Object)]
pub struct GtfsRouterEngine {
    conn: Mutex<Option<Connection>>,
    state: RwLock<Option<WarmState>>,
    corridor_cache: Mutex<corridor::resolver::CorridorCache>,
}

#[uniffi::export]
impl GtfsRouterEngine {
    #[uniffi::constructor]
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            state: RwLock::new(None),
            corridor_cache: Mutex::new(corridor::resolver::CorridorCache::new()),
        }
    }

    /// Opens `db_path` and loads/builds everything reusable across
    /// searches: stops, routes, patterns, shape index, and the coarse
    /// topology graph (loaded from `rust_coarse_graph_*` if a matching
    /// persisted copy exists, built fresh and persisted otherwise — same
    /// ~12-14s from-scratch cost the TS version documents, paid once).
    /// Safe to call again after a feed update; it re-opens and rebuilds.
    pub fn warm_up(&self, db_path: String) -> Result<(), RouterError> {
        let mut conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA cache_size = -8000;")?;

        let stops = repo::load_stops(&conn)?;
        let routes = repo::load_routes(&conn)?;
        let patterns = repo::load_patterns(&conn, &routes)?;
        let shapes_index = repo::load_shape_index(&conn)?;

        let signature = graph::store::compute_graph_signature(&conn)?;
        let adjacency = match graph::store::load_persisted_graph(&conn, &signature)? {
            Some(adj) => adj,
            None => {
                let pattern_stops = repo::get_all_pattern_stops_ordered(&conn)?;
                let adj = graph::coarse::build_adjacency_from_scratch(&stops, &pattern_stops);
                graph::store::save_persisted_graph(&mut conn, &signature, &adj)?;
                adj
            }
        };

        *self.state.write().unwrap() = Some(WarmState {
            stops: Arc::new(stops),
            routes: Arc::new(routes),
            patterns: Arc::new(patterns),
            shapes_index: Arc::new(shapes_index),
            graph: Arc::new(graph::coarse::CoarseGraph { adjacency }),
        });
        *self.conn.lock().unwrap() = Some(conn);
        *self.corridor_cache.lock().unwrap() = corridor::resolver::CorridorCache::new();

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

        let mut index = loader::load_gtfs_index_for_trip(
            conn, &state.stops, &state.patterns, &state.routes, &state.graph, &mut corridor_cache,
            origin_ll, dest_ll, depart_sec_of_day as i64,
            &today_date, today_dow, &tomorrow_date, tomorrow_dow, None,
        )?;

        if index.no_service_found {
            return Err(RouterError::NoServiceFound);
        }

        emit_pre_search_debug(&debug, &state.stops, &index);

        let opts = raptor::RaptorOptions { walking_speed_mps, ..Default::default() };
        let stops_for_cb = state.stops.clone();
        let debug_for_cb = debug.clone();
        let mut on_round = move |round: u32, marked: &[i64]| {
            if let Some(sink) = &debug_for_cb {
                let pts: Vec<LatLng> = marked.iter().filter_map(|&pk| stops_for_cb.get(pk).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon })).collect();
                sink.on_event(DebugEvent::RaptorRound { round, marked_stops: pts });
            }
        };

        let t_raptor = Instant::now();
        let result = raptor::run_search(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, &opts, Some(&mut on_round));
        let mut raptor_ms = t_raptor.elapsed().as_millis() as i64;

        let journeys = match result {
            Ok(j) => j,
            Err(_) => {
                // Same retry-with-a-forced-wide-window fallback as
                // computeGtfsRoute in the TS version: a window wide enough
                // to find SOME trips but not a later leg's boarding trip.
                index = loader::load_gtfs_index_for_trip(
                    conn, &state.stops, &state.patterns, &state.routes, &state.graph, &mut corridor_cache,
                    origin_ll, dest_ll, depart_sec_of_day as i64,
                    &today_date, today_dow, &tomorrow_date, tomorrow_dow, Some(10 * 3600),
                )?;
                if index.no_service_found { return Err(RouterError::NoServiceFound); }
                emit_pre_search_debug(&debug, &state.stops, &index);
                let t_retry = Instant::now();
                let retried = raptor::run_search(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, &opts, Some(&mut on_round))
                    .map_err(RouterError::NoRoute)?;
                // Retry's own load + search time gets appended as separate
                // timing entries below rather than overwriting the first
                // attempt's — a retry happening at all is itself useful
                // diagnostic info, not something to hide by summing it in.
                raptor_ms += t_retry.elapsed().as_millis() as i64;
                retried
            }
        };

        let mut timings: Vec<TimingEntry> = index.timings.iter()
            .map(|(label, ms)| TimingEntry { label: label.clone(), ms: *ms })
            .collect();
        timings.push(TimingEntry { label: "raptor_search".to_string(), ms: raptor_ms });

        Ok(RouteResult { journeys: journeys.into_iter().map(journey_to_ffi).collect(), timings })
    }
}

fn emit_pre_search_debug(debug: &Option<Arc<dyn DebugSink>>, stops: &repo::StopsCache, index: &loader::GtfsIndex) {
    let Some(sink) = debug else { return };
    let to_ll = |pk: i64| stops.get(pk).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon });

    for (level, stop_pks) in index.debug_bfs_levels.iter().enumerate() {
        let pts: Vec<LatLng> = stop_pks.iter().filter_map(|&pk| to_ll(pk)).collect();
        sink.on_event(DebugEvent::SeedBfsLevel { level: level as u32, stops: pts });
    }
    for path in &index.debug_seed_paths {
        let pts: Vec<LatLng> = path.iter().filter_map(|&pk| to_ll(pk)).collect();
        sink.on_event(DebugEvent::SeedPath { path: pts });
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
