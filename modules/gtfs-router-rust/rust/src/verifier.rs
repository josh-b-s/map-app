//! verifier.rs — genuine boardability check for seed-path candidates.
//!
//! Replaces the old "run full McRAPTOR at the end" step. The seed BFS
//! (corridor/seed_bfs.rs) already produced a ranked family of candidate
//! stop-to-stop paths with a pattern_pk per hop (`GtfsIndex::seed_path_edges`,
//! aligned with `debug_seed_paths`). Rather than re-searching the whole
//! network, this just walks each candidate in order and checks whether a
//! real trip actually exists to ride it: same stop_times rows RAPTOR itself
//! boards from, no exploration, no alternate boardings considered.
//!
//! A candidate fails if any hop has no boardable trip, or the trip doesn't
//! reach the next stop in sequence. Failing candidates are skipped, not
//! retried with a different trip choice — this is a verifier, not a search.

use crate::geo::{haversine_meters, LatLon};
use crate::loader::GtfsIndex;
use crate::raptor::{Journey, Leg, RouteSegment};
use crate::repo::StopsCache;

fn walk_time_sec(meters: f64, speed_mps: f64) -> i64 {
    (meters / speed_mps).round() as i64
}

/// One hop of an already-assembled candidate, grouped so consecutive hops
/// riding the same pattern become a single ride instead of a re-boarding
/// check at every intermediate stop.
enum LegSpec {
    Walk(i64, i64),
    Transit { pattern_pk: i64, stops: Vec<i64> },
}

/// Collapses a candidate's per-hop `(path, edges)` into `LegSpec`s. Two
/// adjacent transit hops on the same pattern become one `Transit` leg
/// spanning every stop in between, since the rider never actually gets off
/// at the stops in the middle.
fn group_into_legs(path: &[i64], edges: &[Option<i64>]) -> Vec<LegSpec> {
    let mut legs = Vec::new();
    let mut i = 0;
    while i < edges.len() {
        match edges[i] {
            None => {
                legs.push(LegSpec::Walk(path[i], path[i + 1]));
                i += 1;
            }
            Some(pattern_pk) => {
                let mut stops = vec![path[i], path[i + 1]];
                let mut j = i + 1;
                while j < edges.len() && edges[j] == Some(pattern_pk) {
                    stops.push(path[j + 1]);
                    j += 1;
                }
                legs.push(LegSpec::Transit { pattern_pk, stops });
                i = j;
            }
        }
    }
    legs
}

/// A verified step in the journey, timestamped, ready to hand to
/// `build_journey`. Separate from `LegSpec` because a `Transit` leg here
/// carries the specific trip_pk it was actually boardable on, plus real
/// times pulled from that trip's stop_times rows.
enum Step {
    OriginWalk { to: i64, dist_m: f64 },
    Walk { from: i64, to: i64, dist_m: f64 },
    Transit { trip_pk: i64, pattern_pk: i64, board: i64, alight: i64, board_seq: i64, alight_seq: i64, depart_sec: i64, arrive_sec: i64 },
}

/// Tries to walk one candidate path end to end against real stop_times.
/// Returns `None` the moment a hop isn't genuinely boardable — a partial
/// match isn't a usable journey.
fn verify_one_path(
    index: &GtfsIndex,
    stops: &StopsCache,
    origin: LatLon,
    destination: LatLon,
    path: &[i64],
    edges: &[Option<i64>],
    depart_sec_of_day: i64,
    walking_speed_mps: f64,
) -> Option<Journey> {
    if path.is_empty() || edges.len() != path.len() - 1 { return None; }

    let first_stop = stops.get(path[0])?;
    let origin_dist = haversine_meters(origin, LatLon { lat: first_stop.stop_lat, lon: first_stop.stop_lon });
    let mut time = depart_sec_of_day + walk_time_sec(origin_dist, walking_speed_mps);
    let mut steps = vec![Step::OriginWalk { to: path[0], dist_m: origin_dist }];

    for leg in &group_into_legs(path, edges) {
        match leg {
            LegSpec::Walk(from, to) => {
                let (from_row, to_row) = (stops.get(*from)?, stops.get(*to)?);
                let dist = haversine_meters(
                    LatLon { lat: from_row.stop_lat, lon: from_row.stop_lon },
                    LatLon { lat: to_row.stop_lat, lon: to_row.stop_lon },
                );
                time += walk_time_sec(dist, walking_speed_mps);
                steps.push(Step::Walk { from: *from, to: *to, dist_m: dist });
            }
            LegSpec::Transit { pattern_pk, stops: leg_stops } => {
                let board = leg_stops[0];
                let entries = index.stop_times_by_stop_and_pattern.get(&(board, *pattern_pk))?;
                let idx = entries.partition_point(|e| e.departure_sec < time);
                let board_entry = entries[idx..].iter().find(|e| e.pickup_type == 0)?;
                let trip_pk = board_entry.trip_pk;

                // Ride through every intermediate stop on this same trip,
                // requiring strictly increasing stop_sequence (moving
                // forward, never doubling back onto an earlier point).
                let mut last_seq = board_entry.stop_sequence;
                let mut alight_entry = board_entry;
                for &stop_pk in &leg_stops[1..] {
                    let entry = index.stop_times_by_stop_and_trip.get(&stop_pk)?.get(&trip_pk)?;
                    if entry.stop_sequence <= last_seq { return None; }
                    last_seq = entry.stop_sequence;
                    alight_entry = entry;
                }
                // Only the real alight point needs to allow drop-off —
                // stops ridden through in the middle don't.
                if alight_entry.drop_off_type != 0 { return None; }

                time = alight_entry.arrival_sec;
                steps.push(Step::Transit {
                    trip_pk, pattern_pk: *pattern_pk, board, alight: *leg_stops.last().unwrap(),
                    board_seq: board_entry.stop_sequence, alight_seq: alight_entry.stop_sequence,
                    depart_sec: board_entry.departure_sec, arrive_sec: alight_entry.arrival_sec,
                });
            }
        }
    }

    Some(build_journey(index, stops, origin, destination, &steps, depart_sec_of_day, walking_speed_mps))
}

