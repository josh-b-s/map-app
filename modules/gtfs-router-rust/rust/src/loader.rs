//! loader.rs — port of services/gtfs/loader/gtfsLoader.ts.
//!
//! Loads a GTFS index SCOPED to one trip: corridor -> active services ->
//! trips -> pattern_stops for patterns running today -> time-windowed
//! stop_times. Same staged/widening approach as the TS version.
//!
//! SIMPLIFICATION vs the TS version: patterns and routes are small tables
//! (thousands of rows, not millions) so this port loads them FULLY into
//! `PatternsCache`/`RoutesCache` once per engine lifetime (see repo.rs) and
//! reads pattern/route metadata straight out of those caches here — no
//! per-search "patterns JOIN routes WHERE pattern_pk IN (...)" query at
//! all, unlike gtfsLoader.ts's step 7. trip_id text is dropped entirely
//! from the search path; trip_pk is the only identity RAPTOR needs.
//!
//! PERF NOTE (added after profiling showed this port ~30-45% SLOWER than
//! the TS path despite identical caching architecture): the original
//! version of this file chunked large pk lists into `IN (?,?,?...400
//! placeholders...)` queries, re-`prepare()`-ing fresh SQL text per chunk —
//! this is the exact pre-optimization shape gtfsLoader.ts moved away from
//! (see its own "staged into temp table" log lines). Rewritten to stage pk
//! lists into small per-connection TEMP TABLEs and query against them,
//! same pattern as the TS side.
//!
//! PERF NOTE 2 (added after the first rewrite made things ~13x WORSE, not
//! better): the first pass wrote these as explicit `JOIN temp_table ON
//! temp_table.id = big_table.col`. SQLite's query planner has no ANALYZE
//! statistics for a temp table that was just created and populated this
//! call, so it can't tell the temp table (thousands of rows) is far
//! smaller than `stop_times`/`trips` (potentially millions) — it picked a
//! plan that scanned the BIG table as the outer loop instead of using the
//! big table's index to seek per staged id, undoing the entire point of
//! staging. Rewritten again below as `WHERE col IN (SELECT id FROM
//! temp_table)` — SQLite reliably compiles this into an index-seek semi-join
//! regardless of missing stats, which is why this shape (not an explicit
//! JOIN) is the one to keep. If profiling still looks off after this,
//! next thing to check is whether `stop_times.stop_pk`/`stop_times.trip_pk`
//! actually have indices at all (`EXPLAIN QUERY PLAN` on these three
//! queries) — the IN(SELECT) shape still needs one to be fast.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// (today_date, tomorrow_date, the computed set) — see the cache-check at
/// the top of step 2 in `load_gtfs_index_for_trip`'s module doc below for
/// why this is keyed by date rather than recomputed per search.
pub type ActiveServicesCacheEntry = (String, String, Arc<HashSet<(i64, String)>>);
use rusqlite::Connection;
use crate::geo::{haversine_meters, LatLon};
use crate::graph::coarse::CoarseGraph;
use crate::repo::{PatternCumulativeCache, PatternHeadwayCache, PatternHopsCache, PatternsCache, RoutesCache, StopsCache};
use crate::corridor::resolver::{resolve_corridor, CorridorCache, SeedBfsCache};
use crate::freq_raptor;
use crate::settings::{SEED_MEETS_RETRY_CEILING, TOP_N_SEED_MEETS, FREQ_GRAPH_MIN_CANDIDATE_PATTERNS, ENABLE_SEED_PATH_MARGIN};
use crate::corridor::tagging::CorridorBoundary;
use crate::corridor::seed_bfs::SearchDir;
use crate::settings::{
    INITIAL_WINDOW_MAX_SEC, INITIAL_WINDOW_MIN_SEC, WINDOW_BOARD_BUFFER_SEC,
    WINDOW_DISTANCE_BUFFER_SEC, WINDOW_DISTANCE_SCALE_SEC_PER_KM, WINDOW_WIDENING_STAGES_SEC,
    ENABLE_DURATION_BASED_WINDOW, WINDOW_DURATION_MARGIN_FLOOR_SEC, WINDOW_DURATION_MARGIN_RELATIVE_PCT,
    DURATION_WINDOW_MAX_SEC, margin_threshold,
};

const DOW_COLUMNS: [&str; 7] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

#[derive(Debug, Clone)]
pub struct StopTimeEntry {
    pub trip_pk: i64,
    pub pattern_pk: i64,
    pub stop_sequence: i64,
    pub arrival_sec: i64,
    pub departure_sec: i64,
    /// GTFS pickup_type: 0 = regular (boardable), 1 = no pickup, 2 = must
    /// phone agency, 3 = must coordinate with driver. Only 0 is treated as
    /// boardable for automatic trip planning — see raptor.rs's boarding
    /// search, which skips any entry where this isn't 0.
    pub pickup_type: i64,
    /// Same as pickup_type but for alighting — only 0 is treated as a
    /// valid place to get off. See raptor.rs's ride-through loop, which
    /// still rides PAST a non-0 stop (the vehicle keeps going), it just
    /// won't record an arrival there.
    pub drop_off_type: i64,
}

#[derive(Debug, Clone)]
pub struct PatternMetaFull {
    pub agency: i64,
    pub route_id: String,
    pub shape_id: Option<String>,
    pub route_name: String,
    pub route_type: i64,
    pub route_color: String,
    pub route_text_color: String,
}

