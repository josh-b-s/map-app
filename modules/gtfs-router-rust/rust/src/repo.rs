//! repo.rs — port of services/gtfs/core/gtfsRepo.ts.
//!
//! DESIGN CHANGE FROM THE TS VERSION: gtfsRepo.ts exists mainly to translate
//! SQLite's integer surrogate pks into the (agency, real-id) composite
//! string keys the rest of the JS app thinks in, because the JS side never
//! had a cheap way to carry raw pks across the app. Rust has no such
//! constraint — it reads straight from SQLite — so this port drops the
//! composite-string-key layer entirely and threads `i64` pks through the
//! graph/corridor/raptor modules directly. That removes a string
//! allocation + hash per lookup in what were the hottest loops in the JS
//! version (coarse graph build, RAPTOR rounds).
//!
//! `stop_pk` / `pattern_pk` / `trip_pk` / `shape_pk` are assigned
//! contiguously starting at 1, carried across agencies via `PkOffsets` in
//! the importer (see import.rs) — so a dense `Vec<Option<T>>` indexed by
//! `pk as usize` is a valid O(1) lookup, cheaper than a HashMap. If the
//! importer ever stops guaranteeing contiguous pks, these caches need to
//! fall back to a HashMap instead.

use std::collections::{HashMap, HashSet};
use rusqlite::Connection;
use crate::geo::{haversine_meters, LatLon};
use crate::settings::ASSUMED_TRANSIT_SPEED_MPS;

/// Must match preprocess-gtfs.ts / import.rs's own coordinate packing.
pub const COORD_SCALE: f64 = 1_000_000.0;

const SQL_CHUNK_SIZE: usize = 400;

// ── Stops ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct StopRow {
    pub stop_pk: i64,
    pub stop_id: String,
    pub stop_name: String,
    pub stop_lat: f64, // unpacked real degrees
    pub stop_lon: f64,
    pub agency: i64,
}

pub struct StopsCache {
    by_pk: Vec<Option<StopRow>>, // index 0 unused, index = stop_pk
    count: usize,
}

impl StopsCache {
    pub fn get(&self, pk: i64) -> Option<&StopRow> {
        if pk < 0 { return None; }
        self.by_pk.get(pk as usize).and_then(|o| o.as_ref())
    }

    pub fn iter(&self) -> impl Iterator<Item = &StopRow> {
        self.by_pk.iter().filter_map(|o| o.as_ref())
    }

    pub fn len(&self) -> usize {
        self.count
    }
}

/// Bbox query against stops_rtree (see schema.sql's comment on that
/// table) — bounds must already be in the same scaled-integer units as
/// stops.stop_lat/stop_lon (geo::bbox_scaled produces this directly).
/// Returns candidate stop_pks whose point falls in the box; the caller
/// still needs to refine with a real haversine check, since a bbox is a
/// rectangle, not the circle the caller actually wants.
pub fn nearest_stop_pks_in_bbox(
    conn: &Connection,
    min_lat: i64, max_lat: i64,
    min_lon: i64, max_lon: i64,
) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT stop_pk FROM stops_rtree \
         WHERE min_lat >= ?1 AND max_lat <= ?2 \
         AND min_lon >= ?3 AND max_lon <= ?4"
    )?;
    let rows = stmt.query_map([min_lat, max_lat, min_lon, max_lon], |r| r.get::<_, i64>(0))?;
    rows.collect()
}