/// Turns a verified `Step` sequence into a `Journey` — same segment/leg
/// shape `raptor::reconstruct_path` builds, just driven from a fixed step
/// list instead of backtracking a search's parent pointers.
fn build_journey(
    index: &GtfsIndex,
    stops: &StopsCache,
    origin: LatLon,
    destination: LatLon,
    steps: &[Step],
    departure_sec: i64,
    walking_speed_mps: f64,
) -> Journey {
    let mut segments: Vec<RouteSegment> = Vec::new();
    let mut legs: Vec<Leg> = Vec::new();
    let mut all_coords: Vec<LatLon> = vec![origin];
    let mut transfer_stop_name: Option<String> = None;
    let mut total_walking_meters = 0.0f64;
    let mut used_pattern_pks: Vec<i64> = Vec::new();
    let mut arrival_sec = departure_sec;

    let walk_segment = |from: LatLon, to: LatLon, from_name: &str, to_name: &str, dist_m: f64| -> RouteSegment {
        RouteSegment {
            coords: vec![from, to],
            route_name: format!("Walk (~{} min)", (walk_time_sec(dist_m, walking_speed_mps) / 60).max(1)),
            route_type: -1, route_color: Some("#666666".to_string()), route_text_color: Some("#FFFFFF".to_string()),
            origin_stop_name: from_name.to_string(), dest_stop_name: to_name.to_string(),
            is_walk: true, departure_time_sec: None, arrival_time_sec: None,
            pattern_pk: None,
        }
    };

    for step in steps {
        match step {
            Step::OriginWalk { to, dist_m } => {
                let Some(to_stop) = stops.get(*to) else { continue };
                let to_ll = LatLon { lat: to_stop.stop_lat, lon: to_stop.stop_lon };
                if *dist_m > 1.0 {
                    segments.push(walk_segment(origin, to_ll, "Your location", &to_stop.stop_name, *dist_m));
                    all_coords.push(to_ll);
                    total_walking_meters += dist_m;
                }
            }
            Step::Walk { from, to, dist_m } => {
                let (Some(from_stop), Some(to_stop)) = (stops.get(*from), stops.get(*to)) else { continue };
                let from_ll = LatLon { lat: from_stop.stop_lat, lon: from_stop.stop_lon };
                let to_ll = LatLon { lat: to_stop.stop_lat, lon: to_stop.stop_lon };
                let walk_min = (walk_time_sec(*dist_m, walking_speed_mps) / 60).max(1);
                transfer_stop_name = Some(if from_stop.stop_name == to_stop.stop_name {
                    from_stop.stop_name.clone()
                } else {
                    format!("{} → {} (~{} min walk)", from_stop.stop_name, to_stop.stop_name, walk_min)
                });
                if *dist_m > 1.0 {
                    segments.push(walk_segment(from_ll, to_ll, &from_stop.stop_name, &to_stop.stop_name, *dist_m));
                    all_coords.push(to_ll);
                    total_walking_meters += dist_m;
                }
            }
            Step::Transit { pattern_pk, board, alight, board_seq, alight_seq, depart_sec, arrive_sec, .. } => {
                let (Some(board_stop), Some(alight_stop)) = (stops.get(*board), stops.get(*alight)) else { continue };
                let pat_meta = index.patterns_by_pk.get(pattern_pk);

                let route_name = pat_meta.map(|m| m.route_name.clone()).unwrap_or_else(|| "?".to_string());
                let route_type = pat_meta.map(|m| m.route_type).unwrap_or(3);
                let route_color = pat_meta.and_then(|m| if m.route_color.is_empty() { None } else { Some(format!("#{}", m.route_color.trim_start_matches('#').to_uppercase())) });
                let route_text_color = pat_meta.map(|m| if m.route_text_color.is_empty() { "#FFFFFF".to_string() } else { m.route_text_color.clone() });

                let seq_list = index.pattern_stops.get(pattern_pk).cloned().unwrap_or_default();
                let (lo, hi) = (*board_seq.min(alight_seq), *board_seq.max(alight_seq));
                let mut coords: Vec<LatLon> = seq_list.iter()
                    .filter(|(_, seq)| *seq >= lo && *seq <= hi)
                    .filter_map(|(stop_pk, _)| stops.get(*stop_pk).map(|s| LatLon { lat: s.stop_lat, lon: s.stop_lon }))
                    .collect();
                if coords.is_empty() {
                    coords = vec![
                        LatLon { lat: board_stop.stop_lat, lon: board_stop.stop_lon },
                        LatLon { lat: alight_stop.stop_lat, lon: alight_stop.stop_lon },
                    ];
                }

                segments.push(RouteSegment {
                    coords: coords.clone(), route_name: route_name.clone(), route_type, route_color: route_color.clone(),
                    route_text_color: route_text_color.clone(), origin_stop_name: board_stop.stop_name.clone(),
                    dest_stop_name: alight_stop.stop_name.clone(), is_walk: false,
                    departure_time_sec: Some(*depart_sec), arrival_time_sec: Some(*arrive_sec),
                    pattern_pk: Some(*pattern_pk),
                });
                legs.push(Leg {
                    route_name, route_type, route_color, route_text_color,
                    origin_stop_name: board_stop.stop_name.clone(), dest_stop_name: alight_stop.stop_name.clone(),
                    departure_time_sec: Some(*depart_sec), arrival_time_sec: Some(*arrive_sec),
                });

                all_coords.extend(coords);
                all_coords.push(LatLon { lat: alight_stop.stop_lat, lon: alight_stop.stop_lon });
                if !used_pattern_pks.contains(pattern_pk) { used_pattern_pks.push(*pattern_pk); }
                arrival_sec = *arrive_sec;
            }
        }
    }

    // Final walk from the last path stop to the destination point.
    if let Some(last_stop_pk) = steps.iter().rev().find_map(|s| match s {
        Step::Transit { alight, .. } => Some(*alight),
        Step::Walk { to, .. } => Some(*to),
        Step::OriginWalk { to, .. } => Some(*to),
    }) {
        if let Some(last_stop) = stops.get(last_stop_pk) {
            let last_ll = LatLon { lat: last_stop.stop_lat, lon: last_stop.stop_lon };
            let final_dist = haversine_meters(last_ll, destination);
            if final_dist > 1.0 {
                segments.push(walk_segment(last_ll, destination, &last_stop.stop_name, "Your destination", final_dist));
                all_coords.push(destination);
                total_walking_meters += final_dist;
                arrival_sec += walk_time_sec(final_dist, walking_speed_mps);
            }
        }
    }

    let route_type = legs.first().map(|l| l.route_type).unwrap_or(-1);
    let route_color = legs.first().and_then(|l| l.route_color.clone());
    let route_text_color = legs.first().and_then(|l| l.route_text_color.clone());
    let origin_stop_name = legs.first().map(|l| l.origin_stop_name.clone()).unwrap_or_default();
    let dest_stop_name = legs.last().map(|l| l.dest_stop_name.clone()).unwrap_or_default();
    let route_name = if legs.len() <= 1 {
        legs.first().map(|l| l.route_name.clone()).unwrap_or_default()
    } else {
        legs.iter().map(|l| l.route_name.clone()).collect::<Vec<_>>().join(" → ")
    };

    Journey {
        coords: all_coords,
        segments,
        legs,
        route_name,
        route_type,
        route_color,
        route_text_color,
        origin_stop_name,
        dest_stop_name,
        transfer_stop_name,
        used_pattern_pks: used_pattern_pks.clone(),
        total_duration_min: (arrival_sec - departure_sec) / 60,
        total_walking_meters: total_walking_meters.round() as i64,
        transfer_count: (used_pattern_pks.len() as i64 - 1).max(0),
        departure_time_sec: departure_sec,
        arrival_time_sec: arrival_sec,
    }
}

/// Verifies every seed-path candidate on `index` against real stop_times
/// and returns the genuinely boardable journeys, earliest arrival first.
/// This is the only search step now — no fallback to a full RAPTOR scan.
/// A candidate that fails (no trip actually boardable) is dropped, not
/// retried; if none survive, that's a real "no route", not a bug to patch
/// over by widening the search.
pub fn verify_seed_paths(
    index: &GtfsIndex,
    stops: &StopsCache,
    origin: LatLon,
    destination: LatLon,
    depart_sec_of_day: i64,
    walking_speed_mps: f64,
) -> Result<Vec<Journey>, String> {
    let mut journeys: Vec<Journey> = index.debug_seed_paths.iter()
        .zip(index.seed_path_edges.iter())
        .filter_map(|(path, edges)| verify_one_path(index, stops, origin, destination, path, edges, depart_sec_of_day, walking_speed_mps))
        .collect();

    if journeys.is_empty() {
        return Err("No genuinely boardable route found among the candidate seed paths.".to_string());
    }

    journeys.sort_by_key(|j| j.arrival_time_sec);
    Ok(journeys)
}
