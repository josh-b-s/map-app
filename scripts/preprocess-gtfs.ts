import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const AGENCIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const GTFS_DIR = path.join(__dirname, '../assets/gtfs');
const DB_PATH  = path.join(__dirname, '../assets/gtfs.db');

// ─────────────────────────────────────────────────────────────────────────────
// CSV helpers
// ─────────────────────────────────────────────────────────────────────────────

function splitCSVLine(line: string): string[] {
    const fields: string[] = [];
    let inQuote = false;
    let cur = '';
    for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; continue; }
        cur += ch;
    }
    fields.push(cur);
    return fields;
}

function stripBOM(s: string): string {
    return s.replace(/^\uFEFF/, '');
}

function normalizeHexColor(value?: string | null): string {
    const raw = (value ?? '').trim();
    if (!raw) return '';
    const hex = raw.replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : '';
}

async function* streamCSV(filePath: string): AsyncGenerator<Record<string, string>> {
    if (!fs.existsSync(filePath)) return;
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    let headers: string[] | null = null;
    for await (const line of rl) {
        if (!line.trim()) continue;
        if (!headers) {
            headers = splitCSVLine(line).map(h => stripBOM(h.trim()));
            continue;
        }
        const parts = splitCSVLine(line);
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = (parts[i] ?? '').trim(); });
        yield row;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GTFS time parser  (supports times > 24:00:00 for overnight services)
// ─────────────────────────────────────────────────────────────────────────────

