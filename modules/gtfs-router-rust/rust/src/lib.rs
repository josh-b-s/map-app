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
mod verifier;
mod freq_raptor;
mod fxhash;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll, Waker};
use std::time::Instant;
use rusqlite::Connection;
use crate::geo::haversine_meters;

uniffi::setup_scaffolding!();

// ── Off-JS-thread execution ───────────────────────────────────────────────
// `warm_up` (~10-14s cold) and `compute_route` (0.2-3.7s) are CPU/IO bound
// and used to run synchronously on the calling thread — i.e. the React
// Native JS thread — freezing the whole UI for their duration. Both are now
// exported as `async` and run their blocking body on a dedicated OS thread;
// the returned future just parks a Waker until that thread finishes, so the
// JS thread stays free (uniffi/ubrn poll it via the waker; no tokio needed).
struct BlockingShared<T> {
    result: Option<T>,
    waker: Option<Waker>,
}

struct BlockingTask<T> {
    shared: Arc<Mutex<BlockingShared<T>>>,
}

impl<T> Future for BlockingTask<T> {
    type Output = T;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        let mut g = self.shared.lock().unwrap();
        match g.result.take() {
            Some(r) => Poll::Ready(r),
            None => {
                g.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

fn run_blocking<T, F>(f: F) -> BlockingTask<Result<T, RouterError>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, RouterError> + Send + 'static,
{
    let shared = Arc::new(Mutex::new(BlockingShared { result: None, waker: None }));
    let thread_shared = Arc::clone(&shared);
    let spawned = std::thread::Builder::new()
        .name("gtfs-router-worker".to_string())
        .stack_size(16 * 1024 * 1024) // Rust's 2MB default is tight for the recursive scoring/backtracking
        .spawn(move || {
            // A panic must not leave the JS promise pending forever.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
                .unwrap_or_else(|_| Err(RouterError::Db("native router panicked".to_string())));
            let waker = {
                let mut g = thread_shared.lock().unwrap();
                g.result = Some(result);
                g.waker.take()
            };
            if let Some(w) = waker { w.wake(); }
        });
    if let Err(e) = spawned {
        shared.lock().unwrap().result = Some(Err(RouterError::Db(format!("failed to spawn worker thread: {e}"))));
    }
    BlockingTask { shared }
}

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
    /// Receives EVERY pre-search debug event in a single call, in emission
    /// order (BFS levels, then seed paths, then corridor boundaries).
    /// Replaces the old per-event `on_event`, which crossed the JS bridge
    /// once per event (1600+ synchronous crossings per search).
    fn on_event_batch(&self, events: Vec<DebugEvent>);
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
    pub async fn warm_up(self: Arc<Self>, db_path: String) -> Result<(), RouterError> {
        run_blocking(move || self.warm_up_blocking(db_path)).await
    }
}

impl GtfsRouterEngine {
    fn warm_up_blocking(&self, db_path: String) -> Result<(), RouterError> {
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

}

#[uniffi::export]
impl GtfsRouterEngine {
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

    /// Runs the whole search on a worker thread (see `run_blocking`) so the
    /// JS thread is never blocked; resolves when the search completes.
    #[allow(clippy::too_many_arguments)]
    pub async fn compute_route(
        self: Arc<Self>,
        origin: LatLng,
        destination: LatLng,
        depart_sec_of_day: i32,
        today_date: String,
        today_dow: u8,
        tomorrow_date: String,
        tomorrow_dow: u8,
        walking_speed_mps: f64,
        max_walk_distance_m: f64,
        debug: Option<Arc<dyn DebugSink>>,
    ) -> Result<RouteResult, RouterError> {
        run_blocking(move || self.compute_route_blocking(
            origin, destination, depart_sec_of_day, today_date, today_dow,
            tomorrow_date, tomorrow_dow, walking_speed_mps, max_walk_distance_m, debug,
        )).await
    }
}

impl GtfsRouterEngine {
    #[allow(clippy::too_many_arguments)]
    fn compute_route_blocking(
        &self,
        origin: LatLng,
        destination: LatLng,
        depart_sec_of_day: i32,
        today_date: String,
        today_dow: u8,
        tomorrow_date: String,
        tomorrow_dow: u8,
        walking_speed_mps: f64,
        max_walk_distance_m: f64,
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
            &today_date, today_dow, &tomorrow_date, tomorrow_dow, walking_speed_mps, max_walk_distance_m, None,
        )?;

        if index.no_service_found {
            return Err(RouterError::NoServiceFound);
        }

        let mut debug_emit_ms: i64 = 0;

        // Verifier walks fixed seed-path candidates against real
        // stop_times, no rounds, no exploration, so there is no
        // round-by-round debug feed to wire up here anymore. See
        // verifier.rs's header for why the old McRAPTOR scan is gone.
        let t_raptor = Instant::now();
        let mut pending_failed_attempt_timings: Vec<TimingEntry> = Vec::new();
        let result = verifier::verify_seed_paths(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, walking_speed_mps);
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
                    &today_date, today_dow, &tomorrow_date, tomorrow_dow, walking_speed_mps, max_walk_distance_m, Some(10 * 3600),
                )?;
                if index.no_service_found { return Err(RouterError::NoServiceFound); }
                let t_retry = Instant::now();
                let retried = verifier::verify_seed_paths(&index, &state.stops, origin_ll, dest_ll, depart_sec_of_day as i64, walking_speed_mps)
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
        // Trim to the Pareto-optimal handful BEFORE the expensive work:
        // shape loading (SQL rows for every shape those journeys ride),
        // polyline building, and the FFI/JS cost of everything returned.
        // Previously EVERY verified candidate went through all of that.
        let journeys_verified = journeys.len() as i64;
        let t_select = Instant::now();
        let mut journeys = select_journeys(journeys);
        let select_ms = t_select.elapsed().as_millis() as i64;
        let journeys_returned = journeys.len() as i64;

        let t_shape_resolve = Instant::now();
        resolve_journey_shapes(&mut journeys, conn, &state.patterns, &state.shapes_index);
        simplify_journey_polylines(&mut journeys);
        let shape_resolve_ms = t_shape_resolve.elapsed().as_millis() as i64;

        let mut timings: Vec<TimingEntry> = index.timings.iter()
            .map(|(label, ms)| TimingEntry { label: label.clone(), ms: *ms })
            .collect();
        timings.push(TimingEntry { label: "raptor_search".to_string(), ms: raptor_ms });
        timings.push(TimingEntry { label: "debug_emit".to_string(), ms: debug_emit_ms });
        timings.push(TimingEntry { label: "journey_shape_resolve".to_string(), ms: shape_resolve_ms });
        timings.push(TimingEntry { label: "count.journeys_verified".to_string(), ms: journeys_verified });
        timings.push(TimingEntry { label: "count.journeys_returned".to_string(), ms: journeys_returned });
        timings.push(TimingEntry { label: "journey_select".to_string(), ms: select_ms });
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
            // Same cutoff seed_bfs.rs's path filter uses: the fastest 25% of scored paths, no margin.
            let threshold = settings::percentile(&index.seed_path_scores, settings::SEED_PATH_MARGIN_REFERENCE_PERCENTILE);
            if threshold < f64::MAX {
                let mut kept_patterns: std::collections::HashSet<i64> = std::collections::HashSet::new();
                for (i, pats) in index.seed_path_pattern_pks.iter().enumerate() {
                    let s = index.seed_path_scores.get(i).copied().unwrap_or(f64::MAX);
                    if s <= threshold || s >= f64::MAX { kept_patterns.extend(pats.iter().copied()); }
                }
                // One aggregate entry, not one per journey — was pushing a
                // separate identically-labeled TimingEntry per journey
                // (17 journeys => 17 duplicate "...missing_patterns=Nms"
                // entries in the timings log), which is noise that scales
                // with candidate count rather than a real diagnostic
                // signal. `ms` here is a pattern-count, not a duration —
                // same field-reuse the per-journey version already did,
                // just summed instead of repeated.
                let mut total_missing = 0i64;
                let mut journeys_with_missing = 0i64;
                for j in &journeys {
                    let missing = j.used_pattern_pks.iter().filter(|pk| !kept_patterns.contains(pk)).count() as i64;
                    total_missing += missing;
                    if missing > 0 { journeys_with_missing += 1; }
                }
                timings.push(TimingEntry { label: "count.seed_path_completeness_missing_patterns".to_string(), ms: total_missing });
                timings.push(TimingEntry { label: "count.seed_path_completeness_affected_journeys".to_string(), ms: journeys_with_missing });
            }
        }

        Ok(RouteResult { journeys: journeys.into_iter().map(journey_to_ffi).collect(), timings })
    }
}

