//! settings.rs — port of services/gtfs/shared/routingSettings.ts.
//!
//! Walk-distance handling: there is exactly ONE caller-supplied distance —
//! `max_walk_distance_m`, threaded in from the front end through
//! RaptorOptions / resolve_corridor / run_seed_bfs — and it now governs
//! every "how far would this caller walk" decision: mid-journey transfers
//! (raptor.rs/freq_raptor.rs xfer_radius), BFS seed-stop selection
//! (corridor/resolver.rs's `nearest_for_seed`), and the origin/destination
//! walk-radius stop set (corridor/tagging.rs's `walk_radius_stop_pks`).
//! Previously these were four independently-tuned constants/derivations
//! (SEED_RADIUS_M, ORIGIN_DEST_WALK_RADIUS_M, and a speed-derived
//! transfer_radius_m) that could disagree with each other and with what
//! the caller actually asked for — e.g. a stop within the caller's real
//! walk tolerance but outside the fixed 900m/1000m seeding radii was
//! structurally unreachable no matter how far the caller was willing to
//! walk. `walking_speed_mps` is still separate and still caller-supplied —
//! it's only used to convert a distance into a duration (for scoring,
//! filtering, and verification), never to decide how far is "too far" to
//! walk. `WALK_EDGE_THRESHOLD_M` remains the one exception: it's a
//! build-time graph ceiling, not a per-request cutoff — see its own
//! comment below for why it has to stay independent, and MUST be kept
//! >= the largest `max_walk_distance_m` the front end will ever send.

// ── Seeding (corridor/resolver.rs) ──────────────────────────────────────
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
/// Build-time CEILING on which stop pairs even get a walk edge — not the
/// effective per-search cutoff. The graph is built once (persisted, see
/// graph/store.rs) and reused across every request regardless of the
/// caller's walk tolerance, so it has to be wide enough to cover the
/// widest `max_walk_distance_m` any caller could reasonably send — this
/// stays comfortably above that ceiling. The actual per-request limit is
/// applied later, in seed_bfs.rs's `walk_closure`, against each edge's
/// real `distance_m` using the caller's own `max_walk_distance_m`
/// directly — no derivation, no speed math. Used to be the effective
/// cutoff itself (450m) before that per-request filter existed, which
/// meant a journey needing a wider transfer than 450m was structurally
/// unreachable no matter the caller's tolerance — see graph/coarse.rs's
/// GRID_CELL_DEG constant, replaced by a `grid_cell_deg()` function that
/// derives from this value, so raising this doesn't silently break the
/// neighbor scan. If the front end is ever allowed to send a
/// `max_walk_distance_m` larger than this, raise this constant to match —
/// otherwise those requests silently get capped back down to whatever the
/// graph actually has edges for, with no error.
pub const WALK_EDGE_THRESHOLD_M: f64 = 2_500.0;

/// Cache-key granularity for the per-request max walk distance (see
/// corridor/resolver.rs's `cache_key`). Bucketing avoids a fresh
/// corridor/BFS cache entry for every tiny float difference in the
/// caller's walk tolerance while still giving genuinely different walk
/// abilities (e.g. a wheelchair user vs. a fast runner) their own
/// correctly-filtered candidate set.
pub const WALK_DISTANCE_CACHE_BUCKET_M: f64 = 250.0;

pub fn bucket_walk_distance_m(m: f64) -> i64 {
    ((m / WALK_DISTANCE_CACHE_BUCKET_M).round() as i64) * WALK_DISTANCE_CACHE_BUCKET_M as i64
}

/// Fallback `max_walk_distance_m` for callers that don't supply one (see
/// `RaptorOptions::default`) — a "typical pedestrian" 20-minute walk at
/// 1.4 m/s. Not used once a real caller value is threaded in; every
/// production caller should be supplying `max_walk_distance_m` directly
/// rather than relying on this.
pub const DEFAULT_MAX_WALK_DISTANCE_M: f64 = 1.4 * MAX_TRANSFER_WALK_SEC;


