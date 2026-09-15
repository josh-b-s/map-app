CREATE TABLE stops (
                       stop_pk   INTEGER PRIMARY KEY,
                       stop_id   TEXT    NOT NULL,
                       stop_name TEXT,
                       stop_lat  INTEGER NOT NULL,
                       stop_lon  INTEGER NOT NULL,
                       agency    INTEGER NOT NULL
);

-- R-tree spatial index over stops, for nearest-neighbor/bbox queries
-- (corridor seed-stop lookup). Point data: min==max per dimension for
-- every row. Coordinates are stored in the SAME scaled-integer units as
-- stops.stop_lat/stop_lon (degrees * 1_000_000, see repo.rs::COORD_SCALE
-- / import.rs's pack_coord) — not real degrees — so a query must scale
-- its bounding box the same way, not compare against raw lat/lon floats.
-- stop_pk here must match stops.stop_pk exactly; see import.rs where both
-- tables are populated in the same insert loop.
CREATE VIRTUAL TABLE stops_rtree USING rtree(
                                                stop_pk,
                                                min_lat, max_lat,
                                                min_lon, max_lon
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
    -- GTFS pickup_type/drop_off_type: 0 = regular
    -- (default when blank/missing, per spec), 1 = no
    -- service, 2 = must phone agency, 3 = must
    -- coordinate with driver. The router only ever
    -- treats 0 as usable for automatic trip
    -- planning — 2/3 need advance human contact and
    -- can't be relied on as a walk-up automatic
    -- transfer point, so they're excluded from
    -- routing the same as 1 (no service) is, not
    -- just literal "no service" rows.
                            pickup_type   INTEGER NOT NULL DEFAULT 0,
                            drop_off_type INTEGER NOT NULL DEFAULT 0,
    -- PERF NOTE: PK (and therefore physical row
    -- order, since this is WITHOUT ROWID) was
    -- `(trip_pk, stop_sequence)` — a leftover of
    -- streaming stop_times.txt grouped per trip at
    -- import time, not a deliberate read-path
    -- choice. EVERY read of this table (gtfs router
    -- crate, loader.rs) filters by `stop_pk` first —
    -- `windowed_trip_discovery` and `stop_times_
    -- fetch` both do `WHERE stop_pk IN (...) AND
    -- ...`; nothing anywhere queries by trip_pk
    -- alone. With the old key, `idx_st_stop_dep`
    -- (stop_pk, departure_sec) could locate matching
    -- rows, but fetching the rest of each row (
    -- arrival_sec/pickup_type/drop_off_type) meant a
    -- random jump into a table physically sorted by
    -- TRIP — a scattered disk seek per matched row,
    -- for every single search. Re-keyed so physical
    -- order matches the actual read pattern: rows
    -- for the same stop are now contiguous on disk,
    -- so `stop_pk IN (...)` becomes a handful of
    -- sequential range reads instead of thousands of
    -- scattered ones, and satisfies `stop_pk` +
    -- `departure_sec` range filtering directly from
    -- the clustered table with no secondary-index
    -- hop at all (see indexes.sql — idx_st_stop_dep
    -- removed, now redundant with this ordering).
    -- `trip_pk, stop_sequence` appended after
    -- `departure_sec` purely to preserve the
    -- original key's uniqueness guarantee (a trip
    -- cannot revisit the same stop at the same
    -- departure_sec) — not because anything reads
    -- in that order.
                            PRIMARY KEY (stop_pk, departure_sec, trip_pk, stop_sequence)
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

-- Precomputed per-pattern hop times, aggregated across every trip of a
-- pattern at import time (see import.rs's compute_pattern_hop_stats). One
-- row per (pattern, from-stop) pair — i.e. the same cardinality as
-- pattern_stops minus one row per pattern, NOT stop_times' per-trip
-- cardinality. This is the whole point: collapses "N trips x M stops" down
-- to "1 pattern x M stops" so the frequency-graph pre-filter (router
-- crate's freq_raptor module) can estimate a corridor's likely-fastest
-- journey without touching stop_times/SQL at all.
--
-- stop_sequence here is the FROM stop's stop_sequence in pattern_stops
-- (i.e. this row describes the hop from this stop to the NEXT stop in the
-- pattern's ordered sequence, not to stop_sequence+1 literally — GTFS
-- stop_sequence values aren't guaranteed contiguous). avg_travel_sec is a
-- median across contributing trips (not a mean — see import.rs's
-- aggregation comment for why), measured departure_sec(from) ->
-- arrival_sec(to). sample_trips lets query-time code discount a hop
-- computed from very few trips rather than trusting it at face value.
CREATE TABLE pattern_hops (
                              pattern_pk     INTEGER NOT NULL,
                              stop_sequence  INTEGER NOT NULL,
                              avg_travel_sec INTEGER NOT NULL,
                              sample_trips   INTEGER NOT NULL,
                              PRIMARY KEY (pattern_pk, stop_sequence)
) WITHOUT ROWID;

-- Precomputed per-pattern, per-time-bucket headway (average gap between
-- consecutive trips' departures from the pattern's first stop), same
-- import-time aggregation pass as pattern_hops. time_bucket is a fixed
-- clock bucket shared across every pattern (see import.rs's
-- time_bucket_for) — NOT adaptive per pattern — 0=night, 1=off-peak,
-- 2=peak. avg_headway_sec is NULL when sample_trips < 2 for that
-- pattern+bucket (can't compute a gap from a single trip); query-time code
-- must treat NULL as "unknown, assume infrequent" rather than skipping the
-- pattern, since an unknown headway should bias the frequency-graph
-- estimate toward NOT pruning that pattern (see router's freq_raptor
-- module doc for the margin/pruning-safety reasoning).
CREATE TABLE pattern_headway (
                                 pattern_pk      INTEGER NOT NULL,
                                 time_bucket     INTEGER NOT NULL,
                                 avg_headway_sec INTEGER,
                                 sample_trips    INTEGER NOT NULL,
                                 PRIMARY KEY (pattern_pk, time_bucket)
) WITHOUT ROWID;