/// Journeys worth showing: drops duplicate routes, keeps only the
/// Pareto-optimal set over (arrival minute, walking in 100 m buckets,
/// transfers), always including the best journey per criterion (fastest /
/// least walking / fewest transfers — the three UI tabs), then fills up to
/// MAX_RETURNED_JOURNEYS in arrival order. Result is sorted by arrival.
fn select_journeys(mut journeys: Vec<raptor::Journey>) -> Vec<raptor::Journey> {
    journeys.sort_by_key(|j| j.arrival_time_sec);

    // Identical leg sequences (same routes between the same stops) are the
    // same journey to the user.
    let mut seen: std::collections::HashSet<Vec<(String, String, String)>> = std::collections::HashSet::new();
    journeys.retain(|j| seen.insert(
        j.legs.iter().map(|l| (l.route_name.clone(), l.origin_stop_name.clone(), l.dest_stop_name.clone())).collect()
    ));

    let key = |j: &raptor::Journey| (j.arrival_time_sec / 60, j.total_walking_meters / 100, j.transfer_count);
    let keys: Vec<(i64, i64, i64)> = journeys.iter().map(key).collect();
    let dominates = |a: &(i64, i64, i64), b: &(i64, i64, i64)| {
        a.0 <= b.0 && a.1 <= b.1 && a.2 <= b.2 && (a.0 < b.0 || a.1 < b.1 || a.2 < b.2)
    };
    let mut pareto: Vec<usize> = (0..journeys.len())
        .filter(|&i| !(0..journeys.len()).any(|k| k != i && dominates(&keys[k], &keys[i])))
        .collect();
    pareto.sort_by_key(|&i| journeys[i].arrival_time_sec);

    let mut chosen: Vec<usize> = Vec::new();
    let mut pick = |i: Option<usize>| { if let Some(i) = i { if !chosen.contains(&i) { chosen.push(i); } } };
    pick(pareto.iter().copied().min_by_key(|&i| (journeys[i].arrival_time_sec, journeys[i].total_walking_meters)));
    pick(pareto.iter().copied().min_by_key(|&i| (journeys[i].total_walking_meters, journeys[i].arrival_time_sec)));
    pick(pareto.iter().copied().min_by_key(|&i| (journeys[i].transfer_count, journeys[i].arrival_time_sec)));
    for &i in &pareto {
        if chosen.len() >= settings::MAX_RETURNED_JOURNEYS { break; }
        if !chosen.contains(&i) { chosen.push(i); }
    }
    chosen.sort_by_key(|&i| journeys[i].arrival_time_sec);

    let mut slots: Vec<Option<raptor::Journey>> = journeys.into_iter().map(Some).collect();
    chosen.into_iter().filter_map(|i| slots[i].take()).collect()
}

