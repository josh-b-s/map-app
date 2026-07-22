/**
 * gtfsInsertBenchmark.ts — measures batchInsert() throughput on-device with
 * SYNTHETIC data, before trusting a full real-feed import to be viable.
 *
 * WHY SYNTHETIC DATA FIRST: this isolates the one variable that's actually
 * unproven (op-sqlite bridge + write throughput on a real phone) from
 * everything else in the pipeline (CSV parsing, unzip, JS object
 * allocation) that's either already known-fast (desktop parseCSV, same
 * logic) or benchmarkable separately. If THIS number is bad, no amount of
 * CSV-parsing optimization will save the import — better to find that out
 * in 60 seconds than after sitting through a full 258MB unzip + parse.
 *
 * HOW TO USE:
 *   1. Wire runInsertBenchmark() to a button on a dev-only screen (NOT
 *      something a real user should be able to trigger — it deletes its
 *      own scratch table but still writes real data to the live db file
 *      briefly).
 *   2. Run on a real device, not a simulator — simulator disk I/O and JS
 *      bridge timing are not representative of real device flash storage
 *      and bridge overhead.
 *   3. Run with the app in the state a real import would happen in (i.e.
 *      not immediately after a fresh install with nothing else in the db —
 *      have the normal gtfs.db already loaded, since that's the realistic
 *      condition: SQLite page cache pressure, WAL file size, etc. all
 *      differ from an empty db).
 *   4. Read the logged per-stage numbers (see BenchmarkResult) and
 *      extrapolate: multiply the ms-per-1000-rows figure by 11_860 to
 *      estimate real stop_times-scale time (adjust the multiplier to your
 *      actual feed's row count from your own preprocess-gtfs.ts log).
 */

import type {SQLiteDatabase} from '../../db/sqliteDb';
import {batchInsert} from '../../db/batchInsertUtil';

interface BenchStage {
    rowCount: number;
    ms: number;
    msPer1000Rows: number;
}

export interface BenchmarkResult {
    stages: BenchStage[];
    /** Extrapolated estimate for the real stop_times row count you pass in,
     *  based on the LARGEST stage actually measured (extrapolating from
     *  the biggest sample is more honest than from the smallest — bridge
     *  overhead and GC pauses don't scale linearly at small N). */
    estimatedMsForRealRowCount: number;
}

interface SyntheticStopTimeRow {
    trip_pk: number;
    stop_sequence: number;
    stop_pk: number;
    arrival_sec: number;
    departure_sec: number;
}

function makeSyntheticRows(n: number): SyntheticStopTimeRow[] {
    const rows: SyntheticStopTimeRow[] = [];
    // Deliberately varies trip_pk/stop_pk/time values (not all-identical
    // constants) so this isn't measuring some SQLite fast-path for
    // repeated identical values that a real, varied feed wouldn't hit.
    for (let i = 0; i < n; i++) {
        rows.push({
            trip_pk: Math.floor(i / 20) + 1,        // ~20 stops per synthetic "trip", roughly realistic
            stop_sequence: i % 20,
            stop_pk: (i % 9000) + 1,                 // spread across a stop-count similar to a real feed
            arrival_sec: 3600 * 5 + (i % 86400),
            departure_sec: 3600 * 5 + (i % 86400) + 20,
        });
    }
    return rows;
}

/**
 * Runs the insert benchmark against a scratch table (created and dropped
 * within this function — never touches the real stop_times table), at
 * increasing row counts, and logs timing for each stage as it completes
 * (so you have partial results even if a later, larger stage hangs).
 */
export async function runInsertBenchmark(
    db: SQLiteDatabase,
    realRowCountToEstimate: number,
    stageSizes: number[] = [10_000, 100_000, 500_000, 1_000_000],
    onLog?: (line: string) => void,
): Promise<BenchmarkResult> {
    const log = (line: string) => {
        console.log(`[gtfsInsertBenchmark] ${line}`);
        onLog?.(line);
    };

    await db.execAsync(`DROP TABLE IF EXISTS bench_stop_times_scratch;`);
    await db.execAsync(`
        CREATE TABLE bench_stop_times_scratch
        (
            trip_pk       INTEGER NOT NULL,
            stop_sequence INTEGER NOT NULL,
            stop_pk       INTEGER NOT NULL,
            arrival_sec   INTEGER NOT NULL,
            departure_sec INTEGER NOT NULL,
            PRIMARY KEY (trip_pk, stop_sequence)
        ) WITHOUT ROWID;
    `);

    const stages: BenchStage[] = [];

    try {
        for (const rowCount of stageSizes) {
            log(`generating ${rowCount} synthetic rows…`);
            const rows = makeSyntheticRows(rowCount);

            // Fresh table each stage so earlier stages' rows don't inflate
            // later ones' PRIMARY KEY conflict-checking cost.
            await db.execAsync(`DELETE
                                FROM bench_stop_times_scratch;`);

            const t0 = Date.now();
            await batchInsert(
                db,
                'bench_stop_times_scratch',
                ['trip_pk', 'stop_sequence', 'stop_pk', 'arrival_sec', 'departure_sec'],
                rows,
                r => [r.trip_pk, r.stop_sequence, r.stop_pk, r.arrival_sec, r.departure_sec],
            );
            const ms = Date.now() - t0;
            const msPer1000Rows = (ms / rowCount) * 1000;

            stages.push({rowCount, ms, msPer1000Rows});
            log(`${rowCount} rows: ${ms}ms (${msPer1000Rows.toFixed(1)}ms / 1000 rows)`);
        }
    } finally {
        await db.execAsync(`DROP TABLE IF EXISTS bench_stop_times_scratch;`);
    }

    const largest = stages[stages.length - 1];
    const estimatedMsForRealRowCount = largest ? largest.msPer1000Rows * (realRowCountToEstimate / 1000) : NaN;

    log(`estimated time for ${realRowCountToEstimate} real rows: ${(estimatedMsForRealRowCount / 1000).toFixed(1)}s ` +
        `(extrapolated from the ${largest?.rowCount ?? 0}-row stage)`);

    return {stages, estimatedMsForRealRowCount};
}
