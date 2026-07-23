// debugBfsPoints.ts
// Location: services/gtfs/debug/debugBfsPoints.ts

import type { GtfsDebugInfo } from '@/services/gtfs/router/raptorRouter';

export type Pt = { latitude: number; longitude: number };

/**
 * Ordered list of stops the way BFS actually discovered them, used to draw
 * exploration as ONE continuous polyline instead of a merged tree of
 * chains — much simpler and, since it's a single native Polyline object
 * regardless of point count, doesn't carry the old chain-count risk.
 *
 * Prefers bfsTreeEdges (TS path — true parent->child discovery order, see
 * seedRouteBfs.ts), taking each edge's `to` point. Falls back to flattening
 * bfsLevels (native/Rust path — only per-level frontier snapshots, no
 * individual edges; see debugSinkCollector.ts). Stops within one native
 * level aren't in a meaningful sub-order, so they're taken as given.
 */
export function getBfsDiscoveryPoints(data: GtfsDebugInfo): Pt[] {
    if (data.bfsTreeEdges && data.bfsTreeEdges.length > 0) {
        return data.bfsTreeEdges.map(e => e.to);
    }
    return (data.bfsLevels ?? []).flat();
}

export function keyOfPt(p: Pt): string {
    return `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
}
