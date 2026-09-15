use std::collections::HashMap;
use rusqlite::{Connection, params};
use crate::source::{find_all_gtfs_sources, GtfsSource};
use crate::csv_util::parse_csv_map;
use crate::schema::{GTFS_SCHEMA_SQL, GTFS_INDEXES_SQL};

const ALL_TABLES: &[&str] = &[
    "stops", "stops_rtree", "routes", "calendar", "calendar_dates", "trips", "patterns",
    "pattern_stops", "stop_times", "shape_meta", "shapes",
    "pattern_hops", "pattern_headway",
];

/// Fixed clock buckets shared across every pattern, matching schema.sql's
/// comment on pattern_headway. Deliberately NOT adaptive per pattern —
/// the frequency-graph estimate only needs "roughly how long do I wait",
/// not a precise per-line headway curve, and fixed buckets are trivial to
/// reason about / re-tune in one place (routing settings, not per-import
/// data-driven quantiles that could shift between re-imports of the same
/// agency).
const BUCKET_NIGHT: i64 = 0;
const BUCKET_OFFPEAK: i64 = 1;
const BUCKET_PEAK: i64 = 2;

/// AM peak: 07:00-09:00. PM peak: 15:00-19:00. Night: 22:00-06:00 (wraps
/// past midnight — sec_of_day can exceed 86400 for GTFS's after-midnight
/// service times, so this checks both the wrapped and unwrapped range).
/// Everything else is off-peak. `sec` is seconds-since-midnight of
/// SERVICE day, i.e. can be > 86400 for a trip GTFS timestamps as e.g.
/// "25:30:00" — reduce to a 0..86400 clock position first so a 2am-service
/// trip (25:30 -> 01:30 clock time) buckets the same as a literal 01:30
/// trip, not as an out-of-range peak/off-peak fallthrough.
fn time_bucket_for(sec: i64) -> i64 {
    let clock = sec.rem_euclid(86_400);
    let h = clock / 3600;
    if !(6..22).contains(&h) { BUCKET_NIGHT }
    else if (7..9).contains(&h) || (15..19).contains(&h) { BUCKET_PEAK }
    else { BUCKET_OFFPEAK }
}

/// Median of a mutable slice (sorts in place — callers already own a
/// scratch Vec built just for this, so no extra allocation). Even-length
/// falls back to the lower-middle element rather than averaging the two
/// middle elements: these are integer seconds and callers only need a
/// robust central estimate, not statistical precision, so avoiding the
/// float round-trip is a fine trade.
fn median_i64(vals: &mut [i64]) -> i64 {
    vals.sort_unstable();
    vals[vals.len() / 2]
}

