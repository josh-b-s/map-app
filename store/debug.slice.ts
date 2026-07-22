import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import {GtfsDebugInfo} from "@/services/gtfs/router/raptorRouter";


export type DebugPhase = 'bfs' | 'seed' | 'corridor' | 'raptor';
const PHASE_ORDER: DebugPhase[] = ['bfs', 'seed', 'corridor', 'raptor'];

// How many reveal-steps the corridor phase is broken into. Corridor tagging
// itself doesn't have natural sequential steps the way RAPTOR rounds do
// (it's one pass over precomputed seed paths), so this is an artificial
// chunking purely for the "corridor assembling" visual — each step reveals
// one more chunk of corridor stops.
export const CORRIDOR_CHUNK_COUNT = 10;

// BFS used to reveal one whole LEVEL per step (all of a level's frontier
// appearing at once) — jarring for a big level, and doesn't read as "watch
// it explore in the order it actually happened," which is what a debug viz
// is for. This instead reveals bfsTreeEdges (already in true discovery
// order — see seedRouteBfs.ts) progressively, in small batches, the same
// artificial-chunking idea CORRIDOR_CHUNK_COUNT already uses one line up.
export const BFS_REVEAL_STEPS = 40;

// Hard cap on the number of edges fed into DebugMapOverlay's chain-merge
// per render. NOT a visual preference: mergeEdgesIntoChains reduces the
// NUMBER of native Polyline objects only as far as the graph's actual
// branching allows, and this app's coarse graph deliberately builds
// per-pattern CLIQUE edges (topologyGraph.ts: "a busy interchange stop can
// pick up hundreds of edges") plus seedRouteBfs.ts's multi-parent tracking
// (every sibling route reaching a stop at the same level is kept) — so a
// big corridor's BFS tree can be large AND densely branched, which is
// exactly the shape that does NOT collapse into a few long chains. This
// cap is what actually bounds worst-case native object count regardless of
// how well any one search's tree happens to merge; a still-images crash
// log (java.lang.OutOfMemoryError, GL-Map thread, heap already at
// 190-191MB/192MB before failing a 56-byte allocation) confirmed this gap
// existed once the old per-stop Circle rendering (and its matching
// MAX_DEBUG_MARKERS cap) was replaced with unbounded merged Polylines.
export const MAX_BFS_DEBUG_EDGES = 600;

// Hard cap on individually-rendered map markers (Circle) per debug step.
// Still used by the corridor phase's walk-radius circles (always exactly
// 2, well under this) and kept as the general reference cap for anything
// that renders one native object per data point rather than merging into
// lines — react-native-maps backs each Circle with a real native Google
// Maps object, and rendering hundreds-to-thousands of them in one frame is
// what caused the ORIGINAL OOM crash (corridor stops alone hit 1359,
// RAPTOR rounds hit 2000-3000 marked stops in testing).
export const MAX_DEBUG_MARKERS = 120;

type State = {
    /** Master toggle. When false, computeRoute doesn't even ask
     *  computeGtfsRoute to assemble debug data (see route.slice.ts) — this
     *  isn't just a rendering toggle, it avoids the (small) collection cost
     *  on every normal search. */
    enabled: boolean;
    data: GtfsDebugInfo | null;
    /** Which stage of the search is currently being shown. */
    phase: DebugPhase;
    /** Meaning depends on phase: reveal-chunk index (0..BFS_REVEAL_STEPS-1)
     *  into bfsTreeEdges for 'bfs', index into roundMarkedStops for
     *  'raptor', chunk index (0..CORRIDOR_CHUNK_COUNT-1) for 'corridor'.
     *  Unused (stays 0) for 'seed', a single-shot reveal. */
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
        case 'bfs':      return BFS_REVEAL_STEPS;
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