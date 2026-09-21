//! time_corridor.rs
//!
//! Network-wide, time-based replacement for "which patterns are worth
//! loading for this search". Where the BFS corridor ranks patterns by hop
//! LEVELS (a 2-minute hop and a 40-minute hop both count as one level), this
//! works in estimated SECONDS:
//!
//!   1. FORWARD pass from the origin: for each transit-leg count k (0..=K),
//!      the earliest estimated arrival at every stop using at most k legs.
//!   2. BACKWARD pass from the destination: for each k, the least estimated
//!      time still needed to reach the destination from every stop using at
//!      most k legs.
//!   3. A pattern qualifies when boarding at some stop i and alighting at
//!      some later stop j gives  F_k1(i) + wait + ride(i→j) + B_k2(j)  within a
//!      margin of the best estimate for that total leg count L = k1+1+k2.
//!      Comparing against the best FOR THAT LEG COUNT keeps Pareto options
//!      (a slower direct line AND a faster one-transfer route) instead of
//!      only the single fastest.
//!
//! The estimate is an average-case model (mean hop times, headway/2 waits, no
//! missed connections), so callers must treat the result as a *candidate
//! pool* to be widened by a margin and then verified by the real timetable
//! search — never as the answer.
//!
//! Everything it needs is already resident after warm_up (all
//! `pattern_stops` rows = one linear pass to index), so a search is a few
//! linear scans over ~all pattern stops per round, no SQL.

use std::collections::HashMap;
use std::time::Instant;

use crate::geo::{haversine_meters, LatLon};
use crate::graph::coarse::{CoarseGraph, EdgeKind};
use crate::repo::{time_bucket_for, PatternHeadwayCache, PatternHopsCache, PatternStopRow, StopsCache};
use crate::settings::{
    ASSUMED_TRANSIT_SPEED_MPS, FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC, TIME_CORRIDOR_MARGIN_FLOOR_SEC,
    TIME_CORRIDOR_MARGIN_RELATIVE_PCT, TIME_CORRIDOR_MAX_LEGS, TIME_CORRIDOR_RIDE_SCALE,
    TIME_CORRIDOR_SEGMENT_MARGIN_STOPS, TIME_CORRIDOR_TRANSFER_PENALTY_SEC,
};

/// "Unreachable". Kept well below i64::MAX so sums of a few of these can't overflow.
const INF: i64 = i64::MAX / 8;

#[derive(Clone, Copy)]
struct TcStop {
    stop_pk: i64,
    /// Estimated seconds from the pattern's first stop to this one.
    cum_sec: i64,
    stop_sequence: i64,
}

struct TcPattern {
    pattern_pk: i64,
    stops: Vec<TcStop>,
}

pub struct TimeCorridorIndex {
    patterns: Vec<TcPattern>,
    /// stop_pk -> [(index into `patterns`, position within that pattern)];
    /// dense (indexed by stop_pk) because the per-round scans hit it constantly.
    by_stop: Vec<Vec<(u32, u32)>>,
    idx_of_pk: HashMap<i64, usize>,
    /// Arrays elsewhere are sized `max_stop_pk + 1` and indexed by stop_pk.
    max_stop_pk: usize,
}

fn walk_time_sec(meters: f64, speed_mps: f64) -> i64 {
    (meters / speed_mps).round() as i64
}

