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
use std::time::Instant;
use rusqlite::Connection;
use crate::geo::{haversine_meters, LatLon};
use crate::graph::coarse::CoarseGraph;
use crate::repo::{PatternsCache, RoutesCache, StopsCache};
use crate::corridor::resolver::{resolve_corridor, CorridorCache};
use crate::corridor::tagging::CorridorBoundary;
use crate::settings::{
    INITIAL_WINDOW_MAX_SEC, INITIAL_WINDOW_MIN_SEC, WINDOW_BOARD_BUFFER_SEC,
    WINDOW_DISTANCE_BUFFER_SEC, WINDOW_DISTANCE_SCALE_SEC_PER_KM, WINDOW_WIDENING_STAGES_SEC,
};

const DOW_COLUMNS: [&str; 7] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

#[derive(Debug, Clone)]
pub struct StopTimeEntry {
    pub trip_pk: i64,
    pub pattern_pk: i64,
    pub stop_sequence: i64,
    pub arrival_sec: i64,
    pub departure_sec: i64,
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
    pub stop_times_by_stop: HashMap<i64, Vec<StopTimeEntry>>, // sorted by departure_sec
    pub stop_times_by_stop_and_trip: HashMap<i64, HashMap<i64, StopTimeEntry>>,
    pub no_service_found: bool,
    pub debug_seed_paths: Vec<Vec<i64>>,
    pub debug_bfs_levels: Vec<Vec<i64>>,
    pub debug_bfs_tree_edges: Vec<(i64, i64)>,
    pub debug_corridor_boundary: Vec<CorridorBoundary>,
    /// (label, elapsed_ms) for each stage — diagnostic only, surfaced to
    /// JS via RouteResult.timings for A/B profiling against gtfsLoader.ts's
    /// own console.log breakdown.
    pub timings: Vec<(String, i64)>,
}