// ── Corridor tagging (corridor/tagging.rs) ──────────────────────────────
// (ORIGIN_DEST_WALK_RADIUS_M removed — walk_radius_stop_pks now takes the
// caller's max_walk_distance_m directly, see module header comment.)

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
/// Which kept candidate sizes the duration-based window: the Nth-fastest
/// scoreable one (1 = fastest, 0 = the SLOWEST, the old behaviour). With
/// one candidate per ride sequence the kept set now includes genuinely bad
/// sequences, and sizing from the slowest turned a ~3h window into the 8h cap
/// (slowest candidate 10-13h against real journeys of 1.5-3.5h). In logged
/// runs the returned journey was never slower than the fastest candidate's
/// estimate, so a low rank plus the margin below still covers it.
pub const WINDOW_REF_RANK: usize = 5;
pub const WINDOW_DURATION_MARGIN_FLOOR_SEC: f64 = 10.0 * 60.0;
pub const WINDOW_DURATION_MARGIN_RELATIVE_PCT: f64 = 0.25;
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

/// `max(floor, estimate * relative_pct)` — shared by the window and
/// seed-path margin filters.
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
pub const UNKNOWN_HEADWAY_WAIT_SEC: i64 = 20 * 60;

// ── rank_meets real-time scoring (seed_bfs.rs) ───────────────────────────
/// rank_meets's real-time score for the origin/destination "last mile" leg
/// (real_time_from_root's base case, and its walk-edge branch) uses the
/// caller's actual per-search `walking_speed_mps` (RaptorOptions'), not a
/// fixed baseline. This used to be a hardcoded 1.4 m/s specifically to
/// avoid `SeedBfsCache`/`CorridorCache` needing a cache entry per distinct
/// walking speed — but both caches are already keyed on
/// `bucket_walk_distance_m(max_walk_distance_m)` (see `cache_key` in
/// resolver.rs), and `max_walk_distance_m` is now the caller's own direct,
/// independent input (see module header above) rather than derived from
/// speed — so a runner and a walker already land in different cache
/// buckets whenever they supply different `max_walk_distance_m` values,
/// same as before. Single on-device caller (no cross-request contention),
/// so the extra bucket spread this can add is not a concern here.

/// Final-candidate-set strategy: instead of feeding McRAPTOR
/// `core_stop_pks` (freq_raptor's temporally-narrowed ancestor union),
/// rank EVERY assembled whole candidate trip in `paths` by
/// `score_seed_path` and keep everything within margin of the best (same
/// `max(FLOOR, best*PCT)` shape as every other margin filter here — see
/// `margin_threshold`). These margin-kept paths are what `verifier.rs`
/// walks against real stop_times — there's no full McRAPTOR scan any
/// more, so this is the only candidate-set strategy in play, not one of
/// two being A/B'd. When this is on, the
/// PER-MEET margin/top-K filter in `materialize_seed_paths`
/// (`ENABLE_SEED_MEET_SELECT_MARGIN_PRUNE`/`SEED_MEET_SELECT_TOP_K`) is
/// bypassed entirely — this mode replaces that selection layer rather
/// than stacking on top of it, so every meeting node's paths get
/// backtracked and judged on their OWN assembled-path score. On by
/// default — `paths`/`path_scores`/`path_edges` get computed either way
/// (cheap relative to BFS itself), this constant only controls whether
/// they get filtered to the margin-kept set here. Does NOT affect
/// `core_stop_pks` directly — loader.rs decides whether to use this
/// mode's `seed_path_pattern_pks`/paths instead of freq_raptor's
/// narrowing, so the two remain independently toggleable in principle
/// even though in practice loader.rs currently switches on this same
/// constant.
pub const ENABLE_SEED_PATH_MARGIN: bool = true;

/// The stop_times fetch does one time-range lookup per corridor stop, and
/// each lookup reads EVERY trip's departures at that stop before the trip
/// filter runs. The allowed-stop set used to be the whole corridor (4.5-9.5k
/// stops) although only ~1.4-4.8k of them ever had a candidate trip. true =
/// fetch only stops that lie on a loaded (narrowed) pattern, plus the edge
/// corridor's endpoints.
pub const NARROW_FETCH_STOPS_TO_PATTERNS: bool = true;

