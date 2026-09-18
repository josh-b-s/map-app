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

/// Flat cross-track prefilter on `core_stop_pks`, right before the
/// `get_pattern_pks_for_stops` SQL call (see tagging.rs) — the goal is
/// shrinking the IN-clause/result size on that query, which is currently
/// the slowest stage of on-device corridor resolution. Off by default so
/// A/B timing can isolate its effect; flip on to test.
pub const CROSS_TRACK_STOP_FILTER_ENABLED: bool = false;

/// Fraction of `core_stop_pks` to keep after sorting by cross-track
/// distance to the origin-destination line (smallest/straightest first).
/// 0.5 keeps the straighter half, drops the rest before the SQL query.
pub const CROSS_TRACK_KEEP_FRACTION: f64 = 1.0;

/// Absolute cap on top of CROSS_TRACK_KEEP_FRACTION — whichever is
/// smaller wins. So "keep the straightest 50 stops" regardless of how
/// big core_stop_pks was to begin with, rather than the fraction alone
/// letting a huge core_stop_pks still pass through a huge count.
/// Per-depth-bucket cap — used instead of a flat cap since the
/// flat cross-track sort can starve a deeper-but-necessary bucket
/// entirely — a real 3-transfer option can be straighter-scored-worse
/// than a 2-transfer alternative and lose every one of its stops to it,
/// silently filtering out a genuinely faster journey. Capping per depth
/// guarantees each depth gets a floor of representation regardless of how
/// the other depths score.
pub const CROSS_TRACK_KEEP_MAX_PER_BUCKET: usize = 25;

/// When false, `rank_meets` skips depth-bucket separation entirely: every
/// meeting node goes in one bucket, sorted purely by distance_sum_m
/// straightness, no weighted interleave. Lets you A/B "bucket ranking
/// does the narrowing" against "cross-track filtering on core_stop_pks
/// does the narrowing" independently. Off means depth (transfer count)
/// no longer protects a shortest-transfer candidate from being outranked
/// by a straighter but deeper one, that safety property is what you're
/// giving up while testing this.
pub const DEPTH_BUCKET_RANKING_ENABLED: bool = true;

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

/// EXPERIMENTAL — uses the seed-path margin's whole-trip duration estimate
/// (`resolved.seed_path_scores`, always computed regardless of
/// `ENABLE_SEED_PATH_MARGIN`) to size the FIRST stop_times fetch window,
/// instead of, and now AUTHORITATIVE over, the distance-only
/// `distance_scaled_sec` heuristic above — see the doc at this constant's
/// use in loader.rs for why min'ing the two together defeated the one
/// case this was meant to help (a multi-transfer journey where a LATER
/// leg's boarding falls past the distance heuristic's window even though
/// the first leg's trips exist fine within it). 50%, not the 25% used for
/// pattern/stop margins elsewhere — this margin protects against a
/// DIFFERENT, worse failure mode than those: a too-tight PATTERN margin
/// costs you a possibly-better route (McRAPTOR still finds SOME route); a
/// too-tight WINDOW here means the correct trip's stop_times row isn't
/// even fetched, which is caught by the existing window_stages widening
/// loop / the outer forced-10hr retry, but each of those is much more
/// expensive than just starting with a wide-enough window. Falls back to
/// the distance heuristic only when no duration estimate is available at
/// all (`resolved.seed_path_scores` empty or all-unscoreable) — so this
/// can only help query latency relative to today's behavior, never
/// regress a query the estimate doesn't cover.
pub const ENABLE_DURATION_BASED_WINDOW: bool = true;
pub const WINDOW_DURATION_MARGIN_FLOOR_SEC: f64 = 10.0 * 60.0;
pub const WINDOW_DURATION_MARGIN_RELATIVE_PCT: f64 = 0.5;
/// Separate, more generous ceiling than INITIAL_WINDOW_MAX_SEC — that one
/// was sized for the distance heuristic's much cruder estimate; a
/// multi-transfer journey's real duration (walk+ride+wait across every
/// leg) can legitimately exceed 5 hours' worth of window without being
/// wrong, so capping the duration-based path at the same 5hr ceiling would
/// silently reintroduce the exact failure mode this constant exists to
/// avoid. Still well under WINDOW_WIDENING_STAGES_SEC's first stage
/// (10hr), so a duration estimate that's badly wrong still gets caught by
/// that widening loop rather than fetching an enormous window outright.
pub const DURATION_WINDOW_MAX_SEC: f64 = 8.0 * 3600.0;

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

