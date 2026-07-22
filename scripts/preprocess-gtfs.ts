import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import {GTFS_SCHEMA_SQL, GTFS_INDEXES_SQL} from './gtfsSchema';

const GTFS_INPUT = path.join(__dirname, '../assets/gtfs.zip');
const DB_PATH    = path.join(__dirname, '../assets/gtfs.db');
const ESSENTIAL_FILE = 'agency.txt';
const RUN_INTEGRITY_CHECK = process.env.GTFS_SKIP_INTEGRITY_CHECK !== '1';

const buildStart = Date.now();
function elapsed(): string {
    const s = (Date.now() - buildStart) / 1000;
    return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
}

const COORD_SCALE = 1_000_000;

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

function* parseCSV(buf: Buffer): Generator<Record<string, string>> {
    if (!buf || buf.length === 0) return;
    let headers: string[] | null = null;
    let start = 0;
    const len = buf.length;
    const NL = 0x0a, CR = 0x0d;
    while (start < len) {
        let end = buf.indexOf(NL, start);
        if (end === -1) end = len;
        let lineEnd = end;
        if (lineEnd > start && buf[lineEnd - 1] === CR) lineEnd--;
        if (lineEnd > start) {
            const line = buf.toString('utf8', start, lineEnd);
            if (line.trim()) {
                if (!headers) {
                    headers = splitCSVLine(line).map(h => stripBOM(h.trim()));
                } else {
                    const parts = splitCSVLine(line);
                    const row: Record<string, string> = {};
                    for (let i = 0; i < headers.length; i++) row[headers[i]] = (parts[i] ?? '').trim();
                    yield row;
                }
            }
        }
        start = end + 1;
    }
}

function parseGtfsTimeSec(s: string): number {
    if (!s) return 0;
    const [h, m, sec] = s.split(':');
    return parseInt(h ?? '0', 10) * 3600 + parseInt(m ?? '0', 10) * 60 + parseInt(sec ?? '0', 10);
}

function packCoord(v: string): number | null {
    const f = parseFloat(v);
    if (isNaN(f)) return null;
    return Math.round(f * COORD_SCALE);
}

function createSchema(db: Database.Database) {
    // DDL now lives in gtfsSchema.ts, config with gtfsImporterLegacy.ts (the
    // on-device build) — see that file's module doc for why.
    db.exec(GTFS_SCHEMA_SQL);
}

interface GtfsSource {
    file(name: string): Buffer;
    describe: string;
}

const EMPTY = Buffer.alloc(0);

function collectFromZip(zip: AdmZip, prefix: string, label: string, out: GtfsSource[]): void {
    const entries = zip.getEntries();
    const hasAgencyHere = entries.some(e => !e.isDirectory && e.entryName === prefix + ESSENTIAL_FILE);
    if (hasAgencyHere) {
        out.push({
            describe: label,
            file: (name: string) => {
                const entry = zip.getEntry(prefix + name);
                return entry ? entry.getData() : EMPTY;
            },
        });
        return;
    }

    const childDirs = new Set<string>();
    const childZips = new Set<string>();
    for (const e of entries) {
        if (!e.entryName.startsWith(prefix)) continue;
        const rest = e.entryName.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash === -1) {
            if (!e.isDirectory && rest.toLowerCase().endsWith('.zip')) childZips.add(rest);
        } else {
            childDirs.add(rest.slice(0, slash));
        }
    }
    for (const d of childDirs) collectFromZip(zip, `${prefix}${d}/`, `${label}/${d}`, out);
    for (const z of childZips) {
        const entry = zip.getEntry(prefix + z);
        if (entry) collectFromZipBuffer(entry.getData(), `${label}/${z}`, out);
    }
}

function collectFromZipBuffer(buf: Buffer, label: string, out: GtfsSource[]): void {
    let zip: AdmZip;
    try { zip = new AdmZip(buf); } catch { return; }
    collectFromZip(zip, '', label, out);
}

