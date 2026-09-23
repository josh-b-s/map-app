/**
 * gtfsDbImport.ts — the settings screen's "Add zip" flow: pick a .zip from
 * the device, import it into a brand-new database file, and register it
 * (as the active one) in gtfsDbRegistry.ts.
 *
 * Kept separate from rustGtfsImporter.ts (the generic zip-path -> db-path
 * importer) and gtfsDbRegistry.ts (the list/active-selection bookkeeping)
 * so each file has one job.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import { importGtfsZipToPath, type ImportProgressEvent } from './rustGtfsImporter';
import {
    DuplicateFeedError,
    findDatabaseByHash,
    nameFromZipFileName,
    registerDatabase,
    type GtfsDatabaseEntry,
} from './gtfsDbRegistry';

const SQLITE_DIR = `${FileSystem.documentDirectory}SQLite/`;

/**
 * Opens the system file picker for a .zip. Returns null if the user
 * cancelled — not an error, callers should just no-op in that case.
 */
export async function pickGtfsZip(): Promise<DocumentPicker.DocumentPickerAsset | null> {
    const result = await DocumentPicker.getDocumentAsync({
        // Some Android file providers don't tag zips as application/zip, so
        // the picker UI itself is the real filter — this is a hint, not
        // strictly enforced everywhere.
        type: ['application/zip', 'application/x-zip-compressed'],
        copyToCacheDirectory: true,
        multiple: false,
    });
    if (result.canceled || result.assets.length === 0) return null;
    return result.assets[0];
}

/**
 * Imports `zip` into a fresh database file and registers it, defaulting its
 * display name to the zip's own file name (minus .zip). onProgress mirrors
 * importGtfsZipToPath's per-table progress events.
 *
 * Before running the real import, hashes the zip (MD5, via op-sqlite's...
 * no — via expo-file-system's built-in md5 support, see getInfoAsync below)
 * and checks it against every already-imported feed's stored hash. A byte-
 * identical match throws DuplicateFeedError with the existing entry
 * attached, rather than silently re-running a multi-minute import into a
 * second, redundant database — callers (settings/gtfs.tsx) can catch that
 * specifically and offer to just select the existing one instead.
 */
export async function importZipAsNewDatabase(
    zip: DocumentPicker.DocumentPickerAsset,
    onProgress?: (p: ImportProgressEvent) => void,
): Promise<GtfsDatabaseEntry> {
    // { md5: true } asks expo-file-system to compute the hash natively
    // rather than reading the whole (potentially 100+MB) zip into JS memory
    // just to hash it here.
    const { md5 } = await FileSystem.getInfoAsync(zip.uri, { md5: true }) as { md5?: string };
    if (md5) {
        const existing = await findDatabaseByHash(md5);
        if (existing) throw new DuplicateFeedError(existing);
    }

    await FileSystem.makeDirectoryAsync(SQLITE_DIR, { intermediates: true }).catch(() => {});

    const fileName = `gtfs-${Date.now()}.db`;
    const dbPath = `${SQLITE_DIR}${fileName}`;

    await importGtfsZipToPath(zip.uri, dbPath, onProgress);

    const name = nameFromZipFileName(zip.name ?? 'Imported feed');
    return registerDatabase(name, fileName, md5);
}
