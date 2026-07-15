import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';

const AGENCIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const GTFS_DIR = path.join(__dirname, '../assets/gtfs');
const DB_PATH  = path.join(__dirname, '../assets/gtfs.db');

function splitCSVLine(line: string): string[] {
    const fields: string[] = [];
    let inQuote = false, cur = '';
    for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; continue; }
        cur += ch;
    }
    fields.push(cur);
    return fields;
}

function stripBOM(s: string): string { return s.replace(/^\uFEFF/, ''); }

function normalizeHexColor(value?: string | null): string {
    const raw = (value ?? '').trim();
    if (!raw) return '';
    const hex = raw.replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : '';
}

async function* streamCSV(filePath: string): AsyncGenerator<Record<string, string>> {
    if (!fs.existsSync(filePath)) return;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    let headers: string[] | null = null;
    for await (const line of rl) {
        if (!line.trim()) continue;
        if (!headers) { headers = splitCSVLine(line).map(h => stripBOM(h.trim())); continue; }
        const parts = splitCSVLine(line);
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = (parts[i] ?? '').trim(); });
        yield row;
    }
}

function parseGtfsTimeSec(s: string): number {
    if (!s) return 0;
    const [h, m, sec] = s.split(':');
    return parseInt(h ?? '0', 10) * 3600 + parseInt(m ?? '0', 10) * 60 + parseInt(sec ?? '0', 10);
}

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

        CREATE TABLE calendar (
                                  service_id TEXT    NOT NULL,
                                  agency     INTEGER NOT NULL,
                                  monday     INTEGER NOT NULL DEFAULT 0,
                                  tuesday    INTEGER NOT NULL DEFAULT 0,
                                  wednesday  INTEGER NOT NULL DEFAULT 0,
                                  thursday   INTEGER NOT NULL DEFAULT 0,
                                  friday     INTEGER NOT NULL DEFAULT 0,
                                  saturday   INTEGER NOT NULL DEFAULT 0,
                                  sunday     INTEGER NOT NULL DEFAULT 0,
                                  start_date TEXT    NOT NULL,
                                  end_date   TEXT    NOT NULL,
                                  PRIMARY KEY (service_id, agency)
        );

        CREATE TABLE calendar_dates (
                                        service_id     TEXT    NOT NULL,
                                        agency         INTEGER NOT NULL,
                                        date           TEXT    NOT NULL,
                                        exception_type INTEGER NOT NULL,
                                        PRIMARY KEY (service_id, agency, date)
        );

        CREATE TABLE trips (
                               trip_id    TEXT    NOT NULL,
                               agency     INTEGER NOT NULL,
                               pattern_id TEXT    NOT NULL,
                               service_id TEXT    NOT NULL DEFAULT '',
                               PRIMARY KEY (trip_id, agency)
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

async function processAgency(agencyId: number, db: Database.Database) {
    const zipPath = path.join(GTFS_DIR, String(agencyId), 'google_transit.zip');
    if (!fs.existsSync(zipPath)) { console.log(`Agency ${agencyId}: zip not found, skipping`); return; }

    const tempDir = path.join(os.tmpdir(), `gtfs_agency_${agencyId}`);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    console.log(`Agency ${agencyId}: extracting...`);
    new AdmZip(zipPath).extractAllTo(tempDir, true);

    const file = (name: string) => path.join(tempDir, name);

    {
        const ins = db.prepare(`INSERT OR IGNORE INTO stops (stop_id,stop_name,stop_lat,stop_lon,agency) VALUES (?,?,?,?,?)`);
        const batch: Array<[string,string,number,number,number]> = [];
        for await (const r of streamCSV(file('stops.txt'))) {
            const lat = parseFloat(r.stop_lat), lon = parseFloat(r.stop_lon);
            if (isNaN(lat) || isNaN(lon)) continue;
            // location_type: 0 or blank = actual boardable stop/platform.
            // 1 = parent station (groups platforms, never appears in stop_times),
            // 2 = entrance, 3 = generic node, 4 = boarding area. None of these
            // are boardable, and including them lets nearestStops() pick a dead
            // end (e.g. a station's parent record) over the real platform next
            // to it, silently losing every pattern that stops there.
            const locType = (r.location_type ?? '').trim();
            if (locType !== '' && locType !== '0') continue;
            batch.push([r.stop_id, r.stop_name ?? '', lat, lon, agencyId]);
        }
        db.transaction(() => { for (const a of batch) ins.run(...a); })();
        console.log(`  stops: ${batch.length}`);
    }

    {
        const ins = db.prepare(`INSERT OR IGNORE INTO routes (route_id,route_short_name,route_long_name,route_type,route_color,route_text_color,agency) VALUES (?,?,?,?,?,?,?)`);
        const batch: Array<[string,string,string,number,string,string,number]> = [];
        for await (const r of streamCSV(file('routes.txt'))) {
            batch.push([r.route_id, r.route_short_name ?? '', r.route_long_name ?? '', parseInt(r.route_type ?? '3', 10),
                normalizeHexColor(r.route_color), normalizeHexColor(r.route_text_color) || '#FFFFFF', agencyId]);
        }
        db.transaction(() => { for (const a of batch) ins.run(...a); })();
        console.log(`  routes: ${batch.length}`);
    }

    {
        const ins = db.prepare(`INSERT OR IGNORE INTO calendar
            (service_id,agency,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        const batch: Array<[string,number,number,number,number,number,number,number,number,string,string]> = [];
        for await (const r of streamCSV(file('calendar.txt'))) {
            batch.push([r.service_id, agencyId,
                parseInt(r.monday ?? '0', 10), parseInt(r.tuesday ?? '0', 10),
                parseInt(r.wednesday ?? '0', 10), parseInt(r.thursday ?? '0', 10),
                parseInt(r.friday ?? '0', 10), parseInt(r.saturday ?? '0', 10),
                parseInt(r.sunday ?? '0', 10),
                r.start_date ?? '', r.end_date ?? '']);
        }
        db.transaction(() => { for (const a of batch) ins.run(...a); })();
        console.log(`  calendar entries: ${batch.length}`);
    }

    {
        const ins = db.prepare(`INSERT OR IGNORE INTO calendar_dates (service_id,agency,date,exception_type) VALUES (?,?,?,?)`);
        const batch: Array<[string,number,string,number]> = [];
        for await (const r of streamCSV(file('calendar_dates.txt'))) {
            batch.push([r.service_id, agencyId, r.date ?? '', parseInt(r.exception_type ?? '1', 10)]);
        }
        db.transaction(() => { for (const a of batch) ins.run(...a); })();
        console.log(`  calendar_dates entries: ${batch.length}`);
    }

    // ── Trip metadata (route/direction/shape/service), NOT yet grouped ───────
    const tripMeta = new Map<string, { route_id: string; direction_id: string; shape_id: string; service_id: string }>();
    for await (const t of streamCSV(file('trips.txt'))) {
        tripMeta.set(t.trip_id, {
            route_id: t.route_id, direction_id: t.direction_id ?? '0',
            shape_id: t.shape_id ?? '', service_id: t.service_id ?? '',
        });
    }

    // ── Read stop_times.txt ONCE into memory, per-trip, sorted by sequence ───
    // This is the key structural fix. The old version grouped patterns by
    // (route_id, direction_id, shape_id) and used only ONE representative
    // trip's stops for pattern_stops. Real GTFS feeds routinely have express
    // and all-stops services sharing the exact same shape_id (same physical
    // rail alignment) while stopping at different subsets of stations. If the
    // first-encountered trip for a shape happened to be an express, every
    // station the express skips silently vanished from pattern_stops — even
    // though many other trips of that "pattern" genuinely stop there. This is
    // exactly what happened to Springvale on the Pakenham/Cranbourne line.
    //
    // Fix: a pattern is now defined by the ACTUAL SEQUENCE OF STOP_IDS a trip
    // visits, not by shape_id. Two trips only belong to the same pattern if
    // they stop at exactly the same stations in the same order. shape_id is
    // still recorded per pattern for drawing the route line, but it no longer
    // determines which stops belong to the pattern.
    interface TripStopRow { stop_id: string; stop_sequence: number; arrival_sec: number; departure_sec: number }
    const tripStopTimes = new Map<string, TripStopRow[]>();

    for await (const r of streamCSV(file('stop_times.txt'))) {
        if (!tripMeta.has(r.trip_id)) continue; // orphan stop_times row, no matching trip
        const row: TripStopRow = {
            stop_id: r.stop_id,
            stop_sequence: parseInt(r.stop_sequence ?? '0', 10),
            arrival_sec: parseGtfsTimeSec(r.arrival_time),
            departure_sec: parseGtfsTimeSec(r.departure_time || r.arrival_time),
        };
        if (!tripStopTimes.has(r.trip_id)) tripStopTimes.set(r.trip_id, []);
        tripStopTimes.get(r.trip_id)!.push(row);
    }
    for (const arr of tripStopTimes.values()) arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
    console.log(`  trips with stop_times: ${tripStopTimes.size}`);

    // ── Group trips into patterns keyed by their actual stop_id sequence ─────
    function hashString(s: string): string {
        // djb2 — fast, deterministic, good enough to disambiguate pattern keys
        // (not cryptographic; collisions would only cause two genuinely
        // different stop sequences to share a pattern_id, which we additionally
        // guard against by keeping the full sequence in the Map key itself).
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(16);
    }

    interface PatternGroup {
        pattern_id: string; route_id: string; direction_id: string; shape_id: string;
        trip_id: string; // representative trip, used only for shape fallback bookkeeping
        stops: TripStopRow[]; // the authoritative, shared stop sequence for this pattern
    }
    const patternGroups = new Map<string, PatternGroup>(); // groupKey -> group
    const tripToPatternId = new Map<string, string>();

    for (const [tripId, meta] of tripMeta) {
        const stops = tripStopTimes.get(tripId);
        if (!stops || stops.length === 0) continue; // trip has no timetable rows at all — skip

        const stopIdSeq = stops.map(s => s.stop_id).join(',');
        const groupKey = `${meta.route_id}|${meta.direction_id}|${stopIdSeq}`;

        let group = patternGroups.get(groupKey);
        if (!group) {
            const patternId = `${agencyId}_${meta.route_id}_${meta.direction_id}_${hashString(stopIdSeq)}`;
            group = {
                pattern_id: patternId, route_id: meta.route_id, direction_id: meta.direction_id,
                shape_id: meta.shape_id, trip_id: tripId, stops,
            };
            patternGroups.set(groupKey, group);
        }
        tripToPatternId.set(tripId, group.pattern_id);
    }
    console.log(`  patterns (grouped by actual stop sequence): ${patternGroups.size}`);

    // ── Insert trips ───────────────────────────────────────────────────────────
    {
        const ins = db.prepare(`INSERT OR IGNORE INTO trips (trip_id,agency,pattern_id,service_id) VALUES (?,?,?,?)`);
        const batch: Array<[string,number,string,string]> = [];
        for (const [tripId, patId] of tripToPatternId) {
            batch.push([tripId, agencyId, patId, tripMeta.get(tripId)?.service_id ?? '']);
        }
        db.transaction(() => { for (const a of batch) ins.run(...a); })();
        console.log(`  trips: ${batch.length}`);
    }

    // ── Insert stop_times (every trip, using its now-known pattern_id) ────────
    {
        const insStopTime = db.prepare(`INSERT OR IGNORE INTO stop_times
            (trip_id,agency,stop_sequence,stop_id,pattern_id,arrival_sec,departure_sec) VALUES (?,?,?,?,?,?,?)`);
        let stBatch: Array<[string,number,number,string,string,number,number]> = [];
        let stCount = 0;
        const flushST = () => {
            if (!stBatch.length) return;
            db.transaction(() => { for (const a of stBatch) insStopTime.run(...a); })();
            stBatch = [];
        };
        for (const [tripId, stops] of tripStopTimes) {
            const patId = tripToPatternId.get(tripId);
            if (!patId) continue;
            for (const s of stops) {
                stBatch.push([tripId, agencyId, s.stop_sequence, s.stop_id, patId, s.arrival_sec, s.departure_sec]);
                stCount++;
                if (stBatch.length >= 50_000) flushST();
            }
        }
        flushST();
        console.log(`  stop_times: ${stCount}`);
    }

    // ── Insert patterns + pattern_stops (from the group's authoritative stops) ─
    {
        const insPat = db.prepare(`INSERT OR IGNORE INTO patterns (pattern_id,route_id,agency,direction_id,shape_id,trip_id) VALUES (?,?,?,?,?,?)`);
        const insPS  = db.prepare(`INSERT INTO pattern_stops (pattern_id,stop_id,stop_sequence,agency) VALUES (?,?,?,?)`);
        db.transaction(() => {
            for (const group of patternGroups.values()) {
                insPat.run(group.pattern_id, group.route_id, agencyId, parseInt(group.direction_id, 10), group.shape_id, group.trip_id);
                for (const s of group.stops) insPS.run(group.pattern_id, s.stop_id, s.stop_sequence, agencyId);
            }
        })();
    }

    {
        const insShape = db.prepare(`INSERT INTO shapes (shape_id,agency,shape_pt_lat,shape_pt_lon,shape_pt_sequence) VALUES (?,?,?,?,?)`);
        const ptCount = new Map<string, number>();
        let shBatch: Array<[string,number,number,number,number]> = [];
        let stored = 0;
        const flushSh = () => {
            if (!shBatch.length) return;
            db.transaction(() => { for (const a of shBatch) insShape.run(...a); })();
            shBatch = [];
        };
        for await (const r of streamCSV(file('shapes.txt'))) {
            const lat = parseFloat(r.shape_pt_lat), lon = parseFloat(r.shape_pt_lon);
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

async function main() {
    if (fs.existsSync(DB_PATH)) { fs.unlinkSync(DB_PATH); console.log('Removed existing database\n'); }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous  = OFF');
    db.pragma('temp_store   = MEMORY');
    db.pragma('cache_size   = 20000');

    createSchema(db);

    for (const id of AGENCIES) { console.log(`\nAgency ${id}:`); await processAgency(id, db); }

    console.log('\nBuilding indexes…');
    db.exec(`
        CREATE INDEX idx_stops_lat       ON stops(stop_lat);
        CREATE INDEX idx_stops_lon       ON stops(stop_lon);
        CREATE INDEX idx_ps_stop         ON pattern_stops(stop_id, agency);
        CREATE INDEX idx_ps_pattern      ON pattern_stops(pattern_id);
        CREATE INDEX idx_pat_route       ON patterns(route_id, agency);
        CREATE INDEX idx_shapes          ON shapes(shape_id, agency, shape_pt_sequence);
        CREATE INDEX idx_trips_pattern   ON trips(pattern_id, agency);
        CREATE INDEX idx_trips_service   ON trips(service_id, agency);
        CREATE INDEX idx_st_stop_dep     ON stop_times(stop_id, departure_sec);
        CREATE INDEX idx_st_trip_seq     ON stop_times(trip_id, agency, stop_sequence);
        CREATE INDEX idx_st_pat_stop_dep ON stop_times(pattern_id, stop_id, departure_sec);
        CREATE INDEX idx_cal_service     ON calendar(service_id, agency);
        CREATE INDEX idx_caldt_date      ON calendar_dates(date, agency);
    `);

    console.log('\nCheckpointing WAL…');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode = DELETE');
    db.pragma('integrity_check');

    db.close();
    console.log(`\nDone → ${DB_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });