//! raptor.rs — port of services/gtfs/router/gtfsRouter.ts.
//!
//! Same two properties as the TS version:
//!  1. Zero SQLite queries during search — everything comes from the
//!     already-loaded `GtfsIndex`.
//!  2. Returns every journey to the destination not strictly dominated by
//!     another on (arrival time, walking distance, transfers) — a Pareto
//!     frontier at the destination only, not full McRAPTOR's frontier at
//!     every stop.
//!
//! Times are seconds-since-midnight (`i64`), not formatted strings —
//! display formatting is a UI-layer concern, left to the caller.
//!
//! SCOPE NOTE (v1): transit segment polylines are built from the pattern's
//! stop-to-stop sequence (straight lines between consecutive stops on the
//! ridden pattern), NOT the smoother GTFS `shapes` road/rail-following
//! polyline the TS version trims per-segment via nearest-point matching.
//! Functionally correct (right stops, right order) but visually coarser.
//! Wiring in shape-based polylines is a follow-up, not done here.

use std::collections::{HashMap, HashSet};
use crate::geo::{haversine_meters, LatLon};
use crate::loader::GtfsIndex;
use crate::repo::StopsCache;
use crate::settings::{
    transfer_radius_m, ASSUMED_TRANSIT_SPEED_MPS, BEST_MARKED_CAP, MAX_ROUNDS, NEARBY_STOPS,
};

pub type StopPk = i64;

