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
use crate::repo::{PatternStopRow, StopsCache};
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
    /// pattern_pk this transit edge came from — None for walk edges. Same
    /// debug-overlay purpose as the TS version's viaPatternKey: lets a
    /// debug view draw the actual line's real stop sequence instead of a
    /// meaningless straight clique edge.
    pub via_pattern: Option<i64>,
}

pub struct CoarseGraph {
    pub adjacency: HashMap<i64, Vec<CoarseEdge>>,
}

/// Grid bucket size for walking-edge dedup — same fixed Melbourne-latitude
/// constant the TS version hardcodes, with the same caveat: not wired to
/// WALK_EDGE_THRESHOLD_M, must stay >= it or the 3x3-neighbor-cell scan can
/// miss real neighbors.
const GRID_CELL_DEG: f64 = 0.006;

/// Full from-scratch build: per-line transit cliques + spatially-bucketed
/// walking edges. O(k^2) per pattern below FULL_CLIQUE_MAX_STOPS, stride-
/// sampled above it — identical strategy to buildAdjacencyFromScratch.
pub fn build_adjacency_from_scratch(
    stops: &StopsCache,
    pattern_stops_ordered: &[PatternStopRow],
) -> HashMap<i64, Vec<CoarseEdge>> {
    let mut adjacency: HashMap<i64, Vec<CoarseEdge>> = HashMap::new();
    // (from, kind_tag, to) dedup set — kind_tag distinguishes transit vs
    // walk edges to the same neighbor, mirroring the TS `${kind}:${to}` key.
    let mut edge_keys: HashSet<(i64, u8, i64)> = HashSet::new();

    let mut add_edge = |adjacency: &mut HashMap<i64, Vec<CoarseEdge>>, from: i64, edge: CoarseEdge| {
        if from == edge.to { return; } // never a self-loop
        let tag = match edge.kind { EdgeKind::Transit => 0u8, EdgeKind::Walk => 1u8 };
        if !edge_keys.insert((from, tag, edge.to)) { return; }
        adjacency.entry(from).or_default().push(edge);
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
        flush_pattern(&mut adjacency, &mut add_edge, pattern_pk, group);
        i = j;
    }

    // ── Walking edges: spatially bucketed, not O(n^2) ───────────────────
    let cell_of = |lat: f64, lon: f64| -> (i64, i64) {
        ((lat / GRID_CELL_DEG).floor() as i64, (lon / GRID_CELL_DEG).floor() as i64)
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
                        add_edge(&mut adjacency, s.stop_pk, CoarseEdge { to: other_pk, kind: EdgeKind::Walk, cost: 0.5, via_pattern: None });
                        add_edge(&mut adjacency, other_pk, CoarseEdge { to: s.stop_pk, kind: EdgeKind::Walk, cost: 0.5, via_pattern: None });
                    }
                }
            }
        }
    }

    adjacency
}

fn flush_pattern(
    adjacency: &mut HashMap<i64, Vec<CoarseEdge>>,
    add_edge: &mut impl FnMut(&mut HashMap<i64, Vec<CoarseEdge>>, i64, CoarseEdge),
    pattern_pk: i64,
    group: &[PatternStopRow],
) {
    let n = group.len();
    if n < 2 { return; }
    let stop_at = |idx: usize| group[idx].stop_pk;

    if n <= FULL_CLIQUE_MAX_STOPS {
        for i in 0..n {
            for j in (i + 1)..n {
                add_edge(adjacency, stop_at(i), CoarseEdge {
                    to: stop_at(j), kind: EdgeKind::Transit, cost: 1.0, via_pattern: Some(pattern_pk),
                });
            }
        }
    } else {
        let stride = (n / STRIDE_TARGET_SAMPLES).max(1);
        let mut sample_idx: Vec<usize> = (0..n).step_by(stride).collect();
        if !sample_idx.contains(&0) { sample_idx.push(0); }
        if !sample_idx.contains(&(n - 1)) { sample_idx.push(n - 1); }
        sample_idx.sort_unstable();
        sample_idx.dedup();

        for i in 0..n {
            for &j in &sample_idx {
                if j <= i { continue; } // direction-respecting
                add_edge(adjacency, stop_at(i), CoarseEdge {
                    to: stop_at(j), kind: EdgeKind::Transit, cost: 1.0, via_pattern: Some(pattern_pk),
                });
            }
        }
    }
}