/// Douglas-Peucker in a local equirectangular metre frame. Keeps both
/// endpoints; `tol_m` is the max perpendicular deviation allowed.
fn simplify_polyline(pts: &[geo::LatLon], tol_m: f64) -> Vec<geo::LatLon> {
    let n = pts.len();
    if n <= 2 { return pts.to_vec(); }
    let kx = 111_320.0 * pts[0].lat.to_radians().cos();
    let ky = 110_540.0;
    let xy: Vec<(f64, f64)> = pts.iter().map(|p| (p.lon * kx, p.lat * ky)).collect();
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 { continue; }
        let (ax, ay) = xy[a];
        let (bx, by) = xy[b];
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let mut best = 0.0f64;
        let mut idx = a;
        for i in (a + 1)..b {
            let (px, py) = xy[i];
            let d = if len2 == 0.0 {
                ((px - ax).powi(2) + (py - ay).powi(2)).sqrt()
            } else {
                let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
                ((px - (ax + t * dx)).powi(2) + (py - (ay + t * dy)).powi(2)).sqrt()
            };
            if d > best { best = d; idx = i; }
        }
        if best > tol_m {
            keep[idx] = true;
            stack.push((a, idx));
            stack.push((idx, b));
        }
    }
    pts.iter().zip(keep).filter_map(|(p, k)| if k { Some(p.clone()) } else { None }).collect()
}

