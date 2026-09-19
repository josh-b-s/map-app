import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { DebugMeta } from '@/services/gtfs/debug/debugDataStore';


export type DebugPhase = 'bfs' | 'raptor';
const PHASE_ORDER: DebugPhase[] = ['bfs', 'raptor'];

/** How the bfs phase's candidate routes are displayed:
 *  - 'cumulative': stepIndex is a ROUND number. Shows that round's hull
 *    plus every candidate found by this round or earlier, all at once —
 *    "here's everything found so far."
 *  - 'single': stepIndex is a CANDIDATE index (see
 *    debugBfsPoints.ts's flattenBfsCandidates), ordered by the round each
 *    candidate was first discovered. Shows only that one candidate as a
 *    single full polyline, paired with the hull for whichever round it was
 *    found in — the "step through candidates one at a time" mode, same
 *    shape as how the raptor phase already steps through route-checks.
 *  This is genuinely a different meaning for stepIndex/phase length
 *  depending on mode, not just a rendering toggle — see phaseLength below.
 *
 *  hopColorMode (below) is a SEPARATE, orthogonal toggle: it controls how
 *  a candidate's own shape is colored (per-hop palette vs one flat color),
 *  not which candidates are visible or what stepIndex means. It always
 *  shows every candidate's every hop at once, regardless of
 *  bfsCandidateMode/stepIndex — see DebugMapOverlay.tsx. */
export type BfsCandidateMode = 'cumulative' | 'single';

// Target playback rate for the BFS "exploring" reveal. 30fps reads as
// smooth on a map (30-60 native-bridge frame pushes/sec is already a lot
// for react-native-maps) without the jitter of much lower rates; bump to
// 60 (BFS_TARGET_FPS = 60) if it still looks choppy on target devices.
// 'raptor' keeps the slower STEP_INTERVAL_MS in DebugControls.tsx instead —
// its steps are discrete "here's the next candidate route" reveals, not a
// real animation, so a human-watchable pace reads better than a fast blur.
export const BFS_TARGET_FPS = 30;
export const BFS_STEP_INTERVAL_MS = Math.round(1000 / BFS_TARGET_FPS);

// NOTE: CORRIDOR_CHUNK_COUNT, MAX_BFS_DEBUG_POINTS, BFS_REVEAL_STEPS, and
// MAX_BFS_DEBUG_EDGES have all been removed. There's no separate
// seed/corridor phase anymore — corridor-finding renders as part of the
// bfs phase, stepped per BFS round (see DebugMapOverlay.tsx) — and BFS no
// longer reveals individual points at all, so the old point-count cap and
// per-point reveal-step constants don't apply either.

type State = {
    /** Master toggle. When false, computeRoute doesn't even ask
     *  computeGtfsRoute to assemble debug data (see route.slice.ts) — this
     *  isn't just a rendering toggle, it avoids the (small) collection cost
     *  on every normal search. */
    enabled: boolean;
    /** The debug data itself lives in services/gtfs/debug/debugDataStore.ts,
     *  NOT in Redux (see that file's header). Redux only holds a version
     *  (bumped per search, so subscribers re-read) and the step counts
     *  phaseLength needs. */
    hasData: boolean;
    dataVersion: number;
    bfsRoundCount: number;
    bfsCandidateCount: number;
    raptorStepCount: number;
    /** Which stage of the search is currently being shown. */
    phase: DebugPhase;
    /** Meaning depends on phase (and, for 'bfs', on bfsCandidateMode):
     *  'bfs' + cumulative -> round index (0..bfsLevels.length-1), showing
     *  that round's hull plus every candidate found by this round or
     *  earlier. 'bfs' + single -> candidate index (0..N-1, see
     *  flattenBfsCandidates), showing exactly one candidate at a time,
     *  paired with the hull for whichever round it was found in.
     *  'raptor' -> flattened route-check index (0..raptorStepCount-1, NOT
     *  round index) — each step is one individual candidate route,
     *  replacing rather than accumulating. Unaffected by hopColorMode. */
    stepIndex: number;
    /** Whether DebugControls' auto-advance timer is currently running. */
    playing: boolean;
    /** See BfsCandidateMode doc comment. Persists across a toggle (doesn't
     *  reset on setDebugData) since it's a display preference, not
     *  per-search state — same reasoning as `enabled` itself. */
    bfsCandidateMode: BfsCandidateMode;
    /** Only meaningful during the bfs phase. When true, DebugMapOverlay
     *  renders EVERY HOP of whichever candidate(s) are currently visible
     *  (per bfsCandidateMode/stepIndex), each hop colored by a per-hop-index
     *  palette (or the pattern's real route_color, when it has one) instead
     *  of drawing those candidates as a single flat-colored polyline. It
     *  only changes HOW the visible candidate(s) are colored, not WHICH
     *  candidates are visible — so it doesn't affect phaseLength and isn't
     *  reset on setDebugData, same "persistent display preference"
     *  treatment as bfsCandidateMode gets. Intended for eyeballing candidate
     *  shape/detour before deciding on a geometric pruning threshold. */
    hopColorMode: boolean;
};

