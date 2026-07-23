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
// KNOWN GAPS vs the TS path (see lib.rs's DebugEvent enum — it only emits
// four event kinds):
//   - No `bfsTreeEdges`. The Rust side emits per-level frontier SNAPSHOTS
//     (SeedBfsLevel{level, stops}), not individual parent->child discovery
//     edges, so there's nothing to synthesize a discovery-order edge list
//     from without fabricating connectivity that wasn't actually reported.
//     `bfsLevels` IS populated, so DebugMapOverlay's 'bfs' phase needs a
//     fallback (below) to render level-hulls instead of edge-chains when
//     edges are empty.
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
// the first attempt's rather than replacing them.

import {DebugEvent_Tags} from '@mapapp/gtfs-router-rust';
import type {DebugEvent, DebugSink} from '@mapapp/gtfs-router-rust';
import type {GtfsDebugInfo} from './raptorRouter';

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
                corridorBoundary,
                walkRadiusCircles: [], // not reported by the Rust side — see header note
            };
        },
    };
}
