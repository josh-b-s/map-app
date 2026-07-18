import { open, type DB as OPSQLiteDB, type Transaction as OPSQLiteTx } from '@op-engineering/op-sqlite';
import * as FileSystem from 'expo-file-system/legacy';

const DB_NAME = 'gtfs.db';
const DB_DIR  = `${FileSystem.documentDirectory}SQLite/`;
const DB_PATH = `${DB_DIR}${DB_NAME}`;

export async function isDbReady(): Promise<boolean> {
    const { exists } = await FileSystem.getInfoAsync(DB_PATH);
    return exists;
}

/**
 * Compatibility wrapper around op-sqlite's DB object.
 *
 * WHY THIS EXISTS: op-sqlite's API shape differs from expo-sqlite's in two
 * ways that matter for the rest of this codebase:
 *
 * 1. op-sqlite's execute() only runs the FIRST statement in a
 *    semicolon-separated SQL string (expo-sqlite's execAsync ran all of
 *    them). Every multi-statement PRAGMA/DDL block that used to be one
 *    execAsync call is split and run sequentially inside execAsync() below,
 *    so every existing call site keeps working unchanged.
 *
 * 2. op-sqlite's transaction model passes an explicit `tx` object to the
 *    callback (`db.transaction(async (tx) => { tx.execute(...) })`) —
 *    there's no implicit "just keep calling db.execute() inside the
 *    callback and it magically joins the transaction" behavior the way
 *    expo-sqlite's withTransactionAsync had. coarseGraphStore.ts's
 *    savePersistedGraph() calls db.execAsync/db.runAsync DIRECTLY inside
 *    its withTransactionAsync callback (not a passed tx) — a naive wrapper
 *    would silently lose the atomicity that fix depended on (each
 *    statement would go back to being its own implicit commit). Fixed
 *    here via a mutable `currentTx` field: withTransactionAsync sets it
 *    for the duration of the callback, and every other method routes
 *    through it when set. This mirrors expo-sqlite's implicit-context
 *    behavior explicitly. Safe under this codebase's existing invariant of
 *    exactly one shared connection used serially (see getDb()'s _db
 *    singleton) — op-sqlite's own docs make the same recommendation
 *    ("DO NOT OPEN MORE THAN ONE CONNECTION PER DATABASE").
 */
export class SQLiteDatabase {
    private raw: OPSQLiteDB;
    private currentTx: OPSQLiteTx | null = null;

    constructor(raw: OPSQLiteDB) {
        this.raw = raw;
    }

    private target(): OPSQLiteDB | OPSQLiteTx {
        return this.currentTx ?? this.raw;
    }

    async getAllAsync<T>(sql: string, params: any[] = []): Promise<T[]> {
        const { rows } = await this.target().execute(sql, params);
        return (rows ?? []) as unknown as T[];
    }

    async execAsync(sql: string): Promise<void> {
        const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            await this.target().execute(stmt);
        }
    }

    async runAsync(sql: string, params: any[] = []): Promise<{ lastInsertRowId: number; changes: number }> {
        const res = await this.target().execute(sql, params);
        return { lastInsertRowId: res.insertId ?? 0, changes: res.rowsAffected ?? 0 };
    }

    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
        await this.raw.transaction(async (tx) => {
            this.currentTx = tx;
            try {
                await fn();
            } finally {
                this.currentTx = null;
            }
        });
    }
}

let _db: SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLiteDatabase> {
    if (_db) return _db;

    const ready = await isDbReady();
    if (!ready) {
        throw new Error('GTFS database not found. Download it first.');
    }

    // op-sqlite's `location` option: verify this against op-sqlite's docs
    // for your installed version before relying on it — the docs snippet
    // available at migration time showed `location` used for attach() with
    // a relative-path-prepended-to-filename semantic, but didn't fully
    // spell out open()'s resolution rules for a custom absolute directory
    // like the one this app already uses via expo-file-system. If this
    // doesn't resolve to DB_PATH as expected, check op-sqlite's "Gotchas"
    // page for the current location/path resolution behavior.
    const raw = open({ name: DB_NAME, location: DB_DIR });

    const db = new SQLiteDatabase(raw);

    // Same PRAGMAs as before — execAsync splits this into 4 separate
    // execute() calls internally now, since op-sqlite's execute() only
    // runs the first statement of a multi-statement string.
    await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA cache_size   = -8000;
        PRAGMA temp_store   = MEMORY;
        PRAGMA mmap_size    = 268435456;
    `);

    _db = db;
    return _db;
}

export function resetDb() {
    _db = null;  // call this after a fresh DB is copied in
}

export type LatLng = { latitude: number; longitude: number };
export type TravelMode = "DRIVE" | "TRANSIT" | "WALK" | "BICYCLE";

export interface SearchPlace {
    place_id:  string;
    name:      string;
    address:   string;
    latitude:  number;
    longitude: number;
}

export interface SearchOptions {
    apiKey:    string;
    location?: LatLng;
    signal?:   AbortSignal;
}

export async function searchPlaces(query: string, opts: SearchOptions): Promise<SearchPlace[]> {
    const { apiKey, location, signal } = opts;
    if (!apiKey) throw new Error("Missing API key");
    if (!query.trim()) return [];

    const body: any = { textQuery: query, maxResultCount: 8 };
    if (location) {
        body.locationBias = {
            circle: {
                center: { latitude: location.latitude, longitude: location.longitude },
                radius: 50000,
            },
        };
    }

    const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
            "Content-Type":    "application/json",
            "X-Goog-Api-Key":  apiKey,
            "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
        },
        body:   JSON.stringify(body),
        signal,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    return (data.places ?? []).map((p: any) => ({
        place_id:  p.id,
        name:      p.displayName?.text    ?? "Unknown",
        address:   p.formattedAddress     ?? "",
        latitude:  p.location?.latitude   ?? 0,
        longitude: p.location?.longitude  ?? 0,
    }));
}