/// After warm-up JS calls `prewarm_timetable(now)`; a background thread
/// reads the stop_times pages a search near that time will need through its
/// own read-only connection, so the OS page cache is hot before the first
/// search (the first search was ~2.4x slower per row than the second).
pub const PREWARM_TIMETABLE: bool = true;
/// How far past `now` to pre-read (seconds).
pub const PREWARM_WINDOW_SEC: i64 = 4 * 3600;

/// Whole-path enumeration (seed_bfs.rs `materialize_seed_paths`) only feeds
/// the window sizing, the verifier fallback and the debug view now — the
/// edge corridor + RAPTOR decide what is loaded and searched. Its cost is
/// meets x (fwd half-paths x bwd half-paths), which exploded (1.1M
/// combinations / 5 s in one search), so it is bounded to the best meets
/// (by estimated duration) and a few half-paths per meet. 0 = unbounded.
pub const MAX_ENUMERATED_MEETS: usize = 0;
pub const MAX_HALF_PATHS_PER_MEET: usize = 0;

/// Edge-based corridor (seed_bfs.rs `compute_edge_corridor`). After the
/// bidirectional BFS, ANY graph edge u->v (transit or walk) is kept when
/// `fwd_level(u) + hop + bwd_level(v) <= first_meet + SAFETY_MARGIN_LEVELS`
/// (hop = 1 for a ride, 0 for a walk; a side that hasn't reached a node
/// contributes its exhausted-frontier lower bound). Its patterns are then
/// loaded alongside the kept seed paths' patterns. This is what lets an
/// optional short ride between two stops that are ALSO within walking
/// distance survive: the BFS only records the walk (walking is free, and a
/// stop keeps its first-discovered level), so the ride's pattern was never on
/// any path and never loaded. It also covers alternative transfer points and
/// touched-node alternatives with one rule instead of special cases.
pub const USE_EDGE_CORRIDOR: bool = true;

/// Upper bound on edge-corridor patterns actually LOADED (ranked by best
/// slack, then by how many qualifying edges use the pattern). Bounds the
/// extra timetable rows fetched. Applied in loader.rs AFTER the pool below
/// has been filtered down to patterns that can actually run for this
/// search, so the slots go to patterns with service instead of being
/// spent on ones that never run today / in the search window.
pub const MAX_EDGE_CORRIDOR_EXTRA_PATTERNS: usize = usize::MAX;

/// How many top-ranked edge-corridor patterns resolve_corridor hands to the
/// loader as a candidate pool (the corridor is cached per origin/destination
/// and is time-independent, so the time/day filtering happens in the loader).
/// Must be >= MAX_EDGE_CORRIDOR_EXTRA_PATTERNS; the surplus is the headroom
/// the filters below can refill from.
pub const EDGE_CORRIDOR_POOL_PATTERNS: usize = usize::MAX;

/// true = before applying MAX_EDGE_CORRIDOR_EXTRA_PATTERNS, drop pool
/// patterns with no active trip today (exact; from the same trips query the
/// loader already runs) and, if ENABLE_HEADWAY_WINDOW_FILTER, patterns the
/// import-time pattern_headway table says don't run in the search window.
/// false = old behaviour (plain top-N by rank).
pub const FILTER_EDGE_POOL_BY_ACTIVITY: bool = true;

/// After the loaded pattern set is final, fetch stop_times only for stops
/// served by a loaded pattern that has an active trip today (previously the
/// stop set was built before the active-trip lookup, so stops of patterns
/// with no service today still cost a wasted time-range seek each).
/// Only takes effect together with NARROW_FETCH_STOPS_TO_PATTERNS.
pub const NARROW_FETCH_STOPS_TO_ACTIVE_PATTERNS: bool = true;

/// When one BFS side reaches a stop the OTHER side has already reached (a
/// "touched" stop), should it still expand transit hops from it?
///  - true  = yes. The touched stop is one meeting point, but a different
///            line boarded there can still lead to a valid alternative
///            within SAFETY_MARGIN_LEVELS (e.g. destination near two
///            stations on two lines that only interchange far away: the
///            direct line meets first, but "ride L1 to the interchange,
///            switch to L2" starts at the very stop that was touched).
///  - false = old behaviour: touched stops were treated as finished,
///            which silently dropped those alternatives (see the
///            `alternative_through_a_touched_node_is_found` test).
/// The loop's total-level bound (first meet + margin) still limits cost.
pub const EXPAND_THROUGH_TOUCHED_NODES: bool = true;