impl TimeCorridorIndex {
    /// One linear pass over the (already pattern/sequence-ordered) rows.
    /// Hop times mirror freq_raptor's profile builder: precomputed median hop
    /// seconds where present, else straight-line distance at the same assumed
    /// transit speed (never 0, which would make a pattern look free).
    pub fn build(pattern_stop_rows: &[PatternStopRow], hops: &PatternHopsCache, stops: &StopsCache) -> Self {
        let mut max_stop_pk = 0usize;
        for s in stops.iter() { max_stop_pk = max_stop_pk.max(s.stop_pk.max(0) as usize); }
        for r in pattern_stop_rows { max_stop_pk = max_stop_pk.max(r.stop_pk.max(0) as usize); }

        let mut patterns: Vec<TcPattern> = Vec::new();
        let mut idx_of_pk: HashMap<i64, usize> = HashMap::new();
        let mut by_stop: Vec<Vec<(u32, u32)>> = vec![Vec::new(); max_stop_pk + 1];

        let mut start = 0usize;
        while start < pattern_stop_rows.len() {
            let pk = pattern_stop_rows[start].pattern_pk;
            let mut end = start;
            while end < pattern_stop_rows.len() && pattern_stop_rows[end].pattern_pk == pk { end += 1; }
            let rows = &pattern_stop_rows[start..end];
            start = end;
            if rows.len() < 2 { continue; }

            let hop_by_seq: HashMap<i64, i64> = hops.hops_for(pk).iter().copied().collect();
            let mut cum = 0i64;
            let mut out: Vec<TcStop> = Vec::with_capacity(rows.len());
            out.push(TcStop { stop_pk: rows[0].stop_pk, cum_sec: 0, stop_sequence: rows[0].stop_sequence });
            for w in rows.windows(2) {
                let (from, to) = (&w[0], &w[1]);
                let hop = hop_by_seq.get(&from.stop_sequence).copied().unwrap_or_else(|| {
                    let (Some(a), Some(b)) = (stops.get(from.stop_pk), stops.get(to.stop_pk)) else { return 0 };
                    let d = haversine_meters(
                        LatLon { lat: a.stop_lat, lon: a.stop_lon },
                        LatLon { lat: b.stop_lat, lon: b.stop_lon },
                    );
                    (d / ASSUMED_TRANSIT_SPEED_MPS).round() as i64
                });
                // Median hop times exclude dwell/slack, so raw sums run optimistic;
                // TIME_CORRIDOR_RIDE_SCALE (settings.rs) calibrates that.
                cum += ((hop.max(0) as f64) * TIME_CORRIDOR_RIDE_SCALE).round() as i64;
                out.push(TcStop { stop_pk: to.stop_pk, cum_sec: cum, stop_sequence: to.stop_sequence });
            }

            let pidx = patterns.len();
            for (pos, st) in out.iter().enumerate() {
                by_stop[st.stop_pk.max(0) as usize].push((pidx as u32, pos as u32));
            }
            idx_of_pk.insert(pk, pidx);
            patterns.push(TcPattern { pattern_pk: pk, stops: out });
        }

        TimeCorridorIndex { patterns, by_stop, idx_of_pk, max_stop_pk }
    }

    /// Rebuilds `pattern_stops` rows for patterns the BFS corridor never
    /// fetched rows for, without another SQL round trip.
    pub fn rows_for_patterns(&self, pattern_pks: &[i64]) -> Vec<PatternStopRow> {
        let mut out = Vec::new();
        for pk in pattern_pks {
            let Some(&i) = self.idx_of_pk.get(pk) else { continue };
            for st in &self.patterns[i].stops {
                out.push(PatternStopRow { pattern_pk: *pk, stop_pk: st.stop_pk, stop_sequence: st.stop_sequence });
            }
        }
        out
    }
}

pub struct TimeCorridorPattern {
    pub pattern_pk: i64,
    /// Seconds over the best estimate for the leg count this pattern was
    /// best at (0 = on the best estimated option for that leg count).
    pub slack_sec: i64,
}

pub struct TimeCorridorResult {
    /// Qualifying patterns, best slack first (ties: lower pattern_pk).
    pub ranked: Vec<TimeCorridorPattern>,
    /// Stops of each qualifying pattern worth fetching times for: the
    /// board..alight segment that qualified, plus a small margin either side.
    pub stops_by_pattern: HashMap<i64, Vec<i64>>,
    /// Estimated best arrival (sec of day) using at most L legs, index 0 = 1 leg.
    /// `None` = destination unreachable with that many legs.
    pub best_arrival_by_legs: Vec<Option<i64>>,
    pub elapsed_ms: i64,
    /// Where the time went: (phase, ms) for walk-in, forward, backward, select.
    pub phase_ms: Vec<(&'static str, i64)>,
}

/// Per-search memo of headway/2 waits, keyed by (pattern index, time bucket).
/// `headway_for` is a HashMap lookup plus a linear bucket scan; the selection
/// pass asks for it millions of times, but there are only 3 buckets per pattern.
struct WaitCache<'a> {
    headway: &'a PatternHeadwayCache,
    pks: Vec<i64>,
    memo: Vec<[i64; 3]>,
}