#[derive(Debug, Clone)]
pub struct RouteSegment {
    pub coords: Vec<LatLon>,
    pub route_name: String,
    pub route_type: i64,
    pub route_color: Option<String>,
    pub route_text_color: Option<String>,
    pub origin_stop_name: String,
    pub dest_stop_name: String,
    pub is_walk: bool,
    pub departure_time_sec: Option<i64>,
    pub arrival_time_sec: Option<i64>,
    /// Which pattern this segment rode, if any (None for walk segments).
    /// Not meaningful to callers outside this crate — it exists purely so
    /// lib.rs can resolve the segment's real GTFS shape and swap `coords`
    /// (currently just the stop-to-stop sequence above) for the actual
    /// road/rail-following polyline, trimmed to board->alight, AFTER
    /// run_search returns. Never exposed over the FFI boundary — see
    /// lib.rs's segment_to_ffi, which doesn't carry this field forward.
    pub pattern_pk: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Leg {
    pub route_name: String,
    pub route_type: i64,
    pub route_color: Option<String>,
    pub route_text_color: Option<String>,
    pub origin_stop_name: String,
    pub dest_stop_name: String,
    pub departure_time_sec: Option<i64>,
    pub arrival_time_sec: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct Journey {
    pub coords: Vec<LatLon>,
    pub segments: Vec<RouteSegment>,
    pub legs: Vec<Leg>,
    pub route_name: String,
    pub route_type: i64,
    pub route_color: Option<String>,
    pub route_text_color: Option<String>,
    pub origin_stop_name: String,
    pub dest_stop_name: String,
    pub transfer_stop_name: Option<String>,
    pub total_duration_min: i64,
    pub total_walking_meters: i64,
    pub transfer_count: i64,
    pub departure_time_sec: i64,
    pub arrival_time_sec: i64,
}

#[derive(Debug, Clone)]
enum ParentInfo {
    OriginWalk { dist_m: f64 },
    Footpath { from: StopPk, dist_m: f64 },
    Transit { trip_pk: i64, pattern_pk: i64, board_stop: StopPk, board_seq: i64, alight_seq: i64 },
}

fn walk_time_sec(meters: f64, speed_mps: f64) -> f64 { meters / speed_mps }

/// Walks `parent` backward from `cur` to the earliest stop reachable
/// (an origin-adjacent stop with no parent entry, or a stop whose parent is
/// an OriginWalk), returning the chain in forward (earliest -> cur) order.
/// Used by the `on_route_check` debug callback to show a candidate route
/// connected back through its own earlier transfers, not as an isolated
/// single-round segment. Bounded by `max_rounds`-ish depth in practice
/// (one hop per round at most), but capped defensively anyway since this
/// walks live, still-mutating search state rather than the final
/// backtrack over a completed search.
fn backtrack_stop_chain(mut cur: StopPk, parent: &HashMap<StopPk, ParentInfo>) -> Vec<StopPk> {
    let mut chain = vec![cur];
    for _ in 0..64 {
        match parent.get(&cur) {
            Some(ParentInfo::Transit { board_stop, .. }) => { cur = *board_stop; chain.push(cur); }
            Some(ParentInfo::Footpath { from, .. }) => { cur = *from; chain.push(cur); }
            Some(ParentInfo::OriginWalk { .. }) | None => break,
        }
    }
    chain.reverse();
    chain
}

fn nearest_stops(stops: &StopsCache, allowed: &HashSet<StopPk>, center: LatLon, limit: usize) -> Vec<(StopPk, f64)> {
    let mut out: Vec<(StopPk, f64)> = allowed.iter()
        .filter_map(|&pk| stops.get(pk).map(|s| (pk, haversine_meters(center, LatLon { lat: s.stop_lat, lon: s.stop_lon }))))
        .collect();
    out.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    out.truncate(limit);
    out
}

/// Earliest index in `entries` (sorted by departure_sec) with
/// departure_sec >= min_depart — binary search, same as earliestDepartureIndex.
fn earliest_departure_index(entries: &[crate::loader::StopTimeEntry], min_depart: i64) -> usize {
    entries.partition_point(|e| e.departure_sec < min_depart)
}

pub struct RaptorOptions {
    pub walking_speed_mps: f64,
    pub max_rounds: u32,
}

impl Default for RaptorOptions {
    fn default() -> Self {
        Self { walking_speed_mps: 1.4, max_rounds: MAX_ROUNDS }
    }
}

/// Runs the RAPTOR search over an already-loaded `GtfsIndex`.
///
/// `on_round`, if given, is called with (round_number, marked_stop_pks) at
/// the end of every round — the "currently evaluating" frontier a debug
/// overlay would draw as it expands.
///
/// `on_route_check`, if given, is called once per pattern examined within a
/// round, with (round_number, stop_pks_ridden_so_far, route_color,
/// route_name) — the FULL journey-so-far chain (origin-side boarding
/// history through earlier rounds, reconstructed via `parent`, plus this
/// round's own ridden segment), not just this round's isolated segment, so
/// a debug overlay can draw one connected candidate route rather than a
/// disjoint hop. `route_color`/`route_name` are the pattern's GTFS route
/// color ("#RRGGBB") and short/long name when the feed provides them.
/// Meant to be displayed one-at-a-time (a debug overlay stepping through
/// "which route is RAPTOR checking right now"), not accumulated — see
/// debugSinkCollector.ts.
pub fn run_search(
    index: &GtfsIndex,
    stops: &StopsCache,
    origin: LatLon,
    destination: LatLon,
    depart_sec_of_day: i64,
    opts: &RaptorOptions,
    mut on_round: Option<&mut dyn FnMut(u32, &[StopPk])>,
    mut on_route_check: Option<&mut dyn FnMut(u32, &[StopPk], Option<&str>, Option<&str>)>,
) -> Result<Vec<Journey>, String> {
    let xfer_radius = transfer_radius_m(opts.walking_speed_mps);

    let corridor_stops: Vec<StopPk> = index.allowed_stop_pks.iter().copied().collect();

    // Footpath neighbor grid — cell size derived from xfer_radius so the
    // 3x3-neighbor scan can't miss a real neighbor just outside a smaller
    // fixed cell (xfer_radius scales with walking speed, unlike the coarse
    // graph's fixed WALK_EDGE_THRESHOLD_M).
    let grid_cell_deg = (xfer_radius / 111_000.0 * 1.1).max(0.006);
    let cell_of = |lat: f64, lon: f64| -> (i64, i64) {
        ((lat / grid_cell_deg).floor() as i64, (lon / grid_cell_deg).floor() as i64)
    };
    let mut footpath_grid: HashMap<(i64, i64), Vec<StopPk>> = HashMap::new();
    for &pk in &corridor_stops {
        if let Some(s) = stops.get(pk) {
            footpath_grid.entry(cell_of(s.stop_lat, s.stop_lon)).or_default().push(pk);
        }
    }
    let nearby_for_footpath = |lat: f64, lon: f64| -> Vec<StopPk> {
        let (cy, cx) = cell_of(lat, lon);
        let mut out = Vec::new();
        for dy in -1..=1 {
            for dx in -1..=1 {
                if let Some(bucket) = footpath_grid.get(&(cy + dy, cx + dx)) {
                    out.extend(bucket.iter().copied());
                }
            }
        }
        out
    };

    let origin_nearby = nearest_stops(stops, &index.allowed_stop_pks, origin, NEARBY_STOPS);
    let dest_nearby = nearest_stops(stops, &index.allowed_stop_pks, destination, NEARBY_STOPS);

    if origin_nearby.is_empty() { return Err("No stops near your location.".to_string()); }
    if dest_nearby.is_empty() { return Err("No stops near destination.".to_string()); }

    let mut tau: HashMap<StopPk, i64> = HashMap::new();
    let mut parent: HashMap<StopPk, ParentInfo> = HashMap::new();
    let mut transfers_used: HashMap<StopPk, i64> = HashMap::new();
    let mut walk_so_far: HashMap<StopPk, f64> = HashMap::new();

    let mut marked: HashSet<StopPk> = HashSet::new();
    for &(pk, d) in &origin_nearby {
        let arr = depart_sec_of_day + walk_time_sec(d, opts.walking_speed_mps).round() as i64;
        tau.insert(pk, arr);
        parent.insert(pk, ParentInfo::OriginWalk { dist_m: d });
        transfers_used.insert(pk, 0);
        walk_so_far.insert(pk, d);
        marked.insert(pk);
    }

    let dest_key_map: HashMap<StopPk, f64> = dest_nearby.iter().copied().collect();

    struct Candidate { dest_pk: StopPk, final_walk_m: f64, arrival_sec: i64, total_walk_m: f64, transfers: i64 }
    let mut candidates: Vec<Candidate> = Vec::new();

    fn try_record_destination(
        stop_pk: StopPk,
        tau: &HashMap<StopPk, i64>,
        walk_so_far: &HashMap<StopPk, f64>,
        transfers_used: &HashMap<StopPk, i64>,
        dest_key_map: &HashMap<StopPk, f64>,
        walking_speed_mps: f64,
        candidates: &mut Vec<Candidate>,
    ) {
        let Some(&dist_m) = dest_key_map.get(&stop_pk) else { return };
        let Some(&tau_s) = tau.get(&stop_pk) else { return };
        let arrival_sec = tau_s + walk_time_sec(dist_m, walking_speed_mps).round() as i64;
        let total_walk_m = walk_so_far.get(&stop_pk).copied().unwrap_or(0.0) + dist_m;
        let transfers = transfers_used.get(&stop_pk).copied().unwrap_or(0);
        candidates.push(Candidate { dest_pk: stop_pk, final_walk_m: dist_m, arrival_sec, total_walk_m, transfers });
    }

    for pk in marked.clone() {
        try_record_destination(pk, &tau, &walk_so_far, &transfers_used, &dest_key_map, opts.walking_speed_mps, &mut candidates);
    }
    let mut best_dest_arrival_sec: i64 = candidates.iter().map(|c| c.arrival_sec).min().unwrap_or(i64::MAX);

    // Reverse index: stop_pk -> every (pattern_pk, stop_sequence) serving it.
    let mut patterns_by_stop: HashMap<StopPk, Vec<(i64, i64)>> = HashMap::new();
    for (&pattern_pk, seq_list) in &index.pattern_stops {
        for &(stop_pk, seq) in seq_list {
            patterns_by_stop.entry(stop_pk).or_default().push((pattern_pk, seq));
        }
    }

    let seed_path_stop_set: HashSet<StopPk> = index.debug_seed_paths.iter().flatten().copied().collect();

    for round in 0..opts.max_rounds {
        if marked.is_empty() { break; }

        // Provably-safe pruning once any destination candidate is known.
        if best_dest_arrival_sec < i64::MAX {
            marked = marked.into_iter().filter(|&pk| {
                let Some(s) = stops.get(pk) else { return true };
                let tau_s = tau.get(&pk).copied().unwrap_or(i64::MAX);
                if tau_s == i64::MAX { return true; }
                let lower_bound_remaining = (haversine_meters(destination, LatLon { lat: s.stop_lat, lon: s.stop_lon }) / ASSUMED_TRANSIT_SPEED_MPS) as i64;
                tau_s + lower_bound_remaining <= best_dest_arrival_sec
            }).collect();
        }

        if marked.len() > BEST_MARKED_CAP {
            let seed_protected: HashSet<StopPk> = marked.iter().filter(|pk| seed_path_stop_set.contains(pk)).copied().collect();

            let protected_nearest_dest = (BEST_MARKED_CAP as f64 * 0.25) as usize;
            let mut remaining: Vec<(StopPk, f64)> = marked.iter()
                .filter(|pk| !seed_protected.contains(pk))
                .filter_map(|&pk| stops.get(pk).map(|s| (pk, haversine_meters(destination, LatLon { lat: s.stop_lat, lon: s.stop_lon }))))
                .collect();
            remaining.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            let distance_protected: HashSet<StopPk> = remaining.into_iter().take(protected_nearest_dest).map(|(pk, _)| pk).collect();

            let mut protected: HashSet<StopPk> = HashSet::new();
            protected.extend(seed_protected.iter().copied());
            protected.extend(distance_protected.iter().copied());

            let mut scored: Vec<(StopPk, i64)> = marked.iter()
                .filter(|pk| !protected.contains(pk))
                .map(|&pk| {
                    let tau_s = tau.get(&pk).copied().unwrap_or(i64::MAX);
                    let remaining_sec = stops.get(pk)
                        .map(|s| (haversine_meters(destination, LatLon { lat: s.stop_lat, lon: s.stop_lon }) / ASSUMED_TRANSIT_SPEED_MPS) as i64)
                        .unwrap_or(0);
                    (pk, tau_s.saturating_add(remaining_sec))
                })
                .collect();
            scored.sort_by_key(|(_, score)| *score);
            let remaining_budget = BEST_MARKED_CAP.saturating_sub(protected.len());
            let mut new_marked: HashSet<StopPk> = protected;
            new_marked.extend(scored.into_iter().take(remaining_budget).map(|(pk, _)| pk));
            marked = new_marked;
        }

        let mut newly_marked: HashSet<StopPk> = HashSet::new();

        // Group by pattern: which marked stops board it, and at what tau.
        let mut boardings_by_pattern: HashMap<i64, Vec<(StopPk, i64, i64)>> = HashMap::new();
        for &stop_pk in &marked {
            let Some(patterns) = patterns_by_stop.get(&stop_pk) else { continue };
            let Some(&tau_at_stop) = tau.get(&stop_pk) else { continue };
            for &(pattern_pk, seq) in patterns {
                boardings_by_pattern.entry(pattern_pk).or_default().push((stop_pk, seq, tau_at_stop));
            }
        }
        if boardings_by_pattern.is_empty() { break; }

        for (pattern_pk, mut boardings) in boardings_by_pattern {
            // Ascending stop_sequence order — lowest usable board seq wins,
            // so "ride forward" always has a real destination ahead of it.
            boardings.sort_by_key(|b| b.1);

            let mut best_trip: Option<i64> = None;
            let mut best_board_stop: StopPk = 0;
            let mut best_board_seq: i64 = -1;

            for (stop_pk, _seq, tau_at_stop) in &boardings {
                let Some(entries) = index.stop_times_by_stop.get(stop_pk) else { continue };
                let idx = earliest_departure_index(entries, *tau_at_stop);
                for e in &entries[idx..] {
                    if e.pattern_pk != pattern_pk { continue; }
                    best_trip = Some(e.trip_pk);
                    best_board_stop = *stop_pk;
                    best_board_seq = e.stop_sequence;
                    break; // first pattern match at/after idx is earliest for this stop
                }
                if best_trip.is_some() { break; } // lowest-sequence candidate with a valid trip wins
            }

            let Some(trip_pk) = best_trip else { continue };
            let Some(pattern_stop_seq) = index.pattern_stops.get(&pattern_pk) else { continue };

            // Ridden stop sequence for this pattern this round — board stop
            // first, then every stop scanned along it (whether or not it
            // ended up strictly improving tau), so the debug view shows the
            // whole segment RAPTOR looked at, not just the stops it beat.
            // Only built when a debug sink is actually attached — this loop
            // runs for every pattern in every round of every real search, so
            // an unconditional Vec allocation + push per stop here would be
            // pure overhead on the non-debug path for no benefit.
            let debug_active = on_route_check.is_some();
            let mut ridden: Vec<StopPk> = if debug_active { vec![best_board_stop] } else { Vec::new() };

            let mut scanning = false;
            for &(stop_pk, seq) in pattern_stop_seq {
                if seq < best_board_seq { continue; }
                if seq == best_board_seq { scanning = true; continue; }
                if !scanning { continue; }

                let Some(trip_map) = index.stop_times_by_stop_and_trip.get(&stop_pk) else { continue };
                let Some(entry) = trip_map.get(&trip_pk) else { continue };
                if entry.stop_sequence != seq { continue; }

                if debug_active { ridden.push(stop_pk); }

                let current_best = tau.get(&stop_pk).copied().unwrap_or(i64::MAX);
                if entry.arrival_sec < current_best {
                    tau.insert(stop_pk, entry.arrival_sec);
                    parent.insert(stop_pk, ParentInfo::Transit {
                        trip_pk, pattern_pk, board_stop: best_board_stop, board_seq: best_board_seq, alight_seq: seq,
                    });
                    let prev_transfers = transfers_used.get(&best_board_stop).copied().unwrap_or(0);
                    transfers_used.insert(stop_pk, prev_transfers + 1);
                    let prev_walk = walk_so_far.get(&best_board_stop).copied().unwrap_or(0.0);
                    walk_so_far.insert(stop_pk, prev_walk);
                    newly_marked.insert(stop_pk);
                }
            }

            if debug_active && ridden.len() > 1 {
                if let Some(cb) = on_route_check.as_deref_mut() {
                    // Prepend the journey-so-far up to the boarding stop —
                    // `ridden[0]` IS `best_board_stop`, and the backtrack
                    // chain already ends there too, so skip ridden's first
                    // element to avoid a duplicate point at the join.
                    let mut full_chain = backtrack_stop_chain(best_board_stop, &parent);
                    full_chain.extend(ridden.iter().skip(1).copied());

                    let pat_meta = index.patterns_by_pk.get(&pattern_pk);
                    let route_color = pat_meta.and_then(|m| {
                        if m.route_color.is_empty() { None } else { Some(format!("#{}", m.route_color.trim_start_matches('#').to_uppercase())) }
                    });
                    let route_name = pat_meta.map(|m| m.route_name.clone());
                    cb(round, &full_chain, route_color.as_deref(), route_name.as_deref());
                }
            }
        }

        // ── Footpath relaxation for newly reached stops ─────────────────
        if !newly_marked.is_empty() {
            for key in newly_marked.clone() {
                let Some(stop) = stops.get(key) else { continue };
                let tau_s = tau.get(&key).copied().unwrap_or(i64::MAX);
                if tau_s == i64::MAX { continue; }

                for other_pk in nearby_for_footpath(stop.stop_lat, stop.stop_lon) {
                    if other_pk == key { continue; }
                    let Some(other) = stops.get(other_pk) else { continue };
                    let dist_m = haversine_meters(
                        LatLon { lat: stop.stop_lat, lon: stop.stop_lon },
                        LatLon { lat: other.stop_lat, lon: other.stop_lon },
                    );
                    if dist_m > xfer_radius { continue; }

                    let arr_at_n = tau_s + walk_time_sec(dist_m, opts.walking_speed_mps).round() as i64;
                    let current_best = tau.get(&other_pk).copied().unwrap_or(i64::MAX);
                    if arr_at_n < current_best {
                        tau.insert(other_pk, arr_at_n);
                        parent.insert(other_pk, ParentInfo::Footpath { from: key, dist_m });
                        transfers_used.insert(other_pk, transfers_used.get(&key).copied().unwrap_or(0));
                        walk_so_far.insert(other_pk, walk_so_far.get(&key).copied().unwrap_or(0.0) + dist_m);
                        newly_marked.insert(other_pk);
                    }
                }
            }
        }

        for &pk in &newly_marked {
            try_record_destination(pk, &tau, &walk_so_far, &transfers_used, &dest_key_map, opts.walking_speed_mps, &mut candidates);
        }
        best_dest_arrival_sec = candidates.iter().map(|c| c.arrival_sec).min().unwrap_or(i64::MAX).min(best_dest_arrival_sec);

        marked = newly_marked;

        if let Some(cb) = on_round.as_deref_mut() {
            let snapshot: Vec<StopPk> = marked.iter().copied().collect();
            cb(round, &snapshot);
        }
    }

    if candidates.is_empty() {
        let o_names: Vec<String> = origin_nearby.iter().take(3).filter_map(|(pk, _)| stops.get(*pk).map(|s| s.stop_name.clone())).collect();
        let d_names: Vec<String> = dest_nearby.iter().take(3).filter_map(|(pk, _)| stops.get(*pk).map(|s| s.stop_name.clone())).collect();
        return Err(format!(
            "No route found within {} transfers.\nNear origin: {}\nNear destination: {}",
            opts.max_rounds, o_names.join(", "), d_names.join(", "),
        ));
    }

    // ── Pareto filter ────────────────────────────────────────────────────
    let non_dominated: Vec<&Candidate> = candidates.iter().enumerate().filter(|(i, c)| {
        !candidates.iter().enumerate().any(|(j, o)| {
            j != *i
                && o.arrival_sec <= c.arrival_sec
                && o.total_walk_m <= c.total_walk_m
                && o.transfers <= c.transfers
                && (o.arrival_sec < c.arrival_sec || o.total_walk_m < c.total_walk_m || o.transfers < c.transfers)
        })
    }).map(|(_, c)| c).collect();

    let mut journeys: Vec<Journey> = non_dominated.iter()
        .map(|c| reconstruct_path(index, stops, origin, destination, c.dest_pk, c.final_walk_m, c.arrival_sec, depart_sec_of_day, &parent, opts.walking_speed_mps))
        .collect();
    journeys.sort_by_key(|j| j.arrival_time_sec);

    Ok(journeys)
}

#[allow(clippy::too_many_arguments)]
fn reconstruct_path(
    index: &GtfsIndex,
    stops: &StopsCache,
    origin: LatLon,
    destination: LatLon,
    dest_pk: StopPk,
    final_walk_m: f64,
    arrival_sec: i64,
    departure_sec: i64,
    parent: &HashMap<StopPk, ParentInfo>,
    walking_speed_mps: f64,
) -> Journey {
    enum Step {
        OriginWalk { to: StopPk, dist_m: f64 },
        Footpath { from: StopPk, to: StopPk, dist_m: f64 },
        Transit { trip_pk: i64, pattern_pk: i64, board: StopPk, alight: StopPk, board_seq: i64, alight_seq: i64 },
    }
    let mut steps: Vec<Step> = Vec::new();
    let mut cur = dest_pk;
    loop {
        let Some(p) = parent.get(&cur) else { break };
        match p {
            ParentInfo::OriginWalk { dist_m } => { steps.push(Step::OriginWalk { to: cur, dist_m: *dist_m }); break; }
            ParentInfo::Transit { trip_pk, pattern_pk, board_stop, board_seq, alight_seq } => {
                steps.push(Step::Transit { trip_pk: *trip_pk, pattern_pk: *pattern_pk, board: *board_stop, alight: cur, board_seq: *board_seq, alight_seq: *alight_seq });
                cur = *board_stop;
            }
            ParentInfo::Footpath { from, dist_m } => { steps.push(Step::Footpath { from: *from, to: cur, dist_m: *dist_m }); cur = *from; }
        }
    }
    steps.reverse();

    let mut segments: Vec<RouteSegment> = Vec::new();
    let mut legs: Vec<Leg> = Vec::new();
    let mut all_coords: Vec<LatLon> = vec![origin];
    let mut transfer_stop_name: Option<String> = None;
    let mut total_walking_meters = 0.0f64;
    let mut transfer_count: i64 = 0;

    let walk_segment = |from: LatLon, to: LatLon, from_name: &str, to_name: &str, dist_m: f64| -> RouteSegment {
        RouteSegment {
            coords: vec![from, to],
            route_name: format!("Walk (~{} min)", ((dist_m / walking_speed_mps / 60.0).round() as i64).max(1)),
            route_type: -1, route_color: Some("#666666".to_string()), route_text_color: Some("#FFFFFF".to_string()),
            origin_stop_name: from_name.to_string(), dest_stop_name: to_name.to_string(),
            is_walk: true, departure_time_sec: None, arrival_time_sec: None,
            pattern_pk: None,
        }
    };

    for step in &steps {
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
            Step::Footpath { from, to, dist_m } => {
                let (Some(from_stop), Some(to_stop)) = (stops.get(*from), stops.get(*to)) else { continue };
                let from_ll = LatLon { lat: from_stop.stop_lat, lon: from_stop.stop_lon };
                let to_ll = LatLon { lat: to_stop.stop_lat, lon: to_stop.stop_lon };
                let walk_min = ((dist_m / walking_speed_mps / 60.0).round() as i64).max(1);
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
            Step::Transit { trip_pk, pattern_pk, board, alight, board_seq, alight_seq } => {
                let (Some(board_stop), Some(alight_stop)) = (stops.get(*board), stops.get(*alight)) else { continue };
                let pat_meta = index.patterns_by_pk.get(pattern_pk);

                let route_name = pat_meta.map(|m| m.route_name.clone()).unwrap_or_else(|| "?".to_string());
                let route_type = pat_meta.map(|m| m.route_type).unwrap_or(3);
                let route_color = pat_meta.and_then(|m| if m.route_color.is_empty() { None } else { Some(format!("#{}", m.route_color.trim_start_matches('#').to_uppercase())) });
                let route_text_color = pat_meta.map(|m| if m.route_text_color.is_empty() { "#FFFFFF".to_string() } else { m.route_text_color.clone() });

                let board_entry = index.stop_times_by_stop_and_trip.get(board).and_then(|m| m.get(trip_pk));
                let alight_entry = index.stop_times_by_stop_and_trip.get(alight).and_then(|m| m.get(trip_pk));
                let depart_sec = board_entry.map(|e| e.departure_sec);
                let arrive_sec = alight_entry.map(|e| e.arrival_sec);

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
                    departure_time_sec: depart_sec, arrival_time_sec: arrive_sec,
                    pattern_pk: Some(*pattern_pk),
                });
                legs.push(Leg {
                    route_name, route_type, route_color, route_text_color,
                    origin_stop_name: board_stop.stop_name.clone(), dest_stop_name: alight_stop.stop_name.clone(),
                    departure_time_sec: depart_sec, arrival_time_sec: arrive_sec,
                });

                all_coords.extend(coords);
                all_coords.push(LatLon { lat: alight_stop.stop_lat, lon: alight_stop.stop_lon });
                transfer_count += 1;
            }
        }
    }