pub fn load_stops(conn: &Connection) -> rusqlite::Result<StopsCache> {
    let mut stmt = conn.prepare(
        "SELECT stop_pk, stop_id, stop_name, stop_lat, stop_lon, agency FROM stops",
    )?;
    let mut max_pk: i64 = 0;
    let mut rows: Vec<StopRow> = Vec::new();
    let mapped = stmt.query_map([], |r| {
        Ok(StopRow {
            stop_pk: r.get(0)?,
            stop_id: r.get(1)?,
            stop_name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            stop_lat: r.get::<_, i64>(3)? as f64 / COORD_SCALE,
            stop_lon: r.get::<_, i64>(4)? as f64 / COORD_SCALE,
            agency: r.get(5)?,
        })
    })?;
    for row in mapped {
        let row = row?;
        if row.stop_pk > max_pk { max_pk = row.stop_pk; }
        rows.push(row);
    }
    let mut by_pk: Vec<Option<StopRow>> = (0..=max_pk).map(|_| None).collect();
    let count = rows.len();
    for row in rows {
        let pk = row.stop_pk as usize;
        by_pk[pk] = Some(row);
    }
    Ok(StopsCache { by_pk, count })
}

// ── Routes (interned into small integer ids for cheap Set/HashMap use) ────

pub type RouteId = u32;

#[derive(Debug, Clone)]
pub struct RouteInfo {
    pub route_short_name: String,
    pub route_long_name: String,
    pub route_type: i64,
    pub route_color: String,
    pub route_text_color: String,
}

pub struct RoutesCache {
    pub info_by_id: Vec<RouteInfo>,       // indexed by RouteId
    pub id_by_key: HashMap<(i64, String), RouteId>, // (agency, route_id) -> RouteId
}

pub fn load_routes(conn: &Connection) -> rusqlite::Result<RoutesCache> {
    let mut stmt = conn.prepare(
        "SELECT route_id, agency, route_short_name, route_long_name, route_type, route_color, route_text_color FROM routes",
    )?;
    let mut info_by_id = Vec::new();
    let mut id_by_key = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            r.get::<_, Option<i64>>(4)?.unwrap_or(3),
            r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            r.get::<_, Option<String>>(6)?.unwrap_or_default(),
        ))
    })?;
    for row in rows {
        let (route_id, agency, short, long, rtype, color, text_color) = row?;
        let id = info_by_id.len() as RouteId;
        info_by_id.push(RouteInfo {
            route_short_name: short,
            route_long_name: long,
            route_type: rtype,
            route_color: color,
            route_text_color: text_color,
        });
        id_by_key.insert((agency, route_id), id);
    }
    Ok(RoutesCache { info_by_id, id_by_key })
}

// ── Patterns ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PatternMeta {
    pub agency: i64,
    pub route_id: String,
    pub shape_id: Option<String>,
    pub route_key: Option<RouteId>,
}

pub struct PatternsCache {
    by_pk: Vec<Option<PatternMeta>>, // index = pattern_pk
}

impl PatternsCache {
    pub fn get(&self, pk: i64) -> Option<&PatternMeta> {
        if pk < 0 { return None; }
        self.by_pk.get(pk as usize).and_then(|o| o.as_ref())
    }
}

pub fn load_patterns(conn: &Connection, routes: &RoutesCache) -> rusqlite::Result<PatternsCache> {
    let mut stmt = conn.prepare("SELECT pattern_pk, route_id, agency, shape_id FROM patterns")?;
    let mut max_pk: i64 = 0;
    let mut rows = Vec::new();
    let mapped = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    for row in mapped {
        let (pk, route_id, agency, shape_id) = row?;
        if pk > max_pk { max_pk = pk; }
        rows.push((pk, route_id, agency, shape_id));
    }
    let mut by_pk: Vec<Option<PatternMeta>> = (0..=max_pk).map(|_| None).collect();
    for (pk, route_id, agency, shape_id) in rows {
        let route_key = routes.id_by_key.get(&(agency, route_id.clone())).copied();
        by_pk[pk as usize] = Some(PatternMeta { agency, route_id, shape_id, route_key });
    }
    Ok(PatternsCache { by_pk })
}

/// Every pattern pk in the DB — used only by a "no corridor" full-network
/// comparison baseline, mirroring gtfsLoader.ts's skipCorridorScoping path.
pub fn all_pattern_pks(patterns: &PatternsCache) -> Vec<i64> {
    patterns.by_pk.iter().enumerate()
        .filter_map(|(pk, m)| m.as_ref().map(|_| pk as i64))
        .collect()
}

