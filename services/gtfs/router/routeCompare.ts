// routeCompare.ts
//
// Dev-only harness: runs the existing TS/op-sqlite router and the new Rust
// engine back-to-back for the same query and logs timings + a rough
// result-shape diff. Not meant to ship — call from a debug screen/button.

import {computeGtfsRoute} from './raptorRouter';
import {computeGtfsRouteNative} from './gtfsRouterNative';
import type {LatLng} from '@mapapp/gtfs-router-rust';

export async function compareRouters(
    origin: LatLng,
    destination: LatLng,
    departureTime: Date = new Date(),
) {
    const tStart = performance.now();
    const tsResult = await computeGtfsRoute(origin, destination, departureTime);
    const tsMs = performance.now() - tStart;

    // computeGtfsRouteNative no longer takes a dbPath param — it resolves
    // DB_PATH internally (same file op-sqlite opens), same call shape as
    // the TS path above.
    const rStart = performance.now();
    const rustResult = await computeGtfsRouteNative(origin, destination, departureTime);
    const rustMs = performance.now() - rStart;

    console.log(
        `[routeCompare] TS: ${tsMs.toFixed(0)}ms (${tsResult.journeys.length} journeys) | ` +
        `Rust: ${rustMs.toFixed(0)}ms (${rustResult.journeys.length} journeys) | ` +
        `speedup: ${(tsMs / rustMs).toFixed(2)}x`
    );

    const tsFirst = tsResult.journeys[0];
    const rustFirst = rustResult.journeys[0];
    if (tsFirst && rustFirst) {
        const arrivalMatch = tsFirst.arrivalTime === rustFirst.arrivalTime;
        const transferMatch = tsFirst.transferCount === rustFirst.transferCount;
        console.log(
            `[routeCompare] best-journey match — arrival: ${arrivalMatch}, transfers: ${transferMatch}`,
            {ts: tsFirst, rust: rustFirst},
        );
    }

    return {tsMs, rustMs, tsResult, rustResult};
}