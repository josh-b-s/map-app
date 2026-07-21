/**
 * routingSettings.ts — every constant that governs "how far would a rider
 * walk" or "how long would a rider wait," in one place.
 *
 * WHY THIS FILE EXISTS: these values were previously scattered as local
 * consts across coarseGraph.ts, corridorTagging.ts, corridorResolver.ts,
 * gtfsRouter.ts, and gtfsLoader.ts. That was fine while they were fixed,
 * developer-tuned numbers — but they're the natural candidates for a future
 * user-facing settings screen ("I don't mind walking further," "I'd rather
 * wait less"), and a setting that's supposed to change one rider-facing
 * behavior shouldn't require hunting through five files to find every place
 * that behavior is actually encoded. Everything here is still a plain
 * constant for now — wiring these to an actual settings store/UI is future
 * work, not part of this pass — but the SHAPE is already "one object a
 * settings screen could read from and write to."
 *
 * HOW THE PIECES RELATE (read this before changing a number):
 * Several of these interact in ways that aren't obvious from any one file:
 *   - SEED_RADIUS_M controls how far from the origin/destination PIN a stop
 *     can be and still seed the BFS corridor search.
 *   - WALK_EDGE_THRESHOLD_M controls how close two stops must be to each
 *     other to count as a free transfer in the coarse topology graph BFS
 *     runs over.
 *   - A destination stop only counts as "reached" by BFS if it's literally
 *     a seed OR within one WALK_EDGE_THRESHOLD_M hop of one. For a large,
 *     spread-out precinct (a university campus, a big interchange) where
 *     the useful stop is far from wherever the destination pin geocodes
 *     to, BOTH of these need to be generous enough, or a real route can be
 *     silently unreachable — not "found and ranked low," never discovered
 *     at all. See corridorResolver.ts's resolveCorridor for the full story.
 *   - ORIGIN_DEST_WALK_RADIUS_M is a THIRD, distinct radius — it's the
 *     "never taper the corridor to zero near the endpoints" floor in
 *     corridorTagging.ts, only used by the bbox-fallback corridor path.
 *   - TRANSFER_WALK_RADIUS_SEC (via transferRadiusM()) is a separate
 *     concern again: how far RAPTOR will let a rider walk BETWEEN two
 *     transit legs mid-journey, not at the very start/end of the trip.
 */

// ── Seeding (corridorResolver.ts) ────────────────────────────────────────────
/** Radius within which a stop is considered for BFS seeding, regardless of
 *  how many closer stops exist. See corridorResolver.ts's nearestForSeed —
 *  a fixed "N nearest" with no line-awareness let a wall of closer
 *  tram/bus stops crowd out a farther-but-more-useful stop (a train
 *  station, a bus-loop shuttle terminus) entirely. */
export const SEED_RADIUS_M = 1000;

/** Floor — guarantees at least this many seeds even somewhere sparse enough
 *  that nothing falls within SEED_RADIUS_M (regional/outer-suburb origins). */
export const MIN_SEED_STOPS = 4;

/** Ceiling — a safety valve for pathological density (a CBD super-stop
 *  cluster), not the normal case; line-aware dedup usually thins the
 *  candidate list well below this before it would ever bind. */
export const MAX_SEED_STOPS = 40;

// ── Coarse topology graph (coarseGraph.ts) ───────────────────────────────────
/** Walking-edge threshold for the coarse graph BFS runs over — stops closer
 *  than this are treated as directly walkable for corridor-finding
 *  purposes only (separate from TRANSFER_WALK_RADIUS_SEC below, which is
 *  the router's actual mid-journey transfer-walk radius). This is also,
 *  critically, what determines whether a BFS branch that lands near-but-
 *  not-on a seed counts as "reached the destination" — see this file's
 *  header comment. */
export const WALK_EDGE_THRESHOLD_M = 450;

// ── Corridor tagging bbox fallback (corridorTagging.ts) ──────────────────────
/** Fixed walk-tolerance radius around origin/destination that's ALWAYS kept
 *  in-corridor regardless of taper — the "never taper to zero near the
 *  endpoints" floor. Only used by the bbox-fallback corridor path (the
 *  normal seed-path-derived path uses SEED_RADIUS_M instead, via
 *  corridorResolver.ts's walkRadiusStopIds). */