/// How many of the best (lowest estimated whole-trip duration) candidate
/// seed paths survive selection. Applied AFTER dedup and the per-sequence
/// cap, so these are N genuinely distinct candidates. 0 = keep all.
/// (The timetable window is sized from the SLOWEST of these — see
/// loader.rs — so this also bounds how wide that window gets.)
pub const MAX_SEED_CANDIDATE_PATHS: usize = 30;

/// Final search step over the loaded GtfsIndex:
///  - true  = RAPTOR (raptor.rs) explores every trip/transfer combination
///            inside the loaded corridor + window, so it finds the real
///            earliest-arrival / Pareto journeys even when the best one
///            wasn't among the BFS seed paths. verifier.rs is kept as a
///            fallback if RAPTOR errors or finds nothing.
///  - false = verifier.rs only: just checks that the BFS seed paths are
///            boardable (fastest, but can only return what BFS proposed).
/// Either way the corridor/window loading (seed BFS, top-25% filter)
/// still decides which patterns and stops are available to the search.
pub const USE_RAPTOR_SEARCH: bool = true;

/// Max journeys handed across the FFI bridge to JS. The verifier can
/// verify hundreds of candidate paths; only the Pareto-optimal ones
/// (arrival / walking / transfers) are worth shipping, and each carries
/// full polylines that JS then stores and renders.
pub const MAX_RETURNED_JOURNEYS: usize = 8;

/// Douglas-Peucker tolerance (metres) applied to every returned polyline.
/// GTFS shapes are often far denser than a phone map can show.
pub const RETURNED_POLYLINE_TOLERANCE_M: f64 = 8.0;

/// Max distinct-stop candidate paths kept per ORDERED pattern sequence,
/// after the top-25% score filter (best-scoring kept). Bounds the
/// walk-closure platform fanout (several boardable stops of one line at the
/// same level) while still keeping a few alternative boarding/transfer
/// stops, which the old one-path-per-sequence dedup threw away. 0 = no cap.
pub const MAX_PATHS_PER_PATTERN_SEQUENCE: usize = 1;

/// Assembly-time guard for the same fanout: once this many distinct-stop
/// paths exist for one pattern sequence, further ones are skipped BEFORE
/// allocation/scoring. Must be >= MAX_PATHS_PER_PATTERN_SEQUENCE; larger
/// gives the scoring-based cap a better pool to pick from. 0 = no guard.
pub const MAX_ASSEMBLED_PER_PATTERN_SEQUENCE: usize = 1;

/// true = the "sequence" the two caps above group by is the ordered list of
/// ROUTES (lines) ridden, not of patterns, with consecutive hops on the same
/// line counted as one ride. Express / all-stops / short-turn patterns of one
/// line then compete for the same slot instead of each getting their own, and
/// "board one stop later, same line" no longer creates a new sequence.
/// false = group by exact pattern sequence (still collapsing consecutive
/// repeats of the same pattern).
///
/// The guard now runs BEFORE the stop-list hash/dedup, so a combination whose
/// sequence is already full is dropped for the price of one integer lookup.
/// Side effect: an exact-duplicate stop list arriving under a different
/// pattern/route id is no longer merged into the existing path's pattern
/// union (`paths_dup_pattern_variant_merged` was 0 in every logged run, since
/// the coarse graph keeps one pattern per stop pair).
pub const DEDUP_SEQUENCES_BY_ROUTE: bool = true;
/// The margin is measured from this percentile of scored candidates, not
/// the single fastest one. The fastest candidate's score is a sample of
/// one, built from averaged headway/cumulative-time estimates rather than
/// a real trip lookup — an outlier-prone anchor for a cutoff that then
/// decides which candidates the verifier even gets to try. Anchoring on
/// the 25th percentile instead (the top quarter of candidates by
/// estimated cost) is a steadier reference: it isn't dragged down by one
/// candidate whose average-case estimate happened to look unrealistically
/// good, while still only drawing the line among the genuinely fast
/// candidates rather than the whole field.

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

