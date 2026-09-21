//! graph/coarse.rs — port of services/gtfs/graph/coarseGraph.ts.
//!
//! Answers "does any trip, on any day, ever go directly from stop A to stop
//! B?" (existence only) plus "can you walk between A and B?" — enough to
//! BFS a corridor shape; deliberately NOT schedule-aware (no
//! service_id/calendar/date), same reasoning as the TS version.
//!
//! Nodes are `stop_pk: i64` directly (see repo.rs's module doc for why this
//! port drops the TS composite string-key layer).

use std::collections::{HashMap, HashSet};
use crate::geo::{haversine_meters, LatLon};
use crate::repo::{PatternCumulativeCache, PatternStopRow, PatternsCache, StopsCache};
use crate::settings::{FULL_CLIQUE_MAX_STOPS, STRIDE_TARGET_SAMPLES, WALK_EDGE_THRESHOLD_M};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Transit,
    Walk,
}

#[derive(Debug, Clone)]
pub struct CoarseEdge {
    pub to: i64,
    pub kind: EdgeKind,
    pub cost: f64, // 1.0 transit, 0.5 walk — kept explicit for RAPTOR/BFS scoring, though it's fully derived from `kind`
    /// Real haversine distance in meters for Walk-kind edges; 0.0 for
    /// Transit (meaningless there — transit "distance" isn't a walk
    /// distance, and nothing reads this field for Transit edges).
    /// Previously computed and then discarded (only the WALK_EDGE_THRESHOLD_M
    /// comparison used it) — now retained so freq_raptor's walk-relax step
    /// and any query-time consumer can get a real walk-time estimate
    /// straight from this already-resident structure instead of
    /// rebuilding a footpath grid per search (see freq_raptor.rs's module
    /// doc for why this consolidation matters).
    pub distance_m: f64,
    /// pattern_pk this transit edge came from — None for walk edges. Same
    /// debug-overlay purpose as the TS version's viaPatternKey: lets a
    /// debug view draw the actual line's real stop sequence instead of a
    /// meaningless straight clique edge.
    pub via_pattern: Option<i64>,
}

pub struct CoarseGraph {
    pub adjacency: HashMap<i64, Vec<CoarseEdge>>,
    /// Transit-only reverse index: for every forward transit edge `u -> v`
    /// in `adjacency`, this holds `v -> u`. Built once (not persisted —
    /// trivially re-derivable in one O(E) pass, not worth a second DB
    /// table/signature to keep in sync).
    ///
    /// This does NOT let a one-way line be boarded backwards: it's a
    /// lookup of "who has an edge landing on me", used only by the
    /// destination-side half of a bidirectional search to ask "which stops
    /// can reach me going forward along a real line" — same edge set as
    /// `adjacency`, just re-keyed. A genuinely one-way line (only ever
    /// emits `i -> j` for `i < j` in `flush_pattern`) still only ever
    /// produces reverse entries mirroring that same one direction.
    ///
    /// Walk edges are excluded — `build_adjacency_from_scratch` already
    /// inserts them symmetrically (`a -> b` AND `b -> a`), so forward
    /// `adjacency` alone already answers "who can walk to me".
    pub reverse_transit: HashMap<i64, Vec<CoarseEdge>>,
    /// Exact stop -> (line, terminus) index: for every pattern serving the
    /// stop, its `PatternsCache::line_key` and the pattern's LAST stop_pk (a
    /// direction proxy — opposite-direction platforms of one line have
    /// different termini, so they are not treated as redundant). Sorted, unique. Built once at warm-up; used by the
    /// BFS walk step's greedy cover. Empty (=> cover disabled) when not set.
    pub stop_lines: HashMap<i64, Vec<(i64, i64)>>,
}

impl CoarseGraph {
    pub fn new(adjacency: HashMap<i64, Vec<CoarseEdge>>) -> Self {
        let mut reverse_transit: HashMap<i64, Vec<CoarseEdge>> = HashMap::new();
        for (&from, edges) in &adjacency {
            for e in edges {
                if e.kind != EdgeKind::Transit { continue; }
                reverse_transit.entry(e.to).or_default().push(CoarseEdge {
                    to: from,
                    kind: EdgeKind::Transit,
                    cost: e.cost,
                    distance_m: 0.0,
                    via_pattern: e.via_pattern,
                });
            }
        }
        CoarseGraph { adjacency, reverse_transit, stop_lines: HashMap::new() }
    }

