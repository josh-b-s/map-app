// Single source of truth for which router backs a search. Lives in its own
// file (not route.slice.ts) so gtfsWarmup.ts can read it too: when the
// native Rust router is in use, warming the legacy TS router's caches
// (stops table + 1.16M-edge coarse graph, ~7-10s and ~136MB of JS heap on
// the JS thread) is pure waste.
export const USE_NATIVE_ROUTER = true;
