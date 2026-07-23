/**
 * gtfsWarmup.ts — pays every reasonable "cold start" cost during app
 * launch instead of during the user's first search.
 *
 * IMPORTANT: this calls the EXACT SAME cached functions gtfsLoader.ts uses
 * internally (getAllStopsCached, getCoarseGraph) rather than issuing raw
 * queries. An earlier version of this file called db.getAllAsync directly
 * for the stops table — that still touches SQLite's disk/page cache, but
 * gtfsLoader.ts's own stopsCache/stopsCachePromise (a JS-level module
 * variable, separate from SQLite's cache) never got populated, so the
 * user's first real search still logged "cold fetch" and paid the ~850ms
 * cost again. Calling getAllStopsCached() directly populates that same
 * module-level cache, so gtfsLoader.ts's own call later is a true no-op.
 *
 * Covers everything that's reasonably prefetchable without knowing the
 * user's actual origin/destination yet:
 *   - stops table (29K rows) -> gtfsLoader's stopsCache
 *   - coarse graph (2M edges) -> topologyGraph.ts's in-memory `cache`
 *   - Rust engine's own warm_up() (persisted coarse graph + caches on its
 *     side) -> gtfsRouterNative.ts's engine singleton, IF the native path
 *     is enabled (see USE_NATIVE_ROUTER below). Runs alongside the TS
 *     warmup rather than instead of it, so route.slice.ts's
 *     USE_NATIVE_ROUTER flag can flip between paths without also needing
 *     this file changed — whichever path a search actually uses will
 *     already be warm.
 * Deliberately does NOT try to prefetch anything origin/destination-scoped
 * (corridor, candidate patterns, stop_times) — those depend on where the
 * user is actually going and can't be usefully guessed at app launch.
 *
 * Call warmUpGtfsEngine() once, fire-and-forget, as early as possible in
 * app startup (root layout/App entry) — NOT awaited, since it shouldn't
 * block first paint. Safe to call even if the user searches before it
 * finishes: both underlying caches are promise-guarded (stopsCachePromise,
 * coarseGraph's buildPromise), so a real search that starts mid-warm-up
 * just awaits the same in-flight promise instead of triggering a second load.
 */

import {getDb, isDbReady, DB_PATH} from '../../db/sqliteDb';
import {getAllStopsCached} from '../core/gtfsRepo';
import {getCoarseGraph} from '../graph/topologyGraph';
import {getNativeEngine} from '../router/gtfsRouterNative'; // TODO: verify this path — I'm guessing it lives next to raptorRouter.ts based on the README's file map, adjust to wherever you actually put it

let warmedUp = false;

export async function warmUpGtfsEngine(): Promise<void> {
    if (warmedUp) return; // idempotent — safe to call more than once (e.g. on app foreground)
    warmedUp = true;

    const t0 = Date.now();

    const ready = await isDbReady();
    if (!ready) {
        // No GTFS DB downloaded yet (fresh install, pre-download) — nothing
        // to warm up. The normal download-then-open flow elsewhere in the
        // app handles this; warmup just no-ops rather than throwing.
        console.log('[gtfsWarmup] DB not ready yet — skipping warmup');
        warmedUp = false; // allow a retry once the DB actually exists
        return;
    }

    try {
        const db = await getDb();

        // Same cached function gtfsLoader.ts calls internally — populates
        // its module-level stopsCache, not just SQLite's own page cache.
        const stops = await getAllStopsCached(db);
        console.log(`[gtfsWarmup] stops cached (${stops.length} rows): ${Date.now() - t0}ms`);

        // The big one: loads (or builds, on a genuinely first-ever run)
        // the 2M-edge coarse graph and caches it in-memory for the process
        // lifetime — this is the ~2.1-5s cost seen in profiling. Its own
        // in-memory `cache`/`buildPromise` guards mean this is a true no-op
        // for every subsequent call this session, same as stopsCache above.
        await getCoarseGraph();
        console.log(`[gtfsWarmup] coarseGraph warmed: ${Date.now() - t0}ms total`);

        // Rust engine's own warm_up(): opens ITS OWN rusqlite::Connection
        // against the same on-disk file (DB_PATH) — this is not sharing
        // op-sqlite's handle above, it's a second, independent connection,
        // per op-sqlite's own "one connection per db" caution being about
        // op-sqlite specifically, not the file itself. warm_up() persists/
        // loads the coarse graph into its own new tables
        // (rust_coarse_graph_meta/adjacency — see the rust crate's
        // graph/store.rs) and keeps everything alive for the engine's
        // lifetime, mirroring what getCoarseGraph() above does for the TS
        // path. Runs unconditionally (not gated on a native/TS flag) since
        // it's cheap to skip if unused and keeps this file oblivious to
        // which path route.slice.ts is currently set to.
        try {
            getNativeEngine(DB_PATH); // warms up + records warmedUpPath so the first real search's own getEngine(DB_PATH) call is a no-op
            console.log(`[gtfsWarmup] native engine warmed: ${Date.now() - t0}ms total`);
        } catch (nativeErr) {
            // Non-fatal on its own — if the native path isn't in use this
            // session, this failing shouldn't affect the TS path at all.
            console.warn('[gtfsWarmup] native engine warmup failed (non-fatal):', nativeErr);
        }

        // NOTE: an earlier version of this warmup also ran COUNT(*) against
        // trips/patterns/pattern_stops/stop_times to pre-fault their disk
        // pages. Removed — profiling showed this backfired: those tables
        // are sized by the WHOLE 11-agency network, not any one corridor,
        // so a COUNT(*) has to walk the entire table regardless of what
        // the user is about to search for. Worse, SQLite serializes all
        // queries on one connection, so a real search that started while
        // this was still running got queued BEHIND that full-network scan
        // — one profiled run showed "corridor stop_ids staged into temp
        // table" (normally 7-150ms) balloon to 8144ms purely from waiting
        // on this warmup's COUNT(*) FROM stop_times to finish. The fix
        // isn't to make this faster, it's to not do it: unlike
        // stops/coarseGraph (genuinely network-wide, reused as-is by every
        // search), these tables are only ever queried scoped to a specific
        // corridor's candidate patterns — there's no generic "warm" state
        // for them to be in before that corridor is known.
    } catch (err) {
        // Warmup failing should never crash app startup or block a real
        // search — the normal load path in gtfsLoader.ts will just pay the
        // cold-start cost itself if this didn't finish in time.
        console.warn('[gtfsWarmup] failed (non-fatal, normal search path still works):', err);
        warmedUp = false; // allow a retry on next call
    }
}