    pub fn with_stop_lines(mut self, stop_lines: HashMap<i64, Vec<(i64, i64)>>) -> Self {
        self.stop_lines = stop_lines;
        self
    }
}

/// Exact stop -> (line, terminus) index from the ordered pattern_stops rows.
pub fn build_stop_lines(pattern_stops: &[PatternStopRow], patterns: &PatternsCache) -> HashMap<i64, Vec<(i64, i64)>> {
    let mut out: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    let mut i = 0usize;
    while i < pattern_stops.len() {
        let pk = pattern_stops[i].pattern_pk;
        let mut j = i;
        while j < pattern_stops.len() && pattern_stops[j].pattern_pk == pk { j += 1; }
        let line = patterns.line_key(pk);
        let terminus = pattern_stops[j - 1].stop_pk;
        for r in &pattern_stops[i..j] {
            out.entry(r.stop_pk).or_default().push((line, terminus));
        }
        i = j;
    }
    for v in out.values_mut() { v.sort_unstable(); v.dedup(); }
    out
}

/// Grid bucket size for walking-edge dedup. Derived from
/// WALK_EDGE_THRESHOLD_M (same `radius/111_000*1.1` shape raptor.rs used
/// for its own speed-scaled footpath grid) rather than a fixed constant —
/// this used to be hardcoded at 0.006 with a comment warning it "must
/// stay >= WALK_EDGE_THRESHOLD_M or the 3x3-neighbor-cell scan can miss
/// real neighbors", which was fine while that threshold was a small fixed
/// 450m but silently breaks the moment it's raised. Deriving it removes
/// the hand-sync duty entirely.
fn grid_cell_deg() -> f64 {
    (WALK_EDGE_THRESHOLD_M / 111_000.0 * 1.1).max(0.006)
}

/// Full from-scratch build: per-line transit cliques + spatially-bucketed
/// walking edges. O(k^2) per pattern below FULL_CLIQUE_MAX_STOPS, stride-
/// sampled above it — identical strategy to buildAdjacencyFromScratch.
///
/// PER-LINE: transit edges are deduped on `(from, to, line)` where `line` is
/// `PatternsCache::line_key`, so a stop pair served by several routes keeps
/// one edge per route (previously the first pattern seen won and every other
/// route between the same two stops was invisible to the BFS). When several
/// patterns of one route serve the same stop pair, the edge's `via_pattern`
/// is the one with the FASTEST ride time between the two stops
/// (`cumulative`), so express / short-turn variants are not scored
/// pessimistically by an all-stops variant.
pub fn build_adjacency_from_scratch(
    stops: &StopsCache,
    pattern_stops_ordered: &[PatternStopRow],
    patterns: &PatternsCache,
    cumulative: &PatternCumulativeCache,
) -> HashMap<i64, Vec<CoarseEdge>> {
    let mut adjacency: HashMap<i64, Vec<CoarseEdge>> = HashMap::new();
    // (from, kind_tag, to, line) -> (index into adjacency[from], best ride sec).
    // Walk edges use line = i64::MIN (they have no line).
    let mut edge_keys: HashMap<(i64, u8, i64, i64), (usize, f64)> = HashMap::new();

    let mut add_edge = |adjacency: &mut HashMap<i64, Vec<CoarseEdge>>, from: i64, edge: CoarseEdge, line: i64, ride_sec: f64| {
        if from == edge.to { return; } // never a self-loop
        let tag = match edge.kind { EdgeKind::Transit => 0u8, EdgeKind::Walk => 1u8 };
        let key = (from, tag, edge.to, line);
        if let Some(&(idx, best)) = edge_keys.get(&key) {
            if ride_sec < best {
                if let Some(slot) = adjacency.get_mut(&from).and_then(|v| v.get_mut(idx)) {
                    slot.via_pattern = edge.via_pattern;
                }
                edge_keys.insert(key, (idx, ride_sec));
            }
            return;
        }
        let list = adjacency.entry(from).or_default();
        edge_keys.insert(key, (list.len(), ride_sec));
        list.push(edge);
    };

    // ── Transit edges: per-LINE, direction-respecting ──────────────────
    // patternStopKeys is ordered by real stop_sequence (query guarantees
    // this), so i < j always means genuinely earlier in the pattern's real
    // direction of travel — only ever emit i -> j, never j -> i. See the TS
    // version's long comment on the reachability bug this fixes.
    let mut i = 0usize;
    while i < pattern_stops_ordered.len() {
        let pattern_pk = pattern_stops_ordered[i].pattern_pk;
        let mut j = i;
        while j < pattern_stops_ordered.len() && pattern_stops_ordered[j].pattern_pk == pattern_pk {
            j += 1;
        }
        let group = &pattern_stops_ordered[i..j];
        flush_pattern(&mut adjacency, &mut add_edge, pattern_pk, patterns.line_key(pattern_pk), cumulative, group);
        i = j;
    }

    // ── Walking edges: spatially bucketed, not O(n^2) ───────────────────
    let cell_of = |lat: f64, lon: f64| -> (i64, i64) {
        ((lat / grid_cell_deg()).floor() as i64, (lon / grid_cell_deg()).floor() as i64)
    };
    let mut grid: HashMap<(i64, i64), Vec<i64>> = HashMap::new(); // cell -> stop_pks
    for s in stops.iter() {
        grid.entry(cell_of(s.stop_lat, s.stop_lon)).or_default().push(s.stop_pk);
    }

    for s in stops.iter() {
        let (cy, cx) = cell_of(s.stop_lat, s.stop_lon);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let Some(neighbors) = grid.get(&(cy + dy, cx + dx)) else { continue };
                for &other_pk in neighbors {
                    if other_pk == s.stop_pk { continue; }
                    // Only compute each pair once (canonical ordering by pk).
                    if other_pk <= s.stop_pk { continue; }
                    let Some(other) = stops.get(other_pk) else { continue };
                    let d = haversine_meters(
                        LatLon { lat: s.stop_lat, lon: s.stop_lon },
                        LatLon { lat: other.stop_lat, lon: other.stop_lon },
                    );
                    if d <= WALK_EDGE_THRESHOLD_M {
                        add_edge(&mut adjacency, s.stop_pk, CoarseEdge { to: other_pk, kind: EdgeKind::Walk, cost: 0.5, distance_m: d, via_pattern: None }, i64::MIN, 0.0);
                        add_edge(&mut adjacency, other_pk, CoarseEdge { to: s.stop_pk, kind: EdgeKind::Walk, cost: 0.5, distance_m: d, via_pattern: None }, i64::MIN, 0.0);
                    }
                }
            }
        }
    }

    adjacency
}