const initialState: State = {
    enabled: false,
    hasData: false,
    dataVersion: 0,
    bfsRoundCount: 0,
    bfsCandidateCount: 0,
    raptorStepCount: 0,
    phase: 'bfs',
    stepIndex: 0,
    playing: false,
    bfsCandidateMode: 'cumulative',
    hopColorMode: false,
};

/** Number of steps the given phase has, based on the current data (and, for
 *  'bfs', the candidate display mode). Single source of truth for
 *  advanceStep/retreatStep so phase-length logic isn't duplicated between
 *  the two. Deliberately ignores hopColorMode — it changes how a step's
 *  candidates are colored, not how many steps there are. */
function phaseLength(phase: DebugPhase, s: State, bfsCandidateMode: BfsCandidateMode): number {
    switch (phase) {
        case 'bfs':
            return bfsCandidateMode === 'single'
                ? Math.max(1, s.bfsCandidateCount)
                : Math.max(1, s.bfsRoundCount);
        case 'raptor':
            return Math.max(1, s.raptorStepCount);
    }
}

const slice = createSlice({
    name: 'debug',
    initialState,
    reducers: {
        toggleDebugEnabled(state) {
            state.enabled = !state.enabled;
        },
        setDebugData(state, action: PayloadAction<DebugMeta | null>) {
            const m = action.payload;
            state.hasData = !!m;
            state.dataVersion = m?.version ?? state.dataVersion + 1;
            state.bfsRoundCount = m?.bfsRoundCount ?? 0;
            state.bfsCandidateCount = m?.bfsCandidateCount ?? 0;
            state.raptorStepCount = m?.raptorStepCount ?? 0;
            state.phase = 'bfs';
            state.stepIndex = 0;
            state.playing = false;
        },
        setPlaying(state, action: PayloadAction<boolean>) {
            state.playing = action.payload;
        },
        /** Moves forward one step within the current phase, or into the next
         *  phase if the current one is exhausted. Stops auto-play at the very
         *  end (last RAPTOR route-check) rather than looping — a search has a
         *  natural beginning and end, looping would be confusing to watch. */
        advanceStep(state) {
            if (!state.hasData) return;
            const len = phaseLength(state.phase, state, state.bfsCandidateMode);
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
            if (!state.hasData) return;
            if (state.stepIndex > 0) { state.stepIndex -= 1; return; }
            const prevPhaseIdx = PHASE_ORDER.indexOf(state.phase) - 1;
            if (prevPhaseIdx >= 0) {
                state.phase = PHASE_ORDER[prevPhaseIdx];
                state.stepIndex = phaseLength(state.phase, state, state.bfsCandidateMode) - 1;
            }
        },
        /** Jump straight to a phase (e.g. tapping a phase label), landing on
         *  that phase's first step. */
        setPhase(state, action: PayloadAction<DebugPhase>) {
            if (!state.hasData) return;
            state.phase = action.payload;
            state.stepIndex = 0;
            state.playing = false;
        },
        /** Switches how bfs candidates are shown — see BfsCandidateMode doc
         *  comment. stepIndex means something different in each mode
         *  (round vs candidate index), so it's reset to 0 on switch rather
         *  than kept, since carrying it over would just land on an
         *  unrelated step in the new mode. */
        setBfsCandidateMode(state, action: PayloadAction<BfsCandidateMode>) {
            state.bfsCandidateMode = action.payload;
            if (state.phase === 'bfs') {
                state.stepIndex = 0;
                state.playing = false;
            }
        },
        /** Toggles hop-colored rendering — see hopColorMode doc comment.
         *  Deliberately does NOT touch stepIndex/phase/playing: unlike
         *  setBfsCandidateMode, this doesn't change what stepIndex means,
         *  just how the currently-visible candidates are colored. */
        toggleHopColorMode(state) {
            state.hopColorMode = !state.hopColorMode;
        },
        resetToStart(state) {
            state.phase = 'bfs';
            state.stepIndex = 0;
            state.playing = false;
        },
    },
});

export const {
    toggleDebugEnabled, setDebugData, setPlaying, advanceStep, retreatStep, setPhase, setBfsCandidateMode,
    toggleHopColorMode, resetToStart,
} = slice.actions;
export default slice.reducer;