    let dest_stop = stops.get(dest_pk);
    let dest_stop_ll = dest_stop.map(|s| LatLon { lat: s.stop_lat, lon: s.stop_lon }).unwrap_or(destination);
    if final_walk_m > 1.0 {
        let dest_name = dest_stop.map(|s| s.stop_name.clone()).unwrap_or_default();
        segments.push(walk_segment(dest_stop_ll, destination, &dest_name, "Your destination", final_walk_m));
        all_coords.push(destination);
        total_walking_meters += final_walk_m;
    }

    let first_leg = legs.first();
    let last_leg = legs.last();
    let route_name = if legs.len() <= 1 {
        first_leg.map(|l| l.route_name.clone()).unwrap_or_default()
    } else {
        legs.iter().map(|l| l.route_name.clone()).collect::<Vec<_>>().join(" → ")
    };

    let route_type = first_leg.map(|l| l.route_type).unwrap_or(-1);
    let route_color = first_leg.and_then(|l| l.route_color.clone());
    let route_text_color = first_leg.and_then(|l| l.route_text_color.clone());
    let origin_stop_name = first_leg.map(|l| l.origin_stop_name.clone()).unwrap_or_default();
    let dest_stop_name = last_leg.map(|l| l.dest_stop_name.clone()).unwrap_or_default();

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
        total_duration_min: (arrival_sec - departure_sec) / 60,
        total_walking_meters: total_walking_meters.round() as i64,
        transfer_count: (transfer_count - 1).max(0),
        departure_time_sec: departure_sec,
        arrival_time_sec: arrival_sec,
    }
}