export const ORIGIN_DEST_WALK_RADIUS_M = 900;

export const CORRIDOR_MIN_WIDTH_M = 350;
export const CORRIDOR_TAPER_K_M = 900;          // width(t) = MIN_WIDTH_M + TAPER_K_M * sin(pi * t)
export const CORRIDOR_WIDEN_MIN_WIDTH_M = 700;
export const CORRIDOR_WIDEN_TAPER_K_M = 1600;
/** Below this many stops, the first (narrow) corridor tagging pass is
 *  treated as "suspiciously small" and retried with the widened buffer. */
export const CORRIDOR_MIN_ACCEPTABLE_STOPS = 8;

// ── Journey-planning transfer budget (corridorResolver.ts, seedRouteBfs.ts) ──
/** Since coarseGraph.ts models a BFS hop as "ride one line," this is a real
 *  transfer count, not a stop-count proxy. 5 comfortably covers any
 *  plausible Melbourne metro trip (worst case is usually 2-3 transfers)
 *  with margin to spare. */
export const MAX_TRANSFERS = 5;

/** Below this many seed-path-derived patterns, the seed-path corridor is
 *  treated as suspiciously thin and the resolver falls back to the bbox
 *  corridor instead. */
export const MIN_ACCEPTABLE_PATTERNS = 3;

// ── Mid-journey transfer walking (gtfsRouter.ts) ─────────────────────────────
/** How long a rider will walk between two transit legs mid-journey — NOT
 *  the same radius as WALK_EDGE_THRESHOLD_M above (that one's for corridor
 *  topology only). Actual distance is speed-dependent — see
 *  transferRadiusM() in gtfsRouter.ts, which multiplies this by the
 *  rider's walking speed. 20 minutes was raised from an earlier 7-minute
 *  value (~588m at normal walking speed) that was too tight for real
 *  transfer geometry. */
export const MAX_TRANSFER_WALK_SEC = 20 * 60;

/** How many of the nearest corridor stops (at each end) RAPTOR itself scans
 *  for the initial board / final-arrival check. NOTE: unlike
 *  corridorResolver.ts's nearestForSeed, this one is still a plain
 *  nearest-N with no line-awareness — worth revisiting with the same
 *  radius+dedup treatment if it turns out to miss stops the same way seed
 *  selection used to. */
export const NEARBY_STOPS = 50;

// ── Time-window widening for trip discovery (gtfsLoader.ts) ─────────────────
/** Small buffer added before the requested departure time, so a trip that's
 *  already boarding (departed slightly before "now") isn't excluded. */
export const WINDOW_BOARD_BUFFER_SEC = 15 * 60;

/** Assumed overall travel pace (in-vehicle + wait + transfers) used to scale
 *  the initial search window by straight-line trip distance — NOT a
 *  precise speed estimate, just enough to size the window search bigger
 *  for a long-haul trip than a short hop before RAPTOR runs. */
export const WINDOW_DISTANCE_SCALE_SEC_PER_KM = 150;

/** Flat buffer added on top of the distance-scaled estimate above, mostly
 *  to absorb wait-time-for-first-departure rather than travel time itself. */
export const WINDOW_DISTANCE_BUFFER_SEC = 45 * 60;

/** Initial search window is clamped to this range regardless of what the
 *  distance-scaled estimate comes out to — a very short hop still gets a
 *  reasonable minimum window to find a departure in, and a very long
 *  regional trip doesn't get an unbounded initial window. */
export const INITIAL_WINDOW_MIN_SEC = 2.5 * 3600;
export const INITIAL_WINDOW_MAX_SEC = 5 * 3600;

/** Progressive widening stages tried when the initial (distance-scaled)
 *  window finds no active trips — each is tried in order until one finds
 *  something, or all are exhausted (see gtfsLoader.ts's noServiceFound).
 *  Deliberately generous at the top end: overnight gaps on lower-frequency
 *  lines can be large (last train ~1am, first ~5am is a real 4h+ gap with
 *  zero service, not a bug to route around). */
export const WINDOW_WIDENING_STAGES_SEC = [10 * 3600, 20 * 3600];