fn flush_pattern(
    adjacency: &mut HashMap<i64, Vec<CoarseEdge>>,
    add_edge: &mut impl FnMut(&mut HashMap<i64, Vec<CoarseEdge>>, i64, CoarseEdge, i64, f64),
    pattern_pk: i64,
    line: i64,
    cumulative: &PatternCumulativeCache,
    group: &[PatternStopRow],
) {
    let n = group.len();
    if n < 2 { return; }
    let stop_at = |idx: usize| group[idx].stop_pk;
    // In-vehicle seconds from stop i to stop j along this pattern; a huge
    // value when unknown so any pattern with real data wins the tie-break.
    let ride = |i: usize, j: usize| -> f64 {
        match (cumulative.cumulative_sec(pattern_pk, stop_at(i)), cumulative.cumulative_sec(pattern_pk, stop_at(j))) {
            (Some(a), Some(b)) if b >= a => (b - a) as f64,
            _ => 1.0e12,
        }
    };

    if n <= FULL_CLIQUE_MAX_STOPS {
        for i in 0..n {
            for j in (i + 1)..n {
                add_edge(adjacency, stop_at(i), CoarseEdge {
                    to: stop_at(j), kind: EdgeKind::Transit, cost: 1.0, distance_m: 0.0, via_pattern: Some(pattern_pk),
                }, line, ride(i, j));
            }
        }
    } else {
        let stride = (n / STRIDE_TARGET_SAMPLES).max(1);
        let mut sample_idx: Vec<usize> = (0..n).step_by(stride).collect();
        if !sample_idx.contains(&0) { sample_idx.push(0); }
        if !sample_idx.contains(&(n - 1)) { sample_idx.push(n - 1); }
        sample_idx.sort_unstable();
        sample_idx.dedup();

        // NOTE: this only emits edges from every stop to the SAMPLED stops
        // after it — two stops that are both between two sample points
        // (and neither one itself sampled) never get a direct coarse-graph
        // edge here, only indirect reachability via a nearby sampled stop.
        // Intentional (keeps clique size bounded for long patterns), and
        // fine in practice since the coarse graph only drives corridor-shape
        // BFS, not final RAPTOR boarding — flagged so it isn't mistaken for
        // a bug later.
        for i in 0..n {
            for &j in &sample_idx {
                if j <= i { continue; } // direction-respecting
                add_edge(adjacency, stop_at(i), CoarseEdge {
                    to: stop_at(j), kind: EdgeKind::Transit, cost: 1.0, distance_m: 0.0, via_pattern: Some(pattern_pk),
                }, line, ride(i, j));
            }
        }
    }
}