/// Aggregates hop-times and headways for every pattern in this agency and
/// inserts into pattern_hops/pattern_headway — see schema.sql's comments
/// on both tables for the shape/semantics this produces.
///
/// Runs entirely against data already resident in memory
/// (`trip_stop_times`, built while streaming stop_times.txt; `pattern_groups`,
/// built while grouping trips) — deliberately NOT a second SQL pass over
/// the stop_times table after it's inserted. stop_times' primary key is
/// (stop_pk, departure_sec, trip_pk, stop_sequence) — see that table's own
/// schema comment — so a "GROUP BY trip_pk, stop_sequence"-shaped
/// aggregation query would have no usable index and would mean a full
/// table scan (potentially ~11.8M rows on a feed this size) purely to
/// recompute something this function gets for free from data already
/// sitting in memory one call frame up.
///
/// ALIGNMENT NOTE: `pattern_groups`' key is (route_id, direction_id,
/// Vec<stop_pk>) — i.e. membership in a pattern only guarantees every
/// trip has the SAME ORDERED STOP_PK SEQUENCE, not the same raw
/// stop_sequence NUMBERS (GTFS stop_sequence values aren't required to be
/// contiguous or agree across trips that otherwise visit the same stops in
/// the same order — one trip might number its stops 1,2,3 and another
/// 10,20,30 for the identical physical sequence). So hops/departures are
/// aggregated by ORDINAL POSITION within each trip's own sorted stop list
/// (0, 1, 2, ... — safe because grouping already guarantees identical
/// length/order across every trip in the pattern), and only the
/// REPRESENTATIVE trip's stop_sequence value at that ordinal (same one
/// pattern_stops itself was populated from, a few lines up) is used as the
/// stored row's key — so pattern_hops.stop_sequence values line up exactly
/// with pattern_stops.stop_sequence values for the same pattern, letting a
/// consumer join them directly if it ever needs to.
fn compute_and_insert_pattern_stats(
    conn: &Connection,
    agency_id: i64,
    pattern_groups: &HashMap<(String, String, Vec<i64>), PatternGroup>,
    trip_to_pattern_pk: &HashMap<String, i64>,
    trip_stop_times: &HashMap<String, Vec<TripStopRow>>,
    progress: &dyn ImportProgress,
) -> rusqlite::Result<()> {
    // pattern_pk -> trip_ids assigned to it (pattern_groups only keeps ONE
    // representative trip_pk per group; every trip that matched the group
    // key needs to contribute to the average, not just the first one seen).
    let mut trips_by_pattern: HashMap<i64, Vec<&String>> = HashMap::new();
    for (trip_id, &pattern_pk) in trip_to_pattern_pk {
        trips_by_pattern.entry(pattern_pk).or_default().push(trip_id);
    }

    let mut ins_hop = conn.prepare(
        "INSERT INTO pattern_hops (pattern_pk,stop_sequence,avg_travel_sec,sample_trips) VALUES (?,?,?,?)"
    )?;
    let mut ins_headway = conn.prepare(
        "INSERT INTO pattern_headway (pattern_pk,time_bucket,avg_headway_sec,sample_trips) VALUES (?,?,?,?)"
    )?;

    let mut patterns_done = 0u64;
    for group in pattern_groups.values() {
        // group.stops is the representative trip's rows, already sorted by
        // stop_sequence (see how PatternGroup is populated above) — the
        // canonical ordered stop list every trip in this group shares.
        let n = group.stops.len();
        let Some(trip_ids) = trips_by_pattern.get(&group.pk) else { continue };

        // ── hop times: per-ordinal Vec<travel_sec> across every trip ────
        if n >= 2 {
            let mut per_hop: Vec<Vec<i64>> = vec![Vec::new(); n - 1];
            for &trip_id in trip_ids {
                let Some(rows) = trip_stop_times.get(trip_id) else { continue };
                if rows.len() != n { continue; } // grouping guarantees this; skip defensively rather than panic on a data anomaly
                for i in 0..n - 1 {
                    let travel_sec = rows[i + 1].arrival_sec - rows[i].departure_sec;
                    if travel_sec > 0 {
                        per_hop[i].push(travel_sec);
                    }
                }
            }
            for (i, samples) in per_hop.iter_mut().enumerate() {
                if samples.is_empty() { continue; }
                let stop_sequence = group.stops[i].stop_sequence;
                let median = median_i64(samples);
                ins_hop.execute(params![group.pk, stop_sequence, median, samples.len() as i64])?;
            }
        }

        // ── headway: per-bucket Vec<first_stop_departure_sec> ────────────
        if n >= 1 {
            let mut per_bucket: HashMap<i64, Vec<i64>> = HashMap::new();
            for &trip_id in trip_ids {
                let Some(rows) = trip_stop_times.get(trip_id) else { continue };
                let Some(first) = rows.first() else { continue };
                let bucket = time_bucket_for(first.departure_sec);
                per_bucket.entry(bucket).or_default().push(first.departure_sec);
            }
            for (bucket, mut departures) in per_bucket {
                let sample_trips = departures.len() as i64;
                if departures.len() < 2 {
                    // Can't compute a gap from one trip — still record the
                    // row (sample_trips=1, avg_headway_sec=NULL) rather than
                    // omitting it entirely, so query-time code can tell
                    // "no data at all" (row absent) apart from "we saw
                    // this pattern run in this bucket, just not often
                    // enough to estimate a gap" (row present, NULL headway)
                    // — schema.sql's comment on this table explains why
                    // that distinction matters for the pruning-safety
                    // margin.
                    ins_headway.execute(params![group.pk, bucket, Option::<i64>::None, sample_trips])?;
                    continue;
                }
                departures.sort_unstable();
                let mut gaps: Vec<i64> = departures.windows(2).map(|w| w[1] - w[0]).collect();
                let median_gap = median_i64(&mut gaps);
                ins_headway.execute(params![group.pk, bucket, median_gap, sample_trips])?;
            }
        }

        patterns_done += 1;
        if patterns_done % 500 == 0 {
            progress.on_progress(format!("agency {agency_id} · pattern_hops/headway"), patterns_done, pattern_groups.len() as u64);
        }
    }
    progress.on_progress(format!("agency {agency_id} · pattern_hops/headway"), patterns_done, pattern_groups.len() as u64);
    Ok(())
}

