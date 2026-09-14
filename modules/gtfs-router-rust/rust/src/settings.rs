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

// ── Corridor tagging (corridor/tagging.rs) ──────────────────────────────
pub const ORIGIN_DEST_WALK_RADIUS_M: f64 = 900.0;

/// Replaces the old geometric CORRIDOR_STOP_PROXIMITY_FILTER (taper-buffer
/// distance-to-segment math against seed-path polylines). The corridor
/// path (corridor/resolver.rs's `resolve_corridor`) used to build
/// `allowed_stop_pks` from EVERY stop of EVERY matched pattern — a
/// pattern that only clips the true corridor for a couple of stops still
/// dragged its entire route's stop list in. That's very likely what was
/// driving `count.corridor_stop_pks` up into the thousands on longer trips
/// (Epping/Montsalvat-style corridors) and inflating every SQL stage that
/// filters on it.
///
/// Instead of measuring physical distance to a buffer polygon (which is
/// wrong for any line that loops or crosses back near itself
/// geographically while being nowhere near it ALONG the route),
/// `resolve_corridor` now trims each matched pattern's stops by INDEX:
/// for pattern P, find where P's ordered stop_sequence actually intersects
/// `core_stop_pks` (the seed BFS's own exact traversed-stop set — no
/// geometry, just graph membership), take the min/max touched index, and
/// keep stops within that index range extended by
/// `STOP_SEQUENCE_MARGIN` stops on each side. A sibling express/local/
/// direction variant that only shares one interchange stop with
/// core_stop_pks naturally gets just a narrow window around that stop,
/// same intent the old filter had — just exact instead of approximate,
/// and index arithmetic instead of haversine-per-stop.
///
/// Seed-path stops and the origin/destination walk radius are still always
/// kept regardless (see resolve_corridor) — this only ever narrows the
/// "extra" stops a matched pattern drags in from elsewhere on its route,
/// never the seed paths RAPTOR actually needs to board/alight on.
pub const STOP_SEQUENCE_MARGIN: usize = 2;

// ── Journey-planning transfer budget ────────────────────────────────────
pub const MAX_TRANSFERS: u32 = 5;

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

/// Base unit for seed_bfs::rank_meets's depth-separated ranking (see
/// depth_bucket_weight): depth 0 (the shallowest, fewest-extra-transfers
/// bucket) gets `num_buckets * SEED_MEET_DEPTH_BUCKET_WEIGHT`, tapering
/// linearly down to `SEED_MEET_DEPTH_BUCKET_WEIGHT` at the deepest bucket —
/// so a truncated `batch_size` prefix is dominated by the fewest-transfer
/// candidates first, with deeper depths only filling in the remainder.
/// Since every depth's weight scales by the same constant, changing this
/// value alone doesn't change the RATIO between depths (it scales all of
/// them together) — to change the shape of the taper itself (e.g.
/// non-linear), change depth_bucket_weight's formula instead.
pub const SEED_MEET_DEPTH_BUCKET_WEIGHT: i64 = 50;
pub const MAX_SEED_PATHS: usize = 24; // internal guard against combinatorial half-path fanout WITHIN a single meet's backtrack only — no longer caps the total debug path list, see materialize_seed_paths

/// Default (first-attempt) batch size for resolve_corridor: of every
/// meeting node BFS found within budget, ranked purely by distance-sum
/// straightness — dist(origin, meet) + dist(meet, destination) — see
/// `rank_meets` in seed_bfs.rs — the first attempt materializes only the
/// best TOP_N_SEED_MEETS into core_stop_pks/pattern_pks. Unlike
/// MAX_SEED_PATHS (which only trims the enumerated debug path list after
/// the fact), this genuinely narrows what RAPTOR is allowed to consider —
/// a meeting node outside the batch never enters core_stop_pks at all. If
/// this first batch turns up no pattern with an active trip, loader.rs's
/// retry ladder re-materializes a bigger batch against the SAME BFS run
/// (see SEED_MEETS_RETRY_CEILING) rather than giving up.
pub const TOP_N_SEED_MEETS: usize = 50;

/// Retry ladder for loader.rs: if a search comes back with no candidate
/// patterns / no active trip at all (see resolve_corridor's `batch_size`
/// param), retry against the SAME BFS run (see corridor::resolver::
/// SeedBfsCache) with a bigger slice of its ranked meeting-node list,
/// instead of re-running BFS or falling back to geometric buffering.
/// Doubling from TOP_N_SEED_MEETS is generous headroom-wise since a retry
/// only re-pays the cheap ancestor-union/backtrack/SQL-pattern-lookup
/// cost, not BFS itself — capped here so a genuinely sparse corridor with
/// hundreds of meeting nodes and no real service anywhere doesn't retry
/// indefinitely before giving up.
pub const SEED_MEETS_RETRY_CEILING: usize = 200;

/// A level is one transit boarding (see seed_bfs.rs's module doc), so the
/// cap is a real transfer-count budget, not an arbitrary stop-count guess —
/// only true because coarse graph transit edges are per-line cliques.
pub fn level_cap_for(max_transfers: u32) -> u32 {
    max_transfers.max(1) + 1
}

pub fn transfer_radius_m(walking_speed_mps: f64) -> f64 {
    walking_speed_mps * MAX_TRANSFER_WALK_SEC
}
