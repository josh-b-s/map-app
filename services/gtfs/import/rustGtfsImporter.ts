/**
 * rustGtfsImporter.ts — thin bridge from the app to the native Rust
 * import_gtfs() (see modules/gtfs-importer/rust/src/lib.rs and import.rs).
 *
 * Replaces gtfsImporterLegacy.ts's importLatestZip() as the thing DebugControls.tsx
 * calls. gtfsImporterLegacy.ts itself is left untouched for now as a reference/
 * fallback until the Rust output has been verified against a real feed —
 * see the note in import.rs's process_agency() doc comment.
 *
 * NOTE: ProgressCallback (from generated/gtfs_importer.ts) is a TypeScript
 * interface, not a class — it doesn't exist at runtime, so it can't be
 * `extends`-ed. Pass a plain object literal matching the interface shape
 * instead; ubrn's FfiConverterObjectWithCallbacks wraps it for the FFI call.
 */

import * as FileSystem from 'expo-file-system/legacy';
import {importGtfs, type ProgressCallback} from '@mapapp/gtfs-importer';
import {ensureImportFolders, INCOMING_DIR} from './gtfsImporterLegacy';

export type ImportProgressEvent = { table: string; inserted: number; total: number };

// Same file:// stripping gtfsImporterLegacy.ts already does before handing paths
// to native code — expo-file-system always includes the file:// scheme,
// but std::fs::read on the Rust side wants a bare filesystem path.
function stripFileScheme(p: string): string {
    return p.startsWith('file://') ? p.slice('file://'.length) : p;
}

/** Finds the first .zip sitting in incoming/ — mirrors gtfsImporterLegacy.ts's
 *  findIncomingZip(), duplicated here rather than imported since that one
 *  isn't exported. */
async function findIncomingZip(): Promise<string | null> {
    const entries = await FileSystem.readDirectoryAsync(INCOMING_DIR);
    const zipName = entries.find(e => e.toLowerCase().endsWith('.zip'));
    return zipName ? `${INCOMING_DIR}${zipName}` : null;
}

// documentDirectory/SQLite/gtfs.db — same on-device db path gtfsDb.ts's
// getOrCreateDbForImport() opens via op-sqlite. The Rust side opens this
// file directly via rusqlite rather than going through op-sqlite at all,
// so there's no SQLiteDatabase handle to pass in — just the path.
function gtfsDbPath(): string {
    return `${FileSystem.documentDirectory}SQLite/gtfs.db`;
}

/**
 * Runs the native Rust GTFS import against whatever .zip is sitting in
 * gtfs-import/incoming/, writing straight into documentDirectory/SQLite/gtfs.db.
 * onProgress fires per-table (and periodically mid-table for the two big
 * ones, stop_times/shapes — see import.rs's `% 200_000` progress calls).
 */
export async function runRustImport(
    onProgress?: (p: ImportProgressEvent) => void,
): Promise<void> {
    const t0 = Date.now();
    const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

    console.log('[rustGtfsImporter] starting import…');

    await ensureImportFolders();
    console.log(`[rustGtfsImporter] import folders ready (${elapsed()})`);

    const zipPath = await findIncomingZip();
    if (!zipPath) {
        console.warn(`[rustGtfsImporter] no .zip found in ${INCOMING_DIR}`);
        throw new Error(`No .zip found in ${INCOMING_DIR} — drop one there first.`);
    }
    console.log(`[rustGtfsImporter] using zip: ${zipPath}`);

    // ensure documentDirectory/SQLite/ exists — rusqlite's Connection::open
    // will NOT create missing parent directories, only the db file itself.
    await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}SQLite/`, {
        intermediates: true,
    }).catch((_e: unknown) => {
    });

    const dbPath = gtfsDbPath();
    console.log(`[rustGtfsImporter] db path: ${dbPath}`);

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