pub trait ImportProgress {
    fn on_progress(&self, table: String, inserted: u64, total: u64);
}

fn pack_coord(v: &str) -> Option<i64> {
    v.parse::<f64>().ok().map(|f| (f * 1_000_000.0).round() as i64)
}

fn parse_gtfs_time_sec(s: &str) -> i64 {
    if s.is_empty() { return 0; }
    let mut parts = s.split(':');
    let h: i64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let m: i64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let sec: i64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    h * 3600 + m * 60 + sec
}

fn normalize_hex_color(v: &str) -> String {
    let raw = v.trim();
    if raw.is_empty() { return String::new(); }
    let hex = raw.trim_start_matches('#').to_uppercase();
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("#{hex}")
    } else {
        String::new()
    }
}

#[derive(Clone, Copy, Default)]
pub struct PkOffsets { pub stop: i64, pub trip: i64, pub pattern: i64, pub shape: i64 }

struct TripMeta { pk: i64, route_id: String, direction_id: String, shape_id: String, service_id: String }
struct TripStopRow { stop_pk: i64, stop_sequence: i64, arrival_sec: i64, departure_sec: i64, pickup_type: i64, drop_off_type: i64 }
struct PatternGroup { pk: i64, route_id: String, direction_id: String, shape_id: String, trip_pk: i64, stops: Vec<TripStopRow> }