// ── pattern_stops ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PatternStopRow {
    pub pattern_pk: i64,
    pub stop_pk: i64,
    pub stop_sequence: i64,
}

fn chunked_in_i64<T>(
    conn: &Connection,
    ids: &[i64],
    sql_prefix: &str,
    sql_suffix: &str,
    mut row_fn: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    let mut out = Vec::new();
    for chunk in ids.chunks(SQL_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!("{sql_prefix} ({placeholders}) {sql_suffix}");
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params.as_slice(), &mut row_fn)?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// pattern_stops rows for the given pattern pks, ordered by pattern then
/// sequence — the whole sequence per pattern (not corridor-filtered), same
/// as getPatternStopsForPatternKeys.
pub fn get_pattern_stops_for_patterns(
    conn: &Connection,
    pattern_pks: &[i64],
) -> rusqlite::Result<Vec<PatternStopRow>> {
    if pattern_pks.is_empty() { return Ok(Vec::new()); }
    let mut out = chunked_in_i64(
        conn, pattern_pks,
        "SELECT pattern_pk, stop_pk, stop_sequence FROM pattern_stops WHERE pattern_pk IN",
        "ORDER BY pattern_pk, stop_sequence",
        |r| Ok(PatternStopRow { pattern_pk: r.get(0)?, stop_pk: r.get(1)?, stop_sequence: r.get(2)? }),
    )?;
    out.sort_by(|a, b| a.pattern_pk.cmp(&b.pattern_pk).then(a.stop_sequence.cmp(&b.stop_sequence)));
    Ok(out)
}

/// Every pattern_stops row in the whole DB, ordered by pattern then
/// sequence — used by graph::coarse's from-scratch build.
pub fn get_all_pattern_stops_ordered(conn: &Connection) -> rusqlite::Result<Vec<PatternStopRow>> {
    let mut stmt = conn.prepare(
        "SELECT pattern_pk, stop_pk, stop_sequence FROM pattern_stops ORDER BY pattern_pk, stop_sequence",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PatternStopRow { pattern_pk: r.get(0)?, stop_pk: r.get(1)?, stop_sequence: r.get(2)? })
    })?;
    let mut out = Vec::new();
    for row in rows { out.push(row?); }
    Ok(out)
}

/// Which pattern pks touch ANY of the given stop pks.
pub fn get_pattern_pks_for_stops(conn: &Connection, stop_pks: &[i64]) -> rusqlite::Result<HashSet<i64>> {
    if stop_pks.is_empty() { return Ok(HashSet::new()); }
    let rows: Vec<i64> = chunked_in_i64(
        conn, stop_pks,
        "SELECT DISTINCT pattern_pk FROM pattern_stops WHERE stop_pk IN",
        "",
        |r| r.get(0),
    )?;
    Ok(rows.into_iter().collect())
}

