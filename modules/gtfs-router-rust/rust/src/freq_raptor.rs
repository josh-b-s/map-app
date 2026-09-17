//! freq_raptor.rs — cheap pre-filter that runs between `resolve_corridor`
//! and the real SQL trip-discovery stage (`loader.rs`'s
//! `trips_for_candidates` / `windowed_discovery_and_fetch`).
//!
//! GOAL: `resolve_corridor` produces `candidate_pattern_pks` using
//! straightness/BFS-depth heuristics only — no real duration information.
//! On a large candidate set, every downstream SQL query's cost scales with
//! that set's size (`stop_pk IN (corridor) AND trip_pk IN (active)` has to
//! fan out over however many stops/patterns survived). This module runs a
//! RAPTOR-shaped search over PRECOMPUTED per-pattern hop-times/headways
//! (`pattern_hops`/`pattern_headway`, see schema.sql) instead of real
//! `stop_times` rows, to estimate which of those candidates are actually
//! plausible before the expensive stage ever runs.
//!
//! NOT a replacement for real RAPTOR: no trip-level boarding (there are no
//! trips here, only averages), no schedule awareness, no missed-connection
//! modeling. It answers "roughly how long would this take" cheaply, not
//! "what is the actual best journey." Treat its output as a candidate set
//! to narrow `resolve_corridor`'s result to, with a safety margin — never
//! as a final answer. See `narrow_candidates`'s doc for the pruning-safety
//! reasoning in full.
//!
//! Walking transfers reuse `CoarseGraph`'s resident walk-edge adjacency
//! (now carrying real `distance_m`, see graph/coarse.rs) instead of
//! building a separate footpath grid — same edges real RAPTOR's own
//! transfer-walking will use later, so this stage's walking estimate
//! isn't a second, potentially-inconsistent approximation on top of the
//! hop-time one.

use std::collections::{HashMap, HashSet};
use crate::geo::{haversine_meters, LatLon};
use crate::graph::coarse::{CoarseGraph, EdgeKind};
use crate::repo::{PatternHeadwayCache, PatternHopsCache, PatternStopRow, StopsCache};
use crate::settings::{
    transfer_radius_m, margin_threshold, ASSUMED_TRANSIT_SPEED_MPS, ENABLE_FREQ_GRAPH_MARGIN_PRUNE,
    FREQ_GRAPH_MARGIN_FLOOR_SEC, FREQ_GRAPH_MARGIN_RELATIVE_PCT, FREQ_GRAPH_MAX_ROUNDS,
    FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC,
    ORIGIN_DEST_WALK_RADIUS_M,
};

type StopPk = i64;

fn walk_time_sec(meters: f64, speed_mps: f64) -> i64 {
    (meters / speed_mps).round() as i64
}

/// Per-pattern canonical stop order + cumulative estimated travel time from
/// the pattern's first stop. Built once per call from `pattern_stop_rows`
/// (already sorted pattern_pk, stop_sequence — see repo.rs) restricted to
/// the candidate set, since this whole module only ever runs scoped to
/// `resolve_corridor`'s output, never the full network.
struct PatternProfile {
    /// (stop_pk, cumulative_sec_from_first_stop), in pattern order.
    stops: Vec<(StopPk, i64)>,
}

fn build_pattern_profiles(
    candidate_pattern_pks: &HashSet<i64>,
    pattern_stop_rows: &[PatternStopRow],
    hops: &PatternHopsCache,
    stops: &StopsCache,
) -> HashMap<i64, PatternProfile> {
    // Group the already-sorted rows by pattern_pk in one linear pass —
    // same grouping trick import.rs's flat stop_times build uses.
    let mut by_pattern: HashMap<i64, Vec<&PatternStopRow>> = HashMap::new();
    for row in pattern_stop_rows {
        if !candidate_pattern_pks.contains(&row.pattern_pk) { continue; }
        by_pattern.entry(row.pattern_pk).or_default().push(row);
    }

    let mut profiles = HashMap::new();
    for (pattern_pk, rows) in by_pattern {
        if rows.len() < 2 { continue; } // no hop possible with <2 stops
        // hops_for isn't guaranteed sorted by stop_sequence on load — index
        // it here rather than assuming order.
        let hop_by_seq: HashMap<i64, i64> = hops.hops_for(pattern_pk).iter().copied().collect();

        let mut cum = 0i64;
        let mut out: Vec<(StopPk, i64)> = Vec::with_capacity(rows.len());
        out.push((rows[0].stop_pk, 0));
        for w in rows.windows(2) {
            let (from, to) = (w[0], w[1]);
            let hop_sec = hop_by_seq.get(&from.stop_sequence).copied().unwrap_or_else(|| {
                // No precomputed sample for this hop (e.g. a pattern with
                // exactly one trip ever recorded, or a hop the median
                // filter dropped for being <=0) — fall back to straight-
                // line distance at the same assumed speed real RAPTOR's
                // destination-pruning lower bound already uses, rather
                // than treating the hop as free (0 sec), which would bias
                // this pattern to look artificially fast and could wrongly
                // win it a spot in the narrowed set.
                let (Some(a), Some(b)) = (stops.get(from.stop_pk), stops.get(to.stop_pk)) else { return 0 };
                let d = haversine_meters(
                    LatLon { lat: a.stop_lat, lon: a.stop_lon },
                    LatLon { lat: b.stop_lat, lon: b.stop_lon },
                );
                (d / ASSUMED_TRANSIT_SPEED_MPS).round() as i64
            });
            cum += hop_sec.max(0);
            out.push((to.stop_pk, cum));
        }
        profiles.insert(pattern_pk, PatternProfile { stops: out });
    }
    profiles
}

