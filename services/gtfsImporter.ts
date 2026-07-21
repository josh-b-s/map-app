/**
 * gtfsImporter.ts — on-device counterpart to scripts/preprocess-gtfs.ts.
 *
 * Same eventual job (parse GTFS CSVs -> populate gtfs.db) but a different
 * environment: op-sqlite instead of better-sqlite3 (see gtfsDb.ts's module
 * doc for why those aren't drop-in compatible), and batched multi-value
 * INSERTs instead of one prepared-statement .run() per row (see
 * batchInsertUtil.ts's module doc — a per-row async bridge call at
 * stop_times scale, ~11.8M rows on the current feed, is not viable).
 *
 * FOLDER LAYOUT (separate from gtfsDb.ts's SQLite/ folder deliberately —
 * that folder's presence/contents is what isDbReady() and resetDb() reason
 * about; zip staging/extraction scratch has no business living there):
 *
 *   {documentDirectory}/gtfs-import/
 *     incoming/    <- for now: manually drop a .zip here. Later: document
 *                     picker / download flow writes here instead — this
 *                     module doesn't care how the zip arrived, only that
 *                     it's sitting in this folder when the importer runs.
 *     extracted/   <- scratch space, meant to be wiped and recreated at
 *                     the START of every import (never trust leftovers
 *                     from a prior failed/cancelled run). Safe to delete
 *                     by hand too.
 *
 * CURRENT STATUS: stripped down to folder setup only
 * (IMPORT_ROOT/INCOMING_DIR/EXTRACTED_DIR + ensureImportFolders()) while
 * the parsing/import pipeline is being rebuilt. Nothing here yet unzips a
 * feed, reads CSVs, or touches gtfs.db.
 */

import * as FileSystem from 'expo-file-system/legacy';

export const IMPORT_ROOT = `${FileSystem.documentDirectory}gtfs-import/`;
export const INCOMING_DIR = `${IMPORT_ROOT}incoming/`;
const EXTRACTED_DIR = `${IMPORT_ROOT}extracted/`;

export async function ensureImportFolders(): Promise<void> {
    await FileSystem.makeDirectoryAsync(INCOMING_DIR, {intermediates: true}).catch((_e: unknown) => {
    });
    await FileSystem.makeDirectoryAsync(EXTRACTED_DIR, {intermediates: true}).catch((_e: unknown) => {
    });
}