pub struct GtfsIndex {
    pub allowed_stop_pks: HashSet<i64>,
    pub patterns_by_pk: HashMap<i64, PatternMetaFull>,
    /// pattern_pk -> [(stop_pk, stop_sequence)], ordered by stop_sequence.
    pub pattern_stops: HashMap<i64, Vec<(i64, i64)>>,
    pub stop_times_by_stop: HashMap<i64, Vec<Rc<StopTimeEntry>>>, // sorted by departure_sec
    /// Same rows as `stop_times_by_stop`, but keyed by (stop_pk, pattern_pk)
    /// instead of just stop_pk, each still sorted by departure_sec. Lets the
    /// RAPTOR boarding search binary-search directly into "the next
    /// departure of THIS pattern at this stop" instead of binary-searching
    /// the flat per-stop list (which interleaves every OTHER pattern
    /// serving the same stop) and then linear-scanning past every
    /// non-matching entry to find the next one that matches — expensive at
    /// a busy interchange served by many patterns. `stop_times_by_stop`
    /// itself is kept as-is for any future "any pattern at this stop"
    /// lookup, rather than removed.
    pub stop_times_by_stop_and_pattern: HashMap<(i64, i64), Vec<Rc<StopTimeEntry>>>,
    pub stop_times_by_stop_and_trip: HashMap<i64, HashMap<i64, Rc<StopTimeEntry>>>,
    pub no_service_found: bool,
    pub debug_seed_paths: Vec<Vec<i64>>,
    pub debug_seed_path_depths: Vec<u32>,
    pub debug_bfs_levels: Vec<(SearchDir, Vec<i64>)>,
    pub debug_corridor_boundary: Vec<CorridorBoundary>,
    /// Pattern_pks + whole-trip estimated scores from EVERY margin-kept
    /// candidate seed path — always populated, independent of
    /// ENABLE_SEED_PATH_MARGIN, so lib.rs can measure candidate-generation
    /// completeness against whatever journey McRAPTOR actually finds (see
    /// Journey::used_pattern_pks' doc), regardless of which narrowing
    /// strategy is actually driving routing this run.
    pub seed_path_pattern_pks: Vec<Vec<i64>>,
    pub seed_path_scores: Vec<f64>,
    /// Per-hop pattern_pk for each entry in `debug_seed_paths` — see
    /// `ResolvedCorridor::seed_path_edges`. What `verifier.rs` walks
    /// against real stop_times to confirm a candidate is genuinely
    /// boardable, in place of a full McRAPTOR scan.
    pub seed_path_edges: Vec<Vec<Option<i64>>>,
    /// (label, elapsed_ms) for each stage — diagnostic only, surfaced to
    /// JS via RouteResult.timings for A/B profiling against gtfsLoader.ts's
    /// own console.log breakdown.
    pub timings: Vec<(String, i64)>,
}

fn empty_index(allowed_stop_pks: HashSet<i64>, debug_seed_paths: Vec<Vec<i64>>, debug_seed_path_depths: Vec<u32>, debug_bfs_levels: Vec<(SearchDir, Vec<i64>)>, debug_corridor_boundary: Vec<CorridorBoundary>, timings: Vec<(String, i64)>) -> GtfsIndex {
    GtfsIndex {
        allowed_stop_pks, patterns_by_pk: HashMap::new(), pattern_stops: HashMap::new(),
        stop_times_by_stop: HashMap::new(), stop_times_by_stop_and_pattern: HashMap::new(), stop_times_by_stop_and_trip: HashMap::new(),
        no_service_found: true, debug_seed_paths, debug_seed_path_depths, debug_bfs_levels, debug_corridor_boundary,
        seed_path_pattern_pks: Vec::new(), seed_path_scores: Vec::new(), seed_path_edges: Vec::new(), timings,
    }
}

/// Stages a list of i64 pks into a per-connection TEMP TABLE named
/// `table_name`, clearing any previous contents first. The table is
/// created once (IF NOT EXISTS) and reused across searches on the same
/// connection — cheaper than DROP/CREATE every call, and TEMP TABLEs are
/// already connection-scoped so there's no cross-search leakage risk.
/// Wrapped in a manual transaction (BEGIN/COMMIT via execute_batch) since
/// this only has `&Connection`, not `&mut Connection` — rusqlite's own
/// `Connection::transaction()` needs the latter, so it isn't usable from
/// inside `load_gtfs_index_for_trip`'s call chain without threading a
/// `&mut Connection` all the way through (a bigger change than this fix
/// warrants).
/// Rows per multi-value INSERT batch. SQLite's own limit on bound
/// parameters is 999 by default (`SQLITE_LIMIT_VARIABLE_NUMBER`); 500
/// leaves headroom while still cutting a several-thousand-row staging
/// pass from thousands of round-trips down to single digits.
const STAGE_BATCH_SIZE: usize = 500;