#[cfg(test)]
mod per_line_tests {
    use super::*;
    use crate::repo::StopRow;

    fn stop(pk: i64, lat: f64) -> StopRow {
        StopRow { stop_pk: pk, stop_id: pk.to_string(), stop_name: format!("s{pk}"), stop_lat: lat, stop_lon: 144.0, agency: 1 }
    }
    fn row(pattern_pk: i64, stop_pk: i64, seq: i64) -> PatternStopRow {
        PatternStopRow { pattern_pk, stop_pk, stop_sequence: seq }
    }
    fn transit(adj: &HashMap<i64, Vec<CoarseEdge>>, from: i64, to: i64) -> Vec<i64> {
        let mut v: Vec<i64> = adj.get(&from).map(|es| es.iter()
            .filter(|e| e.kind == EdgeKind::Transit && e.to == to)
            .filter_map(|e| e.via_pattern).collect()).unwrap_or_default();
        v.sort();
        v
    }

    // Stops 1..3 are ~10 km apart so no walk edges interfere.
    fn stops() -> StopsCache { StopsCache::for_test(vec![stop(1, -37.0), stop(2, -37.1), stop(3, -37.2)]) }

    #[test]
    fn two_routes_over_same_pair_keep_two_edges() {
        // pattern 10 -> route 0, pattern 11 -> route 1; both run 1 -> 2.
        let patterns = PatternsCache::for_test(vec![(10, Some(0)), (11, Some(1))]);
        let cum = PatternCumulativeCache::from_rows_for_test(vec![((10, 1), 0), ((10, 2), 300), ((11, 1), 0), ((11, 2), 500)]);
        let rows = vec![row(10, 1, 1), row(10, 2, 2), row(11, 1, 1), row(11, 2, 2)];
        let adj = build_adjacency_from_scratch(&stops(), &rows, &patterns, &cum);
        assert_eq!(transit(&adj, 1, 2), vec![10, 11]);
    }

    #[test]
    fn same_route_keeps_fastest_pattern_per_pair() {
        // Both patterns are route 0. Pattern 10 stops at 2 (slow 1->3); pattern 11 skips 2 (express).
        let patterns = PatternsCache::for_test(vec![(10, Some(0)), (11, Some(0))]);
        let cum = PatternCumulativeCache::from_rows_for_test(vec![
            ((10, 1), 0), ((10, 2), 400), ((10, 3), 900),
            ((11, 1), 0), ((11, 3), 600),
        ]);
        let rows = vec![row(10, 1, 1), row(10, 2, 2), row(10, 3, 3), row(11, 1, 1), row(11, 3, 2)];
        let adj = build_adjacency_from_scratch(&stops(), &rows, &patterns, &cum);
        assert_eq!(transit(&adj, 1, 3), vec![11]); // express wins, exactly one edge
        assert_eq!(transit(&adj, 1, 2), vec![10]); // only the all-stops pattern serves 1 -> 2
    }

    #[test]
    fn reverse_transit_keeps_every_line() {
        let patterns = PatternsCache::for_test(vec![(10, Some(0)), (11, Some(1))]);
        let cum = PatternCumulativeCache::from_rows_for_test(vec![((10, 1), 0), ((10, 2), 300), ((11, 1), 0), ((11, 2), 500)]);
        let rows = vec![row(10, 1, 1), row(10, 2, 2), row(11, 1, 1), row(11, 2, 2)];
        let g = CoarseGraph::new(build_adjacency_from_scratch(&stops(), &rows, &patterns, &cum));
        let mut via: Vec<i64> = g.reverse_transit.get(&2).unwrap().iter().filter_map(|e| e.via_pattern).collect();
        via.sort();
        assert_eq!(via, vec![10, 11]);
    }
}
