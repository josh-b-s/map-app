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
import { nameFromZipFileName, registerDatabase, type GtfsDatabaseEntry } from './gtfsDbRegistry';

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
 */
export async function importZipAsNewDatabase(
    zip: DocumentPicker.DocumentPickerAsset,
    onProgress?: (p: ImportProgressEvent) => void,
): Promise<GtfsDatabaseEntry> {
    await FileSystem.makeDirectoryAsync(SQLITE_DIR, { intermediates: true }).catch(() => {});

    const fileName = `gtfs-${Date.now()}.db`;
    const dbPath = `${SQLITE_DIR}${fileName}`;

    await importGtfsZipToPath(zip.uri, dbPath, onProgress);

    const name = nameFromZipFileName(zip.name ?? 'Imported feed');
    return registerDatabase(name, fileName);
}
