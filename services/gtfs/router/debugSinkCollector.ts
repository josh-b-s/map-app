// debugSinkCollector.ts
//
// Bridges the Rust engine's live DebugEvent callback stream into the same
// GtfsDebugInfo shape computeGtfsRoute() (TS path) produces as a single
// batched object, so debug.slice.ts / DebugMapOverlay.tsx work against
// either backend without changes.
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
// the first attempt's rather than replacing them. Fine for now since a
// retry is rare and this is a debug-only viz, but worth knowing if a
// replay ever looks like it has two searches' worth of frontier data.

// DebugEvent_Tags is a real enum (a value, used in the switch below), so it
// needs a normal import — only DebugEvent/DebugSink are pure types.
import {DebugEvent_Tags} from '@mapapp/gtfs-router-rust';
import type {DebugEvent, DebugSink} from '@mapapp/gtfs-router-rust';
import type {GtfsDebugInfo} from './raptorRouter';

export class DebugSinkCollector implements DebugSink {
    private bfsLevels: GtfsDebugInfo['bfsLevels'] = [];
    private seedPaths: GtfsDebugInfo['seedPaths'] = [];
    private corridorBoundary: GtfsDebugInfo['corridorBoundary'] = [];
    private roundMarkedStops: GtfsDebugInfo['roundMarkedStops'] = [];

    onEvent(event: DebugEvent): void {
        switch (event.tag) {
            case DebugEvent_Tags.SeedBfsLevel:
                // level is a sequential index but events could in principle arrive
                // out of order across a retry — write by index rather than push,
                // so a re-emitted level 0 overwrites instead of duplicating.
                this.bfsLevels[event.inner.level] = event.inner.stops;
                break;
            case DebugEvent_Tags.SeedPath:
                this.seedPaths.push(event.inner.path);
                break;
            case DebugEvent_Tags.CorridorBoundary:
                this.corridorBoundary.push({left: event.inner.left, right: event.inner.right});
                break;
            case DebugEvent_Tags.RaptorRound:
                this.roundMarkedStops[event.inner.round] = event.inner.markedStops;
                break;
        }
    }

    /** Call once after compute_route() resolves — turns the accumulated
     *  stream into the same batched shape the TS path returns inline. */
    toDebugInfo(): GtfsDebugInfo {
        return {
            corridorStops: [], // not reported by the Rust side — see header note
            seedPaths: this.seedPaths,
            bfsLevels: this.bfsLevels.filter(Boolean), // drop any holes from out-of-order writes
            bfsTreeEdges: [], // not reported by the Rust side — see header note
            roundMarkedStops: this.roundMarkedStops.filter(Boolean),
            corridorBoundary: this.corridorBoundary,
            walkRadiusCircles: [], // not reported by the Rust side — see header note
        };
    }
}