#[derive(Clone)]
enum ParentInfo {
    OriginWalk,
    Board { pattern_pk: i64, from_stop: StopPk },
    Walk { from_stop: StopPk },
}

pub struct FreqNarrowResult {
    pub pattern_pks: HashSet<i64>,
    pub stop_pks: HashSet<i64>,
    /// Estimated best arrival sec-of-day at the destination — diagnostic
    /// only (surfaced to loader.rs's timings), not used for anything past
    /// computing the margin internally.
    pub estimated_best_arrival_sec: i64,
}

/// Runs the frequency-graph search and returns a margin-widened pattern
/// set, or `None` if the search never reached anywhere near the
/// destination (no precomputed data covering this corridor, or a
/// genuinely disconnected candidate set) — callers MUST treat `None` as
/// "couldn't estimate, fall back to the unnarrowed candidate set," never
/// as "no route exists." This function only ever narrows a real SQL
/// search's input; it never itself decides a route doesn't exist.
///
/// PRUNING-SAFETY MARGIN: rather than keeping only the single
/// estimated-best journey's patterns, every stop reached within
/// `margin` of the best estimated arrival is treated as "in play," and
/// the union of every pattern that contributed to reaching ANY in-play
/// stop is returned — not just the patterns on the single best path. This
/// matters because the estimate is an average-case model with no
/// schedule/missed-connection awareness: a journey estimated slightly
/// worse than best could easily be the one that actually makes a tight
/// real-world connection, while the "best" estimate's connection happens
/// to be terrible at this specific departure time. Margin = `max(FLOOR,
/// estimated_duration * RELATIVE_PCT)` — see settings.rs for both
/// constants' reasoning.
#[allow(clippy::too_many_arguments)]
pub fn narrow_candidates(
    candidate_pattern_pks: &HashSet<i64>,
    allowed_stop_pks: &HashSet<i64>,
    pattern_stop_rows: &[PatternStopRow],
    hops: &PatternHopsCache,
    headway: &PatternHeadwayCache,
    coarse: &CoarseGraph,
    stops: &StopsCache,
    origin: LatLon,
    destination: LatLon,
    depart_sec_of_day: i64,
    walking_speed_mps: f64,
) -> Option<FreqNarrowResult> {
    let profiles = build_pattern_profiles(candidate_pattern_pks, pattern_stop_rows, hops, stops);
    if profiles.is_empty() { return None; }

    // Reverse index: stop_pk -> [(pattern_pk, index_in_pattern)], scoped to
    // the same candidate set the profiles were built from.
    let mut patterns_by_stop: HashMap<StopPk, Vec<(i64, usize)>> = HashMap::new();
    for (&pattern_pk, profile) in &profiles {
        for (idx, &(stop_pk, _)) in profile.stops.iter().enumerate() {
            patterns_by_stop.entry(stop_pk).or_default().push((pattern_pk, idx));
        }
    }

    let xfer_radius = transfer_radius_m(walking_speed_mps);

    let mut tau: HashMap<StopPk, i64> = HashMap::new();
    let mut parent: HashMap<StopPk, ParentInfo> = HashMap::new();

    // ── Seed from origin: every allowed corridor stop within walking
    // radius of the origin point, same radius resolve_corridor already
    // uses for seed stops (ORIGIN_DEST_WALK_RADIUS_M) — consistent with
    // what the real search will also consider reachable from a standing
    // start.
    let mut marked: HashSet<StopPk> = HashSet::new();
    for &stop_pk in allowed_stop_pks {
        let Some(s) = stops.get(stop_pk) else { continue };
        let d = haversine_meters(origin, LatLon { lat: s.stop_lat, lon: s.stop_lon });
        if d > ORIGIN_DEST_WALK_RADIUS_M { continue; }
        let arr = depart_sec_of_day + walk_time_sec(d, walking_speed_mps);
        tau.insert(stop_pk, arr);
        parent.insert(stop_pk, ParentInfo::OriginWalk);
        marked.insert(stop_pk);
    }
    if marked.is_empty() { return None; }

    for _round in 0..FREQ_GRAPH_MAX_ROUNDS {
        if marked.is_empty() { break; }
        let mut newly_marked: HashSet<StopPk> = HashSet::new();

        // ── Pattern relaxation: group marked boarding candidates by
        // pattern, then a single forward scan per pattern tracking the
        // cheapest "effective start" seen so far — same shape as real
        // RAPTOR's hold-a-trip scan, but continuous (an average hop-time
        // curve, not discrete trip departures) instead of trip-by-trip.
        let mut boardings_by_pattern: HashMap<i64, Vec<(StopPk, usize, i64)>> = HashMap::new();
        for &stop_pk in &marked {
            let Some(entries) = patterns_by_stop.get(&stop_pk) else { continue };
            let Some(&tau_at_stop) = tau.get(&stop_pk) else { continue };
            for &(pattern_pk, idx) in entries {
                boardings_by_pattern.entry(pattern_pk).or_default().push((stop_pk, idx, tau_at_stop));
            }
        }

        for (pattern_pk, boardings) in boardings_by_pattern {
            let Some(profile) = profiles.get(&pattern_pk) else { continue };
            let board_at_idx: HashMap<usize, (StopPk, i64)> = boardings.into_iter()
                .map(|(stop_pk, idx, tau)| (idx, (stop_pk, tau)))
                .collect();

            // best_base = the smallest (effective_start - cumulative_sec)
            // seen scanning left to right — arrival estimate at any later
            // index j is then simply best_base + cum_sec[j]. See this
            // fn's module doc: this is the continuous-graph analogue of
            // "hold a trip, re-board if a marked stop offers something
            // earlier."
            let mut best_base: Option<i64> = None;
            let mut best_base_from_stop: StopPk = 0;

            for (idx, &(stop_pk, cum_sec)) in profile.stops.iter().enumerate() {
                if let Some(&(_, tau_at_stop)) = board_at_idx.get(&idx) {
                    let bucket_time = tau_at_stop;
                    let wait_sec = match headway.headway_for(pattern_pk, bucket_time) {
                        Some(h) => h / 2,
                        None => FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC,
                    };
                    let effective_start = tau_at_stop + wait_sec;
                    let base = effective_start - cum_sec;
                    if best_base.map(|b| base < b).unwrap_or(true) {
                        best_base = Some(base);
                        best_base_from_stop = stop_pk;
                    }
                }
                let Some(base) = best_base else { continue };
                let candidate = base + cum_sec;
                // GUARD: this pattern's FULL real-world stop sequence can
                // run well outside this corridor (a pattern only partly
                // relevant here still carries every stop on its whole
                // route in `profile.stops`) — `best_base` still needs to
                // scan through those stops to keep the cumulative-time
                // math correct for stops that DO matter, but only stops
                // inside `allowed_stop_pks` should ever get marked/output.
                // Without this, out-of-corridor stops leak into `tau` and
                // then into the final narrowed stop set, which is exactly
                // backwards for a narrowing pass — see this fn's doc,
                // "never expand beyond what BFS already decided was
                // in-corridor."
                if !allowed_stop_pks.contains(&stop_pk) { continue; }
                let current = tau.get(&stop_pk).copied().unwrap_or(i64::MAX);
                if candidate < current {
                    tau.insert(stop_pk, candidate);
                    parent.insert(stop_pk, ParentInfo::Board { pattern_pk, from_stop: best_base_from_stop });
                    newly_marked.insert(stop_pk);
                }
            }
        }

        // ── Walk relaxation: reuse CoarseGraph's resident walk edges
        // (real distance_m, see graph/coarse.rs) instead of building a
        // separate footpath grid.
        for &stop_pk in &newly_marked.clone() {
            let Some(edges) = coarse.adjacency.get(&stop_pk) else { continue };
            let Some(&tau_s) = tau.get(&stop_pk) else { continue };
            for e in edges {
                if e.kind != EdgeKind::Walk || e.distance_m > xfer_radius { continue; }
                if !allowed_stop_pks.contains(&e.to) { continue; }
                let arr = tau_s + walk_time_sec(e.distance_m, walking_speed_mps);
                let current = tau.get(&e.to).copied().unwrap_or(i64::MAX);
                if arr < current {
                    tau.insert(e.to, arr);
                    parent.insert(e.to, ParentInfo::Walk { from_stop: stop_pk });
                    newly_marked.insert(e.to);
                }
            }
        }

        marked = newly_marked;
    }

    // ── Estimated best arrival near the destination.
    let mut best_arrival = i64::MAX;
    for &stop_pk in allowed_stop_pks {
        let Some(&tau_s) = tau.get(&stop_pk) else { continue };
        let Some(s) = stops.get(stop_pk) else { continue };
        let d = haversine_meters(destination, LatLon { lat: s.stop_lat, lon: s.stop_lon });
        if d > ORIGIN_DEST_WALK_RADIUS_M { continue; }
        let arr = tau_s + walk_time_sec(d, walking_speed_mps);
        if arr < best_arrival { best_arrival = arr; }
    }
    if best_arrival == i64::MAX { return None; } // never got near the destination — let the caller fall back

    let threshold = if ENABLE_FREQ_GRAPH_MARGIN_PRUNE {
        let estimated_duration = (best_arrival - depart_sec_of_day).max(0) as f64;
        let margin = margin_threshold(estimated_duration, FREQ_GRAPH_MARGIN_FLOOR_SEC as f64, FREQ_GRAPH_MARGIN_RELATIVE_PCT);
        best_arrival + margin.round() as i64
    } else {
        i64::MAX
    };

    // ── Union of patterns contributing to any in-play stop, by walking
    // each in-play stop's parent chain back to origin — NOT just the
    // single best path. See this fn's doc for why.
    let mut narrowed_patterns: HashSet<i64> = HashSet::new();
    let mut narrowed_stops: HashSet<i64> = HashSet::new();
    for (&stop_pk, &tau_s) in &tau {
        if tau_s > threshold { continue; }
        // Defensive, not load-bearing after the pattern-relaxation guard
        // above — but this is the actual safety ceiling this fn's doc
        // promises ("never expand beyond what BFS already decided was
        // in-corridor"), so it belongs here explicitly rather than relying
        // solely on tau never containing an out-of-scope entry in the
        // first place.
        if !allowed_stop_pks.contains(&stop_pk) { continue; }
        narrowed_stops.insert(stop_pk);
        let mut cur = stop_pk;
        for _ in 0..64 { // same defensive depth cap raptor.rs's own backtrack uses
            match parent.get(&cur) {
                Some(ParentInfo::Board { pattern_pk, from_stop }) => {
                    narrowed_patterns.insert(*pattern_pk);
                    narrowed_stops.insert(*from_stop);
                    cur = *from_stop;
                }
                Some(ParentInfo::Walk { from_stop }) => { narrowed_stops.insert(*from_stop); cur = *from_stop; }
                Some(ParentInfo::OriginWalk) | None => break,
            }
        }
    }

    // ── Safety net: always keep patterns touching origin/destination
    // walk-radius stops regardless of what the estimate found, mirroring
    // resolve_corridor's own seed-path stops being kept unconditionally.
    for &stop_pk in allowed_stop_pks {
        let Some(s) = stops.get(stop_pk) else { continue };
        let near_origin = haversine_meters(origin, LatLon { lat: s.stop_lat, lon: s.stop_lon }) <= ORIGIN_DEST_WALK_RADIUS_M;
        let near_dest = haversine_meters(destination, LatLon { lat: s.stop_lat, lon: s.stop_lon }) <= ORIGIN_DEST_WALK_RADIUS_M;
        if !near_origin && !near_dest { continue; }
        narrowed_stops.insert(stop_pk);
        if let Some(entries) = patterns_by_stop.get(&stop_pk) {
            for &(pattern_pk, _) in entries { narrowed_patterns.insert(pattern_pk); }
        }
    }

    if narrowed_patterns.is_empty() { return None; }

    Some(FreqNarrowResult { pattern_pks: narrowed_patterns, stop_pks: narrowed_stops, estimated_best_arrival_sec: best_arrival })
}
