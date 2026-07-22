/**
 * gtfsSchema.ts — the gtfs.db schema, config between scripts/preprocess-gtfs.ts
 * (desktop build, better-sqlite3) and gtfsImporterLegacy.ts (on-device build,
 * op-sqlite). One copy of the DDL so the two build paths can't silently
 * diverge on a column — see gtfsImporterLegacy.ts's module doc for why that
 * divergence risk existed in the first place.
 *
 * Exported as a plain string rather than a function that takes a db,
 * because the two callers run it through different execution paths:
 * better-sqlite3's db.exec() runs a whole multi-statement string directly;
 * op-sqlite's wrapper (gtfsDb.ts's SQLiteDatabase.execAsync) splits on ';'
 * and runs each statement individually. Both are fine with the same raw
 * SQL text — only the runner differs, so only the runner should live in
 * each environment's own file.
 */

export const GTFS_SCHEMA_SQL = `
    CREATE TABLE stops (
                           stop_pk   INTEGER PRIMARY KEY,
                           stop_id   TEXT    NOT NULL,
                           stop_name TEXT,
                           stop_lat  INTEGER NOT NULL,
                           stop_lon  INTEGER NOT NULL,
                           agency    INTEGER NOT NULL
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
                           trip_pk    INTEGER PRIMARY KEY,
                           trip_id    TEXT    NOT NULL,
                           agency     INTEGER NOT NULL,
                           pattern_pk INTEGER NOT NULL,
                           service_id TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE patterns (
                              pattern_pk   INTEGER PRIMARY KEY,
                              route_id     TEXT    NOT NULL,
                              agency       INTEGER NOT NULL,
                              direction_id INTEGER NOT NULL DEFAULT 0,
                              shape_id     TEXT,
                              trip_pk      INTEGER NOT NULL
    );

    -- pattern_pk deliberately NOT stored here: fully derivable via
    -- trip_pk -> trips.pattern_pk. Nothing queries stop_times by
    -- pattern_pk directly (see gtfsRepo.ts's module doc).
    CREATE TABLE pattern_stops (
                                   pattern_pk    INTEGER NOT NULL,
                                   stop_pk       INTEGER NOT NULL,
                                   stop_sequence INTEGER NOT NULL,
                                   PRIMARY KEY (pattern_pk, stop_sequence)
    ) WITHOUT ROWID;

    CREATE TABLE stop_times (
                                trip_pk       INTEGER NOT NULL,
                                stop_sequence INTEGER NOT NULL,
                                stop_pk       INTEGER NOT NULL,
                                arrival_sec   INTEGER NOT NULL,
                                departure_sec INTEGER NOT NULL,
                                PRIMARY KEY (trip_pk, stop_sequence)
    ) WITHOUT ROWID;

    CREATE TABLE shape_meta (
                                shape_pk INTEGER PRIMARY KEY,
                                shape_id TEXT    NOT NULL,
                                agency   INTEGER NOT NULL
    );

    CREATE TABLE shapes (
                            shape_pk          INTEGER NOT NULL,
                            shape_pt_lat      INTEGER NOT NULL,
                            shape_pt_lon      INTEGER NOT NULL,
                            shape_pt_sequence INTEGER NOT NULL,
                            PRIMARY KEY (shape_pk, shape_pt_sequence)
    ) WITHOUT ROWID;
`;

export const GTFS_INDEXES_SQL = `
    CREATE INDEX idx_stops_lat       ON stops(stop_lat);
    CREATE INDEX idx_stops_lon       ON stops(stop_lon);
    CREATE INDEX idx_stops_id        ON stops(stop_id, agency);
    CREATE INDEX idx_ps_stop         ON pattern_stops(stop_pk);
    CREATE INDEX idx_pat_route       ON patterns(route_id, agency);
    CREATE INDEX idx_shape_meta      ON shape_meta(shape_id, agency);
    CREATE INDEX idx_trips_pattern   ON trips(pattern_pk);
    CREATE INDEX idx_trips_service   ON trips(service_id, agency);
    CREATE INDEX idx_trips_id        ON trips(trip_id, agency);
    CREATE INDEX idx_st_stop_dep     ON stop_times(stop_pk, departure_sec);
    CREATE INDEX idx_cal_service     ON calendar(service_id, agency);
    CREATE INDEX idx_caldt_date      ON calendar_dates(date, agency);
`;
