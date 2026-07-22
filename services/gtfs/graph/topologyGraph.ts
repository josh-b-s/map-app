/**
 * topologyGraph.ts — schedule-agnostic stop topology graph.
 *
 * This is deliberately NOT the McRAPTOR search graph. It answers a much
 * cheaper question: "does any trip, on any day, ever go directly from stop A
 * to stop B?" (existence only, not which trip/time) plus "can you walk
 * between A and B?". That's enough to BFS a corridor shape; the timetable
 * search still happens later, scoped to whatever the corridor allows.
 *
 * Cached in-memory for the process lifetime (fastest path — same app
 * session, no I/O at all), and persisted to SQLite across process lifetimes
 * via topologyGraphStore.ts (still requires a signature match — that module
 * owns invalidation, this one just calls it). Building this graph is the
 * expensive part (~12-14s: O(k^2) per-pattern cliques); building it fresh is
 * only ever necessary on the very first run after install, or after a GTFS
 * feed update changes the stored signature.
 * This intentionally does NOT depend on service_id/calendar/date — that's a
 * schedule concern, this is a topology concern, per the spec.
 */

import {getDb} from '../../db/sqliteDb';
import {makeKey} from '../core/gtfsKeyUtil';
import {computeGraphSignature, loadPersistedGraph, savePersistedGraph} from './topologyGraphStore';
import {haversineMeters} from '../../geo/geoUtil';
import {getAllPatternStopsOrdered, getAllStopsCached, type RepoPatternStop} from '../core/gtfsRepo';
import {WALK_EDGE_THRESHOLD_M} from '@/services/gtfs/config/routingSettings';

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
    /** Which pattern (line) this transit edge came from — undefined for
     *  walk edges. NOT used by routing/BFS itself (a coarse hop's cost is
     *  still just kind-determined); this exists PURELY so a debug overlay
     *  can later draw "the actual line just discovered" (its real stop
     *  sequence) instead of a meaningless straight clique edge between two
     *  arbitrary stops on that line. Previously this info was discarded
     *  once the per-pattern clique was built, which is why the debug web
     *  view could only ever draw clique geometry (straight lines between
     *  stop-pairs that have no geographic meaning) rather than the actual
     *  route shape. */
    viaPatternKey?: string;
}

export interface TopologyGraph {
    nodesByKey: Map<string, CoarseNode>;
    adjacency: Map<string, CoarseEdge[]>;
    builtAt: number;
}

// Walking-edge threshold now lives in routingSettings.ts (imported above) —
// stops closer than this are considered directly walkable for
// corridor-finding purposes only (separate from the router's actual
// transfer-walk radius, MAX_TRANSFER_WALK_SEC, also in routingSettings.ts).

// Grid bucket size for walking-edge dedup. Must be >= WALK_EDGE_THRESHOLD_M
// so a stop only ever needs to check its own cell + 8 neighbors, never a
// wider ring. This is what keeps walking-edge construction from being O(n^2)
// across ~30K stops. NOTE: this is hardcoded for Melbourne's latitude and
// NOT wired to WALK_EDGE_THRESHOLD_M — if that ever becomes a user-facing
// setting, this needs to scale (or get recomputed) alongside it, or a
// larger user-chosen threshold could silently exceed this cell size and
// break the "only check 8 neighbors" invariant.
const GRID_CELL_DEG = 0.006; // ~650m at Melbourne's latitude, comfortably > threshold

let cache: TopologyGraph | null = null;
let buildPromise: Promise<TopologyGraph> | null = null;

/**
 * Logs Hermes' own heap stats, if available. This is the actual JS heap
 * (where the 2M-edge adjacency structure lives), not device RAM — Android
 * caps each app's heap independently of total device memory (typically
 * 256-512MB by default regardless of the phone's physical RAM), so this
 * number is the one that actually matters for "will this OOM on a low-end
 * device," not whatever the emulator's memory setting is. Safe to call
 * anywhere — no-ops if HermesInternal isn't present (e.g. running under a
 * different JS engine).
 */
