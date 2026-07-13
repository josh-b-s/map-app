import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';

const DB_NAME = 'gtfs.db';
const DB_DIR  = `${FileSystem.documentDirectory}SQLite/`;
const DB_PATH = `${DB_DIR}${DB_NAME}`;

let _db: SQLite.SQLiteDatabase | null = null;

export async function isDbReady(): Promise<boolean> {
    const { exists } = await FileSystem.getInfoAsync(DB_PATH);
    return exists;
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
    if (_db) return _db;

    const ready = await isDbReady();
    if (!ready) {
        throw new Error('GTFS database not found. Download it first.');
    }

    const db = await SQLite.openDatabaseAsync(DB_NAME);

    // Use WAL on the reading side for better concurrent performance.
    // The distributed DB is built without WAL (journal_mode=DELETE), so
    // this creates a fresh WAL owned by the app – no sidecar-file issues.
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