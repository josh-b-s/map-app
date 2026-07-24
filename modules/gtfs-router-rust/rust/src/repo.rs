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
        self.by_pk.iter().filter(|o| o.is_some()).count()
    }
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
    for row in rows {
        let pk = row.stop_pk as usize;
        by_pk[pk] = Some(row);
    }
    Ok(StopsCache { by_pk })
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

/// Which routes (as interned RouteId) serve each of the given stop pks —
/// one bulk query. Mirrors getRouteKeysForStopKeys, used by corridor seed
/// selection to skip a stop that adds no new route to the seed set.
pub fn get_route_ids_for_stops(
    conn: &Connection,
    stop_pks: &[i64],
    patterns: &PatternsCache,
) -> rusqlite::Result<HashMap<i64, HashSet<RouteId>>> {
    if stop_pks.is_empty() { return Ok(HashMap::new()); }
    let rows: Vec<(i64, i64)> = chunked_in_i64(
        conn, stop_pks,
        "SELECT DISTINCT stop_pk, pattern_pk FROM pattern_stops WHERE stop_pk IN",
        "",
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut out: HashMap<i64, HashSet<RouteId>> = HashMap::new();
    for (stop_pk, pattern_pk) in rows {
        if let Some(meta) = patterns.get(pattern_pk) {
            if let Some(route_key) = meta.route_key {
                out.entry(stop_pk).or_default().insert(route_key);
            }
        }
    }
    Ok(out)
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
