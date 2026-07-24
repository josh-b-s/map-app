// debugSinkCollector.ts
//
// Bridges the Rust engine's live DebugEvent callback stream into the same
// GtfsDebugInfo shape computeGtfsRoute() (TS path) produces as a single
// batched object, so debug.slice.ts / DebugMapOverlay.tsx work against
// either backend without changes.
//
// IMPORTANT: DebugSink (like ProgressCallback in rustGtfsImporter.ts) is a
// plain TS interface, not a class — it doesn't exist at runtime, so ubrn's
// FfiConverterObjectWithCallbacks needs a plain object literal implementing
// its shape, not a class instance. An earlier version of this file was a
// class (`class DebugSinkCollector implements DebugSink`), which threw
// "Cannot lower this object to a pointer" the moment a real search passed
// an actual instance through (the no-debug `undefined` case worked fine,
// which is why this didn't show up until debug mode was actually toggled
// on). Rewritten as a factory function returning a plain object, same
// pattern rustGtfsImporter.ts's progressCallback already uses successfully.
//
// TWO-PHASE MODEL (bfs / raptor): the old seed/corridor/bfs/raptor 4-phase
// split has collapsed to 2 — corridor-finding (BFS + its seed paths +
// tapered boundary) is all one "bfs" phase now, stepped per BFS round; and
// "raptor" is stepped per individual candidate-route check within a round,
// not per round itself. See debugBfsPoints.ts and DebugMapOverlay.tsx for
// how bfsLevels/routeChecks get consumed under this model.
//
// SHAPES + COLOR: `seedPaths` coords now come from the pattern's real GTFS
// shape (trimmed to the ridden portion) where the Rust side could resolve
// one, not a straight stop-to-stop line — see lib.rs's emit_pre_search_debug
// / shaped_edge_coords. No change needed here since seedPaths' TYPE hasn't
// changed, only what's inside it. `routeChecks` entries now also carry the
// pattern's route_color (from lib.rs's RaptorRouteCheck event) and the
// FULL journey-so-far chain back through earlier rounds' boarding history,
// not just the current round's own segment — again, only the CONTENTS
// changed; see the type note on GtfsDebugInfo.routeChecks itself.
//
// KNOWN GAPS vs the TS path (see lib.rs's DebugEvent enum):
//   - No `bfsTreeEdges`. The Rust side emits per-level frontier SNAPSHOTS
//     (SeedBfsLevel{level, stops}), not individual parent->child discovery
//     edges. Doesn't matter anymore under the round-stepped bfs phase —
//     nothing here consumes tree-edge order any more, only per-round sets.
//   - No `corridorStops` (flat list) — only the tapered-boundary polygons
//     (`corridorBoundary`) survive. lib.rs never emits a corridor-stops event.
//   - No `walkRadiusCircles` — the fixed-radius origin/dest circles are a
//     TS-side rendering detail (corridorTagging.ts), not something Rust
//     reports. DebugMapOverlay already `?? []`s this, so it just renders
//     nothing extra rather than crashing.
//
// RETRY NOTE: compute_route() internally retries once with a wider window
// on certain failures (see lib.rs), re-emitting the pre-search debug events
// for the retry on the SAME sink. This collector just appends everything
// it receives in arrival order, so a retried search's events land after
// the first attempt's rather than replacing them. RaptorRouteCheck events
// carry their own `round`, so a retry's round 0 will collide with the
// first attempt's round 0 in `routeChecks[0]` the same way `roundMarkedStops`
// already does — pre-existing behavior, not new here.

import {DebugEvent_Tags} from '@/modules/gtfs-router-rust';
import type {DebugEvent, DebugSink} from '@/modules/gtfs-router-rust';
import type {GtfsDebugInfo} from '../router/raptorRouter';

export interface DebugCollectorHandle {
    sink: DebugSink; // plain object literal — pass THIS to compute_route's debug param
    toDebugInfo: () => GtfsDebugInfo;
}

/** Creates a fresh collector. Call once per search (debugMode ? createDebugSinkCollector() : null),
 *  same lifecycle as the old class was meant to have — just not a class. */
export function createDebugSinkCollector(): DebugCollectorHandle {
    const bfsLevels: GtfsDebugInfo['bfsLevels'] = [];
    const seedPaths: GtfsDebugInfo['seedPaths'] = [];
    const corridorBoundary: GtfsDebugInfo['corridorBoundary'] = [];
    const roundMarkedStops: GtfsDebugInfo['roundMarkedStops'] = [];
    // Per round, every individual candidate-route polyline RAPTOR examined
    // that round — NOT accumulated across rounds by this collector; the
    // "show one at a time" behavior lives in DebugMapOverlay's stepIndex
    // logic, not here. This is just the raw per-round bucket.
    const routeChecks: GtfsDebugInfo['routeChecks'] = [];

    const sink: DebugSink = {
        onEvent(event: DebugEvent): void {
            switch (event.tag) {
                case DebugEvent_Tags.SeedBfsLevel:
                    // level is a sequential index but events could in principle
                    // arrive out of order across a retry — write by index rather
                    // than push, so a re-emitted level 0 overwrites instead of
                    // duplicating.
                    bfsLevels[event.inner.level] = event.inner.stops;
                    break;
                case DebugEvent_Tags.SeedPath:
                    seedPaths.push(event.inner.path);
                    break;
                case DebugEvent_Tags.CorridorBoundary:
                    corridorBoundary.push({left: event.inner.left, right: event.inner.right});
                    break;
                case DebugEvent_Tags.RaptorRound:
                    roundMarkedStops[event.inner.round] = event.inner.markedStops;
                    break;
                case DebugEvent_Tags.RaptorRouteCheck:
                    // Same index-by-round approach as roundMarkedStops, but
                    // appending within the round's bucket since MANY patterns
                    // can be checked in one round (unlike the single
                    // marked-stop snapshot per round). `coords` here is the
                    // FULL journey-so-far chain (not just this round's own
                    // segment); routeColor/routeName are the pattern's real
                    // GTFS color/name when the feed has them — both come
                    // straight off the event, no reshaping needed.
                    (routeChecks[event.inner.round] ??= []).push({
                        coords: event.inner.coords,
                        routeColor: event.inner.routeColor ?? undefined,
                        routeName: event.inner.routeName ?? undefined,
                    });
                    break;
            }
        },
    };

    return {
        sink,
        toDebugInfo(): GtfsDebugInfo {
            return {
                corridorStops: [], // not reported by the Rust side — see header note
                seedPaths,
                bfsLevels: bfsLevels.filter(Boolean), // drop any holes from out-of-order writes
                bfsTreeEdges: [], // not reported by the Rust side — see header note
                roundMarkedStops: roundMarkedStops.filter(Boolean),
                routeChecks: routeChecks.map(r => r ?? []), // preserve round index, no holes
                corridorBoundary,
                walkRadiusCircles: [], // not reported by the Rust side — see header note
            };
        },
    };
}
