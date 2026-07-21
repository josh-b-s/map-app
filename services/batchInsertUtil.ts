/**
 * batchInsertUtil.ts — chunked multi-value INSERT helper for bulk-loading
 * GTFS tables on-device via op-sqlite.
 *
 * WHY THIS EXISTS: op-sqlite's execute() is an async JS<->native bridge
 * call. One insert.run() per row (the desktop preprocess-gtfs.ts pattern,
 * fine there because better-sqlite3 is synchronous/in-process) means one
 * bridge round trip per row. At stop_times scale (~11.8M rows across a
 * typical multi-agency feed) that's the same per-row marshaling problem
 * coarseGraphStore.ts's header comment already documents for a mere 30K
 * rows — just ~400x worse. The fix is the same one already used there:
 * pack many rows into one multi-value INSERT, and batch those inside a
 * single transaction so SQLite doesn't fsync/commit per chunk either.
 *
 * SIZING: SQLite's default bound-parameter limit is 999. Chunk size is
 * derived from columnsPerRow so (chunkSize * columnsPerRow) stays
 * comfortably under that regardless of how wide the row is — a 5-column
 * table (stop_times) and a 2-column table (coarse_graph_adjacency) get
 * different row-per-chunk counts automatically instead of a single magic
 * number tuned for one specific table and silently wrong for another.
 */

import type {SQLiteDatabase} from './gtfsDb';

const MAX_BOUND_PARAMS = 900; // stay under SQLite's 999 cap with margin

/**
 * Inserts `rows` into `table` in chunked multi-value INSERTs, all inside
 * one transaction. `toParams` flattens one row into its positional bind
 * values, in the same order as `columns`.
 *
 * Does NOT open its own transaction if `db` is already inside one (op-sqlite
 * routes through gtfsDb.ts's currentTx when set — see its module doc) —
 * pass `wrapInTransaction: false` when calling this from inside a caller
 * that's already managing the transaction (e.g. importing several tables
 * for one agency atomically).
 */
export async function batchInsert<T>(
    db: SQLiteDatabase,
    table: string,
    columns: string[],
    rows: T[],
    toParams: (row: T) => any[],
    opts: {wrapInTransaction?: boolean; onProgress?: (inserted: number, total: number) => void} = {},
): Promise<void> {
    if (rows.length === 0) return;

    const {wrapInTransaction = true, onProgress} = opts;
    const rowsPerChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns.length));
    const columnList = columns.join(', ');
    const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;

    const runChunks = async () => {
        let inserted = 0;
        for (let i = 0; i < rows.length; i += rowsPerChunk) {
            const chunk = rows.slice(i, i + rowsPerChunk);
            const placeholders = chunk.map(() => rowPlaceholder).join(', ');
            const params = chunk.flatMap(toParams);
            await db.runAsync(
                `INSERT INTO ${table} (${columnList}) VALUES ${placeholders}`,
                params,
            );
            inserted += chunk.length;
            onProgress?.(inserted, rows.length);
        }
    };

    if (wrapInTransaction) {
        await db.withTransactionAsync(runChunks);
    } else {
        await runChunks();
    }
}