function logHeapUsage(label: string): void {
    // @ts-ignore — HermesInternal is a Hermes-specific global, not in RN's types
    const stats = global.HermesInternal?.getInstrumentedStats?.();
    if (!stats) return;
    const usedMB = (stats.js_heapSize / (1024 * 1024)).toFixed(1);
    const allocatedMB = (stats.js_allocatedBytes / (1024 * 1024)).toFixed(1);
    console.log(`[coarseGraph] heap after ${label}: ${usedMB}MB used / ${allocatedMB}MB allocated`);
}

/**
 * Full from-scratch build: per-line transit cliques + spatially-bucketed
 * walking edges. This is the O(k^2)-per-pattern, ~12-14s path — only run
 * when there's no valid persisted graph for the current signature.
 */
function buildAdjacencyFromScratch(
    stopRows: CoarseNode[],
    psRows: RepoPatternStop[],
): Map<string, CoarseEdge[]> {
    const adjacency = new Map<string, CoarseEdge[]>();

    // Dedup key set, parallel to `adjacency` — lets addEdge dedup in O(1)
    // instead of scanning the edge list. Matters a lot now that transit
    // edges are per-line cliques (a busy interchange stop can pick up
    // hundreds of edges). Scoped to this build call (not module-level) so
    // it can never leak stale dedup state into a later rebuild.
    const edgeKeySets = new Map<string, Set<string>>();

    function addEdge(from: string, edge: CoarseEdge) {
        if (from === edge.to) return; // never a self-loop (loop routes can revisit a stop_id)
        let keys = edgeKeySets.get(from);
        if (!keys) {
            keys = new Set();
            edgeKeySets.set(from, keys);
        }
        const dedupKey = `${edge.kind}:${edge.to}`;
        if (keys.has(dedupKey)) return;
        keys.add(dedupKey);
        if (!adjacency.has(from)) adjacency.set(from, []);
        adjacency.get(from)!.push(edge);
    }

    // ── Transit edges: per-LINE, not per-stop-pair ────────────────────────
    // The unit of a BFS hop here is "ride this line to any stop it serves,"
    // not "pass the next stop." A rail line with 20 intermediate stations is
    // one hop, exactly like a human planning "get on the Frankston line, get
    // off, transfer" — not 20 hops. This is what makes corridor BFS
    // reachable within a small transfer-count budget for long cross-network
    // trips, and it's what makes "transfers" in seedRouteBfs.ts correspond
    // to real transfers instead of stop counts.

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
        // DIRECTION: patternStopKeys is already ordered by real stop_sequence
        // (psRows is queried `ORDER BY agency, pattern_id, stop_sequence`), so
        // i < j here always means "genuinely earlier in this pattern's real
        // direction of travel." GTFS patterns are inherently directional —
        // a separate pattern_id exists for the other direction/return trip —
        // so there is never a legitimate reason to add a j -> i edge here.
        //
        // An earlier version of this function added BOTH i->j and j->i for
        // every pair, on the reasoning that "ride this line" should be a
        // single BFS hop regardless of which end you start from. That's true
        // for genuinely picking a DIFFERENT stop to board vs alight — but it
        // also silently created edges representing riding a pattern
        // BACKWARD, opposite its actual direction of travel, which no real
        // trip can do. BFS then could (and did) discover a "path" that
        // depended on one of these backward edges — landing on a stop that's
        // downstream of where you actually needed to board, with no way to
        // ride forward to the real destination. That corridor/reachability
        // bug (RAPTOR reaching a structurally-wrong-direction board stop with
        // no valid boarding candidate ever marked upstream) could only be
        // patched around downstream with increasingly fragile heuristics
        // (geometric sweeps, hop-length thresholds) that either didn't catch
        // it or over-corrected and blew up corridor size/search cost for
        // unrelated long-haul trips. Removing the reverse edge at the source
        // makes the wrong-direction jump impossible to construct in the
        // first place, so none of that downstream patching is needed.
        if (n <= FULL_CLIQUE_MAX_STOPS) {
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    addEdge(patternStopKeys[i], {
                        to: patternStopKeys[j],
                        cost: 1,
                        kind: 'transit',
                        viaPatternKey: patternKey ?? undefined
                    });
                }
            }
        } else {
            const stride = Math.max(1, Math.floor(n / STRIDE_TARGET_SAMPLES));
            const sampleIdx = new Set<number>([0, n - 1]); // always include both termini
            for (let i = 0; i < n; i += stride) sampleIdx.add(i);
            const samples = [...sampleIdx];
            for (let i = 0; i < n; i++) {
                for (const j of samples) {
                    if (j <= i) continue; // direction-respecting — see note above
                    addEdge(patternStopKeys[i], {
                        to: patternStopKeys[j],
                        cost: 1,
                        kind: 'transit',
                        viaPatternKey: patternKey ?? undefined
                    });
                }
            }
        }
    };

    for (const row of psRows) {
        if (row.patternKey !== patternKey) {
            flushPattern();
            patternKey = row.patternKey;
            patternStopKeys = [];
        }
        patternStopKeys.push(row.stopKey);
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
                    const d = haversineMeters({lat: s.stop_lat, lon: s.stop_lon}, {
                        lat: other.stop_lat,
                        lon: other.stop_lon
                    });
                    if (d <= WALK_EDGE_THRESHOLD_M) {
                        addEdge(sKey, {to: oKey, cost: 0.5, kind: 'walk'});
                        addEdge(oKey, {to: sKey, cost: 0.5, kind: 'walk'});
                    }
                }
            }
        }
    }

    return adjacency;
}

