import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import {GtfsDebugInfo} from "@/services/gtfs/router/raptorRouter";
import { getBfsDiscoveryPoints } from '@/services/gtfs/debug/debugBfsPoints';


export type DebugPhase = 'bfs' | 'seed' | 'corridor' | 'raptor';
const PHASE_ORDER: DebugPhase[] = ['bfs', 'seed', 'corridor', 'raptor'];

// How many reveal-steps the corridor phase is broken into. Corridor tagging
// itself doesn't have natural sequential steps the way RAPTOR rounds do
// (it's one pass over precomputed seed paths), so this is an artificial
// chunking purely for the "corridor assembling" visual — each step reveals
// one more chunk of corridor stops.
export const CORRIDOR_CHUNK_COUNT = 10;

// Target playback rate for the BFS "exploring" reveal. 30fps reads as
// smooth on a map (30-60 native-bridge frame pushes/sec is already a lot
// for react-native-maps) without the jitter of much lower rates; bump to
// 60 (BFS_TARGET_FPS = 60) if it still looks choppy on target devices.
// Other phases (seed/corridor/raptor) keep the slower STEP_INTERVAL_MS in
// DebugControls.tsx — they're chunk reveals, not a real animation, so a
// human-watchable pace reads better than a fast blur there.
export const BFS_TARGET_FPS = 30;
export const BFS_STEP_INTERVAL_MS = Math.round(1000 / BFS_TARGET_FPS);

// Hard cap on points fed into a single BFS Polyline per render. No longer
// a hard OOM boundary the way the old MAX_BFS_DEBUG_EDGES was (one
// Polyline is one native object regardless of point count) — this is just
// a sane ceiling on coordinate-array size/bridge payload for a very large
// exploration.
export const MAX_BFS_DEBUG_POINTS = 2000;

// NOTE: BFS_REVEAL_STEPS and MAX_BFS_DEBUG_EDGES (fixed-chunk BFS reveal)
// have been removed. BFS now reveals one real discovered point per step
// (see phaseLength below) at BFS_STEP_INTERVAL_MS, instead of chunking a
// fixed number of artificial steps — so there's no separate "how many
// chunks" constant needed here anymore.

type State = {
    /** Master toggle. When false, computeRoute doesn't even ask
     *  computeGtfsRoute to assemble debug data (see route.slice.ts) — this
     *  isn't just a rendering toggle, it avoids the (small) collection cost
     *  on every normal search. */
    enabled: boolean;
    data: GtfsDebugInfo | null;
    /** Which stage of the search is currently being shown. */
    phase: DebugPhase;
    /** Meaning depends on phase: index into BFS discovery-order points
     *  (0..N-1, see debugBfsPoints.ts) for 'bfs', index into
     *  roundMarkedStops for 'raptor', chunk index (0..CORRIDOR_CHUNK_COUNT-1)
     *  for 'corridor'. Unused (stays 0) for 'seed', a single-shot reveal. */
    stepIndex: number;
    /** Whether DebugControls' auto-advance timer is currently running. */
    playing: boolean;
};

const initialState: State = {
    enabled: false,
    data: null,
    phase: 'bfs',
    stepIndex: 0,
    playing: false,
};

/** Number of steps the given phase has, based on the current data. Single
 *  source of truth for advanceStep/retreatStep so phase-length logic isn't
 *  duplicated between the two. */
function phaseLength(phase: DebugPhase, data: GtfsDebugInfo): number {
    switch (phase) {
        case 'bfs':      return Math.max(1, getBfsDiscoveryPoints(data).length);
        case 'raptor':   return Math.max(1, data.roundMarkedStops.length);
        case 'corridor': return CORRIDOR_CHUNK_COUNT;
        case 'seed':     return 1;
    }
}

const slice = createSlice({
    name: 'debug',
    initialState,
    reducers: {
        toggleDebugEnabled(state) {
            state.enabled = !state.enabled;
        },
        setDebugData(state, action: PayloadAction<GtfsDebugInfo | null>) {
            state.data = action.payload;
            state.phase = 'bfs';
            state.stepIndex = 0;
            state.playing = false;
        },
        setPlaying(state, action: PayloadAction<boolean>) {
            state.playing = action.payload;
        },
        /** Moves forward one step within the current phase, or into the next
         *  phase if the current one is exhausted. Stops auto-play at the very
         *  end (last RAPTOR round) rather than looping — a search has a
         *  natural beginning and end, looping would be confusing to watch. */
        advanceStep(state) {
            if (!state.data) return;
            const len = phaseLength(state.phase, state.data);
            if (state.stepIndex < len - 1) {
                state.stepIndex += 1;
                return;
            }
            const nextPhaseIdx = PHASE_ORDER.indexOf(state.phase) + 1;
            if (nextPhaseIdx < PHASE_ORDER.length) {
                state.phase = PHASE_ORDER[nextPhaseIdx];
                state.stepIndex = 0;
            } else {
                state.playing = false; // reached the very end — stop, don't loop
            }
        },
        /** Mirror of advanceStep, for manual step-back. */
        retreatStep(state) {
            if (!state.data) return;
            if (state.stepIndex > 0) { state.stepIndex -= 1; return; }
            const prevPhaseIdx = PHASE_ORDER.indexOf(state.phase) - 1;
            if (prevPhaseIdx >= 0) {
                state.phase = PHASE_ORDER[prevPhaseIdx];
                state.stepIndex = phaseLength(state.phase, state.data) - 1;
            }
        },
        /** Jump straight to a phase (e.g. tapping a phase label), landing on
         *  that phase's first step. */
        setPhase(state, action: PayloadAction<DebugPhase>) {
            if (!state.data) return;
            state.phase = action.payload;
            state.stepIndex = 0;
            state.playing = false;
        },
        resetToStart(state) {
            state.phase = 'bfs';
            state.stepIndex = 0;
            state.playing = false;
        },
    },
});

export const {
    toggleDebugEnabled, setDebugData, setPlaying, advanceStep, retreatStep, setPhase, resetToStart,
} = slice.actions;
export default slice.reducer;