/// Which PATTERNS (not routes) serve each of the given stop pks — one bulk
/// query. Used by corridor seed selection to skip a stop that adds no new
/// pattern to the seed set. Deliberately pattern_pk-granularity rather than
/// route-level: two patterns can share the same route number (e.g. inbound
/// vs outbound, an express vs all-stops variant) while genuinely diverging
/// in which stops they serve, so collapsing to "same route" risks discarding
/// a farther stop that's actually the ONLY seed for a pattern the closer
/// stop doesn't serve at all — the closer stop "covering" that route number
/// wouldn't mean it covers that specific ride. Same rows the old route-level
/// version queried; just not collapsed through PatternsCache.route_key.
pub fn get_patterns_by_stop(
    conn: &Connection,
    stop_pks: &[i64],
) -> rusqlite::Result<HashMap<i64, HashSet<i64>>> {
    if stop_pks.is_empty() { return Ok(HashMap::new()); }
    let rows: Vec<(i64, i64)> = chunked_in_i64(
        conn, stop_pks,
        "SELECT DISTINCT stop_pk, pattern_pk FROM pattern_stops WHERE stop_pk IN",
        "",
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut out: HashMap<i64, HashSet<i64>> = HashMap::new();
    for (stop_pk, pattern_pk) in rows {
        out.entry(stop_pk).or_default().insert(pattern_pk);
    }
    Ok(out)
}

// ── Network-wide cumulative pattern-time cache ────────────────────────────
// Resident, same tier as CoarseGraph — NOT corridor-scoped like
// freq_raptor's own (now-removed) per-search PatternProfile building. Exists
// because CoarseGraph's transit edges are a clique/stride-sampled
// simplification (see graph/coarse.rs's flush_pattern): an edge from stop i
// to stop j on a pattern can skip real intermediate stops, so "real travel
// time for this one edge" isn't recoverable from the edge alone — it needs
// each stop's cumulative position within the pattern's real ordered
// sequence. rank_meets (seed_bfs.rs) needs exactly this to score a meeting
// node by real hop-time instead of straight-line distance, and freq_raptor
// needs it too (previously rebuilt from scratch, corridor-scoped, on every
// search — this cache lets it do a flat O(1) lookup instead).
//
// Built once at warm_up from the SAME already-fetched `pattern_stops` rows
// CoarseGraph's from-scratch build already uses (`get_all_pattern_stops_
// ordered`), combined with PatternHopsCache — no new SQL at all, this is
// pure computation over data warm_up already has in hand. See lib.rs's
// warm_up: that fetch now always runs, not only inside the persisted-
// graph-miss branch, specifically so this cache can reuse it.
pub struct PatternCumulativeCache {
    // (pattern_pk, stop_pk) -> cumulative_sec from that pattern's first
    // stop. Flat rather than nested per-pattern maps — this gets looked up
    // inside BFS-scale traversals (seed_bfs.rs) and freq_raptor's round
    // loop, both of which want O(1) without an extra per-pattern
    // indirection.
    by_pattern_stop: HashMap<(i64, i64), i64>,
}

impl PatternCumulativeCache {
    pub fn cumulative_sec(&self, pattern_pk: i64, stop_pk: i64) -> Option<i64> {
        self.by_pattern_stop.get(&(pattern_pk, stop_pk)).copied()
    }
}

/// Shared by `load_pattern_cumulative` (network-wide, called once at
/// warm_up) — the one place this cumulative-sum-with-fallback logic
/// lives now; freq_raptor.rs previously had its own private copy of this
/// exact computation, scoped per-search, now removed in favor of
/// consulting this resident cache directly.
fn build_cumulative_for_pattern(
    rows: &[&PatternStopRow], // one pattern's rows, already sorted by stop_sequence
    hops: &PatternHopsCache,
    stops: &StopsCache,
    out: &mut HashMap<(i64, i64), i64>,
) {
    if rows.is_empty() { return; }
    let pattern_pk = rows[0].pattern_pk;
    let hop_by_seq: HashMap<i64, i64> = hops.hops_for(pattern_pk).iter().copied().collect();

    let mut cum = 0i64;
    out.insert((pattern_pk, rows[0].stop_pk), 0);
    for w in rows.windows(2) {
        let (from, to) = (w[0], w[1]);
        let hop_sec = hop_by_seq.get(&from.stop_sequence).copied().unwrap_or_else(|| {
            // No precomputed sample for this hop — fall back to straight-
            // line distance at ASSUMED_TRANSIT_SPEED_MPS, same reasoning
            // as freq_raptor.rs previously documented: treating a data
            // gap as a FREE hop (0 sec) would bias that pattern to look
            // artificially fast to whichever consumer is scoring it.
            let (Some(a), Some(b)) = (stops.get(from.stop_pk), stops.get(to.stop_pk)) else { return 0 };
            let d = haversine_meters(
                LatLon { lat: a.stop_lat, lon: a.stop_lon },
                LatLon { lat: b.stop_lat, lon: b.stop_lon },
            );
            (d / ASSUMED_TRANSIT_SPEED_MPS).round() as i64
        });
        cum += hop_sec.max(0);
        out.insert((pattern_pk, to.stop_pk), cum);
    }
}

pub fn load_pattern_cumulative(
    pattern_stop_rows: &[PatternStopRow], // already ORDER BY pattern_pk, stop_sequence — reuse the SAME fetch warm_up already does for CoarseGraph, don't re-query
    hops: &PatternHopsCache,
    stops: &StopsCache,
) -> PatternCumulativeCache {
    let mut by_pattern_stop: HashMap<(i64, i64), i64> = HashMap::new();

    let mut current_pattern: Option<i64> = None;
    let mut current_rows: Vec<&PatternStopRow> = Vec::new();
    for row in pattern_stop_rows {
        if current_pattern != Some(row.pattern_pk) {
            build_cumulative_for_pattern(&current_rows, hops, stops, &mut by_pattern_stop);
            current_rows.clear();
            current_pattern = Some(row.pattern_pk);
        }
        current_rows.push(row);
    }
    build_cumulative_for_pattern(&current_rows, hops, stops, &mut by_pattern_stop); // last pattern

    PatternCumulativeCache { by_pattern_stop }
}

// ── Frequency-graph precompute (pattern_hops / pattern_headway) ──────────
// Both tables are tiny relative to stop_times — see schema.sql's comments
// on them — so, like PatternsCache/RoutesCache above, loaded FULLY into
// memory once per engine lifetime rather than queried per search. Consumed
// by router/src/freq_raptor.rs.

/// pattern_pk -> [(from_stop_sequence, avg_travel_sec)], NOT necessarily
/// sorted by stop_sequence on load (insertion order from the SQL scan) —
/// freq_raptor.rs sorts once when it builds its own cumulative-time array
/// per pattern, so this cache doesn't need to guarantee order itself.
pub struct PatternHopsCache {
    by_pattern: HashMap<i64, Vec<(i64, i64)>>,
}

impl PatternHopsCache {
    pub fn hops_for(&self, pattern_pk: i64) -> &[(i64, i64)] {
        self.by_pattern.get(&pattern_pk).map(|v| v.as_slice()).unwrap_or(&[])
    }
}

pub fn load_pattern_hops(conn: &Connection) -> rusqlite::Result<PatternHopsCache> {
    let mut stmt = conn.prepare("SELECT pattern_pk, stop_sequence, avg_travel_sec FROM pattern_hops")?;
    let mut by_pattern: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    })?;
    for row in rows {
        let (pattern_pk, stop_sequence, avg_travel_sec) = row?;
        by_pattern.entry(pattern_pk).or_default().push((stop_sequence, avg_travel_sec));
    }
    Ok(PatternHopsCache { by_pattern })
}

