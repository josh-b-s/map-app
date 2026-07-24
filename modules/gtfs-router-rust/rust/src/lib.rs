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

/// "Currently evaluating" events for a debug polyline overlay — fired
/// live during a search, not batched into the final result, so the caller
/// can throttle rendering (e.g. to 60fps) at the receiving end.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum DebugEvent {
    SeedBfsLevel { level: u32, stops: Vec<LatLng> },
    SeedPath { path: Vec<LatLng> },
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

        let t_debug_emit = Instant::now();
        emit_pre_search_debug(&debug, conn, &state.stops, &state.patterns, &state.shapes_index, &state.graph, &index);
        let mut debug_emit_ms = t_debug_emit.elapsed().as_millis() as i64;

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
        let debug_for_route_cb = debug.clone();
        let mut on_route_check = move |round: u32, ridden: &[i64], route_color: Option<&str>, route_name: Option<&str>| {
            if let Some(sink) = &debug_for_route_cb {
                let pts: Vec<LatLng> = ridden.iter().filter_map(|&pk| stops_for_route_cb.get(pk).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon })).collect();
                if pts.len() >= 2 {
                    sink.on_event(DebugEvent::RaptorRouteCheck { round, coords: pts, route_color: route_color.map(String::from), route_name: route_name.map(String::from) });
                }
            }
        };

        let t_raptor = Instant::now();
        let result = raptor::run_search(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, &opts, Some(&mut on_round), Some(&mut on_route_check));
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
                let t_retry_emit = Instant::now();
                emit_pre_search_debug(&debug, conn, &state.stops, &state.patterns, &state.shapes_index, &state.graph, &index);
                debug_emit_ms += t_retry_emit.elapsed().as_millis() as i64;
                let t_retry = Instant::now();
                let retried = raptor::run_search(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, &opts, Some(&mut on_round), Some(&mut on_route_check))
                    .map_err(RouterError::NoRoute)?;
                // Retry's own load + search time gets appended as separate
                // timing entries below rather than overwriting the first
                // attempt's — a retry happening at all is itself useful
                // diagnostic info, not something to hide by summing it in.
                raptor_ms += t_retry.elapsed().as_millis() as i64;
                retried
            }
        };

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

        Ok(RouteResult { journeys: journeys.into_iter().map(journey_to_ffi).collect(), timings })
    }
}

/// Nearest point in `shape` (by index) to `target` — used to project a stop
/// onto its pattern's GTFS shape polyline so a seed-path edge can be
/// trimmed to the real ridden portion instead of drawn as a straight line.
/// Linear scan: shapes are at most a few hundred points and this only runs
/// for the small candidate seed-path set, not every pattern in the feed.
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
    shapes_index: &repo::ShapesIndex,
    graph: &graph::coarse::CoarseGraph,
    index: &loader::GtfsIndex,
) {
    let Some(sink) = debug else { return };
    let to_ll = |pk: i64| stops.get(pk).map(|s| LatLng { latitude: s.stop_lat, longitude: s.stop_lon });

    for (level, stop_pks) in index.debug_bfs_levels.iter().enumerate() {
        let pts: Vec<LatLng> = stop_pks.iter().filter_map(|&pk| to_ll(pk)).collect();
        sink.on_event(DebugEvent::SeedBfsLevel { level: level as u32, stops: pts });
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

    for path in &index.debug_seed_paths {
        let mut pts: Vec<LatLng> = Vec::new();
        for w in path.windows(2) {
            let (from, to) = (w[0], w[1]);
            let (Some(from_ll), Some(to_ll)) = (to_ll(from), to_ll(to)) else { continue };
            let edge = graph.adjacency.get(&from).and_then(|edges| edges.iter().find(|e| e.to == to));
            let seg = match edge {
                Some(e) if e.kind == graph::coarse::EdgeKind::Transit => {
                    match e.via_pattern {
                        Some(pattern_pk) => shaped_edge_coords(from_ll, to_ll, pattern_pk, patterns, &shape_points),
                        None => vec![from_ll, to_ll],
                    }
                }
                _ => vec![from_ll, to_ll], // walk edge, or edge not found — straight line
            };
            // Avoid a duplicate point at the join between consecutive edges.
            if pts.last() == seg.first() {
                pts.extend(seg.into_iter().skip(1));
            } else {
                pts.extend(seg);
            }
        }
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
