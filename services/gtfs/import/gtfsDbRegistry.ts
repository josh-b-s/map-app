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
import { setActiveDbPath, clearActiveDbPath } from '@/services/db/sqliteDb';
import { invalidateNativeRouter } from '../router/gtfsRouterNative';

export type GtfsDatabaseEntry = {
    id: string;
    name: string;
    fileName: string;
    importedAt: number;
    /** MD5 of the source .zip at import time (see gtfsDbImport.ts) — lets a
     *  future import detect "this exact feed is already imported" before
     *  paying the real import cost. Optional because entries created before
     *  this field existed won't have one; those just never match. */
    zipHash?: string;
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

/**
 * Finds an already-imported database whose source zip had this exact hash,
 * if any. Used by gtfsDbImport.ts BEFORE running the (expensive) import, so
 * re-adding a byte-identical feed can be caught early instead of silently
 * doing the full import again into a second, redundant database file.
 */
export async function findDatabaseByHash(zipHash: string): Promise<GtfsDatabaseEntry | null> {
    const reg = await readRegistry();
    return reg.databases.find(d => d.zipHash === zipHash) ?? null;
}

/** Strips a trailing .zip (case-insensitive) so "melbourne-gtfs.zip" -> "melbourne-gtfs". */
export function nameFromZipFileName(zipFileName: string): string {
    return zipFileName.replace(/\.zip$/i, '');
}

/**
 * Thrown by renameDatabase() when the requested name collides with another
 * existing entry — distinguished from other Errors so callers (the
 * settings screen) can show a specific "name already exists" message
 * rather than a generic failure.
 */
export class DuplicateNameError extends Error {
    constructor(name: string) {
        super(`"${name}" is already in use by another feed.`);
        this.name = 'DuplicateNameError';
    }
}

/**
 * Thrown by gtfsDbImport.ts when the picked zip's hash exactly matches an
 * already-imported feed's — distinguished from other Errors so the
 * settings screen can offer "use the existing one" instead of a generic
 * failure message.
 */
export class DuplicateFeedError extends Error {
    existing: GtfsDatabaseEntry;
    constructor(existing: GtfsDatabaseEntry) {
        super(`This exact feed is already imported as "${existing.name}".`);
        this.name = 'DuplicateFeedError';
        this.existing = existing;
    }
}

function namesCollide(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Appends " (1)", " (2)", etc. — same convention every desktop file system
 * uses for "a file with this name already exists here" — until `candidate`
 * no longer collides (case-insensitively) with anything in `existingNames`.
 * Used for imports, where silently disambiguating is friendlier than
 * bothering the user mid-import; renameDatabase() below, in contrast,
 * rejects a collision outright since a rename is a deliberate, one-off
 * action the user should get a chance to reconsider.
 */
function dedupeName(candidate: string, existingNames: string[]): string {
    if (!existingNames.some(n => namesCollide(n, candidate))) return candidate;
    let n = 1;
    let attempt = `${candidate} (${n})`;
    while (existingNames.some(existing => namesCollide(existing, attempt))) {
        n += 1;
        attempt = `${candidate} (${n})`;
    }
    return attempt;
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
 * the caller — see gtfsDbImport.ts) and makes it the active one. If `name`
 * collides with an existing entry, silently disambiguates it file-system
 * style ("Melbourne" -> "Melbourne (1)") rather than failing the import.
 */
export async function registerDatabase(name: string, fileName: string, zipHash?: string): Promise<GtfsDatabaseEntry> {
    const reg = await readRegistry();
    const uniqueName = dedupeName(name, reg.databases.map(d => d.name));
    const entry: GtfsDatabaseEntry = {
        id: `${Date.now()}`,
        name: uniqueName,
        fileName,
        importedAt: Date.now(),
        zipHash,
    };
    reg.databases.push(entry);
    reg.activeId = entry.id;
    await writeRegistry(reg);

    setActiveDbPath(dbPathFor(entry));
    invalidateNativeRouter();

    return entry;
}

/**
 * Renames an existing entry. Unlike registerDatabase()'s import-time
 * auto-disambiguation, this REJECTS a name that collides with another
 * entry (throwing DuplicateNameError) instead of silently appending
 * " (1)" — a rename is a deliberate action, so the user should get a
 * chance to pick a different name rather than have one picked for them.
 * Renaming to an entry's OWN current name (e.g. saving without changing
 * anything) is not treated as a collision.
 */
export async function renameDatabase(id: string, newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Name cannot be empty.');

    const reg = await readRegistry();
    const entry = reg.databases.find(d => d.id === id);
    if (!entry) throw new Error(`Unknown GTFS database id: ${id}`);

    const collision = reg.databases.some(d => d.id !== id && namesCollide(d.name, trimmed));
    if (collision) throw new DuplicateNameError(trimmed);

    entry.name = trimmed;
    await writeRegistry(reg);
}

/**
 * Removes a database's registry entry and its on-disk file. If it was the
 * active one, falls back to the most recently imported of whatever's left
 * (or clears the selection entirely if this was the last database) rather
 * than refusing the delete — the settings screen's confirmation dialog is
 * where the user should be stopped and asked, not here.
 */
export async function deleteDatabase(id: string): Promise<void> {
    const reg = await readRegistry();
    const entry = reg.databases.find(d => d.id === id);
    reg.databases = reg.databases.filter(d => d.id !== id);

    if (reg.activeId === id) {
        const fallback = [...reg.databases].sort((a, b) => b.importedAt - a.importedAt)[0] ?? null;
        if (fallback) {
            reg.activeId = fallback.id;
            setActiveDbPath(dbPathFor(fallback));
            invalidateNativeRouter();
        } else {
            reg.activeId = null;
            clearActiveDbPath();
            invalidateNativeRouter();
        }
    }

    await writeRegistry(reg);

    if (entry) {
        await FileSystem.deleteAsync(dbPathFor(entry), { idempotent: true }).catch(() => {});
    }
}