/// Fixed clock buckets — MUST match import.rs's time_bucket_for exactly,
/// since this is decoding rows that function's bucketing decided. Router
/// and importer are separate crates (no shared dependency between them
/// today), so this is a deliberate duplication rather than a shared
/// helper — if you ever add a shared crate, move both copies there and
/// delete one.
pub fn time_bucket_for(sec: i64) -> i64 {
    let clock = sec.rem_euclid(86_400);
    let h = clock / 3600;
    if !(6..22).contains(&h) { 0 } // night
    else if (7..9).contains(&h) || (15..19).contains(&h) { 2 } // peak
    else { 1 } // off-peak
}

/// pattern_pk -> [(time_bucket, avg_headway_sec)]. `avg_headway_sec` is
/// `None` when the import-time sample for that pattern+bucket had fewer
/// than 2 trips (see schema.sql's comment on pattern_headway) — callers
/// MUST treat that as "unknown, assume infrequent," never as "0 wait" or
/// "skip this pattern."
pub struct PatternHeadwayCache {
    by_pattern: HashMap<i64, Vec<(i64, Option<i64>)>>,
}

impl PatternHeadwayCache {
    /// Headway for this pattern in whichever bucket `at_sec` (seconds
    /// since midnight, possibly > 86400 for an after-midnight estimate)
    /// falls into. `None` covers BOTH "no row at all for this
    /// pattern+bucket" (pattern rarely/never runs then) and "row present
    /// but avg_headway_sec was NULL" (ran, too few trips to estimate a
    /// gap) — freq_raptor.rs's caller applies the same conservative
    /// fallback either way, so collapsing them here is intentional, not a
    /// loss of information anything currently needs.
    pub fn headway_for(&self, pattern_pk: i64, at_sec: i64) -> Option<i64> {
        let bucket = time_bucket_for(at_sec);
        self.by_pattern.get(&pattern_pk)?.iter().find(|(b, _)| *b == bucket).and_then(|(_, h)| *h)
    }
}