// ── Frequency-graph pre-filter (freq_raptor.rs) ──────────────────────────
/// Below this many candidate patterns, skip the frequency-graph pass
/// entirely and go straight to the real SQL stage — the pre-filter's own
/// (small) overhead isn't worth paying when there's nothing worth
/// narrowing. Needs real tuning against Melbourne-scale
/// `count.candidate_pattern_pks` numbers once this is running — 40 is a
/// starting guess, not a measured value.
pub const FREQ_GRAPH_MIN_CANDIDATE_PATTERNS: usize = 40;

/// Pruning-safety margin around the frequency graph's best estimated
/// arrival: `margin = max(FLOOR, estimated_duration * RELATIVE_PCT)`. Both
/// components matter — a pure relative margin is too tight on short hops
/// and too loose on long ones (see freq_raptor.rs's module doc for the
/// full reasoning on why a single best estimate can't be trusted alone).
pub const FREQ_GRAPH_MARGIN_FLOOR_SEC: i64 = 8 * 60;
pub const FREQ_GRAPH_MARGIN_RELATIVE_PCT: f64 = 0.25;

/// On/off switch for the margin pruning above, isolated from the constants
/// themselves so it can be A/B'd without touching their tuned values —
/// `false` sets the threshold to `i64::MAX`, i.e. every in-play stop stays
/// in play and this pass narrows nothing. For measuring how much this pass
/// alone is worth, independent of `ENABLE_SEED_MEET_SELECT_MARGIN_PRUNE`
/// below (same shape, different stage).
pub const ENABLE_FREQ_GRAPH_MARGIN_PRUNE: bool = false;

/// Shared shape used by both duration-based margin filters in this crate
/// (`FREQ_GRAPH_MARGIN_*` above and `SEED_MEET_SELECT_MARGIN_*` below) —
/// `max(floor, estimate * relative_pct)`. Kept as one function so the two
/// sites can't quietly drift apart on the formula itself while still using
/// independently tuned floor/pct constants and independent duration
/// estimates (a frequency-graph relaxation vs. a per-candidate BFS
/// backtrack — genuinely different traversals, not mergeable themselves).
pub fn margin_threshold(estimate: f64, floor: f64, relative_pct: f64) -> f64 {
    (estimate * relative_pct).max(floor)
}

/// Wait-time estimate used when `PatternHeadwayCache::headway_for` returns
/// `None` (no data, or too few trips to compute a gap) — deliberately
/// large/conservative rather than optimistic: an unknown headway should
/// bias the estimate AWAY FROM this pattern looking artificially fast,
/// not toward it, since discovering "actually this was fine" later (via
/// the real SQL stage) is cheap, while wrongly pruning a genuinely-good
/// route because its headway was unmeasured is a correctness bug.
pub const FREQ_GRAPH_UNKNOWN_HEADWAY_WAIT_SEC: i64 = 20 * 60;

/// Round cap for the frequency-graph search — same transfer-budget
/// reasoning as level_cap_for below, but this graph is cheap enough that
/// there's no strong reason to cap it any tighter than the real search.
pub const FREQ_GRAPH_MAX_ROUNDS: u32 = 6;

// ── rank_meets real-time scoring (seed_bfs.rs) ───────────────────────────
/// Fixed walking speed used ONLY for scoring the origin/destination "last
/// mile" leg in rank_meets's real-time score — deliberately NOT the
/// caller's actual per-search `walking_speed_mps` (RaptorOptions'). Two
/// reasons: (1) `SeedBfsCache`/`CorridorCache` are keyed independent of
/// walking speed — if ranking depended on the real per-search value, every
/// distinct walking speed would need its own cache entry for what's
/// otherwise the same corridor; (2) this score only needs to be
/// DIRECTIONALLY better than straight-line distance, not exactly correct —
/// it's picking which candidates are even worth materializing, not
/// producing a rider-facing duration. Same 1.4 m/s as RaptorOptions'
/// own Default (raptor.rs) — not a coincidence, just reusing the same
/// "typical pedestrian" baseline for consistency.
pub const RANK_MEETS_WALKING_SPEED_MPS: f64 = 1.4;

