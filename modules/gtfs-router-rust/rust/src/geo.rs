//! geo.rs — port of services/geo/geoUtil.ts.
//!
//! Pure math, no logic changes from the TS version — kept as its own module
//! for the same reason the TS side pulled it out: one implementation, no
//! risk of drift between the graph/corridor/raptor modules that all need it.

#[derive(Debug, Clone, Copy)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

pub fn haversine_meters(a: LatLon, b: LatLon) -> f64 {
    const R: f64 = 6_371_000.0;
    let to_rad = |d: f64| d * std::f64::consts::PI / 180.0;
    let d_lat = to_rad(b.lat - a.lat);
    let d_lon = to_rad(b.lon - a.lon);
    let s1 = (d_lat / 2.0).sin();
    let s2 = (d_lon / 2.0).sin();
    let x = s1 * s1 + to_rad(a.lat).cos() * to_rad(b.lat).cos() * s2 * s2;
    R * 2.0 * x.sqrt().asin()
}

/// Converts a center point + radius (meters) into a bounding box in the
/// SAME scaled-integer units stops_rtree stores its coordinates in
/// (degrees * `coord_scale` — see schema.sql's comment on stops_rtree),
/// for use as an R-tree query's min/max bounds. Returns
/// (min_lat, max_lat, min_lon, max_lon), all pre-scaled.
///
/// This is an approximation (equirectangular, not geodesic) — deliberately
/// so: an R-tree bbox query can only ever return a rectangle, never a
/// circle, so the caller MUST still refine with a real `haversine_meters`
/// check on the returned candidates (as corridor/resolver.rs's
/// `nearest_for_seed` does) before trusting distances. This just needs to
/// be a bbox no smaller than the true radius in every direction, not an
/// exact circle-to-box conversion.
pub fn bbox_scaled(center: LatLon, radius_m: f64, coord_scale: f64) -> (i64, i64, i64, i64) {
    const METERS_PER_DEG_LAT: f64 = 111_320.0;
    let lat_rad = center.lat * std::f64::consts::PI / 180.0;
    // Clamped, not just to dodge an actual divide-by-zero at the poles
    // (irrelevant for a transit network) — cos() can also go slightly
    // negative from floating-point error exactly at +/-90, which would
    // flip the sign of dlon and produce an inverted (min > max) box.
    let meters_per_deg_lon = (METERS_PER_DEG_LAT * lat_rad.cos()).max(1.0);
    let dlat = radius_m / METERS_PER_DEG_LAT;
    let dlon = radius_m / meters_per_deg_lon;
    let min_lat = ((center.lat - dlat) * coord_scale).round() as i64;
    let max_lat = ((center.lat + dlat) * coord_scale).round() as i64;
    let min_lon = ((center.lon - dlon) * coord_scale).round() as i64;
    let max_lon = ((center.lon + dlon) * coord_scale).round() as i64;
    (min_lat, max_lat, min_lon, max_lon)
}