pub fn load_pattern_headway(conn: &Connection) -> rusqlite::Result<PatternHeadwayCache> {
    let mut stmt = conn.prepare("SELECT pattern_pk, time_bucket, avg_headway_sec FROM pattern_headway")?;
    let mut by_pattern: HashMap<i64, Vec<(i64, Option<i64>)>> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?))
    })?;
    for row in rows {
        let (pattern_pk, bucket, avg_headway_sec) = row?;
        by_pattern.entry(pattern_pk).or_default().push((bucket, avg_headway_sec));
    }
    Ok(PatternHeadwayCache { by_pattern })
}

// ── Shapes ──────────────────────────────────────────────────────────────

pub struct ShapesIndex {
    id_to_pk: HashMap<(i64, String), i64>, // (agency, shape_id) -> shape_pk
}

pub fn load_shape_index(conn: &Connection) -> rusqlite::Result<ShapesIndex> {
    let mut stmt = conn.prepare("SELECT shape_pk, shape_id, agency FROM shape_meta")?;
    let mut id_to_pk = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    })?;
    for row in rows {
        let (pk, shape_id, agency) = row?;
        id_to_pk.insert((agency, shape_id), pk);
    }
    Ok(ShapesIndex { id_to_pk })
}

/// Loads polylines for a small set of (agency, shape_id) pairs — the
/// counterpart to loader.rs's deferred shape loading (only fetch shapes for
/// patterns the surviving journeys actually use).
pub fn get_shape_points(
    conn: &Connection,
    shapes_index: &ShapesIndex,
    shape_ids: &[(i64, String)], // (agency, shape_id)
) -> rusqlite::Result<HashMap<(i64, String), Vec<(f64, f64)>>> {
    let mut pk_to_key: HashMap<i64, (i64, String)> = HashMap::new();
    for key in shape_ids {
        if let Some(pk) = shapes_index.id_to_pk.get(key) {
            pk_to_key.insert(*pk, key.clone());
        }
    }
    let pks: Vec<i64> = pk_to_key.keys().copied().collect();
    if pks.is_empty() { return Ok(HashMap::new()); }

    let rows: Vec<(i64, i64, i64, i64)> = chunked_in_i64(
        conn, &pks,
        "SELECT shape_pk, shape_pt_lat, shape_pt_lon, shape_pt_sequence FROM shapes WHERE shape_pk IN",
        "ORDER BY shape_pk, shape_pt_sequence",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    let mut out: HashMap<i64, Vec<(f64, f64, i64)>> = HashMap::new();
    for (pk, lat, lon, seq) in rows {
        out.entry(pk).or_default().push((lat as f64 / COORD_SCALE, lon as f64 / COORD_SCALE, seq));
    }
    // Keyed by (agency, shape_id) — every current/planned caller only ever
    // has this key (from PatternMeta), never the internal shape_pk, so
    // re-keying here (using pk_to_key, which we already built above) saves
    // every caller from having to duplicate that lookup themselves.
    let mut result = HashMap::new();
    for (pk, mut pts) in out {
        pts.sort_by_key(|p| p.2);
        if let Some(key) = pk_to_key.get(&pk) {
            result.insert(key.clone(), pts.into_iter().map(|(lat, lon, _)| (lat, lon)).collect());
        }
    }
    Ok(result)
}
