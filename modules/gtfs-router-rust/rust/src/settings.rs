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

/// Progressive-widening cap for the stops_rtree bbox query in
/// corridor/resolver.rs's `nearest_for_seed`: once the query radius
/// reaches this without finding MIN_SEED_STOPS candidates, one more
/// widened attempt is made and then it gives up and falls back to a full
/// scan over every stop in the network instead. Because widening is
/// geometric (x4 per step) and the cap is only checked after a query, the
/// actual last-attempted radius can overshoot this value by up to 4x
/// before falling back — deliberate, so a search that's *just* past the
/// nominal cap doesn't pay full-scan cost when one more widened query
/// would have found enough. Guarantees the same "always find at least
/// MIN_SEED_STOPS stops, network permitting" behavior the old brute-force
/// implementation had, for the rare edge case of a search near the
/// boundary of a sparse network.
pub const MAX_RTREE_RADIUS_M: f64 = 32_000.0;

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

/// A/B toggle for how `windowed_trip_discovery` filters to active trips:
/// - `true` (current default, as of on-device A/B testing): stage
///   `active_trip_pks` into a temp table and add `AND trip_pk IN (...)` to
///   the SQL, so SQLite filters before rows ever cross into Rust.
/// - `false`: fetch every stop_times row in the time window, filter each
///   one against the Rust `active_trip_pks` HashSet.
/// Flipped to `true` after matched on-device comparisons (Caulfield to
/// Mornington/Werribee/Epping, same routes both settings): windowed_trip_
/// discovery was consistently faster with SQL-side filtering (-19%, -9%,
/// -22%), including one clean case where trips_for_candidates cost was
/// identical between runs so the comparison wasn't confounded by cache
/// warmth. Still only 3 routes worth of evidence — revisit if a wider
/// range of corridors doesn't hold the same pattern.
pub const USE_SQL_ACTIVE_TRIP_FILTER: bool = true;

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
