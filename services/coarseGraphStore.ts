/**
 * coarseGraphStore.ts — SQLite persistence for the coarse graph adjacency.
 *
 * The graph itself (coarseGraph.ts) is expensive to build (~12-14s: O(k^2)
 * per-pattern cliques over ~2M edges) but is schedule-agnostic and only
 * changes when the GTFS feed itself changes. Rebuilding it every cold start
 * wastes that entire cost for no reason. This module persists the built
 * adjacency into the same SQLite db (gtfs.db) so a cold start can load it
 * back in roughly the time of the stops query (~1s) instead of rebuilding.
 *
 * Storage shape: one row per stop with ALL its outgoing edges packed into a
 * single compact string column — NOT one row per edge. Reading ~2M
 * individual rows back through the JS bridge is itself slow enough to erase
 * most of the benefit (per-row marshaling overhead dominates at that scale);
 * reading ~30K rows and doing cheap string splits does not have that problem.
 *
 * Invalidation: keyed by a signature derived from stops/pattern_stops row
 * counts, not file mtime. A full content hash would be more precise but
 * isn't needed — a GTFS feed update always replaces data wholesale, so a
 * row-count change is a reliable enough signal, and it's cheap enough to
 * check on every getCoarseGraph() call. File mtime specifically must be
 * avoided: these persistence tables live in the same gtfs.db file they
 * cache data from, so our own writes would bump the file's mtime and
 * immediately invalidate themselves on the very next read.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import type { CoarseEdge } from './coarseGraph';

const EDGE_SEP = '\x1f';       // unit separator — won't collide with real stop_ids
const KIND_TRANSIT = 't';
const KIND_WALK = 'w';
const INSERT_CHUNK = 200;      // rows per multi-value INSERT, comfortably under SQLite's bound-variable limit

export interface GraphSignature {
    stopCount: number;
    patternStopCount: number;
}

export async function computeGraphSignature(db: SQLiteDatabase): Promise<GraphSignature> {
    const [{ c: stopCount }] = await db.getAllAsync<{ c: number }>(`SELECT COUNT(*) as c FROM stops`);
    const [{ c: patternStopCount }] = await db.getAllAsync<{ c: number }>(`SELECT COUNT(*) as c FROM pattern_stops`);
    return { stopCount, patternStopCount };
}

function signatureKey(sig: GraphSignature): string {
    return `${sig.stopCount}:${sig.patternStopCount}`;
}

async function ensureTables(db: SQLiteDatabase): Promise<void> {
    await db.execAsync(`
        CREATE TABLE IF NOT EXISTS coarse_graph_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS coarse_graph_adjacency (stop_key TEXT PRIMARY KEY, edges TEXT NOT NULL);
    `);
}

// cost is fully determined by kind (transit=1, walk=0.5 — see coarseGraph.ts),
// so we only ever need to persist the kind, not the cost, per edge.
function encodeEdges(edges: CoarseEdge[]): string {
    return edges.map(e => `${e.to}${e.kind === 'transit' ? KIND_TRANSIT : KIND_WALK}`).join(EDGE_SEP);
}

function decodeEdges(packed: string): CoarseEdge[] {
    if (!packed) return [];
    return packed.split(EDGE_SEP).map(tok => {
        const kindChar = tok[tok.length - 1];
        const to = tok.slice(0, -1); // always our appended marker char, never part of the key
        const kind: CoarseEdge['kind'] = kindChar === KIND_TRANSIT ? 'transit' : 'walk';
        return { to, kind, cost: kind === 'transit' ? 1 : 0.5 };
    });
}

/**
 * Attempts to load a previously persisted graph matching the given
 * signature. Returns null on any mismatch, absence, or empty store —
 * caller falls back to a full rebuild (which also re-persists).
 */
export async function loadPersistedGraph(
    db: SQLiteDatabase,
    signature: GraphSignature,
): Promise<Map<string, CoarseEdge[]> | null> {
    await ensureTables(db);

    const metaRows = await db.getAllAsync<{ value: string }>(
        `SELECT value FROM coarse_graph_meta WHERE key = 'signature'`,
    );
    if (metaRows.length === 0 || metaRows[0].value !== signatureKey(signature)) return null;

    const rows = await db.getAllAsync<{ stop_key: string; edges: string }>(
        `SELECT stop_key, edges FROM coarse_graph_adjacency`,
    );
    if (rows.length === 0) return null; // stale/half-written — treat as a miss, rebuild

    const adjacency = new Map<string, CoarseEdge[]>();
    for (const row of rows) adjacency.set(row.stop_key, decodeEdges(row.edges));
    return adjacency;
}

/**
 * Persists a freshly-built graph, replacing whatever was stored before.
 * Runs as one transaction so a crash mid-write can't leave a half-written
 * store that still matches the signature (which would otherwise look
 * "valid" on the next load but silently be missing most edges).
 */
export async function savePersistedGraph(
    db: SQLiteDatabase,
    signature: GraphSignature,
    adjacency: Map<string, CoarseEdge[]>,
): Promise<void> {
    await ensureTables(db);

    const rows = [...adjacency.entries()].map(([stopKey, edges]) => ({ stopKey, packed: encodeEdges(edges) }));

    await db.withTransactionAsync(async () => {
        await db.execAsync(`DELETE FROM coarse_graph_adjacency; DELETE FROM coarse_graph_meta;`);

        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
            const chunk = rows.slice(i, i + INSERT_CHUNK);
            const placeholders = chunk.map(() => '(?, ?)').join(', ');
            const params = chunk.flatMap(r => [r.stopKey, r.packed]);
            await db.runAsync(
                `INSERT INTO coarse_graph_adjacency (stop_key, edges) VALUES ${placeholders}`,
                params,
            );
        }

        await db.runAsync(
            `INSERT INTO coarse_graph_meta (key, value) VALUES ('signature', ?)`,
            [signatureKey(signature)],
        );
    });
}
