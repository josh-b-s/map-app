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
