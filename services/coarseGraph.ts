/**
 * coarseGraph.ts — schedule-agnostic stop topology graph.
 *
 * This is deliberately NOT the McRAPTOR search graph. It answers a much
 * cheaper question: "does any trip, on any day, ever go directly from stop A
 * to stop B?" (existence only, not which trip/time) plus "can you walk
 * between A and B?". That's enough to BFS a corridor shape; the timetable
 * search still happens later, scoped to whatever the corridor allows.
 *
 * Cached in-memory for the process lifetime. Rebuild only when the GTFS feed
 * itself changes — call invalidateCoarseGraphCache() after a feed reload.
 * This intentionally does NOT depend on service_id/calendar/date — that's a
 * schedule concern, this is a topology concern, per the spec.
 */

import { getDb } from './gtfsDb';
import { makeKey, parseKey } from './gtfsKeyUtil';

export interface CoarseNode {
    stop_id: string;
    agency: number;
    stop_lat: number;
    stop_lon: number;
}

export interface CoarseEdge {
    to: string;      // stopKey
    cost: number;     // 1 = transit hop, 0.5 = walking edge
    kind: 'transit' | 'walk';
}

export interface CoarseGraph {
    nodesByKey: Map<string, CoarseNode>;
    adjacency: Map<string, CoarseEdge[]>;
    builtAt: number;
}

// Walking-edge threshold — stops closer than this are considered directly
// walkable for corridor-finding purposes only (separate from the router's
// actual transfer-walk radius).
const WALK_EDGE_THRESHOLD_M = 450;

// Grid bucket size for walking-edge dedup. Must be >= WALK_EDGE_THRESHOLD_M
// so a stop only ever needs to check its own cell + 8 neighbors, never a
// wider ring. This is what keeps walking-edge construction from being O(n^2)
// across ~30K stops.
const GRID_CELL_DEG = 0.006; // ~650m at Melbourne's latitude, comfortably > threshold

let cache: CoarseGraph | null = null;
let buildPromise: Promise<CoarseGraph> | null = null;

export function invalidateCoarseGraphCache(): void {
    cache = null;
    buildPromise = null;
}

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const x = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
    return R * 2 * Math.asin(Math.sqrt(x));
}

// Dedup key set, parallel to `adjacency` — lets addEdge dedup in O(1) instead
// of scanning the edge list. Matters a lot now that transit edges are
// per-line cliques (a busy interchange stop can pick up hundreds of edges).
const edgeKeySets = new Map<string, Set<string>>();

function addEdge(adj: Map<string, CoarseEdge[]>, from: string, edge: CoarseEdge) {
    if (from === edge.to) return; // never a self-loop (loop routes can revisit a stop_id)
    let keys = edgeKeySets.get(from);
    if (!keys) { keys = new Set(); edgeKeySets.set(from, keys); }
    const dedupKey = `${edge.kind}:${edge.to}`;
    if (keys.has(dedupKey)) return;
    keys.add(dedupKey);
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(edge);
}