impl<'a> WaitCache<'a> {
    fn new(index: &TimeCorridorIndex, headway: &'a PatternHeadwayCache) -> Self {
        WaitCache {
            headway,
            pks: index.patterns.iter().map(|p| p.pattern_pk).collect(),
            memo: vec![[-1; 3]; index.patterns.len()],
        }
    }
    #[inline]
    fn wait(&mut self, pidx: usize, at_sec: i64) -> i64 {
        let b = time_bucket_for(at_sec) as usize;
        let cached = self.memo[pidx][b];
        if cached >= 0 { return cached; }
        let w = match self.headway.headway_for(self.pks[pidx], at_sec) {
            Some(h) => h / 2,
            None => FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC,
        };
        self.memo[pidx][b] = w;
        w
    }
}

fn margin_for(best_duration_sec: i64) -> i64 {
    let rel = (best_duration_sec.max(0) as f64 * TIME_CORRIDOR_MARGIN_RELATIVE_PCT).round() as i64;
    TIME_CORRIDOR_MARGIN_FLOOR_SEC.max(rel)
}

/// Returns `None` when the estimate can't connect origin to destination
/// (no stops in walking range, or nothing reaches the destination within
/// the leg limit). Callers MUST treat that as "couldn't estimate, don't
/// narrow", never as "no route".
#[allow(clippy::too_many_arguments)]
pub fn compute(
    index: &TimeCorridorIndex,
    graph: &CoarseGraph,
    stops: &StopsCache,
    headway: &PatternHeadwayCache,
    origin: LatLon,
    destination: LatLon,
    depart_sec: i64,
    walking_speed_mps: f64,
    max_walk_distance_m: f64,
) -> Option<TimeCorridorResult> {
    let t0 = Instant::now();
    let n = index.max_stop_pk + 1;
    let k_max = TIME_CORRIDOR_MAX_LEGS.max(1);
    let penalty = TIME_CORRIDOR_TRANSFER_PENALTY_SEC;
    let mut waits = WaitCache::new(index, headway);

    // ── Walk-in / walk-out stops ────────────────────────────────────────
    let mut origin_walk = vec![INF; n];
    let mut dest_walk = vec![INF; n];
    let mut origin_stops: Vec<u32> = Vec::new();
    let mut dest_stops: Vec<u32> = Vec::new();
    // Cheap lat/lon box test before the trig-heavy haversine (29k stops x 2).
    let dlat_deg = max_walk_distance_m / 111_320.0 * 1.05;
    let near = |c: LatLon, ll: &LatLon| -> bool {
        let dlon_deg = dlat_deg / c.lat.to_radians().cos().abs().max(0.2);
        (ll.lat - c.lat).abs() <= dlat_deg && (ll.lon - c.lon).abs() <= dlon_deg
    };
    for s in stops.iter() {
        let pk = s.stop_pk;
        if pk < 0 || pk as usize >= n { continue; }
        let ll = LatLon { lat: s.stop_lat, lon: s.stop_lon };
        if near(origin, &ll) {
            let d_o = haversine_meters(origin, ll);
            if d_o <= max_walk_distance_m {
                origin_walk[pk as usize] = walk_time_sec(d_o, walking_speed_mps);
                origin_stops.push(pk as u32);
            }
        }
        if near(destination, &ll) {
            let d_d = haversine_meters(destination, ll);
            if d_d <= max_walk_distance_m {
                dest_walk[pk as usize] = walk_time_sec(d_d, walking_speed_mps);
                dest_stops.push(pk as u32);
            }
        }
    }
    let t_walk = t0.elapsed().as_millis() as i64;
    let t_fwd_start = Instant::now();
    if origin_stops.is_empty() || dest_stops.is_empty() { return None; }

    // A label that is not the plain walk-in / walk-out value came from riding,
    // so boarding/alighting there is a TRANSFER and pays the connection penalty.
    // (INF in f0/b0 means "not a walk-in/out stop", so any finite label there
    // is transit-derived.)

    // ── Forward: f[k][stop] = earliest arrival using <= k transit legs ──
    let mut f: Vec<Vec<i64>> = Vec::with_capacity(k_max + 1);
    let mut f0 = vec![INF; n];
    for &s in &origin_stops { f0[s as usize] = depart_sec + origin_walk[s as usize]; }
    f.push(f0);

    let mut marked: Vec<u32> = origin_stops.clone();
    for k in 1..=k_max {
        let prev = f[k - 1].clone();
        let mut cur = prev.clone();
        let mut is_marked = vec![false; n];
        for &s in &marked { is_marked[s as usize] = true; }

        let mut first_pos = vec![u32::MAX; index.patterns.len()];
        let mut touched: Vec<u32> = Vec::new();
        for &s in &marked {
            for &(pidx, pos) in &index.by_stop[s as usize] {
                let e = &mut first_pos[pidx as usize];
                if *e == u32::MAX { touched.push(pidx); }
                if pos < *e { *e = pos; }
            }
        }

        let mut is_new = vec![false; n];
        let mut newly: Vec<u32> = Vec::new();
        for &pidx in &touched {
            let start_pos = first_pos[pidx as usize];
            let pat = &index.patterns[pidx as usize];
            let mut base = INF;
            for i in (start_pos as usize)..pat.stops.len() {
                let st = pat.stops[i];
                let spk = st.stop_pk as usize;
                if is_marked[spk] && prev[spk] < INF {
                    let xfer = if prev[spk] < f[0][spk] { penalty } else { 0 };
                    let b = prev[spk] + xfer + waits.wait(pidx as usize, prev[spk]) - st.cum_sec;
                    if b < base { base = b; }
                }
                if base < INF {
                    let cand = base + st.cum_sec;
                    if cand < cur[spk] {
                        cur[spk] = cand;
                        if !is_new[spk] { is_new[spk] = true; newly.push(spk as u32); }
                    }
                }
            }
        }
        let riding_improved = newly.len();
        for ni in 0..riding_improved {
            let s = newly[ni] as i64;
            let Some(edges) = graph.adjacency.get(&s) else { continue };
            let arr_s = cur[s as usize];
            for e in edges {
                if e.kind != EdgeKind::Walk || e.distance_m > max_walk_distance_m { continue; }
                let t = e.to;
                if t < 0 || t as usize >= n { continue; }
                let arr = arr_s + walk_time_sec(e.distance_m, walking_speed_mps);
                if arr < cur[t as usize] {
                    cur[t as usize] = arr;
                    if !is_new[t as usize] { is_new[t as usize] = true; newly.push(t as u32); }
                }
            }
        }
        marked = newly;
        f.push(cur);
        if marked.is_empty() {
            while f.len() < k_max + 1 { let last = f.last().unwrap().clone(); f.push(last); }
            break;
        }
    }

    // ── Best estimated arrival per leg count (transit must actually help) ──
    let mut best_arrival: Vec<i64> = vec![INF; k_max + 1]; // index = legs
    for l in 1..=k_max {
        for &s in &dest_stops {
            let su = s as usize;
            if f[l][su] < INF && f[l][su] < f[0][su] {
                let arr = f[l][su] + dest_walk[su];
                if arr < best_arrival[l] { best_arrival[l] = arr; }
            }
        }
    }
    let overall_best = best_arrival.iter().copied().skip(1).min().unwrap_or(INF);
    if overall_best >= INF { return None; }
    let mid_time = depart_sec + (overall_best - depart_sec).max(0) / 2;
    let t_fwd = t_fwd_start.elapsed().as_millis() as i64;
    let t_bwd_start = Instant::now();

    // ── Backward: b[k][stop] = least remaining time using <= k legs ─────
    let mut b: Vec<Vec<i64>> = Vec::with_capacity(k_max);
    let mut b0 = vec![INF; n];
    for &s in &dest_stops { b0[s as usize] = dest_walk[s as usize]; }
    b.push(b0.clone());
    let mut marked: Vec<u32> = dest_stops.clone();
    for _k in 1..k_max {
        let prev = b.last().unwrap().clone();
        let mut cur = prev.clone();
        let mut is_marked = vec![false; n];
        for &s in &marked { is_marked[s as usize] = true; }

        let mut last_pos = vec![u32::MAX; index.patterns.len()];
        let mut touched: Vec<u32> = Vec::new();
        for &s in &marked {
            for &(pidx, pos) in &index.by_stop[s as usize] {
                let e = &mut last_pos[pidx as usize];
                if *e == u32::MAX { touched.push(pidx); *e = pos; } else if pos > *e { *e = pos; }
            }
        }

        let mut is_new = vec![false; n];
        let mut newly: Vec<u32> = Vec::new();
        for &pidx in &touched {
            let end_pos = last_pos[pidx as usize];
            let pat = &index.patterns[pidx as usize];
            let wait = waits.wait(pidx as usize, mid_time);
            let mut best_tail = INF; // min over later marked j of (cum_j + remaining_j)
            for i in (0..=(end_pos as usize)).rev() {
                let st = pat.stops[i];
                let spk = st.stop_pk as usize;
                if best_tail < INF {
                    let cand = wait + best_tail - st.cum_sec;
                    if cand < cur[spk] {
                        cur[spk] = cand;
                        if !is_new[spk] { is_new[spk] = true; newly.push(spk as u32); }
                    }
                }
                if is_marked[spk] && prev[spk] < INF {
                    let xfer = if prev[spk] < b0[spk] { penalty } else { 0 };
                    let t = st.cum_sec + prev[spk] + xfer;
                    if t < best_tail { best_tail = t; }
                }
            }
        }
        let riding_improved = newly.len();
        for ni in 0..riding_improved {
            let s = newly[ni] as i64;
            let Some(edges) = graph.adjacency.get(&s) else { continue };
            let rem_s = cur[s as usize];
            for e in edges {
                if e.kind != EdgeKind::Walk || e.distance_m > max_walk_distance_m { continue; }
                let t = e.to;
                if t < 0 || t as usize >= n { continue; }
                let cand = rem_s + walk_time_sec(e.distance_m, walking_speed_mps);
                if cand < cur[t as usize] {
                    cur[t as usize] = cand;
                    if !is_new[t as usize] { is_new[t as usize] = true; newly.push(t as u32); }
                }
            }
        }
        marked = newly;
        b.push(cur);
        if marked.is_empty() {
            while b.len() < k_max { let last = b.last().unwrap().clone(); b.push(last); }
            break;
        }
    }

    let t_bwd = t_bwd_start.elapsed().as_millis() as i64;
    let t_sel_start = Instant::now();

    // ── Select patterns ─────────────────────────────────────────────────
    // A pattern can only qualify if minF + minB (the best forward label and the
    // best backward label anywhere on it — ride and waits only add to that) is
    // within the most generous (best_L + margin_L). Computing both is one
    // sequential pass per pattern, and skips the (pattern x k1 x k2) scans for
    // patterns nowhere near the origin->destination corridor.
    let generous_total = (1..=k_max)
        .filter(|&l| best_arrival[l] < INF)
        .map(|l| best_arrival[l] + margin_for(best_arrival[l] - depart_sec))
        .max()
        .unwrap_or(INF);
    let f_all = &f[k_max];
    let b_all = &b[k_max - 1];
    let mut scanned_patterns = 0i64;
    // Loop order is (pattern, k1) outer so the boarding side (prefix-min of
    // f-derived "effective start") is computed ONCE per (pattern, k1) and
    // reused for every k2, instead of being recomputed per (k1, k2).
    let mut best_slack: HashMap<i64, i64> = HashMap::new();
    let mut seg: HashMap<i64, (usize, usize)> = HashMap::new(); // pattern_pk -> (min board pos, max alight pos)
    let mut prefix: Vec<(i64, usize)> = Vec::new(); // per position: (best base among i < j, its position)

    for (pidx, pat) in index.patterns.iter().enumerate() {
        let (mut min_f, mut min_b) = (INF, INF);
        for st in &pat.stops {
            let spk = st.stop_pk as usize;
            if f_all[spk] < min_f { min_f = f_all[spk]; }
            if b_all[spk] < min_b { min_b = b_all[spk]; }
        }
        if min_f >= INF || min_b >= INF || min_f + min_b > generous_total { continue; }
        scanned_patterns += 1;
        for k1 in 0..k_max {
            let fk = &f[k1];
            prefix.clear();
            let mut base = INF;
            let mut base_pos = 0usize;
            let mut any = false;
            for (j, st) in pat.stops.iter().enumerate() {
                prefix.push((base, base_pos)); // boarding strictly before j
                let spk = st.stop_pk as usize;
                if fk[spk] < INF {
                    let xfer = if fk[spk] < f[0][spk] { penalty } else { 0 };
                    let bb = fk[spk] + xfer + waits.wait(pidx, fk[spk]) - st.cum_sec;
                    if bb < base { base = bb; base_pos = j; any = true; }
                }
            }
            if !any { continue; }

            for k2 in 0..(k_max - k1) {
                let l = k1 + 1 + k2;
                let best_l = best_arrival[l];
                if best_l >= INF { continue; }
                let margin = margin_for(best_l - depart_sec);
                let bk = &b[k2];
                for (j, st) in pat.stops.iter().enumerate() {
                    let (pbase, ppos) = prefix[j];
                    if pbase >= INF { continue; }
                    let spk = st.stop_pk as usize;
                    if bk[spk] >= INF { continue; }
                    let xfer = if bk[spk] < b0[spk] { penalty } else { 0 };
                    let total = pbase + st.cum_sec + bk[spk] + xfer;
                    let slack = total - best_l;
                    if slack <= margin {
                        let e = best_slack.entry(pat.pattern_pk).or_insert(i64::MAX);
                        if slack < *e { *e = slack; }
                        let sg = seg.entry(pat.pattern_pk).or_insert((ppos, j));
                        if ppos < sg.0 { sg.0 = ppos; }
                        if j > sg.1 { sg.1 = j; }
                    }
                }
            }
        }
    }

    let mut ranked: Vec<TimeCorridorPattern> = best_slack
        .into_iter()
        .map(|(pattern_pk, slack)| TimeCorridorPattern { pattern_pk, slack_sec: slack.max(0) })
        .collect();
    ranked.sort_by(|a, b| a.slack_sec.cmp(&b.slack_sec).then(a.pattern_pk.cmp(&b.pattern_pk)));

    let mut stops_by_pattern: HashMap<i64, Vec<i64>> = HashMap::new();
    for r in &ranked {
        let Some(&(lo, hi)) = seg.get(&r.pattern_pk) else { continue };
        let Some(&pidx) = index.idx_of_pk.get(&r.pattern_pk) else { continue };
        let pat = &index.patterns[pidx];
        let lo = lo.saturating_sub(TIME_CORRIDOR_SEGMENT_MARGIN_STOPS);
        let hi = (hi + TIME_CORRIDOR_SEGMENT_MARGIN_STOPS).min(pat.stops.len() - 1);
        stops_by_pattern.insert(r.pattern_pk, pat.stops[lo..=hi].iter().map(|s| s.stop_pk).collect());
    }

    let best_arrival_by_legs: Vec<Option<i64>> =
        (1..=k_max).map(|l| if best_arrival[l] < INF { Some(best_arrival[l]) } else { None }).collect();

    let t_sel = t_sel_start.elapsed().as_millis() as i64;
    let _ = scanned_patterns;
    Some(TimeCorridorResult {
        ranked,
        stops_by_pattern,
        best_arrival_by_legs,
        elapsed_ms: t0.elapsed().as_millis() as i64,
        phase_ms: vec![("walk_in", t_walk), ("forward", t_fwd), ("backward", t_bwd), ("select", t_sel)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::StopRow;

    fn stop(pk: i64, lat: f64, lon: f64) -> StopRow {
        StopRow { stop_pk: pk, stop_id: pk.to_string(), stop_name: pk.to_string(), stop_lat: lat, stop_lon: lon, agency: 1 }
    }
    fn rows(pattern_pk: i64, stop_pks: &[i64]) -> Vec<PatternStopRow> {
        stop_pks.iter().enumerate()
            .map(|(i, &s)| PatternStopRow { pattern_pk, stop_pk: s, stop_sequence: i as i64 + 1 })
            .collect()
    }

    /// Stops 1..3 on a line ~1.1km apart (origin at 1, destination at 3);
    /// 4 is a small detour; 5,6 are ~110km away; 9-11 are a huge detour.
    fn world() -> (StopsCache, Vec<PatternStopRow>) {
        let stops = StopsCache::for_test(vec![
            stop(1, -37.800, 144.90), stop(2, -37.810, 144.90), stop(3, -37.820, 144.90),
            stop(4, -37.810, 144.92),
            stop(5, -36.800, 144.90), stop(6, -36.810, 144.90),
            stop(9, -37.810, 145.40), stop(10, -37.900, 145.40), stop(11, -37.900, 144.90),
        ]);
        let mut r = Vec::new();
        r.extend(rows(1, &[1, 2, 3]));            // direct
        r.extend(rows(2, &[1, 4, 3]));            // small detour, still competitive
        r.extend(rows(3, &[5, 6]));               // unrelated, far away
        r.extend(rows(8, &[1, 9, 10, 11, 3]));    // enormous detour
        (stops, r)
    }

    #[test]
    fn keeps_competitive_patterns_and_drops_far_or_slow_ones() {
        let (stops, r) = world();
        let hops = PatternHopsCache::empty_for_test();
        let headway = PatternHeadwayCache::empty_for_test();
        let index = TimeCorridorIndex::build(&r, &hops, &stops);
        let graph = CoarseGraph::new(HashMap::new());

        let res = compute(
            &index, &graph, &stops, &headway,
            LatLon { lat: -37.800, lon: 144.90 }, LatLon { lat: -37.820, lon: 144.90 },
            9 * 3600, 1.4, 300.0,
        ).expect("should connect");

        let pks: Vec<i64> = res.ranked.iter().map(|p| p.pattern_pk).collect();
        assert!(pks.contains(&1), "direct pattern must qualify: {pks:?}");
        assert!(pks.contains(&2), "small-detour pattern is within margin: {pks:?}");
        assert!(!pks.contains(&3), "unreachable far pattern must not qualify: {pks:?}");
        assert!(!pks.contains(&8), "enormous-detour pattern must not qualify: {pks:?}");
        assert_eq!(pks[0], 1, "best slack first");
        assert!(res.best_arrival_by_legs[0].is_some());
        // Segment stops for the direct pattern cover its whole (short) ride.
        assert_eq!(res.stops_by_pattern[&1], vec![1, 2, 3]);
    }

    #[test]
    fn unreachable_destination_returns_none() {
        let (stops, r) = world();
        let hops = PatternHopsCache::empty_for_test();
        let headway = PatternHeadwayCache::empty_for_test();
        let index = TimeCorridorIndex::build(&r, &hops, &stops);
        let graph = CoarseGraph::new(HashMap::new());
        // Destination next to stop 6, origin next to stop 1: no pattern links them.
        let res = compute(
            &index, &graph, &stops, &headway,
            LatLon { lat: -37.800, lon: 144.90 }, LatLon { lat: -36.810, lon: 144.90 },
            9 * 3600, 1.4, 300.0,
        );
        assert!(res.is_none());
    }

    #[test]
    fn keeps_slow_direct_and_fast_transfer_options_side_by_side() {
        // A slow 1-leg option and a faster 2-leg option are BOTH useful: the
        // qualifying rule is relative to the best estimate for each leg count.
        let stops = StopsCache::for_test(vec![
            stop(1, -37.800, 144.90), stop(3, -37.820, 144.90), stop(40, -37.810, 144.90),
            stop(50, -37.810, 145.60), stop(51, -37.900, 145.60),
        ]);
        let mut r = Vec::new();
        r.extend(rows(20, &[1, 50, 51, 3])); // slow direct
        r.extend(rows(21, &[1, 40]));        // leg 1 of the transfer route
        r.extend(rows(22, &[40, 3]));        // leg 2
        let index = TimeCorridorIndex::build(&r, &PatternHopsCache::empty_for_test(), &stops);
        let res = compute(
            &index, &CoarseGraph::new(HashMap::new()), &stops, &PatternHeadwayCache::empty_for_test(),
            LatLon { lat: -37.800, lon: 144.90 }, LatLon { lat: -37.820, lon: 144.90 },
            9 * 3600, 1.4, 300.0,
        ).expect("should connect");
        let pks: Vec<i64> = res.ranked.iter().map(|p| p.pattern_pk).collect();
        assert!(pks.contains(&20), "slow direct option should survive as the 1-leg option: {pks:?}");
        assert!(pks.contains(&21) && pks.contains(&22), "fast transfer option should survive: {pks:?}");
        let (one_leg, two_leg) = (res.best_arrival_by_legs[0].unwrap(), res.best_arrival_by_legs[1].unwrap());
        assert!(two_leg < one_leg, "transfer route should be estimated faster than the slow direct one");
    }

    /// Rough scale check on a synthetic feed the size of the real one
    /// (~29k stops, 4,649 patterns x ~32 stops). Run with:
    ///   cargo test --release --lib time_corridor::tests::synthetic_scale -- --ignored --nocapture
    #[test]
    #[ignore]
    fn synthetic_scale_timing() {
        let side = 170i64; // 170x170 = 28,900 stops
        let mut st = Vec::new();
        for y in 0..side { for x in 0..side {
            st.push(stop(y * side + x + 1, -38.2 + y as f64 * 0.004, 144.5 + x as f64 * 0.004));
        } }
        let stops = StopsCache::for_test(st);
        let mut r = Vec::new();
        let mut seed = 12345u64;
        let mut next = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) as i64 };
        for p in 0..4649i64 {
            let horizontal = next() % 2 == 0;
            let a = next() % side; let start = next() % (side - 32);
            let pks: Vec<i64> = (0..32).map(|i| if horizontal { a * side + start + i + 1 } else { (start + i) * side + a + 1 }).collect();
            r.extend(rows(p + 1, &pks));
        }
        let index = TimeCorridorIndex::build(&r, &PatternHopsCache::empty_for_test(), &stops);
        let graph = CoarseGraph::new(HashMap::new());
        let headway = PatternHeadwayCache::from_rows_for_test(
            (1..=4649i64).map(|p| (p, vec![(0, Some(3600)), (1, Some(1200)), (2, Some(600))])).collect(),
        );
        // Several origin/destination pairs (a random sparse grid won't connect all of them).
        for (o, d) in [((-38.0, 144.7), (-37.9, 144.9)), ((-37.9, 144.6), (-37.7, 144.9)), ((-38.1, 144.8), (-37.8, 144.7)), ((-37.95, 144.75), (-37.85, 144.65))] {
            let t = Instant::now();
            let res = compute(&index, &graph, &stops, &headway,
                LatLon { lat: o.0, lon: o.1 }, LatLon { lat: d.0, lon: d.1 }, 12 * 3600, 1.4, 1200.0);
            println!("compute: {:?}ms, result: {:?}", t.elapsed().as_millis(), res.as_ref().map(|r| (r.ranked.len(), r.best_arrival_by_legs.clone())));
        }
    }

    #[test]
    fn rows_for_patterns_round_trips_sequences() {
        let (stops, r) = world();
        let index = TimeCorridorIndex::build(&r, &PatternHopsCache::empty_for_test(), &stops);
        let got = index.rows_for_patterns(&[2]);
        assert_eq!(got.iter().map(|x| (x.stop_pk, x.stop_sequence)).collect::<Vec<_>>(), vec![(1, 1), (4, 2), (3, 3)]);
    }
}
