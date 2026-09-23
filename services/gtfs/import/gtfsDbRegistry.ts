/**
 * gtfsDbRegistry.ts — tracks the set of GTFS databases the user has
 * imported (one per zip they've added) and which one is currently active.
 *
 * Each import gets its own .db file, named by id so re-importing the same
 * region twice never collides: `{documentDirectory}SQLite/gtfs-{id}.db`.
 * There is no legacy single-db fallback any more — sqliteDb.ts's
 * currentDbPath starts as null, and stays null until restoreActiveDatabase()
 * (app startup) or setActiveDatabase()/registerDatabase() (below) point it
 * at a real imported file.
 *
 * Metadata (id/name/fileName/importedAt + which id is active) lives in one
 * small JSON file rather than a real table, since it's a handful of rows at
 * most and needs to be readable before any database is even open yet.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { setActiveDbPath } from '@/services/db/sqliteDb';
import { invalidateNativeRouter } from '../router/gtfsRouterNative';

export type GtfsDatabaseEntry = {
    id: string;
    name: string;
    fileName: string;
    importedAt: number;
};

type RegistryFile = {
    databases: GtfsDatabaseEntry[];
    activeId: string | null;
};

const SQLITE_DIR = `${FileSystem.documentDirectory}SQLite/`;
const REGISTRY_PATH = `${FileSystem.documentDirectory}gtfs-import/databases.json`;

async function readRegistry(): Promise<RegistryFile> {
    try {
        const raw = await FileSystem.readAsStringAsync(REGISTRY_PATH);
        const parsed = JSON.parse(raw) as RegistryFile;
        return { databases: parsed.databases ?? [], activeId: parsed.activeId ?? null };
    } catch {
        // No registry file yet (fresh install, or first import ever) —
        // start empty rather than throwing.
        return { databases: [], activeId: null };
    }
}

async function writeRegistry(reg: RegistryFile): Promise<void> {
    const dir = REGISTRY_PATH.slice(0, REGISTRY_PATH.lastIndexOf('/') + 1);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export function dbPathFor(entry: GtfsDatabaseEntry): string {
    return `${SQLITE_DIR}${entry.fileName}`;
}

export async function listDatabases(): Promise<GtfsDatabaseEntry[]> {
    const reg = await readRegistry();
    return [...reg.databases].sort((a, b) => b.importedAt - a.importedAt);
}

export async function getActiveDatabaseId(): Promise<string | null> {
    const reg = await readRegistry();
    return reg.activeId;
}

/** Strips a trailing .zip (case-insensitive) so "melbourne-gtfs.zip" -> "melbourne-gtfs". */
export function nameFromZipFileName(zipFileName: string): string {
    return zipFileName.replace(/\.zip$/i, '');
}

/**
 * Repoints the app at whichever database was active last session. Call
 * this once at startup (see app/_layout.tsx) BEFORE anything else touches
 * the db (warmup, a route search) — without it, sqliteDb.ts's currentDbPath
 * just stays at its module-load default (the legacy gtfs.db path) even
 * though the registry file and settings/gtfs.tsx's list both still say a
 * different feed is selected, which is exactly the "shows as selected but
 * routing errors" bug this fixes: the UI's idea of "active" was persisted,
 * but the actual db connection's idea of "active" was not.
 *
 * If the previously-active entry's file is missing (e.g. storage was
 * cleared, or the file was deleted outside the app), falls back to no
 * active database instead of pointing at a nonexistent file, and clears
 * activeId in the registry so the list doesn't keep showing a dead
 * selection as checked.
 */
export async function restoreActiveDatabase(): Promise<void> {
    const reg = await readRegistry();
    if (!reg.activeId) return;

    const entry = reg.databases.find(d => d.id === reg.activeId);
    const path = entry ? dbPathFor(entry) : null;
    const exists = path ? (await FileSystem.getInfoAsync(path)).exists : false;

    if (entry && exists) {
        setActiveDbPath(path!);
        return;
    }

    console.warn(`[gtfsDbRegistry] active database "${reg.activeId}" is missing on disk — clearing selection`);
    reg.activeId = null;
    await writeRegistry(reg);
}

/**
 * Points the app (op-sqlite connection + Rust router engine) at `id`.
 * Throws if `id` isn't a known database.
 */
export async function setActiveDatabase(id: string): Promise<void> {
    const reg = await readRegistry();
    const entry = reg.databases.find(d => d.id === id);
    if (!entry) throw new Error(`Unknown GTFS database id: ${id}`);

    setActiveDbPath(dbPathFor(entry));
    invalidateNativeRouter(); // forces the next search to re-warm against the new file

    reg.activeId = id;
    await writeRegistry(reg);
}

/**
 * Registers a freshly-imported database file (already written to disk by
 * the caller — see gtfsDbImport.ts) and makes it the active one.
 */
export async function registerDatabase(name: string, fileName: string): Promise<GtfsDatabaseEntry> {
    const reg = await readRegistry();
    const entry: GtfsDatabaseEntry = {
        id: `${Date.now()}`,
        name,
        fileName,
        importedAt: Date.now(),
    };
    reg.databases.push(entry);
    reg.activeId = entry.id;
    await writeRegistry(reg);

    setActiveDbPath(dbPathFor(entry));
    invalidateNativeRouter();

    return entry;
}

/** Removes a database's registry entry and its on-disk file. Refuses to delete the active one. */
export async function deleteDatabase(id: string): Promise<void> {
    const reg = await readRegistry();
    if (reg.activeId === id) {
        throw new Error('Cannot delete the currently selected database — select another one first.');
    }
    const entry = reg.databases.find(d => d.id === id);
    reg.databases = reg.databases.filter(d => d.id !== id);
    await writeRegistry(reg);

    if (entry) {
        await FileSystem.deleteAsync(dbPathFor(entry), { idempotent: true }).catch(() => {});
    }
}
