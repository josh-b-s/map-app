//! settings.rs — port of services/gtfs/shared/routingSettings.ts.
//!
//! See that file's header comment for how these interact (SEED_RADIUS_M vs
//! WALK_EDGE_THRESHOLD_M vs ORIGIN_DEST_WALK_RADIUS_M vs
//! MAX_TRANSFER_WALK_SEC — four different "how far would someone walk"
//! radii serving four different purposes). Kept 1:1 with the TS values;
//! change both sides together if you ever tune one.

// ── Seeding (corridor/resolver.rs) ──────────────────────────────────────
pub const SEED_RADIUS_M: f64 = 1000.0;
pub const MIN_SEED_STOPS: usize = 4;
pub const MAX_SEED_STOPS: usize = 40;

// ── Coarse topology graph (graph/coarse.rs) ─────────────────────────────
pub const WALK_EDGE_THRESHOLD_M: f64 = 450.0;

// ── Corridor tagging bbox fallback (corridor/tagging.rs) ────────────────
pub const ORIGIN_DEST_WALK_RADIUS_M: f64 = 900.0;
pub const CORRIDOR_MIN_WIDTH_M: f64 = 350.0;
pub const CORRIDOR_TAPER_K_M: f64 = 900.0;
pub const CORRIDOR_WIDEN_MIN_WIDTH_M: f64 = 700.0;
pub const CORRIDOR_WIDEN_TAPER_K_M: f64 = 1600.0;
pub const CORRIDOR_MIN_ACCEPTABLE_STOPS: usize = 8;

// ── Journey-planning transfer budget ────────────────────────────────────
pub const MAX_TRANSFERS: u32 = 5;
pub const MIN_ACCEPTABLE_PATTERNS: usize = 3;

// ── Mid-journey transfer walking (raptor.rs) ────────────────────────────
pub const MAX_TRANSFER_WALK_SEC: f64 = 20.0 * 60.0;
pub const NEARBY_STOPS: usize = 50;

// ── Time-window widening for trip discovery (loader.rs) ─────────────────
pub const WINDOW_BOARD_BUFFER_SEC: i64 = 15 * 60;
pub const WINDOW_DISTANCE_SCALE_SEC_PER_KM: f64 = 150.0;
pub const WINDOW_DISTANCE_BUFFER_SEC: f64 = 45.0 * 60.0;
pub const INITIAL_WINDOW_MIN_SEC: f64 = 2.5 * 3600.0;
pub const INITIAL_WINDOW_MAX_SEC: f64 = 5.0 * 3600.0;
pub const WINDOW_WIDENING_STAGES_SEC: [i64; 2] = [10 * 3600, 20 * 3600];

// ── RAPTOR round tuning ──────────────────────────────────────────────────
pub const MAX_ROUNDS: u32 = 5;
pub const BEST_MARKED_CAP: usize = 400;
pub const ASSUMED_TRANSIT_SPEED_MPS: f64 = 10.0;

// ── Coarse-graph clique sizing (graph/coarse.rs) ────────────────────────
pub const FULL_CLIQUE_MAX_STOPS: usize = 60;
pub const STRIDE_TARGET_SAMPLES: usize = 40;

// ── Seed BFS (corridor/seed_bfs.rs) ─────────────────────────────────────
pub const SAFETY_MARGIN_LEVELS: u32 = 1;
pub const MAX_SEED_PATHS: usize = 24;

/// A level is one transit boarding (see seed_bfs.rs's module doc), so the
/// cap is a real transfer-count budget, not an arbitrary stop-count guess —
/// only true because coarse graph transit edges are per-line cliques.
pub fn level_cap_for(max_transfers: u32) -> u32 {
    max_transfers.max(1) + 1
}

pub fn transfer_radius_m(walking_speed_mps: f64) -> f64 {
    walking_speed_mps * MAX_TRANSFER_WALK_SEC
}
