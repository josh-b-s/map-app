/**
 * geoUtil.ts — shared geo-math primitives.
 *
 * Previously an identical haversineMeters implementation was copy-pasted
 * into coarseGraph.ts, corridorTagging.ts, and gtfsLoader.ts. One
 * implementation here, imported everywhere — no functional change, just
 * removes the drift risk of three copies silently diverging.
 */

export interface LatLon {
    lat: number;
    lon: number;
}

export function haversineMeters(a: LatLon, b: LatLon): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const x = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
    return R * 2 * Math.asin(Math.sqrt(x));
}
