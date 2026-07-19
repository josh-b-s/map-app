/**
 * sqlChunkUtil.ts — chunked-IN-query helper, shared by any module that needs
 * to query SQLite with an ID list that can exceed its bound-parameter cap.
 *
 * Previously defined only inside gtfsLoader.ts. Pulled out because
 * corridorResolver.ts now needs the identical helper (fetching pattern_stops
 * for a candidate pattern list) and gtfsLoader.ts importing it FROM
 * corridorResolver.ts (or vice versa) would create a circular dependency —
 * this is the shared leaf both sit on top of.
 */

/** SQLite's default bound-parameter limit is 999; stay comfortably under it. */
export const SQL_CHUNK_SIZE = 400;

export function placeholders(n: number): string {
    return Array(n).fill('?').join(',');
}

/** Runs `queryFn` in chunks over `items`, unioning the results — needed
 *  because candidate ID lists (stop ids, pattern ids) can exceed SQLite's
 *  bound-parameter cap for a single query. */
export async function chunkedQuery<T, R>(
    items: T[],
    chunkSize: number,
    queryFn: (chunk: T[]) => Promise<R[]>,
    // Optional label — when provided, logs each individual chunk's timing.
    // Off by default (each call site opts in) since most callers already
    // have a single lap() covering the whole chunked query and don't need
    // per-chunk detail; this exists purely for tracking down variance that
    // a single before/after timestamp can't distinguish (e.g. "is chunk 3
    // of 12 disproportionately slow, or is the cost spread evenly?").
    debugLabel?: string,
): Promise<R[]> {
    if (items.length === 0) return [];
    const out: R[] = [];
    const numChunks = Math.ceil(items.length / chunkSize);
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const chunkIdx = Math.floor(i / chunkSize);
        const cT0 = debugLabel ? Date.now() : 0;
        const rows = await queryFn(chunk);
        if (debugLabel) {
            console.log(`[sqlChunkUtil]   [DIAGNOSTIC] ${debugLabel} chunk ${chunkIdx + 1}/${numChunks} ` +
                `(${chunk.length} items -> ${rows.length} rows): ${Date.now() - cT0}ms`);
        }
        for (const r of rows) out.push(r);
    }
    return out;
}
