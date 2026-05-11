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

    _db = await SQLite.openDatabaseAsync(DB_NAME);
    return _db;
}

export function resetDb() {
    _db = null;  // call this after a fresh DB is copied in
}