/// Direct port of processAgency() from both TS files — this is the
/// authoritative logic; TS's preprocess-gtfs.ts and gtfsImporterLegacy.ts should
/// both be considered legacy once this ships and is verified against a
/// real feed.
fn process_agency(
    conn: &Connection,
    agency_id: i64,
    source: &GtfsSource,
    pk_offsets: PkOffsets,
    progress: &dyn ImportProgress,
) -> rusqlite::Result<PkOffsets> {
    // ── stops ──────────────────────────────────────────────────────────
    let mut stop_id_to_pk: HashMap<String, i64> = HashMap::new();
    let mut next_stop_pk = pk_offsets.stop;
    {
        let mut ins = conn.prepare(
            "INSERT INTO stops (stop_pk,stop_id,stop_name,stop_lat,stop_lon,agency) VALUES (?,?,?,?,?,?)"
        )?;
        // Point data in the rtree: min==max per dimension. Same scaled-int
        // units as stops.stop_lat/stop_lon (see schema.sql's comment on
        // stops_rtree) — `lat`/`lon` here are already packed via
        // pack_coord() above, so no extra conversion needed.
        let mut ins_rtree = conn.prepare(
            "INSERT INTO stops_rtree (stop_pk,min_lat,max_lat,min_lon,max_lon) VALUES (?,?,?,?,?)"
        )?;
        let mut count = 0u64;
        for r in parse_csv_map(&source.file("stops.txt")) {
            let stop_id = r.get("stop_id").cloned().unwrap_or_default();
            let (lat, lon) = match (
                r.get("stop_lat").and_then(|v| pack_coord(v)),
                r.get("stop_lon").and_then(|v| pack_coord(v)),
            ) {
                (Some(lat), Some(lon)) => (lat, lon),
                _ => continue,
            };
            let loc_type = r.get("location_type").map(|s| s.trim()).unwrap_or("");
            if !loc_type.is_empty() && loc_type != "0" { continue; }
            if stop_id_to_pk.contains_key(&stop_id) { continue; }
            let pk = next_stop_pk; next_stop_pk += 1;
            stop_id_to_pk.insert(stop_id.clone(), pk);
            ins.execute(params![
                pk, stop_id, r.get("stop_name").cloned().unwrap_or_default(),
                lat, lon, agency_id
            ])?;
            ins_rtree.execute(params![pk, lat, lat, lon, lon])?;
            count += 1;
        }
        progress.on_progress(format!("agency {agency_id} · stops"), count, count);
    }

    // ── routes / calendar / calendar_dates (low volume, INSERT OR IGNORE) ─
    {
        let mut ins = conn.prepare(
            "INSERT OR IGNORE INTO routes (route_id,route_short_name,route_long_name,route_type,route_color,route_text_color,agency) VALUES (?,?,?,?,?,?,?)"
        )?;
        let mut count = 0u64;
        for r in parse_csv_map(&source.file("routes.txt")) {
            let route_type: i64 = r.get("route_type").and_then(|v| v.parse().ok()).unwrap_or(3);
            let color = normalize_hex_color(r.get("route_color").map(|s| s.as_str()).unwrap_or(""));
            let text_color = {
                let v = normalize_hex_color(r.get("route_text_color").map(|s| s.as_str()).unwrap_or(""));
                if v.is_empty() { "#FFFFFF".to_string() } else { v }
            };
            ins.execute(params![
                r.get("route_id").cloned().unwrap_or_default(),
                r.get("route_short_name").cloned().unwrap_or_default(),
                r.get("route_long_name").cloned().unwrap_or_default(),
                route_type, color, text_color, agency_id
            ])?;
            count += 1;
        }
        progress.on_progress(format!("agency {agency_id} · routes"), count, count);
    }
    {
        let mut ins = conn.prepare(
            "INSERT OR IGNORE INTO calendar (service_id,agency,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        )?;
        let mut count = 0u64;
        for r in parse_csv_map(&source.file("calendar.txt")) {
            let g = |k: &str| r.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            ins.execute(params![
                r.get("service_id").cloned().unwrap_or_default(), agency_id,
                g("monday"), g("tuesday"), g("wednesday"), g("thursday"),
                g("friday"), g("saturday"), g("sunday"),
                r.get("start_date").cloned().unwrap_or_default(),
                r.get("end_date").cloned().unwrap_or_default(),
            ])?;
            count += 1;
        }
        progress.on_progress(format!("agency {agency_id} · calendar"), count, count);
    }
    {
        let mut ins = conn.prepare(
            "INSERT OR IGNORE INTO calendar_dates (service_id,agency,date,exception_type) VALUES (?,?,?,?)"
        )?;
        let mut count = 0u64;
        for r in parse_csv_map(&source.file("calendar_dates.txt")) {
            let exc: i64 = r.get("exception_type").and_then(|v| v.parse().ok()).unwrap_or(1);
            ins.execute(params![
                r.get("service_id").cloned().unwrap_or_default(), agency_id,
                r.get("date").cloned().unwrap_or_default(), exc
            ])?;
            count += 1;
        }
        progress.on_progress(format!("agency {agency_id} · calendar_dates"), count, count);
    }

    // ── trips.txt -> in-memory trip metadata ──────────────────────────
    let mut trip_meta: HashMap<String, TripMeta> = HashMap::new();
    let mut next_trip_pk = pk_offsets.trip;
    for t in parse_csv_map(&source.file("trips.txt")) {
        let trip_id = t.get("trip_id").cloned().unwrap_or_default();
        let pk = next_trip_pk; next_trip_pk += 1;
        trip_meta.insert(trip_id, TripMeta {
            pk,
            route_id: t.get("route_id").cloned().unwrap_or_default(),
            direction_id: t.get("direction_id").cloned().unwrap_or_else(|| "0".into()),
            shape_id: t.get("shape_id").cloned().unwrap_or_default(),
            service_id: t.get("service_id").cloned().unwrap_or_default(),
        });
    }

    // ── stop_times.txt -> grouped per trip. Millions of rows — use the
    // streaming CSV path, not parse_csv_map (avoid one HashMap per row). ─
    let mut trip_stop_times: HashMap<String, Vec<TripStopRow>> = HashMap::new();
    {
        let bytes = source.file("stop_times.txt");
        if !bytes.is_empty() {
            let mut rdr = csv::ReaderBuilder::new().has_headers(true).flexible(true).from_reader(bytes.as_slice());
            let headers = rdr.headers().map_err(|e| {
                rusqlite::Error::InvalidParameterName(format!("csv header error: {e}"))
            })?.clone();
            let idx = |name: &str| headers.iter().position(|h| h == name);
            let (trip_i, stop_i, arr_i, dep_i, seq_i, pickup_i, dropoff_i) = (
                idx("trip_id"), idx("stop_id"), idx("arrival_time"), idx("departure_time"), idx("stop_sequence"),
                idx("pickup_type"), idx("drop_off_type"),
            );
            if let (Some(ti), Some(si)) = (trip_i, stop_i) {
                for rec in rdr.records() {
                    let rec = match rec { Ok(r) => r, Err(_) => continue };
                    let trip_id = rec.get(ti).unwrap_or("");
                    if !trip_meta.contains_key(trip_id) { continue; }
                    let stop_id = rec.get(si).unwrap_or("");
                    let stop_pk = match stop_id_to_pk.get(stop_id) { Some(pk) => *pk, None => continue };
                    let arrival_sec = arr_i.and_then(|i| rec.get(i)).map(parse_gtfs_time_sec).unwrap_or(0);
                    let dep_raw = dep_i.and_then(|i| rec.get(i)).unwrap_or("");
                    let departure_sec = if dep_raw.is_empty() { arrival_sec } else { parse_gtfs_time_sec(dep_raw) };
                    let stop_sequence = seq_i.and_then(|i| rec.get(i)).and_then(|v| v.parse().ok()).unwrap_or(0);
                    // Blank/missing means 0 (regular) per GTFS spec default
                    // for both fields.
                    let pickup_type: i64 = pickup_i.and_then(|i| rec.get(i)).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    let drop_off_type: i64 = dropoff_i.and_then(|i| rec.get(i)).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    trip_stop_times.entry(trip_id.to_string()).or_default().push(TripStopRow {
                        stop_pk, stop_sequence, arrival_sec, departure_sec, pickup_type, drop_off_type,
                    });
                }
            }
        }
    }
    for rows in trip_stop_times.values_mut() {
        rows.sort_by_key(|r| r.stop_sequence);
    }

    // ── group trips into patterns by (route, direction, exact stop seq) ──
    // Sorted by trip_id BEFORE grouping — trip_meta is a HashMap, and
    // iterating it directly (as this used to) visits entries in Rust's
    // randomized hash order, which is different on every single process
    // run. Since pattern_pk is assigned in first-encountered order, that
    // meant re-importing the exact same GTFS zip twice in a row could
    // assign a completely different pattern_pk to the same route each
    // time — with nothing to detect the mismatch, a router process that
    // had already cached pattern metadata from an earlier import (in the
    // same running app session, before a re-import) would silently show
    // one route's name on another route's geometry. Sorting first makes
    // "which group is encountered first" depend only on the data, not on
    // the hasher's per-process random seed.
    let mut sorted_trips: Vec<(&String, &TripMeta)> = trip_meta.iter().collect();
    sorted_trips.sort_by(|a, b| a.0.cmp(b.0));

    // Dedup key is (route_id, direction_id, stop_pk sequence) directly —
    // NOT a comma-joined string built via `.to_string()` per stop_pk (as
    // this used to do). That meant every trip — not just the first trip of
    // each genuinely new pattern, EVERY trip, since the key has to be built
    // before you can check if it's new — paid for a decimal-string
    // allocation per stop plus a full string join, just to hash/compare
    // it. A Vec<i64> hashes and compares (element-by-element) exactly as
    // well for this purpose, without ever formatting anything to text.
    let mut pattern_groups: HashMap<(String, String, Vec<i64>), PatternGroup> = HashMap::new();
    let mut trip_to_pattern_pk: HashMap<String, i64> = HashMap::new();
    let mut next_pattern_pk = pk_offsets.pattern;
    for (trip_id, meta) in sorted_trips {
        let stops = match trip_stop_times.get(trip_id) { Some(s) if !s.is_empty() => s, _ => continue };
        let stop_pk_seq: Vec<i64> = stops.iter().map(|s| s.stop_pk).collect();
        let group_key = (meta.route_id.clone(), meta.direction_id.clone(), stop_pk_seq);
        let pk = pattern_groups.entry(group_key).or_insert_with(|| {
            let pk = next_pattern_pk; next_pattern_pk += 1;
            PatternGroup {
                pk, route_id: meta.route_id.clone(), direction_id: meta.direction_id.clone(),
                shape_id: meta.shape_id.clone(), trip_pk: meta.pk,
                stops: stops.iter().map(|s| TripStopRow {
                    stop_pk: s.stop_pk, stop_sequence: s.stop_sequence,
                    arrival_sec: s.arrival_sec, departure_sec: s.departure_sec,
                    pickup_type: s.pickup_type, drop_off_type: s.drop_off_type,
                }).collect(),
            }
        }).pk;
        trip_to_pattern_pk.insert(trip_id.clone(), pk);
    }

    // ── trips (insert) ─────────────────────────────────────────────────
    {
        let mut ins = conn.prepare(
            "INSERT INTO trips (trip_pk,trip_id,agency,pattern_pk,service_id) VALUES (?,?,?,?,?)"
        )?;
        let mut count = 0u64;
        for (trip_id, pattern_pk) in &trip_to_pattern_pk {
            let meta = &trip_meta[trip_id];
            ins.execute(params![meta.pk, trip_id, agency_id, pattern_pk, meta.service_id])?;
            count += 1;
        }
        progress.on_progress(format!("agency {agency_id} · trips"), count, count);
    }

    // ── stop_times (insert) — the big one, ~11.8M rows across the feed ──
    //
    // PERF NOTE: stop_times' PRIMARY KEY (and therefore physical row order,
    // since it's WITHOUT ROWID) is `(stop_pk, departure_sec, trip_pk,
    // stop_sequence)` — see schema.sql's note on why. `trip_stop_times` is
    // grouped by trip (that's how stop_times.txt streams in), which is a
    // COMPLETELY different order. Inserting in trip order against a
    // stop_pk-keyed table would mean every single insert lands at a random
    // point in the B-tree instead of appending at the end — each one a
    // potential page split, for millions of rows. Collected into one flat
    // Vec and sorted into PK order first so the actual `INSERT` pass below
    // is a sequential append, same as the OLD trip-ordered key got "for
    // free" from stop_times.txt's natural order — the sort is a one-time,
    // cache-friendly pass over small structs, far cheaper than paying
    // random-insertion page-split cost 11.8M times.
    //
    // Also switched from one `execute()` per row to batched multi-value
    // `INSERT ... VALUES (?,?,?,?,?,?,?),(...),...` (same batching already
    // used for staging in the router crate's `stage_ids`) — cuts several
    // million single-row round-trips down to a few thousand statements.
    {
        struct FlatStopTime { trip_pk: i64, stop_sequence: i64, stop_pk: i64, arrival_sec: i64, departure_sec: i64, pickup_type: i64, drop_off_type: i64 }

        let mut flat: Vec<FlatStopTime> = Vec::new();
        for (trip_id, stops) in &trip_stop_times {
            if !trip_to_pattern_pk.contains_key(trip_id) { continue; } // gates on membership only, same as both TS versions
            let trip_pk = trip_meta[trip_id].pk;
            for s in stops {
                flat.push(FlatStopTime {
                    trip_pk, stop_sequence: s.stop_sequence, stop_pk: s.stop_pk,
                    arrival_sec: s.arrival_sec, departure_sec: s.departure_sec,
                    pickup_type: s.pickup_type, drop_off_type: s.drop_off_type,
                });
            }
        }
        flat.sort_unstable_by_key(|r| (r.stop_pk, r.departure_sec, r.trip_pk, r.stop_sequence));

        const STOP_TIMES_BATCH_SIZE: usize = 140; // 7 cols x 140 rows = 980 bound params, under SQLite's 999-per-statement default (SQLITE_LIMIT_VARIABLE_NUMBER) — 400 here would have been 2800 and simply failed at execute() time.
        let mut count = 0u64;
        for chunk in flat.chunks(STOP_TIMES_BATCH_SIZE) {
            let placeholders = chunk.iter().map(|_| "(?,?,?,?,?,?,?)").collect::<Vec<_>>().join(",");
            let sql = format!(
                "INSERT INTO stop_times (trip_pk,stop_sequence,stop_pk,arrival_sec,departure_sec,pickup_type,drop_off_type) VALUES {placeholders}"
            );
            let mut ins = conn.prepare_cached(&sql)?;
            let mut params_flat: Vec<i64> = Vec::with_capacity(chunk.len() * 7);
            for r in chunk {
                params_flat.extend_from_slice(&[r.trip_pk, r.stop_sequence, r.stop_pk, r.arrival_sec, r.departure_sec, r.pickup_type, r.drop_off_type]);
            }
            let param_refs: Vec<&dyn rusqlite::ToSql> = params_flat.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            ins.execute(param_refs.as_slice())?;
            let prev_count = count;
            count += chunk.len() as u64;
            if count / 200_000 != prev_count / 200_000 {
                progress.on_progress(format!("agency {agency_id} · stop_times"), count, 0);
            }
        }
        progress.on_progress(format!("agency {agency_id} · stop_times"), count, count);
    }

    // ── patterns + pattern_stops ───────────────────────────────────────
    {
        let mut ins_pat = conn.prepare(
            "INSERT INTO patterns (pattern_pk,route_id,agency,direction_id,shape_id,trip_pk) VALUES (?,?,?,?,?,?)"
        )?;
        let mut ins_ps = conn.prepare(
            "INSERT INTO pattern_stops (pattern_pk,stop_pk,stop_sequence) VALUES (?,?,?)"
        )?;
        for g in pattern_groups.values() {
            let direction: i64 = g.direction_id.parse().unwrap_or(0);
            ins_pat.execute(params![g.pk, g.route_id, agency_id, direction, g.shape_id, g.trip_pk])?;
            for s in &g.stops {
                ins_ps.execute(params![g.pk, s.stop_pk, s.stop_sequence])?;
            }
        }
        progress.on_progress(format!("agency {agency_id} · patterns"), pattern_groups.len() as u64, pattern_groups.len() as u64);
    }

    // ── pattern_hops + pattern_headway (frequency-graph precompute) ─────
    compute_and_insert_pattern_stats(conn, agency_id, &pattern_groups, &trip_to_pattern_pk, &trip_stop_times, progress)?;

    // ── shapes — same every-3rd-point decimation as both TS versions ────
    let mut next_shape_pk = pk_offsets.shape;
    {
        let bytes = source.file("shapes.txt");
        if !bytes.is_empty() {
            let mut ins_meta = conn.prepare("INSERT INTO shape_meta (shape_pk,shape_id,agency) VALUES (?,?,?)")?;
            let mut ins_shape = conn.prepare("INSERT INTO shapes (shape_pk,shape_pt_lat,shape_pt_lon,shape_pt_sequence) VALUES (?,?,?,?)")?;
            let mut shape_id_to_pk: HashMap<String, i64> = HashMap::new();
            let mut pt_count: HashMap<String, u64> = HashMap::new();

            let mut rdr = csv::ReaderBuilder::new().has_headers(true).flexible(true).from_reader(bytes.as_slice());
            let headers = rdr.headers().map_err(|e| {
                rusqlite::Error::InvalidParameterName(format!("csv header error: {e}"))
            })?.clone();
            let idx = |name: &str| headers.iter().position(|h| h == name);
            let (id_i, lat_i, lon_i, seq_i) = (idx("shape_id"), idx("shape_pt_lat"), idx("shape_pt_lon"), idx("shape_pt_sequence"));
            let mut stored = 0u64;
            if let (Some(idi), Some(lati), Some(loni)) = (id_i, lat_i, lon_i) {
                for rec in rdr.records() {
                    let rec = match rec { Ok(r) => r, Err(_) => continue };
                    let shape_id = rec.get(idi).unwrap_or("");
                    if shape_id.is_empty() { continue; }
                    let (lat, lon) = match (
                        rec.get(lati).and_then(pack_coord),
                        rec.get(loni).and_then(pack_coord),
                    ) { (Some(a), Some(b)) => (a, b), _ => continue };
                    let cnt = *pt_count.get(shape_id).unwrap_or(&0);
                    pt_count.insert(shape_id.to_string(), cnt + 1);
                    if cnt != 0 && cnt % 3 != 0 { continue; }
                    let shape_pk = *shape_id_to_pk.entry(shape_id.to_string()).or_insert_with(|| {
                        let pk = next_shape_pk; next_shape_pk += 1;
                        pk
                    });
                    if pt_count[shape_id] == 1 {
                        ins_meta.execute(params![shape_pk, shape_id, agency_id])?;
                    }
                    let seq: i64 = seq_i.and_then(|i| rec.get(i)).and_then(|v| v.parse().ok()).unwrap_or(0);
                    ins_shape.execute(params![shape_pk, lat, lon, seq])?;
                    stored += 1;
                    if stored % 200_000 == 0 { progress.on_progress(format!("agency {agency_id} · shapes"), stored, 0); }
                }
            }
            progress.on_progress(format!("agency {agency_id} · shapes"), stored, stored);
        }
    }

    Ok(PkOffsets { stop: next_stop_pk, trip: next_trip_pk, pattern: next_pattern_pk, shape: next_shape_pk })
}

/// Entry point matching the existing uniffi stub's signature
/// (zip_path, db_path, onProgress) — see gtfs-importer's generated bindings
/// and testRustStub() in DebugControls.tsx.
pub fn import_gtfs(zip_path: &str, db_path: &str, progress: &dyn ImportProgress) -> rusqlite::Result<()> {
    use std::time::Instant;
    let t0 = Instant::now();

    // These two steps previously accounted for an unexplained gap between
    // "db path ready" and "starting table: agency 1" in the JS-side logs —
    // report them explicitly so future timing issues are visible without
    // guessing which phase they're in.
    progress.on_progress("reading zip".to_string(), 0, 0);
    let zip_bytes = std::fs::read(zip_path).map_err(|e| {
        rusqlite::Error::InvalidParameterName(format!("failed to read zip: {e}"))
    })?;
    progress.on_progress(
        format!("read zip ({} bytes, {:.1}s)", zip_bytes.len(), t0.elapsed().as_secs_f64()),
        0, 0,
    );

    progress.on_progress("scanning zip for GTFS feeds".to_string(), 0, 0);
    let sources = find_all_gtfs_sources(&zip_bytes);
    if sources.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "no agency.txt found anywhere in zip — not a valid GTFS zip".into()
        ));
    }
    progress.on_progress(
        format!("found {} feed(s) ({:.1}s)", sources.len(), t0.elapsed().as_secs_f64()),
        0, 0,
    );

    let mut conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "OFF")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", 20000)?;

    for table in ALL_TABLES {
        conn.execute(&format!("DROP TABLE IF EXISTS {table}"), [])?;
    }
    conn.execute_batch(GTFS_SCHEMA_SQL)?;

    let tx = conn.transaction()?;
    let mut pk_offsets = PkOffsets { stop: 1, trip: 1, pattern: 1, shape: 1 };
    for (i, source) in sources.iter().enumerate() {
        progress.on_progress(format!("agency {}/{} ({})", i + 1, sources.len(), source.describe()), 0, 0);
        pk_offsets = process_agency(&tx, (i + 1) as i64, source, pk_offsets, progress)?;
    }
    progress.on_progress(
        format!("all agencies imported ({:.1}s)", t0.elapsed().as_secs_f64()),
        0, 0,
    );
    tx.commit()?;

    progress.on_progress("building indexes".to_string(), 0, 0);
    conn.execute_batch(GTFS_INDEXES_SQL)?;
    progress.on_progress(
        format!("indexes built ({:.1}s)", t0.elapsed().as_secs_f64()),
        0, 0,
    );

    progress.on_progress("checkpointing WAL".to_string(), 0, 0);
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
    conn.execute_batch("PRAGMA journal_mode = DELETE;")?;
    progress.on_progress(
        format!("WAL checkpointed ({:.1}s)", t0.elapsed().as_secs_f64()),
        0, 0,
    );

    // VACUUM rewrites the db file compactly, reclaiming free pages left
    // behind by the bulk inserts above — this is what the desktop
    // preprocess-gtfs.ts reference does that this importer was missing,
    // and why its output was ~550MB vs. this importer's ~606MB on the same
    // feed. Must run outside any transaction (VACUUM can't run inside one),
    // which is already the case here since `tx` was committed above.
    progress.on_progress("vacuuming".to_string(), 0, 0);
    conn.execute_batch("VACUUM;")?;
    progress.on_progress(
        format!("vacuum done ({:.1}s total)", t0.elapsed().as_secs_f64()),
        0, 0,
    );

    Ok(())
}