function collectFromDisk(rootPath: string, label: string, out: GtfsSource[]): void {
    const stat = fs.statSync(rootPath);

    if (stat.isFile()) {
        if (rootPath.toLowerCase().endsWith('.zip')) collectFromZipBuffer(fs.readFileSync(rootPath), label, out);
        return;
    }
    if (!stat.isDirectory()) return;

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    if (entries.some(e => e.isFile() && e.name === ESSENTIAL_FILE)) {
        out.push({
            describe: rootPath,
            file: (name: string) => {
                try { return fs.readFileSync(path.join(rootPath, name)); }
                catch { return EMPTY; }
            },
        });
        return;
    }

    for (const e of entries) {
        const full = path.join(rootPath, e.name);
        if (e.isDirectory()) collectFromDisk(full, `${label}/${e.name}`, out);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.zip')) collectFromZipBuffer(fs.readFileSync(full), `${label}/${e.name}`, out);
    }
}

function findAllGtfsSources(inputPath: string): GtfsSource[] {
    if (!fs.existsSync(inputPath)) return [];
    const out: GtfsSource[] = [];
    collectFromDisk(inputPath, inputPath, out);
    return out;
}

function processAgency(agencyId: number, source: GtfsSource, db: Database.Database) {
    console.log(`Agency ${agencyId}: reading ${source.describe}`);
    const file = (name: string) => source.file(name);

    let nextStopPk = (db.prepare(`SELECT COALESCE(MAX(stop_pk), 0) AS m FROM stops`).get() as any).m + 1;
    let nextTripPk = (db.prepare(`SELECT COALESCE(MAX(trip_pk), 0) AS m FROM trips`).get() as any).m + 1;
    let nextPatternPk = (db.prepare(`SELECT COALESCE(MAX(pattern_pk), 0) AS m FROM patterns`).get() as any).m + 1;
    let nextShapePk = (db.prepare(`SELECT COALESCE(MAX(shape_pk), 0) AS m FROM shape_meta`).get() as any).m + 1;

    const stopIdToPk = new Map<string, number>();
    {
        const ins = db.prepare(`INSERT INTO stops (stop_pk,stop_id,stop_name,stop_lat,stop_lon,agency) VALUES (?,?,?,?,?,?)`);
        let count = 0;
        for (const r of parseCSV(file('stops.txt'))) {
            const lat = packCoord(r.stop_lat), lon = packCoord(r.stop_lon);
            if (lat === null || lon === null) continue;
            const locType = (r.location_type ?? '').trim();
            if (locType !== '' && locType !== '0') continue;
            if (stopIdToPk.has(r.stop_id)) continue;
            const pk = nextStopPk++;
            stopIdToPk.set(r.stop_id, pk);
            ins.run(pk, r.stop_id, r.stop_name ?? '', lat, lon, agencyId);
            count++;
        }
        console.log(`  stops: ${count}`);
    }

    {
        const ins = db.prepare(`INSERT OR IGNORE INTO routes (route_id,route_short_name,route_long_name,route_type,route_color,route_text_color,agency) VALUES (?,?,?,?,?,?,?)`);
        let count = 0;
        for (const r of parseCSV(file('routes.txt'))) {
            ins.run(r.route_id, r.route_short_name ?? '', r.route_long_name ?? '', parseInt(r.route_type ?? '3', 10),
                normalizeHexColor(r.route_color), normalizeHexColor(r.route_text_color) || '#FFFFFF', agencyId);
            count++;
        }
        console.log(`  routes: ${count}`);
    }

    {
        const ins = db.prepare(`INSERT OR IGNORE INTO calendar
            (service_id,agency,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        let count = 0;
        for (const r of parseCSV(file('calendar.txt'))) {
            ins.run(r.service_id, agencyId,
                parseInt(r.monday ?? '0', 10), parseInt(r.tuesday ?? '0', 10),
                parseInt(r.wednesday ?? '0', 10), parseInt(r.thursday ?? '0', 10),
                parseInt(r.friday ?? '0', 10), parseInt(r.saturday ?? '0', 10),
                parseInt(r.sunday ?? '0', 10),
                r.start_date ?? '', r.end_date ?? '');
            count++;
        }
        console.log(`  calendar entries: ${count}`);
    }
    {
        const ins = db.prepare(`INSERT OR IGNORE INTO calendar_dates (service_id,agency,date,exception_type) VALUES (?,?,?,?)`);
        let count = 0;
        for (const r of parseCSV(file('calendar_dates.txt'))) {
            ins.run(r.service_id, agencyId, r.date ?? '', parseInt(r.exception_type ?? '1', 10));
            count++;
        }
        console.log(`  calendar_dates entries: ${count}`);
    }

    interface TripMeta { pk: number; route_id: string; direction_id: string; shape_id: string; service_id: string }
    const tripMeta = new Map<string, TripMeta>();
    for (const t of parseCSV(file('trips.txt'))) {
        tripMeta.set(t.trip_id, {
            pk: nextTripPk++,
            route_id: t.route_id, direction_id: t.direction_id ?? '0',
            shape_id: t.shape_id ?? '', service_id: t.service_id ?? '',
        });
    }
    console.log(`  trips.txt entries: ${tripMeta.size}`);

    interface TripStopRow { stop_pk: number; stop_sequence: number; arrival_sec: number; departure_sec: number }
    const tripStopTimes = new Map<string, TripStopRow[]>();
    let skippedNoStop = 0;

    for (const r of parseCSV(file('stop_times.txt'))) {
        if (!tripMeta.has(r.trip_id)) continue;
        const stopPk = stopIdToPk.get(r.stop_id);
        if (stopPk === undefined) { skippedNoStop++; continue; }
        const row: TripStopRow = {
            stop_pk: stopPk,
            stop_sequence: parseInt(r.stop_sequence ?? '0', 10),
            arrival_sec: parseGtfsTimeSec(r.arrival_time),
            departure_sec: parseGtfsTimeSec(r.departure_time || r.arrival_time),
        };
        if (!tripStopTimes.has(r.trip_id)) tripStopTimes.set(r.trip_id, []);
        tripStopTimes.get(r.trip_id)!.push(row);
    }
    for (const arr of tripStopTimes.values()) arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
    console.log(`  trips with stop_times: ${tripStopTimes.size}${skippedNoStop ? ` (skipped ${skippedNoStop} rows referencing unimported stops)` : ''}`);

    interface PatternGroup {
        pk: number; route_id: string; direction_id: string; shape_id: string;
        trip_pk: number;
        stops: TripStopRow[];
    }
    const patternGroups = new Map<string, PatternGroup>();
    const tripToPatternPk = new Map<string, number>();

    for (const [tripId, meta] of tripMeta) {
        const stops = tripStopTimes.get(tripId);
        if (!stops || stops.length === 0) continue;

        const stopPkSeq = stops.map(s => s.stop_pk).join(',');
        const groupKey = `${meta.route_id}|${meta.direction_id}|${stopPkSeq}`;

        let group = patternGroups.get(groupKey);
        if (!group) {
            group = {
                pk: nextPatternPk++, route_id: meta.route_id, direction_id: meta.direction_id,
                shape_id: meta.shape_id, trip_pk: meta.pk, stops,
            };
            patternGroups.set(groupKey, group);
        }
        tripToPatternPk.set(tripId, group.pk);
    }
    console.log(`  patterns (grouped by actual stop sequence): ${patternGroups.size}`);

    {
        const ins = db.prepare(`INSERT INTO trips (trip_pk,trip_id,agency,pattern_pk,service_id) VALUES (?,?,?,?,?)`);
        let count = 0;
        for (const [tripId, patternPk] of tripToPatternPk) {
            const meta = tripMeta.get(tripId)!;
            ins.run(meta.pk, tripId, agencyId, patternPk, meta.service_id);
            count++;
        }
        console.log(`  trips: ${count}`);
    }

    // No pattern_pk column in stop_times — it's derivable via trip_pk.
    {
        const ins = db.prepare(`INSERT INTO stop_times
                                (trip_pk,stop_sequence,stop_pk,arrival_sec,departure_sec) VALUES (?,?,?,?,?)`);
        let count = 0;
        for (const [tripId, stops] of tripStopTimes) {
            const patternPk = tripToPatternPk.get(tripId);
            if (!patternPk) continue; // gates on pattern membership only, doesn't store it
            const tripPk = tripMeta.get(tripId)!.pk;
            for (const s of stops) {
                ins.run(tripPk, s.stop_sequence, s.stop_pk, s.arrival_sec, s.departure_sec);
                count++;
            }
        }
        console.log(`  stop_times: ${count}`);
    }

    {
        const insPat = db.prepare(`INSERT INTO patterns (pattern_pk,route_id,agency,direction_id,shape_id,trip_pk) VALUES (?,?,?,?,?,?)`);
        const insPS  = db.prepare(`INSERT INTO pattern_stops (pattern_pk,stop_pk,stop_sequence) VALUES (?,?,?)`);
        for (const group of patternGroups.values()) {
            insPat.run(group.pk, group.route_id, agencyId, parseInt(group.direction_id, 10), group.shape_id, group.trip_pk);
            for (const s of group.stops) insPS.run(group.pk, s.stop_pk, s.stop_sequence);
        }
    }

    {
        const insMeta  = db.prepare(`INSERT INTO shape_meta (shape_pk,shape_id,agency) VALUES (?,?,?)`);
        const insShape = db.prepare(`INSERT INTO shapes (shape_pk,shape_pt_lat,shape_pt_lon,shape_pt_sequence) VALUES (?,?,?,?)`);
        const shapeIdToPk = new Map<string, number>();
        const ptCount = new Map<string, number>();
        let stored = 0;
        for (const r of parseCSV(file('shapes.txt'))) {
            const lat = packCoord(r.shape_pt_lat), lon = packCoord(r.shape_pt_lon);
            if (!r.shape_id || lat === null || lon === null) continue;
            const cnt = ptCount.get(r.shape_id) ?? 0;
            ptCount.set(r.shape_id, cnt + 1);
            if (cnt !== 0 && cnt % 3 !== 0) continue;
            let shapePk = shapeIdToPk.get(r.shape_id);
            if (shapePk === undefined) {
                shapePk = nextShapePk++;
                shapeIdToPk.set(r.shape_id, shapePk);
                insMeta.run(shapePk, r.shape_id, agencyId);
            }
            insShape.run(shapePk, lat, lon, parseInt(r.shape_pt_sequence ?? '0', 10));
            stored++;
        }
        console.log(`  shape points stored: ${stored}`);
    }
}

function main() {
    if (fs.existsSync(DB_PATH)) { fs.unlinkSync(DB_PATH); console.log('Removed existing database\n'); }

    console.log(`Scanning ${GTFS_INPUT} for GTFS feeds…`);
    const sources = findAllGtfsSources(GTFS_INPUT);
    if (sources.length === 0) {
        console.error(`No ${ESSENTIAL_FILE} found anywhere under ${GTFS_INPUT} — nothing to import.`);
        process.exit(1);
    }
    console.log(`Found ${sources.length} feed(s):`);
    sources.forEach((s, i) => console.log(`  [${i + 1}] ${s.describe}`));

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous  = OFF');
    db.pragma('temp_store   = MEMORY');
    db.pragma('cache_size   = 20000');

    createSchema(db);

    db.transaction(() => {
        sources.forEach((source, i) => {
            const agencyId = i + 1;
            console.log(`\nAgency ${agencyId}: [${elapsed()} elapsed]`);
            processAgency(agencyId, source, db);
        });
    })();
    console.log(`\nAll agencies imported. [${elapsed()} elapsed]`);

    console.log('\nBuilding indexes…');
    db.exec(GTFS_INDEXES_SQL);
    console.log(`Indexes built. [${elapsed()} elapsed]`);

    console.log('\nCheckpointing WAL…');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode = DELETE');
    console.log(`WAL checkpointed. [${elapsed()} elapsed]`);

    if (RUN_INTEGRITY_CHECK) {
        console.log('\nRunning integrity check…');
        db.pragma('integrity_check');
        console.log(`Integrity check done. [${elapsed()} elapsed]`);
    } else {
        console.log('\nSkipping integrity check (RUN_INTEGRITY_CHECK = false)');
    }

    console.log('\nVacuuming (this can take a while on a multi-GB db)…');
    db.exec('VACUUM;');
    console.log(`Vacuum done. [${elapsed()} elapsed]`);

    db.close();
    const stats = fs.statSync(DB_PATH);
    console.log(`\nDone → ${DB_PATH} (${(stats.size / 1024 / 1024).toFixed(1)} MB) in ${elapsed()}`);
}

main();