/// Simplifies every returned segment polyline, then rebuilds each
/// journey's whole-route `coords` from them so the two stay consistent.
fn simplify_journey_polylines(journeys: &mut [raptor::Journey]) {
    for j in journeys.iter_mut() {
        for seg in j.segments.iter_mut() {
            if seg.coords.len() > 2 {
                seg.coords = simplify_polyline(&seg.coords, settings::RETURNED_POLYLINE_TOLERANCE_M);
            }
        }
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
    shaped_edge_coords_checked(from_ll, to_ll, pattern_pk, patterns, shape_points)
        .unwrap_or_else(|| vec![from_ll, to_ll])
}

/// Direction-aware projection of `from`/`to` onto a shape: picks
/// (i0, i1) with i0 < i1 minimizing dist(from, shape[i0]) + dist(to,
/// shape[i1]). Plain "nearest point to each end" is wrong for shapes that
/// loop or run out-and-back (both stops can sit near BOTH ends of the
/// shape), and would return the whole shape as the "ridden" slice. GTFS
/// shapes follow trip direction, so restricting to i0 < i1 fixes that.
fn project_forward(shape: &[(f64, f64)], from: geo::LatLon, to: geo::LatLon) -> Option<(usize, usize)> {
    let mut best_i0 = 0usize;
    let mut best_d0 = f64::MAX;
    let mut best: Option<(f64, usize, usize)> = None;
    for (j, &(lat, lon)) in shape.iter().enumerate() {
        let p = geo::LatLon { lat, lon };
        let d0 = haversine_meters(from, p);
        if d0 < best_d0 { best_d0 = d0; best_i0 = j; }
        let cost = best_d0 + haversine_meters(to, p);
        if best.map_or(true, |(c, _, _)| cost < c) { best = Some((cost, best_i0, j)); }
    }
    best.and_then(|(_, i0, i1)| if i1 > i0 { Some((i0, i1)) } else { None })
}

/// Like `shaped_edge_coords` but returns None (instead of a straight line)
/// when there's no usable shape OR the trimmed slice is implausibly long
/// for the hop (a wrong/looping shape, e.g. a slice hundreds of km long
/// for a 10 km bus hop). Callers that already hold real geometry
/// (resolve_journey_shapes: the pattern's own stop-to-stop polyline) keep
/// it on None rather than overwriting it with a straight line.
fn shaped_edge_coords_checked(
    from_ll: LatLng,
    to_ll: LatLng,
    pattern_pk: i64,
    patterns: &repo::PatternsCache,
    shape_points: &HashMap<(i64, String), Vec<(f64, f64)>>,
) -> Option<Vec<LatLng>> {
    let meta = patterns.get(pattern_pk)?;
    let shape_id = meta.shape_id.as_ref()?;
    let shape = shape_points.get(&(meta.agency, shape_id.clone()))?;
    if shape.len() < 2 { return None; }

    let from_geo = geo::LatLon { lat: from_ll.latitude, lon: from_ll.longitude };
    let to_geo = geo::LatLon { lat: to_ll.latitude, lon: to_ll.longitude };
    let (i0, i1) = match project_forward(shape, from_geo, to_geo) {
        Some(pair) => pair,
        None => {
            let a = nearest_shape_index(shape, from_geo)?;
            let b = nearest_shape_index(shape, to_geo)?;
            if a == b { return None; }
            (a, b)
        }
    };

    let (lo, hi) = (i0.min(i1), i0.max(i1));
    let mut slice: Vec<LatLng> = shape[lo..=hi].iter().map(|&(lat, lon)| LatLng { latitude: lat, longitude: lon }).collect();
    if i0 > i1 { slice.reverse(); }

    // Sanity: a real ridden slice is a small multiple of the straight-line
    // distance between the two stops.
    let straight = haversine_meters(from_geo, to_geo);
    let slice_len: f64 = slice.windows(2)
        .map(|w| haversine_meters(
            geo::LatLon { lat: w[0].latitude, lon: w[0].longitude },
            geo::LatLon { lat: w[1].latitude, lon: w[1].longitude },
        ))
        .sum();
    if slice_len > straight * 4.0 + 1500.0 { return None; }
    Some(slice)
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
            // None => no usable/plausible shape: KEEP the segment's existing
            // stop-to-stop polyline rather than overwriting it.
            if let Some(shaped) = shaped_edge_coords_checked(from_ll, to_ll, pk, patterns, &shape_points) {
                if shaped.len() >= 2 {
                    seg.coords = shaped.into_iter().map(geo::LatLon::from).collect();
                }
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
    let mut events: Vec<DebugEvent> = Vec::new();
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
        events.push(DebugEvent::SeedBfsLevel { dir: (*dir).into(), level, stops: pts });
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
        events.push(DebugEvent::SeedPath { path_index: path_index as u32, depth, hops });
    }

    for boundary in &index.debug_corridor_boundary {
        let left: Vec<LatLng> = boundary.left.iter().map(|p| LatLng { latitude: p.lat, longitude: p.lon }).collect();
        let right: Vec<LatLng> = boundary.right.iter().map(|p| LatLng { latitude: p.lat, longitude: p.lon }).collect();
        events.push(DebugEvent::CorridorBoundary { left, right });
    }

    if !events.is_empty() { sink.on_event_batch(events); }
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