function parseGtfsTimeSec(s: string): number {
    if (!s) return 0;
    const parts = s.split(':');
    const h   = parseInt(parts[0] ?? '0', 10);
    const m   = parseInt(parts[1] ?? '0', 10);
    const sec = parseInt(parts[2] ?? '0', 10);
    return h * 3600 + m * 60 + sec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

function createSchema(db: Database.Database) {
    db.exec(`
        CREATE TABLE stops (
                               stop_id   TEXT    NOT NULL,
                               stop_name TEXT,
                               stop_lat  REAL    NOT NULL,
                               stop_lon  REAL    NOT NULL,
                               agency    INTEGER NOT NULL,
                               PRIMARY KEY (stop_id, agency)
        );

        CREATE TABLE routes (
                                route_id         TEXT    NOT NULL,
                                route_short_name TEXT,
                                route_long_name  TEXT,
                                route_type       INTEGER,
                                route_color      TEXT,
                                route_text_color TEXT,
                                agency           INTEGER NOT NULL,
                                PRIMARY KEY (route_id, agency)
        );

        /*
         * trips: every trip from every agency.
         * pattern_id is denormalised here for fast RAPTOR lookups.
         */
        CREATE TABLE trips (
                               trip_id    TEXT    NOT NULL,
                               agency     INTEGER NOT NULL,
                               pattern_id TEXT    NOT NULL,
                               service_id TEXT    NOT NULL DEFAULT '',
                               PRIMARY KEY (trip_id, agency)
        );

        /*
         * patterns: one row per unique (route × direction × shape) combination.
         * trip_id is the representative trip used for geometry (pattern_stops).
         */
        CREATE TABLE patterns (
                                  pattern_id   TEXT PRIMARY KEY,
                                  route_id     TEXT    NOT NULL,
                                  agency       INTEGER NOT NULL,
                                  direction_id INTEGER NOT NULL DEFAULT 0,
                                  shape_id     TEXT,
                                  trip_id      TEXT    NOT NULL
        );

        /* Stop-sequence skeleton for each pattern (geometry / boarding lookup). */
        CREATE TABLE pattern_stops (
                                       pattern_id    TEXT    NOT NULL,
                                       stop_id       TEXT    NOT NULL,
                                       stop_sequence INTEGER NOT NULL,
                                       agency        INTEGER NOT NULL
        );

        /*
         * stop_times: every departure/arrival for every trip.
         * pattern_id is denormalised to allow a single indexed scan when RAPTOR
         * searches for the earliest trip on a given pattern at a given stop.
         *
         * Times are stored as seconds since midnight (GTFS permits values > 86400
         * for after-midnight services on the same service day, e.g. 25:30:00 →
         * 91800 s).  Comparisons like departure_sec >= tau[stop] work correctly
         * without any modular arithmetic.
         */
        CREATE TABLE stop_times (
                                    trip_id       TEXT    NOT NULL,
                                    agency        INTEGER NOT NULL,
                                    stop_sequence INTEGER NOT NULL,
                                    stop_id       TEXT    NOT NULL,
                                    pattern_id    TEXT    NOT NULL,
                                    arrival_sec   INTEGER NOT NULL,
                                    departure_sec INTEGER NOT NULL,
                                    PRIMARY KEY (trip_id, agency, stop_sequence)
        );

        CREATE TABLE shapes (
                                shape_id          TEXT    NOT NULL,
                                agency            INTEGER NOT NULL,
                                shape_pt_lat      REAL    NOT NULL,
                                shape_pt_lon      REAL    NOT NULL,
                                shape_pt_sequence INTEGER NOT NULL
        );
    `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-agency processing
// ─────────────────────────────────────────────────────────────────────────────

async function processAgency(agencyId: number, db: Database.Database) {
    const zipPath = path.join(GTFS_DIR, String(agencyId), 'google_transit.zip');
    if (!fs.existsSync(zipPath)) {
        console.log(`Agency ${agencyId}: zip not found, skipping`);
        return;
    }

    const tempDir = path.join(os.tmpdir(), `gtfs_agency_${agencyId}`);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    console.log(`Agency ${agencyId}: extracting...`);
    new AdmZip(zipPath).extractAllTo(tempDir, true);

    const file = (name: string) => path.join(tempDir, name);

    // ── Stops ────────────────────────────────────────────────────────────────
    {
        const ins = db.prepare(
            `INSERT OR IGNORE INTO stops (stop_id, stop_name, stop_lat, stop_lon, agency)
             VALUES (?, ?, ?, ?, ?)`
        );
        const batch: Array<[string, string, number, number, number]> = [];
        for await (const r of streamCSV(file('stops.txt'))) {
            const lat = parseFloat(r.stop_lat);
            const lon = parseFloat(r.stop_lon);
            if (isNaN(lat) || isNaN(lon)) continue;
            batch.push([r.stop_id, r.stop_name ?? '', lat, lon, agencyId]);
        }
        db.transaction(() => { for (const a of batch) ins.run(...a); })();
        console.log(`  stops: ${batch.length}`);
    }

    // ── Routes ───────────────────────────────────────────────────────────────
    {
        const ins = db.prepare(
            `INSERT OR IGNORE INTO routes
             (route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        const batch: Array<[string, string, string, number, string, string, number]> = [];
        for await (const r of streamCSV(file('routes.txt'))) {
            batch.push([
                r.route_id,
                r.route_short_name ?? '',
                r.route_long_name  ?? '',
                parseInt(r.route_type ?? '3', 10),
                normalizeHexColor(r.route_color),
                normalizeHexColor(r.route_text_color) || '#FFFFFF',
                agencyId,
            ]);
        }
        db.transaction(() => { for (const a of batch) ins.run(...a); })();
        console.log(`  routes: ${batch.length}`);
    }

    // ── Trips → pattern map + trips table ────────────────────────────────────
    //
    // A "pattern" is the unique combination of (route × direction × shape).
    // All trips that share the same pattern have identical stop sequences.
    // We store:
    //   • ALL trips in the `trips` table (needed for timetable RAPTOR)
    //   • ONE representative trip per pattern in `patterns` (for geometry)
    //
    const patternMap = new Map<string, {
        route_id: string;
        direction_id: string;
        shape_id: string;
        trip_id: string;   // representative trip
    }>();
    const tripToPattern = new Map<string, string>(); // trip_id → pattern_key

    const insTripBatch: Array<[string, number, string, string]> = [];

    for await (const t of streamCSV(file('trips.txt'))) {
        const key = `${agencyId}_${t.route_id}_${t.direction_id ?? '0'}_${t.shape_id ?? ''}`;
        tripToPattern.set(t.trip_id, key);
        insTripBatch.push([t.trip_id, agencyId, key, t.service_id ?? '']);
        if (!patternMap.has(key)) {
            patternMap.set(key, {
                route_id:     t.route_id,
                direction_id: t.direction_id ?? '0',
                shape_id:     t.shape_id    ?? '',
                trip_id:      t.trip_id,   // first occurrence = representative
            });
        }
    }

    const insTrip = db.prepare(
        `INSERT OR IGNORE INTO trips (trip_id, agency, pattern_id, service_id) VALUES (?, ?, ?, ?)`
    );
    db.transaction(() => { for (const a of insTripBatch) insTrip.run(...a); })();
    console.log(`  trips: ${insTripBatch.length}, patterns: ${patternMap.size}`);

    // ── Stop times → stop_times table + seed pattern_stops ───────────────────
    //
    // We stream stop_times.txt once and do two things simultaneously:
    //   1. Insert every row into stop_times (all trips, needed for RAPTOR).
    //   2. Collect stop sequences for the representative trip of each pattern
    //      (used to populate pattern_stops for geometry / boarding-seq lookup).
    //
    const representativeTripIds = new Set(
        Array.from(patternMap.values()).map(p => p.trip_id)
    );
    const patternRepStops = new Map<string, Array<{ stop_id: string; seq: number }>>();

    const insStopTime = db.prepare(
        `INSERT OR IGNORE INTO stop_times
         (trip_id, agency, stop_sequence, stop_id, pattern_id, arrival_sec, departure_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let stBatch: Array<[string, number, number, string, string, number, number]> = [];
    let stCount = 0;

    const flushST = () => {
        if (stBatch.length === 0) return;
        db.transaction(() => { for (const a of stBatch) insStopTime.run(...a); })();
        stBatch = [];
    };

    for await (const r of streamCSV(file('stop_times.txt'))) {
        const patternId = tripToPattern.get(r.trip_id);
        if (!patternId) continue;

        const seq     = parseInt(r.stop_sequence ?? '0', 10);
        const arrSec  = parseGtfsTimeSec(r.arrival_time);
        const depSec  = parseGtfsTimeSec(r.departure_time || r.arrival_time);

        stBatch.push([r.trip_id, agencyId, seq, r.stop_id, patternId, arrSec, depSec]);
        stCount++;

        // Collect for pattern_stops (representative trip only)
        if (representativeTripIds.has(r.trip_id)) {
            if (!patternRepStops.has(patternId)) patternRepStops.set(patternId, []);
            patternRepStops.get(patternId)!.push({ stop_id: r.stop_id, seq });
        }

        if (stBatch.length >= 50_000) flushST();
    }
    flushST();
    console.log(`  stop_times: ${stCount}`);

    // ── Patterns + pattern_stops ──────────────────────────────────────────────
    {
        const insPattern = db.prepare(
            `INSERT OR IGNORE INTO patterns
             (pattern_id, route_id, agency, direction_id, shape_id, trip_id)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        const insPS = db.prepare(
            `INSERT INTO pattern_stops (pattern_id, stop_id, stop_sequence, agency)
             VALUES (?, ?, ?, ?)`
        );
        db.transaction(() => {
            for (const [key, p] of patternMap.entries()) {
                insPattern.run(key, p.route_id, agencyId, parseInt(p.direction_id, 10), p.shape_id, p.trip_id);
                const stops = (patternRepStops.get(key) ?? []).sort((a, b) => a.seq - b.seq);
                for (const s of stops) insPS.run(key, s.stop_id, s.seq, agencyId);
            }
        })();
    }

    // ── Shapes (thinned to ~1/3 of points to keep DB size manageable) ────────
    {
        const insShape = db.prepare(
            `INSERT INTO shapes (shape_id, agency, shape_pt_lat, shape_pt_lon, shape_pt_sequence)
             VALUES (?, ?, ?, ?, ?)`
        );
        const ptCount = new Map<string, number>();
        let shBatch: Array<[string, number, number, number, number]> = [];
        let stored = 0;

        const flushSh = () => {
            if (shBatch.length === 0) return;
            db.transaction(() => { for (const a of shBatch) insShape.run(...a); })();
            shBatch = [];
        };

        for await (const r of streamCSV(file('shapes.txt'))) {
            const lat = parseFloat(r.shape_pt_lat);
            const lon = parseFloat(r.shape_pt_lon);
            if (!r.shape_id || isNaN(lat) || isNaN(lon)) continue;

            const cnt = ptCount.get(r.shape_id) ?? 0;
            ptCount.set(r.shape_id, cnt + 1);
            if (cnt !== 0 && cnt % 3 !== 0) continue;

            shBatch.push([r.shape_id, agencyId, lat, lon, parseInt(r.shape_pt_sequence ?? '0', 10)]);
            stored++;
            if (shBatch.length >= 50_000) flushSh();
        }
        flushSh();
        console.log(`  shape points stored: ${stored}`);
    }

    fs.rmSync(tempDir, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
        console.log('Removed existing database\n');
    }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous  = OFF');
    db.pragma('temp_store   = MEMORY');
    db.pragma('cache_size   = 20000');

    createSchema(db);

    for (const id of AGENCIES) {
        console.log(`\nAgency ${id}:`);
        await processAgency(id, db);
    }

    console.log('\nBuilding indexes…');
    db.exec(`
        /* Spatial lookup for stops */
        CREATE INDEX idx_stops_lat      ON stops(stop_lat);
        CREATE INDEX idx_stops_lon      ON stops(stop_lon);

        /* Pattern/stop graph */
        CREATE INDEX idx_ps_stop        ON pattern_stops(stop_id, agency);
        CREATE INDEX idx_ps_pattern     ON pattern_stops(pattern_id);
        CREATE INDEX idx_pat_route      ON patterns(route_id, agency);

        /* Shapes */
        CREATE INDEX idx_shapes         ON shapes(shape_id, agency, shape_pt_sequence);

        /* Timetable (RAPTOR critical-path indexes) */
        CREATE INDEX idx_trips_pattern  ON trips(pattern_id, agency);

        /* RAPTOR boarding scan: given a stop + minimum departure, find earliest trip */
        CREATE INDEX idx_st_stop_dep    ON stop_times(stop_id, departure_sec);

        /* RAPTOR trip scan: given a trip, iterate its stops in order */
        CREATE INDEX idx_st_trip_seq    ON stop_times(trip_id, agency, stop_sequence);

        /* Optional: pattern+stop boarding (useful for pattern-scoped queries) */
        CREATE INDEX idx_st_pat_stop_dep ON stop_times(pattern_id, stop_id, departure_sec);
    `);

    // Collapse the WAL back into the main file before distributing.
    // Without this, copying only gtfs.db (without gtfs.db-wal / gtfs.db-shm)
    // produces a "database disk image is malformed" error on the device.
    console.log('\nCheckpointing WAL…');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode=DELETE'); // switch to rollback journal – no sidecar files
    db.pragma('integrity_check');          // fail loudly here rather than on-device

    db.close();
    console.log(`\nDone → ${DB_PATH}`);
    console.log('\nNote: the stop_times table can add several hundred MB to the DB.');
    console.log('Consider filtering by service_id / calendar if size is a concern.');
}

main().catch(err => { console.error(err); process.exit(1); });