/// Stages a list of i64 pks into a per-connection TEMP TABLE named
/// `table_name`, clearing any previous contents first. The table is
/// created once (IF NOT EXISTS) and reused across searches on the same
/// connection — cheaper than DROP/CREATE every call, and TEMP TABLEs are
/// already connection-scoped so there's no cross-search leakage risk.
///
/// PERF NOTE (added alongside the on-device GTFS importer's move to
/// batched multi-value INSERTs, same reasoning applies here): this used
/// to `stmt.execute([id])` once per id — a fresh bind+step+reset per row.
/// For a several-thousand-row corridor stop set or windowed-trip set,
/// that's several thousand engine round-trips just to stage data that's
/// about to be queried back out. Rewritten to build one multi-value
/// `INSERT ... VALUES (?),(?),...` per `STAGE_BATCH_SIZE`-row chunk
/// instead, cutting round-trips by ~500x with no change in what ends up
/// in the table.
fn stage_ids(conn: &Connection, table_name: &str, ids: &[i64]) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TEMP TABLE IF NOT EXISTS {table_name} (id INTEGER PRIMARY KEY)"
    ))?;
    conn.execute_batch("BEGIN")?;
    // NOTE: `conn` is a long-lived, reused connection (kept open for the
    // engine's whole lifetime), so if anything below fails partway through
    // the transaction we MUST roll back before returning — otherwise the
    // connection is left sitting inside an open transaction indefinitely,
    // silently breaking every later query/write on it. See stage_ids_inner
    // for the fallible body; this wrapper just guarantees cleanup on Err.
    match stage_ids_inner(conn, table_name, ids) {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            // Best-effort rollback: if this also fails there's nothing more
            // we can do from here, but we still want to surface the
            // original error rather than the rollback failure.
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn stage_ids_inner(conn: &Connection, table_name: &str, ids: &[i64]) -> rusqlite::Result<()> {
    conn.execute(&format!("DELETE FROM {table_name}"), [])?;
    for chunk in ids.chunks(STAGE_BATCH_SIZE) {
        let placeholders = chunk.iter().map(|_| "(?)").collect::<Vec<_>>().join(",");
        let sql = format!("INSERT INTO {table_name} (id) VALUES {placeholders}");
        let params: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params.as_slice())?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn load_gtfs_index_for_trip(
    conn: &Connection,
    stops: &StopsCache,
    patterns: &PatternsCache,
    routes: &RoutesCache,
    graph: &CoarseGraph,
    hops: &PatternHopsCache,
    headway: &PatternHeadwayCache,
    pattern_cumulative: &PatternCumulativeCache,
    corridor_cache: &mut CorridorCache,
    bfs_cache: &mut SeedBfsCache,
    active_services_cache: &Mutex<Option<ActiveServicesCacheEntry>>,
    origin: LatLon,
    destination: LatLon,
    depart_sec_of_day: i64,
    today_date: &str,   // YYYYMMDD
    today_dow: u8,      // 0=Sunday..6=Saturday, matches JS Date.getDay()
    tomorrow_date: &str,
    tomorrow_dow: u8,
    walking_speed_mps: f64,
    force_window_sec: Option<i64>,
) -> rusqlite::Result<GtfsIndex> {
    let t_total = Instant::now();
    let mut timings: Vec<(String, i64)> = Vec::new();
    macro_rules! mark {
        ($t:expr, $label:expr) => {
            timings.push(($label.to_string(), $t.elapsed().as_millis() as i64));
        };
    }

    // ── Active service_ids for TODAY and TOMORROW ───────────────────────
    // A search close to midnight can need trips only active under
    // tomorrow's calendar entry — same reasoning as the TS version.
    //
    // This result depends ONLY on (today_date, tomorrow_date) — never on
    // origin/destination/corridor — so it's identical for every search
    // made on the same calendar day, and identical across every attempt of
    // the retry ladder below. Computed once, up front (moved ahead of
    // corridor resolution for exactly that reason), cached at
    // GtfsRouterEngine's level, keyed by date so it self-invalidates the
    // moment the date rolls over.
    let t = Instant::now();
    let active_services: Arc<HashSet<(i64, String)>> = {
        let mut cache_guard = active_services_cache.lock().unwrap();
        match cache_guard.as_ref() {
            Some((cached_today, cached_tomorrow, set))
                if cached_today == today_date && cached_tomorrow == tomorrow_date =>
            {
                Arc::clone(set)
            }
            _ => {
                let mut fresh: HashSet<(i64, String)> = HashSet::new();
                for (date_str, dow) in [(today_date, today_dow), (tomorrow_date, tomorrow_dow)] {
                    let dow_col = DOW_COLUMNS[dow as usize];
                    let cal_sql = format!(
                        "SELECT service_id, agency FROM calendar WHERE {dow_col} = 1 AND start_date <= ?1 AND end_date >= ?1"
                    );
                    {
                        let mut stmt = conn.prepare(&cal_sql)?;
                        let rows = stmt.query_map([date_str], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
                        for row in rows {
                            let (service_id, agency) = row?;
                            fresh.insert((agency, service_id));
                        }
                    }
                    {
                        let mut stmt = conn.prepare(
                            "SELECT service_id, agency, exception_type FROM calendar_dates WHERE date = ?1",
                        )?;
                        let rows = stmt.query_map([date_str], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                        })?;
                        for row in rows {
                            let (service_id, agency, exception_type) = row?;
                            let key = (agency, service_id);
                            if exception_type == 1 { fresh.insert(key); }
                            else if exception_type == 2 { fresh.remove(&key); }
                        }
                    }
                }
                let fresh = Arc::new(fresh);
                *cache_guard = Some((today_date.to_string(), tomorrow_date.to_string(), Arc::clone(&fresh)));
                fresh
            }
        }
    };
    mark!(t, "active_services");

    // ── Corridor -> candidate patterns -> trips actually running today ──
    // Retried with a bigger seed-meet batch if a batch comes back with no
    // pattern that has an active trip at all. BFS itself only ever runs
    // ONCE per (origin, destination, max_transfers) — see corridor::
    // resolver::SeedBfsCache — a retry here just re-slices the SAME ranked
    // meeting-node list into a bigger batch and re-pays the cheap
    // ancestor-union/backtrack/SQL-pattern-lookup/trips-query cost, not
    // the graph walk. Replaces the old geometric bbox-fallback, which used
    // to trigger on a corridor-SHAPE heuristic (MIN_ACCEPTABLE_PATTERNS)
    // rather than on the thing that actually matters here: whether a real,
    // currently-running trip came out the other end.
    let mut batch_size = if ENABLE_SEED_PATH_MARGIN {
        // This mode replaces the meet-level selection layer (rank_meets'
        // margin/top-K) with a path-level margin filter instead (see
        // ENABLE_SEED_PATH_MARGIN's doc) — for that filter to see every
        // meet's paths rather than only whichever meets an artificially
        // small batch_size happened to include, every meeting node BFS
        // found needs to be backtracked, not just the top TOP_N_SEED_MEETS.
        // materialize_seed_paths clamps this to run.ordered_meets.len()
        // internally, so usize::MAX is a safe "no cap" sentinel here, not
        // an actual allocation size.
        usize::MAX
    } else {
        TOP_N_SEED_MEETS
    };
    let (resolved, allowed_stop_pks, candidate_pattern_pks, active_trip_pks, pattern_keys_with_active_trip, trip_pk_to_pattern) = loop {
        let t = Instant::now();
        let resolved = resolve_corridor(conn, stops, patterns, graph, corridor_cache, bfs_cache, origin, destination, batch_size, pattern_cumulative, headway, walking_speed_mps)?;
        mark!(t, "corridor_resolution");
        for (label, ms) in &resolved.sub_timings {
            timings.push((format!("corridor.{label}"), *ms));
        }

        let full_allowed_stop_pks = resolved.allowed_stop_pks.clone();
        let full_candidate_pattern_pks: Vec<i64> = resolved.pattern_pks.iter().copied().collect();

        // COUNT LOGGING (not real durations — piggybacking on the
        // (label, i64) timings channel, same trick already used for
        // active_trip_filter_sql). These two numbers are the actual
        // fan-out driver for both windowed_trip_discovery/stop_times_fetch
        // queries' `stop_pk IN (SELECT id FROM corridor_stop_pks)`
        // semi-join — BEFORE any freq_raptor narrowing, so this still
        // shows what BFS/batch_size alone produced. `count.seed_bfs_meets_
        // total` (from resolve_corridor's own sub_timings) is the
        // pre-batch candidate count — how many meeting nodes existed to
        // choose from, independent of batch_size.
        timings.push(("count.corridor_stop_pks".to_string(), full_allowed_stop_pks.len() as i64));
        timings.push(("count.candidate_pattern_pks".to_string(), full_candidate_pattern_pks.len() as i64));

        // ── Candidate-set narrowing: EITHER the seed-path margin filter
        // OR freq_raptor's frequency-graph pre-filter, never both — see
        // ENABLE_SEED_PATH_MARGIN's doc in settings.rs for why these are
        // two competing strategies for the same job (narrow the
        // materialized candidate set BEFORE trips_for_candidates /
        // windowed_discovery_and_fetch run below) rather than stacked
        // stages. Both produce the same `FreqNarrowResult` shape so every
        // consumer below — the active-trip lookup, the cheap
        // fallback-to-full, all the timings/logging — is shared code,
        // unaware of which strategy actually produced it.
        let freq_narrow: Option<freq_raptor::FreqNarrowResult> = if ENABLE_SEED_PATH_MARGIN {
            // Union of patterns/stops across every margin-kept whole
            // candidate trip (resolve_corridor/materialize_seed_paths
            // already did the actual margin filtering — this just
            // flattens what survived). See seed_path_pattern_pks' doc for
            // why this field isn't debug-only despite the naming symmetry
            // with debug_seed_paths.
            let mut pattern_pks: HashSet<i64> = HashSet::new();
            for pats in &resolved.seed_path_pattern_pks { pattern_pks.extend(pats.iter().copied()); }
            // Deliberately NOT narrowed to the literal stops in the
            // margin-kept `paths` — those are a handful of discrete
            // backtracked stop SEQUENCES, not every stop the surviving
            // patterns actually run through. Narrowing stop_pks to just
            // those broke real routes whose correct boarding/alighting
            // stop simply wasn't the one a particular backtracked path
            // happened to record, even though the pattern itself was kept
            // (that stop's stop_times rows get filtered out downstream by
            // `stop_pk IN corridor_stop_pks` regardless of pattern_pks).
            // freq_raptor's own narrowing barely touches stops either (see
            // count.freq_narrowed_stop_pks vs corridor_stop_pks in past
            // runs) — patterns are where the real narrowing should happen,
            // stops should stay generous.
            let stop_pks: HashSet<i64> = full_allowed_stop_pks.clone();

            let best_score = resolved.seed_path_scores.iter().copied().filter(|&s| s < f64::MAX).fold(f64::MAX, f64::min);
            // depart_sec_of_day + best whole-trip estimate, same
            // "estimated best arrival sec-of-day" semantics
            // FreqNarrowResult's doc promises — kept meaningful here
            // rather than a placeholder, since freq_raptor.applied's
            // fallback-to-full logging below doesn't distinguish sources.
            let estimated_best_arrival_sec = if best_score < f64::MAX {
                depart_sec_of_day + best_score.round() as i64
            } else {
                depart_sec_of_day
            };

            timings.push(("count.seed_path_narrowed_pattern_pks".to_string(), pattern_pks.len() as i64));
            timings.push(("count.seed_path_narrowed_stop_pks".to_string(), stop_pks.len() as i64));

            if pattern_pks.is_empty() {
                // No margin-kept path at all — same "couldn't estimate,
                // fall back to unnarrowed" contract FreqNarrowResult's own
                // doc requires of freq_raptor::narrow_candidates.
                None
            } else {
                Some(freq_raptor::FreqNarrowResult { pattern_pks, stop_pks, estimated_best_arrival_sec })
            }
        } else if full_candidate_pattern_pks.len() >= FREQ_GRAPH_MIN_CANDIDATE_PATTERNS {
            // ── Frequency-graph pre-filter (freq_raptor.rs) ───────────────
            // Narrows the materialized candidate set using precomputed
            // hop-times/headways instead of real stop_times rows — see
            // freq_raptor.rs's module doc for the algorithm and the
            // pruning-safety margin reasoning. Gated by a size threshold:
            // below FREQ_GRAPH_MIN_CANDIDATE_PATTERNS there's nothing worth
            // narrowing, so this stage's own (small) overhead isn't worth
            // paying.
            let t = Instant::now();
            let r = freq_raptor::narrow_candidates(
                &resolved.pattern_pks, &full_allowed_stop_pks, &resolved.pattern_stop_rows,
                hops, headway, graph, stops, origin, destination, depart_sec_of_day, walking_speed_mps,
            );
            mark!(t, "freq_raptor_narrow");
            timings.push(("freq_raptor.applied".to_string(), r.is_some() as i64));
            if let Some(res) = &r {
                timings.push(("count.freq_narrowed_pattern_pks".to_string(), res.pattern_pks.len() as i64));
                timings.push(("count.freq_narrowed_stop_pks".to_string(), res.stop_pks.len() as i64));
            }
            r
        } else {
            None
        };

        // Pulled out so the freq-narrowed attempt and the unnarrowed
        // fallback attempt below share one code path instead of two
        // hand-maintained copies of the exact same query.
        let run_trips_for_candidates = |pattern_pks: &[i64]| -> rusqlite::Result<(HashSet<i64>, HashMap<i64, i64>, HashSet<i64>)> {
            let mut active_trip_pks: HashSet<i64> = HashSet::new();
            let mut pattern_keys_with_active_trip: HashSet<i64> = HashSet::new();
            let mut trip_pk_to_pattern: HashMap<i64, i64> = HashMap::new();
            if pattern_pks.is_empty() {
                return Ok((active_trip_pks, trip_pk_to_pattern, pattern_keys_with_active_trip));
            }
            // Staged into a temp table + JOIN instead of chunked IN(...) —
            // see this file's module-level PERF NOTE.
            stage_ids(conn, "candidate_pattern_pks", pattern_pks)?;
            let mut stmt = conn.prepare(
                "SELECT trip_pk, agency, pattern_pk, service_id \
                 FROM trips \
                 WHERE pattern_pk IN (SELECT id FROM candidate_pattern_pks)"
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))
            })?;
            for row in rows {
                let (trip_pk, agency, pattern_pk, service_id) = row?;
                if !active_services.contains(&(agency, service_id)) { continue; }
                active_trip_pks.insert(trip_pk);
                trip_pk_to_pattern.insert(trip_pk, pattern_pk);
                pattern_keys_with_active_trip.insert(pattern_pk);
            }
            Ok((active_trip_pks, trip_pk_to_pattern, pattern_keys_with_active_trip))
        };

        let t = Instant::now();
        let (active_trip_pks, trip_pk_to_pattern, pattern_keys_with_active_trip, allowed_stop_pks, candidate_pattern_pks) =
            if let Some(narrow) = &freq_narrow {
                let narrowed_patterns: Vec<i64> = narrow.pattern_pks.iter().copied().collect();
                let (a, t2p, p) = run_trips_for_candidates(&narrowed_patterns)?;
                if !p.is_empty() {
                    (a, t2p, p, narrow.stop_pks.clone(), narrowed_patterns)
                } else {
                    // CHEAP FALLBACK (see freq_raptor.rs's pruning-safety
                    // doc): the narrowed set had NO active service today —
                    // retry against the FULL materialized candidate set
                    // before reaching for the expensive batch_size-doubling
                    // retry below. This costs one more trips_for_candidates
                    // query against data already resident (no new BFS, no
                    // new corridor-resolution SQL) — cheap insurance
                    // against the frequency estimate having wrongly
                    // excluded the only patterns that actually run today,
                    // as distinct from BFS/batch_size genuinely not having
                    // found enough candidates (that failure mode still
                    // falls through to the existing retry below).
                    timings.push(("freq_raptor.fallback_to_full".to_string(), 1));
                    let (a, t2p, p) = run_trips_for_candidates(&full_candidate_pattern_pks)?;
                    (a, t2p, p, full_allowed_stop_pks.clone(), full_candidate_pattern_pks.clone())
                }
            } else {
                let (a, t2p, p) = run_trips_for_candidates(&full_candidate_pattern_pks)?;
                (a, t2p, p, full_allowed_stop_pks.clone(), full_candidate_pattern_pks.clone())
            };
        mark!(t, "trips_for_candidates");
        timings.push(("count.active_trip_pks".to_string(), active_trip_pks.len() as i64));

        // Nothing left to gain from a bigger batch once it already covers
        // every meeting node BFS found, or the ceiling is reached — stop
        // retrying and return whatever this (possibly still-empty)
        // attempt found, same as before the retry ladder existed.
        let exhausted = batch_size >= resolved.total_seed_meets_found || batch_size >= SEED_MEETS_RETRY_CEILING;

        if !pattern_keys_with_active_trip.is_empty() || exhausted {
            break (resolved, allowed_stop_pks, candidate_pattern_pks, active_trip_pks, pattern_keys_with_active_trip, trip_pk_to_pattern);
        }

        timings.push(("seed_batch_retry.from_batch_size".to_string(), batch_size as i64));
        batch_size = (batch_size * 2).min(SEED_MEETS_RETRY_CEILING);
    };

    if candidate_pattern_pks.is_empty() || pattern_keys_with_active_trip.is_empty() {
        mark!(t_total, "total");
        return Ok(empty_index(
            allowed_stop_pks, resolved.debug_seed_paths.clone(), resolved.debug_seed_path_depths.clone(), resolved.debug_bfs_levels.clone(),
            resolved.debug_corridor_boundary.clone(), timings,
        ));
    }

    let patterns_running_today: Vec<i64> = pattern_keys_with_active_trip.iter().copied().collect();

    // ── 4. pattern_stops for patterns running today ──────────────────────
    // Reuse resolver's already-fetched rows when available (normal
    // seed-path-derived path); only re-query on the bbox-fallback path.
    let t = Instant::now();
    let pattern_stop_rows: Vec<crate::repo::PatternStopRow> = if !resolved.pattern_stop_rows.is_empty() {
        resolved.pattern_stop_rows.iter()
            .filter(|r| pattern_keys_with_active_trip.contains(&r.pattern_pk))
            .cloned()
            .collect()
    } else {
        crate::repo::get_pattern_stops_for_patterns(conn, &patterns_running_today)?
    };

    let mut pattern_stops: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for r in &pattern_stop_rows {
        pattern_stops.entry(r.pattern_pk).or_default().push((r.stop_pk, r.stop_sequence));
    }

    // ── 5. Pattern + route metadata — straight from the preloaded caches ─
    let mut patterns_by_pk: HashMap<i64, PatternMetaFull> = HashMap::new();
    for &pk in &patterns_running_today {
        let Some(meta) = patterns.get(pk) else { continue };
        let route_info = meta.route_key.and_then(|rid| routes.info_by_id.get(rid as usize));
        let (route_name, route_type, route_color, route_text_color) = match route_info {
            Some(ri) => (
                if !ri.route_short_name.is_empty() { ri.route_short_name.clone() } else if !ri.route_long_name.is_empty() { ri.route_long_name.clone() } else { "?".to_string() },
                ri.route_type, ri.route_color.clone(), if ri.route_text_color.is_empty() { "#FFFFFF".to_string() } else { ri.route_text_color.clone() },
            ),
            None => ("?".to_string(), 3, String::new(), "#FFFFFF".to_string()),
        };
        patterns_by_pk.insert(pk, PatternMetaFull {
            agency: meta.agency, route_id: meta.route_id.clone(), shape_id: meta.shape_id.clone(),
            route_name, route_type, route_color, route_text_color,
        });
    }
    mark!(t, "pattern_stops_and_meta");

    // ── 6. Time-windowed stop_times ──────────────────────────────────────
    let t = Instant::now();
    let straight_line_m = haversine_meters(origin, destination);
    let distance_scaled_sec = (straight_line_m / 1000.0) * WINDOW_DISTANCE_SCALE_SEC_PER_KM + WINDOW_DISTANCE_BUFFER_SEC;
    let distance_based_window_sec = distance_scaled_sec.max(INITIAL_WINDOW_MIN_SEC).min(INITIAL_WINDOW_MAX_SEC);

    // See ENABLE_DURATION_BASED_WINDOW's doc — this is now AUTHORITATIVE
    // when available, not min'd against the distance heuristic. Min'ing
    // against distance defeated the one case this was meant to help: a
    // multi-transfer journey where a LATER leg's boarding (after a
    // transfer wait) falls past window_hi even though the first leg's
    // trips exist fine within a narrower window — raptor::run_search
    // returns Err (candidates.is_empty(), not "window empty") in exactly
    // that case, forcing the expensive 10hr retry. The duration estimate
    // already integrates walk+ride+wait across the WHOLE assembled path
    // (see score_seed_path), so it's naturally often LARGER than the
    // distance-only heuristic on a multi-transfer trip — that's the
    // useful case, not one to clamp away. Still floored at
    // INITIAL_WINDOW_MIN_SEC and capped at DURATION_WINDOW_MAX_SEC (a
    // separate, more generous ceiling than INITIAL_WINDOW_MAX_SEC, since
    // that one was sized for the distance heuristic's much cruder
    // estimate). Falls back to the distance heuristic only when no
    // duration estimate is available at all.
    let duration_based_window_sec: Option<f64> = if ENABLE_DURATION_BASED_WINDOW {
        let best_score = resolved.seed_path_scores.iter().copied().filter(|&s| s < f64::MAX).fold(f64::MAX, f64::min);
        if best_score < f64::MAX {
            let margin = margin_threshold(best_score, WINDOW_DURATION_MARGIN_FLOOR_SEC, WINDOW_DURATION_MARGIN_RELATIVE_PCT);
            Some((best_score + margin).max(INITIAL_WINDOW_MIN_SEC).min(DURATION_WINDOW_MAX_SEC))
        } else {
            None
        }
    } else {
        None
    };
    if let Some(d) = duration_based_window_sec {
        timings.push(("window.duration_based_sec".to_string(), d.round() as i64));
    }
    timings.push(("window.distance_based_sec".to_string(), distance_based_window_sec.round() as i64));

    let initial_window_sec = force_window_sec.map(|v| v as f64)
        .unwrap_or_else(|| duration_based_window_sec.unwrap_or(distance_based_window_sec));

    let mut window_stages: Vec<i64> = vec![initial_window_sec.round() as i64];
    window_stages.extend(WINDOW_WIDENING_STAGES_SEC.iter().copied());

    let corridor_stop_pks: Vec<i64> = allowed_stop_pks.iter().copied().collect();
    // Staged ONCE before the window-widening loop below — the corridor
    // stop set doesn't change across widening stages, only the time
    // window does, so there's no reason to re-stage per stage.
    let t_stage_corridor = Instant::now();
    stage_ids(conn, "corridor_stop_pks", &corridor_stop_pks)?;
    mark!(t_stage_corridor, "stage_corridor_stop_pks");

    // Surfaces which side of the settings::USE_SQL_ACTIVE_TRIP_FILTER A/B
    // this run took, right in the stage-timings log line — not a real
    // duration, just piggybacking on the existing (label, i64) timings
    // format so it shows up as active_trip_filter_sql=1|0 without needing
    // a second log statement.
    timings.push(("active_trip_filter_sql".to_string(), crate::settings::USE_SQL_ACTIVE_TRIP_FILTER as i64));

    // See settings::USE_SQL_ACTIVE_TRIP_FILTER's doc — this is the other
    // half of the A/B: stage active_trip_pks too, and let SQLite filter on
    // it directly instead of fetching every windowed row and checking a
    // Rust HashSet per row.
    if crate::settings::USE_SQL_ACTIVE_TRIP_FILTER {
        let active_trip_pks_vec: Vec<i64> = active_trip_pks.iter().copied().collect();
        let t_stage_active = Instant::now();
        stage_ids(conn, "active_trip_pks_staged", &active_trip_pks_vec)?;
        mark!(t_stage_active, "stage_active_trip_pks");
    }

    // Per-widening-stage sub-timings — surfaced separately from the total
    // below so a slow discovery+fetch can be traced to EITHER "the first
    // (narrowest) window attempt is just slow" (query/index problem, same
    // cost regardless of how many stages run) OR "we're paying for 2-3
    // widening attempts because the initial window kept coming up empty"
    // (a tuning problem in INITIAL_WINDOW_*/WINDOW_WIDENING_STAGES_SEC, not
    // a query-speed problem). Previously only the sum across every attempt
    // was visible, which conflated those two very different root causes.
    //
    // MERGED with stop_times_fetch (previously a separate step below):
    // both queries were doing the exact same
    // `stop_pk IN corridor ∧ departure_sec BETWEEN ∧ trip_pk IN active`
    // scan — discovery to get just trip_pk, then fetch to get full rows
    // for those trip_pks. On the common case (the first/narrowest window
    // already finds trips — true for the large majority of searches),
    // that's the same corridor+window scan done twice for no reason. Now
    // each attempt fetches full rows directly; windowed_trip_pks (used
    // only for logging/the no-service check) is derived from the result
    // set's distinct trip_pks instead of a separate query. The widening
    // loop still only exists to retry with a wider window when an attempt
    // comes back empty, so nothing is wasted on the (rare) widening path
    // either — an empty attempt fetches zero rows either way.
    let mut stop_times_by_stop: HashMap<i64, Vec<Rc<StopTimeEntry>>> = HashMap::new();
    let mut stop_times_by_stop_and_pattern: HashMap<(i64, i64), Vec<Rc<StopTimeEntry>>> = HashMap::new();
    let mut stop_times_by_stop_and_trip: HashMap<i64, HashMap<i64, Rc<StopTimeEntry>>> = HashMap::new();
    let mut windowed_trip_pks: HashSet<i64> = HashSet::new();
    let mut stages_tried: i64 = 0;
    let mut rows_returned_total: i64 = 0;
    for &window_sec in &window_stages {
        let t_stage = Instant::now();
        stages_tried += 1;
        let window_lo = (depart_sec_of_day - WINDOW_BOARD_BUFFER_SEC).max(0);
        let window_hi = depart_sec_of_day + window_sec;

        stop_times_by_stop.clear();
        stop_times_by_stop_and_pattern.clear();
        stop_times_by_stop_and_trip.clear();
        windowed_trip_pks.clear();
        let mut rows_returned: i64 = 0;

        // stop_pk IN (corridor_stop_pks) filters in SQL instead of after
        // fetching: a trip's full stop sequence can run well outside a
        // narrow corridor (system-wide route vs. a slice of it), so
        // without this, every out-of-corridor stop would still get
        // decoded into a StopTimeEntry and thrown away below.
        //
        // departure_sec BETWEEN matters because stop_times' PRIMARY KEY
        // is (stop_pk, departure_sec, trip_pk, stop_sequence) — without
        // this bound, the stop_pk IN (...) seek has to walk EVERY
        // stop_time for each of potentially thousands of corridor stops
        // across the whole day before trip_pk gets a chance to filter
        // anything out. With it, each per-stop seek is a bounded range
        // scan instead.
        if crate::settings::USE_SQL_ACTIVE_TRIP_FILTER {
            let mut stmt = conn.prepare(
                "SELECT trip_pk, stop_pk, stop_sequence, arrival_sec, departure_sec, pickup_type, drop_off_type \
                 FROM stop_times \
                 WHERE stop_pk IN (SELECT id FROM corridor_stop_pks) \
                 AND departure_sec BETWEEN ?1 AND ?2 \
                 AND trip_pk IN (SELECT id FROM active_trip_pks_staged)"
            )?;
            let rows = stmt.query_map([window_lo, window_hi], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?))
            })?;
            for row in rows {
                rows_returned += 1;
                let (trip_pk, stop_pk, stop_sequence, arrival_sec, departure_sec, pickup_type, drop_off_type) = row?;
                windowed_trip_pks.insert(trip_pk);
                let Some(&pattern_pk) = trip_pk_to_pattern.get(&trip_pk) else { continue };
                let entry = Rc::new(StopTimeEntry { trip_pk, pattern_pk, stop_sequence, arrival_sec, departure_sec, pickup_type, drop_off_type });
                stop_times_by_stop.entry(stop_pk).or_default().push(Rc::clone(&entry));
                stop_times_by_stop_and_pattern.entry((stop_pk, pattern_pk)).or_default().push(Rc::clone(&entry));
                stop_times_by_stop_and_trip.entry(stop_pk).or_default().insert(trip_pk, entry);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT trip_pk, stop_pk, stop_sequence, arrival_sec, departure_sec, pickup_type, drop_off_type \
                 FROM stop_times \
                 WHERE stop_pk IN (SELECT id FROM corridor_stop_pks) \
                 AND departure_sec BETWEEN ?1 AND ?2"
            )?;
            let rows = stmt.query_map([window_lo, window_hi], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?))
            })?;
            for row in rows {
                let (trip_pk, stop_pk, stop_sequence, arrival_sec, departure_sec, pickup_type, drop_off_type) = row?;
                if !active_trip_pks.contains(&trip_pk) { continue; }
                rows_returned += 1;
                windowed_trip_pks.insert(trip_pk);
                let Some(&pattern_pk) = trip_pk_to_pattern.get(&trip_pk) else { continue };
                let entry = Rc::new(StopTimeEntry { trip_pk, pattern_pk, stop_sequence, arrival_sec, departure_sec, pickup_type, drop_off_type });
                stop_times_by_stop.entry(stop_pk).or_default().push(Rc::clone(&entry));
                stop_times_by_stop_and_pattern.entry((stop_pk, pattern_pk)).or_default().push(Rc::clone(&entry));
                stop_times_by_stop_and_trip.entry(stop_pk).or_default().insert(trip_pk, entry);
            }
        }
        rows_returned_total = rows_returned;
        mark!(t_stage, format!("windowed_discovery_and_fetch.attempt{stages_tried}_window{window_sec}s_trips{}_rows{}", windowed_trip_pks.len(), rows_returned));
        if !windowed_trip_pks.is_empty() { break; }
    }
    mark!(t, "windowed_discovery_and_fetch");
    timings.push(("windowed_trip_discovery.stages_tried".to_string(), stages_tried));
    timings.push(("count.windowed_trip_pks".to_string(), windowed_trip_pks.len() as i64));
    timings.push(("count.stop_times_rows_returned".to_string(), rows_returned_total));
    timings.push(("count.stop_times_distinct_stops".to_string(), stop_times_by_stop.len() as i64));

    let no_service_found = windowed_trip_pks.is_empty();
    if no_service_found {
        mark!(t_total, "total");
        return Ok(GtfsIndex {
            allowed_stop_pks, patterns_by_pk, pattern_stops,
            stop_times_by_stop: HashMap::new(), stop_times_by_stop_and_pattern: HashMap::new(), stop_times_by_stop_and_trip: HashMap::new(),
            no_service_found: true,
            debug_seed_paths: resolved.debug_seed_paths.clone(), debug_seed_path_depths: resolved.debug_seed_path_depths.clone(), debug_bfs_levels: resolved.debug_bfs_levels.clone(),
            debug_corridor_boundary: resolved.debug_corridor_boundary.clone(),
            seed_path_pattern_pks: resolved.seed_path_pattern_pks.clone(), seed_path_scores: resolved.seed_path_scores.clone(),
            seed_path_edges: resolved.seed_path_edges.clone(),
            timings,
        });
    }

    let t = Instant::now();
    for v in stop_times_by_stop.values_mut() {
        v.sort_by_key(|e| e.departure_sec);
    }
    for v in stop_times_by_stop_and_pattern.values_mut() {
        v.sort_by_key(|e| e.departure_sec);
    }
    mark!(t, "stop_times_sort");
    mark!(t_total, "total");

    Ok(GtfsIndex {
        allowed_stop_pks, patterns_by_pk, pattern_stops,
        stop_times_by_stop, stop_times_by_stop_and_pattern, stop_times_by_stop_and_trip, no_service_found: false,
        debug_seed_paths: resolved.debug_seed_paths.clone(), debug_seed_path_depths: resolved.debug_seed_path_depths.clone(), debug_bfs_levels: resolved.debug_bfs_levels.clone(),
        debug_corridor_boundary: resolved.debug_corridor_boundary.clone(),
        seed_path_pattern_pks: resolved.seed_path_pattern_pks.clone(), seed_path_scores: resolved.seed_path_scores.clone(),
        seed_path_edges: resolved.seed_path_edges.clone(),
        timings,
    })
}
