/**
 * rustGtfsImporter.ts — thin bridge from the app to the native Rust
 * import_gtfs() (see modules/gtfs-importer/rust/src/lib.rs and import.rs).
 *
 * importGtfsZipToPath() is the generic entry point: given an explicit zip
 * file and target .db path, it runs the native import and reports progress.
 * gtfsDbImport.ts (the settings screen's "Add zip" flow) calls this with a
 * fresh per-import db path from gtfsDbRegistry.ts, rather than the old
 * single-fixed-db-file/single-incoming-folder flow this file used to own.
 *
 * NOTE: ProgressCallback (from generated/gtfs_importer.ts) is a TypeScript
 * interface, not a class — it doesn't exist at runtime, so it can't be
 * `extends`-ed. Pass a plain object literal matching the interface shape
 * instead; ubrn's FfiConverterObjectWithCallbacks wraps it for the FFI call.
 */

import {importGtfs, type ProgressCallback} from '@mapapp/gtfs-importer';

export type ImportProgressEvent = { table: string; inserted: number; total: number };

// expo-file-system always includes the file:// scheme on uris/paths it
// hands back, but std::fs::read on the Rust side wants a bare filesystem
// path.
function stripFileScheme(p: string): string {
    return p.startsWith('file://') ? p.slice('file://'.length) : p;
}

/**
 * Runs the native Rust GTFS import from `zipPath` straight into `dbPath`
 * (a fresh, not-yet-existing file — the importer creates it). onProgress
 * fires per-table (and periodically mid-table for the two big ones,
 * stop_times/shapes — see import.rs's `% 200_000` progress calls).
 */
export async function importGtfsZipToPath(
    zipPath: string,
    dbPath: string,
    onProgress?: (p: ImportProgressEvent) => void,
): Promise<void> {
    const t0 = Date.now();
    const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

    console.log(`[rustGtfsImporter] starting import of ${zipPath} -> ${dbPath}`);

    // Track a per-table start time so we can log a duration when a table
    // finishes (i.e. when the next progress event names a different table,
    // or when the whole import completes).
    let currentTable: string | null = null;
    let tableStart = Date.now();
    let lastLoggedPercent = -1;

    const progressCallback: ProgressCallback = {
        onProgress(table: string, inserted: bigint, total: bigint) {
            const insertedNum = Number(inserted);
            const totalNum = Number(total);

            if (table !== currentTable) {
                if (currentTable !== null) {
                    console.log(
                        `[rustGtfsImporter] finished ${currentTable} in ${((Date.now() - tableStart) / 1000).toFixed(1)}s (${elapsed()} total)`,
                    );
                }
                currentTable = table;
                tableStart = Date.now();
                lastLoggedPercent = -1;
                console.log(`[rustGtfsImporter] starting table: ${table} (${elapsed()} total)`);
            }

            // Throttle per-row logs to every 10% so big tables (stop_times,
            // shapes) don't flood the console.
            const percent = totalNum > 0 ? Math.floor((insertedNum / totalNum) * 100) : 0;
            if (percent >= lastLoggedPercent + 10 || insertedNum === totalNum) {
                lastLoggedPercent = percent;
                console.log(
                    `[rustGtfsImporter] ${table}: ${insertedNum}/${totalNum} (${percent}%) — ${elapsed()} total`,
                );
            }

            onProgress?.({table, inserted: insertedNum, total: totalNum});
        },
    };

    try {
        await importGtfs(
            stripFileScheme(zipPath),
            stripFileScheme(dbPath),
            progressCallback,
        );
        if (currentTable !== null) {
            console.log(
                `[rustGtfsImporter] finished ${currentTable} in ${((Date.now() - tableStart) / 1000).toFixed(1)}s`,
            );
        }
        console.log(`[rustGtfsImporter] import complete in ${elapsed()}`);
    } catch (err) {
        console.error(`[rustGtfsImporter] import failed after ${elapsed()}:`, err);
        throw err;
    }
}