# gtfs-router (Rust port of the JS routing pipeline)

Full logic port of `coarseGraph.ts` → `seedRouteBfs.ts` → `corridorTagging.ts`
/ `corridorResolver.ts` → `gtfsLoader.ts` → `gtfsRouter.ts`, mirroring the
`gtfs-importer` crate's conventions (UniFFI 0.30 proc-macros, `rusqlite`
bundled, `thiserror` for the error enum, no build.rs — bindings are
generated via the `uniffi-bindgen` bin target same as the importer).

## ⚠️ Not yet compiler-verified

This was written and cross-checked by hand (every `use crate::...` and every
struct field access traced back to its definition) but **has not been run
through `cargo check`** — the sandbox this was built in has no network
access to fetch crates.io dependencies. Please run:

```sh
cd modules/gtfs-router/rust
cargo check
```

first, before wiring up bindings. If it doesn't compile clean, paste the
first handful of errors back and I'll fix them — likely candidates are
minor borrow-checker complaints in `corridor/seed_bfs.rs`'s closure-based
walk-closure or `raptor.rs`'s RAPTOR round loop, since those are the two
places doing the most non-trivial mutable-borrow juggling.

## Biggest design change from the TS version

Rust reads SQLite directly, so this drops `gtfsKeyUtil.ts`'s
`makeKey`/`parseKey` composite string-key layer entirely and threads raw
`i64` surrogate pks (`stop_pk`, `pattern_pk`, `trip_pk`) through every
module instead. That layer only existed in JS to survive the bridge — see
`repo.rs`'s module doc for the full reasoning. `StopsCache`/`PatternsCache`
use dense `Vec<Option<T>>` indexed by pk instead of a `HashMap`, since the
importer assigns pks contiguously from 1 (see `import.rs`'s `PkOffsets`).

## Scope cuts in this first pass (see inline `SCOPE NOTE` comments)

- **No cancellation token.** A search runs to completion or returns an
  error. Add a `CancellationToken` uniffi::Object (checked periodically
  inside the RAPTOR round loop) as a follow-up if searches need to be
  abortable from the UI.
- **No general progress/logging callback** — only `DebugSink`, since that's
  what you said you actually want first (the "currently evaluating"
  polylines). `DebugSink::on_event` fires live during a search — throttle
  on the receiving end (Kotlin/Swift/TS side) to whatever frame rate you
  want; Rust doesn't rate-limit these itself.
- **Transit segment polylines are stop-to-stop**, built from the pattern's
  `pattern_stops` sequence — not the smoother GTFS `shapes` polyline the TS
  version trims per-segment. Functionally correct (right stops, right
  order), visually coarser. `repo.rs`'s `ShapesIndex`/`get_shape_points`
  are already ported and warmed up in `GtfsRouterEngine`, just not wired
  into `raptor::reconstruct_path` yet — that's the natural next increment.
- **Bbox-fallback corridor tagging** (`corridor/tagging.rs`'s
  `compute_corridor`) is ported but is the rarely-hit path (only fires when
  the seed-path corridor comes back too thin) — worth extra scrutiny/testing
  precisely because it'll be exercised least in normal use.
- **Persisted coarse graph uses NEW tables** (`rust_coarse_graph_meta` /
  `rust_coarse_graph_adjacency`, fixed-width binary edge encoding) rather
  than reusing the JS-persisted `coarse_graph_meta`/`coarse_graph_adjacency`
  (TEXT-keyed) tables — see `graph/store.rs`'s module doc for why. Both can
  coexist in the same `gtfs.db` without collision.

## Wiring this up

1. Add this crate to your workspace / ubrn build config the same way
   `gtfs-importer` is wired (same `uniffi-bindgen.rs` bin pattern).
2. Generate bindings the same way you generate them for the importer.
3. On the app side: construct one `GtfsRouterEngine`, call
   `warm_up(db_path)` once at launch (fire-and-forget, same spot
   `gtfsWarmup.ts` runs today), keep the engine object alive, and call
   `compute_route(...)` per search.
4. `today_date`/`today_dow`/`tomorrow_date`/`tomorrow_dow` are passed in by
   the caller (Kotlin/Swift/TS already has a proper timezone-aware `Date`)
   rather than computed in Rust — see `loader.rs`'s module doc. `today_dow`
   uses JS `Date.getDay()` convention: `0 = Sunday .. 6 = Saturday`.
5. After a feed re-import, call `engine.invalidate()` then `warm_up()`
   again — the persisted coarse graph rebuilds automatically since its
   signature (stop/pattern_stop row counts) will have changed.

## File map (mirrors the TS services/ tree)

| Rust | TS equivalent |
|---|---|
| `geo.rs` | `geo/geoUtil.ts` |
| `settings.rs` | `gtfs/shared/routingSettings.ts` |
| `repo.rs` | `gtfs/core/gtfsRepo.ts` (+ `gtfsKeyUtil.ts`, dropped — see above) |
| `graph/coarse.rs` | `gtfs/graph/coarseGraph.ts` |
| `graph/store.rs` | `gtfs/graph/coarseGraphStore.ts` |
| `corridor/seed_bfs.rs` | `gtfs/graph/seedRouteBfs.ts` |
| `corridor/tagging.rs` | `gtfs/corridor/corridorTagging.ts` |
| `corridor/resolver.rs` | `gtfs/corridor/corridorResolver.ts` |
| `loader.rs` | `gtfs/loader/gtfsLoader.ts` |
| `raptor.rs` | `gtfs/router/gtfsRouter.ts` |
| `lib.rs` | new — the FFI boundary, no TS equivalent |