export async function getCoarseGraph(): Promise<TopologyGraph> {
    if (cache) return cache;
    if (buildPromise) return buildPromise;

    buildPromise = (async () => {
        const t0 = Date.now();
        const db = await getDb();

        // ── Nodes ────────────────────────────────────────────────────────────
        // Shares gtfsRepo's stops cache (same one gtfsLoader.ts's
        // getAllStopsCached uses) rather than running its own copy of this
        // query — was previously a second, independent, un-cached-against-
        // the-other `SELECT ... FROM stops`, AND (separately) was reading
        // stop_lat/stop_lon as raw values when preprocess-gtfs.ts actually
        // packs them as integers*COORD_SCALE — see gtfsRepo.ts's
        // getAllStopsCached doc comment.
        const stopRows: CoarseNode[] = await getAllStopsCached(db);
        const nodesByKey = new Map<string, CoarseNode>();
        for (const s of stopRows) nodesByKey.set(makeKey(s.agency, s.stop_id), s);

        // ── Try the persisted store first ───────────────────────────────────
        const signature = await computeGraphSignature(db);
        const persisted = await loadPersistedGraph(db, signature);
        if (persisted) {
            console.log(`[coarseGraph] loaded from persisted store in ${Date.now() - t0}ms: ` +
                `${nodesByKey.size} nodes, ${[...persisted.values()].reduce((a, l) => a + l.length, 0)} directed edges`);
            logHeapUsage('loading persisted graph');
            cache = {nodesByKey, adjacency: persisted, builtAt: Date.now()};
            return cache;
        }

        // ── No valid persisted graph (first run, or feed changed) — build fresh ──
        console.log('[coarseGraph] no valid persisted graph for this feed — building fresh');
        const psRows = await getAllPatternStopsOrdered(db);
        const adjacency = buildAdjacencyFromScratch(stopRows, psRows);

        console.log(`[coarseGraph] built in ${Date.now() - t0}ms: ${nodesByKey.size} nodes, ` +
            `${[...adjacency.values()].reduce((a, l) => a + l.length, 0)} directed edges`);
        logHeapUsage('fresh build');

        cache = {nodesByKey, adjacency, builtAt: Date.now()};

        // Persist for next cold start. Deliberately not awaited before
        // returning — the in-memory graph is already usable, no reason to
        // make this search wait on a disk write that only benefits the next
        // one. A failure here just means next cold start rebuilds again.
        savePersistedGraph(db, signature, adjacency).then(
            () => console.log(`[coarseGraph] persisted graph for future cold starts`),
            err => console.warn('[coarseGraph] failed to persist graph (will rebuild next cold start):', err),
        );

        return cache;
    })();

    return buildPromise;
}