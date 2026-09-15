CREATE INDEX idx_stops_lat       ON stops(stop_lat);
CREATE INDEX idx_stops_lon       ON stops(stop_lon);
CREATE INDEX idx_stops_id        ON stops(stop_id, agency);
CREATE INDEX idx_ps_stop         ON pattern_stops(stop_pk);
CREATE INDEX idx_pat_route       ON patterns(route_id, agency);
CREATE INDEX idx_shape_meta      ON shape_meta(shape_id, agency);
CREATE INDEX idx_trips_pattern   ON trips(pattern_pk);
CREATE INDEX idx_trips_service   ON trips(service_id, agency);
CREATE INDEX idx_trips_id        ON trips(trip_id, agency);
-- idx_st_stop_dep removed: stop_times' PRIMARY KEY is now
-- (stop_pk, departure_sec, trip_pk, stop_sequence) — see schema.sql's note
-- on that table — so this index would just be a byte-for-byte duplicate of
-- the table's own physical order. Keeping it would cost import time and
-- storage for zero query benefit.
CREATE INDEX idx_cal_service     ON calendar(service_id, agency);
CREATE INDEX idx_caldt_date      ON calendar_dates(date, agency);