fn empty_index(allowed_stop_pks: HashSet<i64>, debug_seed_paths: Vec<Vec<i64>>, debug_bfs_levels: Vec<Vec<i64>>, debug_bfs_tree_edges: Vec<(i64, i64)>, debug_corridor_boundary: Vec<CorridorBoundary>, timings: Vec<(String, i64)>) -> GtfsIndex {
    GtfsIndex {
        allowed_stop_pks, patterns_by_pk: HashMap::new(), pattern_stops: HashMap::new(),
        stop_times_by_stop: HashMap::new(), stop_times_by_stop_and_trip: HashMap::new(),
        no_service_found: true, debug_seed_paths, debug_bfs_levels, debug_bfs_tree_edges, debug_corridor_boundary, timings,
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
fn stage_ids(conn: &Connection, table_name: &str, ids: &[i64]) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TEMP TABLE IF NOT EXISTS {table_name} (id INTEGER PRIMARY KEY)"
    ))?;
    conn.execute_batch("BEGIN")?;
    conn.execute(&format!("DELETE FROM {table_name}"), [])?;
    {
        let mut stmt = conn.prepare(&format!("INSERT INTO {table_name} (id) VALUES (?1)"))?;
        for id in ids {
            stmt.execute([id])?;
        }
    }
    conn.execute_batch("COMMIT")?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn load_gtfs_index_for_trip(
    conn: &Connection,
    stops: &StopsCache,
    patterns: &PatternsCache,
    routes: &RoutesCache,
    graph: &CoarseGraph,
    corridor_cache: &mut CorridorCache,
    origin: LatLon,
    destination: LatLon,
    depart_sec_of_day: i64,
    today_date: &str,   // YYYYMMDD
    today_dow: u8,      // 0=Sunday..6=Saturday, matches JS Date.getDay()
    tomorrow_date: &str,
    tomorrow_dow: u8,
    force_window_sec: Option<i64>,
) -> rusqlite::Result<GtfsIndex> {
    let t_total = Instant::now();
    let mut timings: Vec<(String, i64)> = Vec::new();
    macro_rules! mark {
        ($t:expr, $label:expr) => {
            timings.push(($label.to_string(), $t.elapsed().as_millis() as i64));
        };
    }

    // ── 1. Corridor -> candidate patterns + stops ───────────────────────
    let t = Instant::now();
    let resolved = resolve_corridor(conn, stops, patterns, graph, corridor_cache, origin, destination)?;
    mark!(t, "corridor_resolution");
    for (label, ms) in &resolved.sub_timings {
        timings.push((format!("corridor.{label}"), *ms));
    }

    let allowed_stop_pks = resolved.allowed_stop_pks.clone();
    let candidate_pattern_pks: Vec<i64> = resolved.pattern_pks.iter().copied().collect();

    if candidate_pattern_pks.is_empty() {
        mark!(t_total, "total");
        return Ok(empty_index(
            allowed_stop_pks, resolved.debug_seed_paths.clone(), resolved.debug_bfs_levels.clone(),
            resolved.debug_bfs_tree_edges.clone(), resolved.debug_corridor_boundary.clone(), timings,
        ));
    }

    // ── 2. Active service_ids for TODAY and TOMORROW ────────────────────
    // A search close to midnight can need trips only active under
    // tomorrow's calendar entry — same reasoning as the TS version.
    let t = Instant::now();
    let mut active_services: HashSet<(i64, String)> = HashSet::new();
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
                active_services.insert((agency, service_id));
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
                if exception_type == 1 { active_services.insert(key); }
                else if exception_type == 2 { active_services.remove(&key); }
            }
        }
    }

    mark!(t, "active_services");

    // ── 3. Trips for candidate patterns, filtered to active services ────
    // Staged into a temp table + JOIN instead of chunked IN(...) — see
    // this file's module-level PERF NOTE.
    let t = Instant::now();
    stage_ids(conn, "candidate_pattern_pks", &candidate_pattern_pks)?;

    let mut active_trip_pks: HashSet<i64> = HashSet::new();
    let mut pattern_keys_with_active_trip: HashSet<i64> = HashSet::new();
    // trip_pk -> pattern_pk (agency implicit via pattern; not needed further)
    let mut trip_pk_to_pattern: HashMap<i64, i64> = HashMap::new();

    {
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
    }
    mark!(t, "trips_for_candidates");

    if pattern_keys_with_active_trip.is_empty() {
        mark!(t_total, "total");
        return Ok(empty_index(
            allowed_stop_pks, resolved.debug_seed_paths.clone(), resolved.debug_bfs_levels.clone(),
            resolved.debug_bfs_tree_edges.clone(), resolved.debug_corridor_boundary.clone(), timings,
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
    let initial_window_sec = force_window_sec.map(|v| v as f64)
        .unwrap_or_else(|| distance_scaled_sec.max(INITIAL_WINDOW_MIN_SEC).min(INITIAL_WINDOW_MAX_SEC));

    let mut window_stages: Vec<i64> = vec![initial_window_sec.round() as i64];
    window_stages.extend(WINDOW_WIDENING_STAGES_SEC.iter().copied());

    let corridor_stop_pks: Vec<i64> = allowed_stop_pks.iter().copied().collect();
    // Staged ONCE before the window-widening loop below — the corridor
    // stop set doesn't change across widening stages, only the time
    // window does, so there's no reason to re-stage per stage.
    stage_ids(conn, "corridor_stop_pks", &corridor_stop_pks)?;

    let mut windowed_trip_pks: HashSet<i64> = HashSet::new();
    for &window_sec in &window_stages {
        let window_lo = (depart_sec_of_day - WINDOW_BOARD_BUFFER_SEC).max(0);
        let window_hi = depart_sec_of_day + window_sec;

        windowed_trip_pks.clear();
        {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT trip_pk FROM stop_times \
                 WHERE stop_pk IN (SELECT id FROM corridor_stop_pks) \
                 AND departure_sec BETWEEN ?1 AND ?2"
            )?;
            let rows = stmt.query_map([window_lo, window_hi], |r| Ok(r.get::<_, i64>(0)?))?;
            for row in rows {
                let trip_pk = row?;
                if active_trip_pks.contains(&trip_pk) {
                    windowed_trip_pks.insert(trip_pk);
                }
            }
        }
        if !windowed_trip_pks.is_empty() { break; }
    }
    mark!(t, "windowed_trip_discovery");

    let no_service_found = windowed_trip_pks.is_empty();
    if no_service_found {
        mark!(t_total, "total");
        return Ok(GtfsIndex {
            allowed_stop_pks, patterns_by_pk, pattern_stops,
            stop_times_by_stop: HashMap::new(), stop_times_by_stop_and_trip: HashMap::new(),
            no_service_found: true,
            debug_seed_paths: resolved.debug_seed_paths.clone(), debug_bfs_levels: resolved.debug_bfs_levels.clone(),
            debug_bfs_tree_edges: resolved.debug_bfs_tree_edges.clone(), debug_corridor_boundary: resolved.debug_corridor_boundary.clone(),
            timings,
        });
    }

    let corridor_stop_set: HashSet<i64> = allowed_stop_pks.iter().copied().collect();
    let windowed_trip_vec: Vec<i64> = windowed_trip_pks.into_iter().collect();

    // Staged into a temp table + JOIN instead of chunked IN(...) — the
    // costliest of the three (up to ~7500 pks in earlier profiling runs,
    // ~19 chunked queries before this fix vs. 1 staged JOIN now).
    let t = Instant::now();
    stage_ids(conn, "windowed_trip_pks", &windowed_trip_vec)?;

    let mut stop_times_by_stop: HashMap<i64, Vec<StopTimeEntry>> = HashMap::new();
    let mut stop_times_by_stop_and_trip: HashMap<i64, HashMap<i64, StopTimeEntry>> = HashMap::new();

    let t = Instant::now();
    {
        let mut stmt = conn.prepare(
            "SELECT trip_pk, stop_pk, stop_sequence, arrival_sec, departure_sec \
             FROM stop_times \
             WHERE trip_pk IN (SELECT id FROM windowed_trip_pks)"
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))
        })?;
        for row in rows {
            let (trip_pk, stop_pk, stop_sequence, arrival_sec, departure_sec) = row?;
            if !corridor_stop_set.contains(&stop_pk) { continue; }
            let Some(&pattern_pk) = trip_pk_to_pattern.get(&trip_pk) else { continue };
            let entry = StopTimeEntry { trip_pk, pattern_pk, stop_sequence, arrival_sec, departure_sec };
            stop_times_by_stop.entry(stop_pk).or_default().push(entry.clone());
            stop_times_by_stop_and_trip.entry(stop_pk).or_default().insert(trip_pk, entry);
        }
    }
    mark!(t, "stop_times_fetch");

    let t = Instant::now();
    for v in stop_times_by_stop.values_mut() {
        v.sort_by_key(|e| e.departure_sec);
    }
    mark!(t, "stop_times_sort");
    mark!(t_total, "total");

    Ok(GtfsIndex {
        allowed_stop_pks, patterns_by_pk, pattern_stops,
        stop_times_by_stop, stop_times_by_stop_and_trip, no_service_found: false,
        debug_seed_paths: resolved.debug_seed_paths.clone(), debug_bfs_levels: resolved.debug_bfs_levels.clone(),
        debug_bfs_tree_edges: resolved.debug_bfs_tree_edges.clone(), debug_corridor_boundary: resolved.debug_corridor_boundary.clone(),
        timings,
    })
}