/// Margin applied when `materialize_seed_paths` selects which meeting
/// nodes in a `batch_size`-capped slice actually get backtracked into
/// `core_stop_pks` — `margin = max(FLOOR, best_score_in_batch * PCT)`,
/// same shape as `FREQ_GRAPH_MARGIN_*` and the same reasoning: a single
/// best real-time estimate shouldn't be trusted alone (no schedule/
/// missed-connection awareness at this stage either), so every meeting
/// node within margin of the batch's best stays in play rather than only
/// the literal single best one. `batch_size` itself is still the outer
/// ceiling (and still what the existing retry ladder doubles) — this
/// margin only trims WITHIN that ceiling, so a genuinely-close alternative
/// a few nodes into the batch doesn't drag in a needlessly wide ancestor
/// union just because count-based truncation alone can't tell "clearly
/// worse" apart from "basically tied."
pub const SEED_MEET_SELECT_MARGIN_FLOOR_SEC: f64 = 4.0 * 60.0;
pub const SEED_MEET_SELECT_MARGIN_RELATIVE_PCT: f64 = 0.25;

/// On/off switch for the margin filter above, isolated from the constants
/// themselves so it can be A/B'd without touching their tuned values —
/// `false` skips straight to keeping the whole depth group (the
/// `SEED_MEET_SELECT_TOP_K` hard ceiling below still applies either way,
/// since that's a separate backtracking-cost bound, not part of this test).
pub const ENABLE_SEED_MEET_SELECT_MARGIN_PRUNE: bool = false;

/// Hard ceiling applied AFTER the margin filter above — bounds the
/// pathological case margin alone can't: a wide, genuinely-flat plateau of
/// many meeting nodes all within margin of the best (common on a dense
/// grid of near-identical bus options, say). Margin decides WHICH
/// candidates are close enough to trust; this just caps how many of them
/// `core_stop_pks` ever has to carry, sorted by the same real-time score
/// so a cap that actually bites drops the weakest candidates first, not an
/// arbitrary interleave-order tail. Real-time-based, unlike
/// `cross_track_filter`'s straight-line cap — see this constant's use in
/// `materialize_seed_paths`.
pub const SEED_MEET_SELECT_TOP_K: usize = usize::MAX;

/// EXPERIMENTAL — an alternative final-candidate-set strategy explored
/// alongside `freq_raptor`'s narrow-then-scan approach: instead of feeding
/// McRAPTOR `core_stop_pks` (freq_raptor's temporally-narrowed ancestor
/// union), rank EVERY assembled whole candidate trip in `paths` by
/// `score_seed_path` and keep everything within margin of the best (same
/// `max(FLOOR, best*PCT)` shape as every other margin filter here — see
/// `margin_threshold`), meant to be handed to a lightweight per-path
/// verifier rather than a full McRAPTOR scan. When this is on, the
/// PER-MEET margin/top-K filter in `materialize_seed_paths`
/// (`ENABLE_SEED_MEET_SELECT_MARGIN_PRUNE`/`SEED_MEET_SELECT_TOP_K`) is
/// bypassed entirely — this mode replaces that selection layer rather
/// than stacking on top of it, so every meeting node's paths get
/// backtracked and judged on their OWN assembled-path score. Off by
/// default — `paths`/`path_scores` still get computed either way (cheap
/// relative to BFS itself), this constant only controls whether they get
/// filtered to the margin-kept set here. Does NOT affect `core_stop_pks`
/// directly — loader.rs decides whether to use this mode's
/// `seed_path_pattern_pks`/paths instead of freq_raptor's narrowing, so
/// the two remain independently A/B-able in principle even though in
/// practice loader.rs currently switches on this same constant.
pub const ENABLE_SEED_PATH_MARGIN: bool = true;
pub const SEED_PATH_MARGIN_FLOOR_SEC: f64 = 5.0 * 60.0;
pub const SEED_PATH_MARGIN_RELATIVE_PCT: f64 = 0.25;

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
pub const TOP_N_SEED_MEETS: usize = usize::MAX;

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