export async function getCoarseGraph(): Promise<CoarseGraph> {
    if (cache) return cache;
    if (buildPromise) return buildPromise;

    buildPromise = (async () => {
        const t0 = Date.now();
        const db = await getDb();

        // ── Nodes ────────────────────────────────────────────────────────────
        const stopRows = await db.getAllAsync<CoarseNode>(
            `SELECT stop_id, stop_lat, stop_lon, agency FROM stops`,
        );
        const nodesByKey = new Map<string, CoarseNode>();
        for (const s of stopRows) nodesByKey.set(makeKey(s.agency, s.stop_id), s);

        const adjacency = new Map<string, CoarseEdge[]>();

        // ── Transit edges: per-LINE, not per-stop-pair ────────────────────────
        // The unit of a BFS hop here is "ride this line to any stop it
        // serves," not "pass the next stop." A rail line with 20 intermediate
        // stations is one hop, exactly like a human planning "get on the
        // Frankston line, get off, transfer" — not 20 hops. This is what
        // makes corridor BFS reachable within a small transfer-count budget
        // for long cross-network trips, and it's what makes "transfers" in
        // seedRouteBfs.ts correspond to real transfers instead of stop counts.
        //
        // We only need pattern_stops (one row per pattern, not per trip) —
        // existence of a pattern already implies "some trip goes A -> ... -> Z".
        const psRows = await db.getAllAsync<{ pattern_id: string; agency: number; stop_id: string; stop_sequence: number }>(
            `SELECT pattern_id, agency, stop_id, stop_sequence FROM pattern_stops ORDER BY agency, pattern_id, stop_sequence`,
        );

        // Full O(k^2) cliques are fine for normal patterns (trams/buses/most
        // rail lines: tens of stops). For unusually long patterns (V/Line-style
        // regional rail, 60+ stops) a full clique would add tens of thousands
        // of edges for one line, so beyond the cap we connect every stop to a
        // stride-sampled subset (plus the terminus) instead of every stop to
        // every stop. Still "ride the line = ~1 hop," just not a perfect clique.
        const FULL_CLIQUE_MAX_STOPS = 60;
        const STRIDE_TARGET_SAMPLES = 40;

        let patternKey: string | null = null;
        let patternStopKeys: string[] = [];

        const flushPattern = () => {
            if (patternStopKeys.length < 2) return;
            const n = patternStopKeys.length;
            if (n <= FULL_CLIQUE_MAX_STOPS) {
                for (let i = 0; i < n; i++) {
                    for (let j = i + 1; j < n; j++) {
                        addEdge(adjacency, patternStopKeys[i], { to: patternStopKeys[j], cost: 1, kind: 'transit' });
                        addEdge(adjacency, patternStopKeys[j], { to: patternStopKeys[i], cost: 1, kind: 'transit' });
                    }
                }
            } else {
                const stride = Math.max(1, Math.floor(n / STRIDE_TARGET_SAMPLES));
                const sampleIdx = new Set<number>([0, n - 1]); // always include both termini
                for (let i = 0; i < n; i += stride) sampleIdx.add(i);
                const samples = [...sampleIdx];
                for (let i = 0; i < n; i++) {
                    for (const j of samples) {
                        if (j === i) continue;
                        addEdge(adjacency, patternStopKeys[i], { to: patternStopKeys[j], cost: 1, kind: 'transit' });
                        addEdge(adjacency, patternStopKeys[j], { to: patternStopKeys[i], cost: 1, kind: 'transit' });
                    }
                }
            }
        };

        for (const row of psRows) {
            const rowPatternKey = makeKey(row.agency, row.pattern_id);
            const stopKey = makeKey(row.agency, row.stop_id);
            if (rowPatternKey !== patternKey) {
                flushPattern();
                patternKey = rowPatternKey;
                patternStopKeys = [];
            }
            patternStopKeys.push(stopKey);
        }
        flushPattern(); // last pattern in the sorted rows

        // ── Walking edges: spatially bucketed, not O(n^2) ────────────────────
        const grid = new Map<string, CoarseNode[]>();
        const cellOf = (lat: number, lon: number) =>
            `${Math.floor(lat / GRID_CELL_DEG)}:${Math.floor(lon / GRID_CELL_DEG)}`;
        for (const s of stopRows) {
            const c = cellOf(s.stop_lat, s.stop_lon);
            if (!grid.has(c)) grid.set(c, []);
            grid.get(c)!.push(s);
        }

        for (const s of stopRows) {
            const [cy, cx] = cellOf(s.stop_lat, s.stop_lon).split(':').map(Number);
            const sKey = makeKey(s.agency, s.stop_id);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const neighbors = grid.get(`${cy + dy}:${cx + dx}`);
                    if (!neighbors) continue;
                    for (const other of neighbors) {
                        if (other === s) continue;
                        const oKey = makeKey(other.agency, other.stop_id);
                        // Only compute the pair once (canonical ordering by key string).
                        if (oKey <= sKey) continue;
                        const d = haversineMeters(s.stop_lat, s.stop_lon, other.stop_lat, other.stop_lon);
                        if (d <= WALK_EDGE_THRESHOLD_M) {
                            addEdge(adjacency, sKey, { to: oKey, cost: 0.5, kind: 'walk' });
                            addEdge(adjacency, oKey, { to: sKey, cost: 0.5, kind: 'walk' });
                        }
                    }
                }
            }
        }

        console.log(`[coarseGraph] built in ${Date.now() - t0}ms: ${nodesByKey.size} nodes, ` +
            `${[...adjacency.values()].reduce((a, l) => a + l.length, 0)} directed edges`);

        cache = { nodesByKey, adjacency, builtAt: Date.now() };
        return cache;
    })();

    return buildPromise;
}
