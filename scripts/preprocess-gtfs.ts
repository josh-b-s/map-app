import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';

// Config
const AGENCIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const GTFS_DIR = path.join(__dirname, '../assets/gtfs');
const DB_PATH = path.join(__dirname, '../assets/gtfs.db');

// CSV helpers
function splitCSVLine(line: string): string[] {
    const fields: string[] = [];
    let inQuote = false;
    let cur = '';
    for (const ch of line) {
        if (ch === '"') {
            inQuote = !inQuote;
            continue;
        }
        if (ch === ',' && !inQuote) {
            fields.push(cur);
            cur = '';
            continue;
        }
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
        headers.forEach((h, i) => {
            row[h] = (parts[i] ?? '').trim();
        });
        yield row;
    }
}

// Schema
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

        CREATE TABLE patterns (
                                  pattern_id   TEXT PRIMARY KEY,
                                  route_id     TEXT    NOT NULL,
                                  agency       INTEGER NOT NULL,
                                  direction_id INTEGER NOT NULL DEFAULT 0,
                                  shape_id     TEXT,
                                  trip_id      TEXT    NOT NULL
        );

        CREATE TABLE pattern_stops (
                                       pattern_id    TEXT    NOT NULL,
                                       stop_id       TEXT    NOT NULL,
                                       stop_sequence INTEGER NOT NULL,
                                       agency        INTEGER NOT NULL
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

// Per-agency processing
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
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tempDir, true);

    const file = (name: string) => path.join(tempDir, name);

    // Stops
    {
        const insStop = db.prepare(
            `INSERT OR IGNORE INTO stops (stop_id, stop_name, stop_lat, stop_lon, agency)
             VALUES (?, ?, ?, ?, ?)`
        );

        let count = 0;
        const batch: Array<[string, string, number, number, number]> = [];

        for await (const r of streamCSV(file('stops.txt'))) {
            const lat = parseFloat(r.stop_lat);
            const lon = parseFloat(r.stop_lon);
            if (isNaN(lat) || isNaN(lon)) continue;

            batch.push([r.stop_id, r.stop_name ?? '', lat, lon, agencyId]);
            count++;
        }

        db.transaction(() => {
            for (const args of batch) insStop.run(...args);
        })();

        console.log(`  stops: ${count}`);
    }

    // Routes
    {
        const insRoute = db.prepare(
            `INSERT OR IGNORE INTO routes
             (route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );

        let count = 0;
        const batch: Array<[string, string, string, number, string, string, number]> = [];

        for await (const r of streamCSV(file('routes.txt'))) {
            batch.push([
                r.route_id,
                r.route_short_name ?? '',
                r.route_long_name ?? '',
                parseInt(r.route_type ?? '3'),
                normalizeHexColor(r.route_color),
                normalizeHexColor(r.route_text_color) || '#FFFFFF',
                agencyId,
            ]);
            count++;
        }

        db.transaction(() => {
            for (const args of batch) insRoute.run(...args);
        })();

        console.log(`  routes: ${count}`);
    }

    // Trips -> patterns
    const patternMap = new Map<string, {
        route_id: string;
        direction_id: string;
        shape_id: string;
        trip_id: string;
    }>();

    for await (const t of streamCSV(file('trips.txt'))) {
        const key = `${agencyId}_${t.route_id}_${t.direction_id ?? '0'}_${t.shape_id ?? ''}`;
        if (!patternMap.has(key)) {
            patternMap.set(key, {
                route_id: t.route_id,
                direction_id: t.direction_id ?? '0',
                shape_id: t.shape_id ?? '',
                trip_id: t.trip_id,
            });
        }
    }
    console.log(`  patterns: ${patternMap.size}`);

    // Stop times
    const neededTrips = new Set(Array.from(patternMap.values()).map(p => p.trip_id));
    const tripStops = new Map<string, Array<{ stop_id: string; seq: number }>>();

    for await (const r of streamCSV(file('stop_times.txt'))) {
        if (!neededTrips.has(r.trip_id)) continue;
        if (!tripStops.has(r.trip_id)) tripStops.set(r.trip_id, []);
        tripStops.get(r.trip_id)!.push({
            stop_id: r.stop_id,
            seq: parseInt(r.stop_sequence ?? '0'),
        });
    }

    // Insert patterns + pattern_stops
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
                insPattern.run(key, p.route_id, agencyId, parseInt(p.direction_id), p.shape_id, p.trip_id);

                const stops = (tripStops.get(p.trip_id) ?? []).sort((a, b) => a.seq - b.seq);
                for (const s of stops) {
                    insPS.run(key, s.stop_id, s.seq, agencyId);
                }
            }
        })();
    }

    // Shapes
    {
        const insShape = db.prepare(
            `INSERT INTO shapes (shape_id, agency, shape_pt_lat, shape_pt_lon, shape_pt_sequence)
             VALUES (?, ?, ?, ?, ?)`
        );

        const shapePtCount = new Map<string, number>();
        let stored = 0;
        const batch: Array<[string, number, number, number, number]> = [];

        for await (const r of streamCSV(file('shapes.txt'))) {
            const lat = parseFloat(r.shape_pt_lat);
            const lon = parseFloat(r.shape_pt_lon);
            if (!r.shape_id || isNaN(lat) || isNaN(lon)) continue;

            const cnt = shapePtCount.get(r.shape_id) ?? 0;
            shapePtCount.set(r.shape_id, cnt + 1);

            if (cnt !== 0 && cnt % 3 !== 0) continue;

            batch.push([r.shape_id, agencyId, lat, lon, parseInt(r.shape_pt_sequence ?? '0')]);
            stored++;

            if (batch.length >= 50_000) {
                db.transaction(() => {
                    for (const args of batch) insShape.run(...args);
                })();
                batch.length = 0;
            }
        }

        if (batch.length > 0) {
            db.transaction(() => {
                for (const args of batch) insShape.run(...args);
            })();
        }

        console.log(`  shape points stored: ${stored}`);
    }

    fs.rmSync(tempDir, { recursive: true });
}

// Main
async function main() {
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
        console.log('Removed existing database\n');
    }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = OFF');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = 20000');

    createSchema(db);

    for (const id of AGENCIES) {
        console.log(`\nAgency ${id}:`);
        await processAgency(id, db);
    }

    console.log('\nBuilding indexes...');
    db.exec(`
        CREATE INDEX idx_stops_lat  ON stops(stop_lat);
        CREATE INDEX idx_stops_lon  ON stops(stop_lon);
        CREATE INDEX idx_ps_stop    ON pattern_stops(stop_id, agency);
        CREATE INDEX idx_ps_pattern ON pattern_stops(pattern_id);
        CREATE INDEX idx_shapes     ON shapes(shape_id, agency, shape_pt_sequence);
        CREATE INDEX idx_pat_route  ON patterns(route_id, agency);
    `);

    db.close();
    console.log(`\nDone -> ${DB_PATH}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});