// gtfsRouterNative.ts
//
// Thin adapter over the uniffi-generated Rust GtfsRouterEngine, shaped to
// match computeGtfsRoute()'s public signature/return type exactly, so call
// sites (and the comparison harness below) can swap implementations by
// changing one import.

import gtfsRouterRust from '@mapapp/gtfs-router-rust';
import type {
    LatLng,
    RouteResult,
    Journey,
    Leg,
    RouterError,
} from '@mapapp/gtfs-router-rust';
import type {
    GtfsRouteResult,
    GtfsJourney,
    RouteSegment,
    WALK_SPEED_MPS,
} from './raptorRouter'; // reuse your existing TS types so both paths are interchangeable
import { DebugSinkCollector } from './debugSinkCollector';
import { DB_PATH } from '@/services/db/sqliteDb';

const { GtfsRouterEngine } = gtfsRouterRust.gtfs_router;

// ── Singleton engine, mirrors how you already hold a single sqlite handle open ──
let engine: InstanceType<typeof GtfsRouterEngine> | null = null;
let warmedUpPath: string | null = null;

function getEngine(dbPath: string) {
    if (!engine) engine = new GtfsRouterEngine();
    if (warmedUpPath !== dbPath) {
        engine.warmUp(dbPath); // rebuilds/loads coarse graph + reusable state, ~12-14s cold
        warmedUpPath = dbPath;
    }
    return engine;
}

/**
 * Exposes the same singleton + warmedUpPath tracking getEngine() uses
 * internally, so gtfsWarmup.ts can pre-warm at app launch and the first
 * real search's own getEngine(dbPath) call sees warmedUpPath already set
 * and skips calling warm_up() a second time.
 */
export function getNativeEngine(dbPath?: string) {
    if (dbPath) return getEngine(dbPath);
    if (!engine) engine = new GtfsRouterEngine();
    return engine;
}

// Call this once after any GTFS re-import (mirrors your old invalidate flow)
export function invalidateNativeRouter() {
    engine?.invalidate();
    warmedUpPath = null;
}

function secToTimeString(sec?: number): string | undefined {
    if (sec === undefined) return undefined;
    const h = Math.floor(sec / 3600) % 24;
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * loader.rs expects today_date/tomorrow_date as unhyphenated "YYYYMMDD"
 * (GTFS's own calendar/calendar_dates date format — see its doc comment:
 * `today_date: &str, // YYYYMMDD`), in LOCAL time, not UTC. `toISOString()`
 * gets both wrong at once: it's hyphenated ("2026-07-23") AND UTC-based, so
 * for any Melbourne search before ~10-11am local it would report the
 * previous UTC calendar day entirely, on top of the format mismatch.
 */
function toGtfsDateString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

function toSegment(seg: import('@mapapp/gtfs-router-rust').RouteSegment): RouteSegment {
    // segments live on Journey.segments directly (not nested under Leg) —
    // see lib.rs's Journey struct.
    return {
        coords: seg.coords,
        routeName: seg.routeName,
        routeType: seg.routeType,
        routeColor: seg.routeColor,
        routeTextColor: seg.routeTextColor,
        originStopName: seg.originStopName,
        destStopName: seg.destStopName,
        type: seg.isWalk ? 'walk' : 'transit',
        departureTime: secToTimeString(seg.departureTimeSec),
        arrivalTime: secToTimeString(seg.arrivalTimeSec),
    };
}

function toJourney(j: Journey): GtfsJourney {
    // j.segments and j.legs are separate parallel arrays on Journey itself
    // (see lib.rs) — segments are the fine-grained walk/transit polyline
    // pieces, legs are the coarser "board here, alight there" summary.
    const segments = j.segments.map(toSegment);
    const first = j.legs[0];
    const last = j.legs[j.legs.length - 1];
    return {
        coords: j.coords,
        segments,
        legs: j.legs.map((leg: Leg) => ({
            routeName: leg.routeName,
            routeType: leg.routeType,
            routeColor: leg.routeColor,
            routeTextColor: leg.routeTextColor,
            originStopName: leg.originStopName,
            destStopName: leg.destStopName,
            departureTime: secToTimeString(leg.departureTimeSec),
            arrivalTime: secToTimeString(leg.arrivalTimeSec),
        })),
        routeName: j.routeName,
        routeType: j.routeType,
        routeColor: j.routeColor,
        routeTextColor: j.routeTextColor,
        originStopName: j.originStopName,
        destStopName: j.destStopName,
        transferStopName: j.transferStopName,
        totalDurationMin: j.totalDurationMin,
        totalWalkingMeters: j.totalWalkingMeters,
        transferCount: j.transferCount,
        departureTime: secToTimeString(j.departureTimeSec)!,
        arrivalTime: secToTimeString(j.arrivalTimeSec)!,
    };
}

/**
 * Same signature/contract as computeGtfsRoute() in raptorRouter.ts, backed by
 * the Rust RAPTOR engine instead. Uses DB_PATH internally (same file
 * op-sqlite opens) rather than taking a path param, so route.slice.ts's
 * call site doesn't need to know about it — same call shape as the TS path.
 */
export async function computeGtfsRouteNative(
    origin: LatLng,
    destination: LatLng,
    departureTime: Date = new Date(),
    walkingSpeedMps: number = 1.4, // WALK_SPEED_MPS.NORMAL
    debugMode: boolean = false,
): Promise<GtfsRouteResult> {
    const eng = getEngine(DB_PATH);

    const today = departureTime;
    const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000);
    const departSecOfDay =
        today.getHours() * 3600 + today.getMinutes() * 60 + today.getSeconds();

    const collector = debugMode ? new DebugSinkCollector() : null;

    try {
        const result: RouteResult = eng.computeRoute(
            origin,
            destination,
            departSecOfDay,
            toGtfsDateString(today),
            today.getDay(),
            toGtfsDateString(tomorrow),
            tomorrow.getDay(),
            walkingSpeedMps,
            collector ?? undefined, // confirmed from the generated binding: FfiConverterOptional checks `=== undefined` for the None case; null instead throws "Cannot convert null value to object" trying to lower it as a real object
        );

        // Diagnostic — mirrors gtfsLoader.ts's own per-stage console.log
        // breakdown, sourced from lib.rs's new RouteResult.timings field
        // (loader.rs's per-stage Instant timers + compute_route's own
        // raptor_search timer). "total" is loader.rs's load time only;
        // raptor_search is a separate top-level entry, not summed into it.
        console.log(
            '[gtfsRouterNative] stage timings: ' +
            result.timings.map(t => `${t.label}=${t.ms}ms`).join(' | ')
        );

        return {
            journeys: result.journeys.map(toJourney),
            debug: collector?.toDebugInfo(),
        };
    } catch (err) {
        // RouterError variants come through here (e.g. NoServiceFound) — map to
        // whatever shape your callers already expect from computeGtfsRoute's
        // rejection path.
        throw err as RouterError;
    }
}
