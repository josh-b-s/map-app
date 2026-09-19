// debugDataStore.ts
//
// Holds the (large) GtfsDebugInfo OUTSIDE Redux. A debug-mode search
// produces thousands of coordinates; when that lived in `state.debug.data`
// every dispatch paid for it: RTK's serializable/immutable-check
// middleware deep-walked it (24s in the logs), Immer proxied/froze it, and
// the advanceStep reducer re-ran flattenBfsCandidates against an Immer
// draft of it 30x/sec during playback. Redux now only holds a small
// `meta` (counts + a version number); the data itself lives here and
// components read it through useDebugData(), which re-renders them when
// the version bumps.

import { useSelector } from 'react-redux';
import type { RootState } from '@/store/store';
import type { GtfsDebugInfo } from '@/services/gtfs/router/raptorRouter';
import { flattenBfsCandidates, raptorStepCount } from './debugBfsPoints';
import type { BfsCandidateStep } from './debugBfsPoints';

export type DebugMeta = {
    version: number;
    bfsRoundCount: number;
    bfsCandidateCount: number;
    raptorStepCount: number;
};

let current: GtfsDebugInfo | null = null;
let candidateSteps: BfsCandidateStep[] = [];
let version = 0;

/** Stores the data and computes everything derived from it ONCE. Returns
 *  the small serializable meta to put in Redux (null clears). */
export function publishDebugData(info: GtfsDebugInfo | null | undefined): DebugMeta | null {
    version += 1;
    if (!info) {
        current = null;
        candidateSteps = [];
        return null;
    }
    current = info;
    candidateSteps = flattenBfsCandidates(info.seedPaths, info.bfsLevels, info.seedPathDepths);
    return {
        version,
        bfsRoundCount: info.bfsLevels?.length ?? 0,
        bfsCandidateCount: candidateSteps.length,
        raptorStepCount: raptorStepCount(info),
    };
}

export function getBfsCandidateSteps(): BfsCandidateStep[] {
    return candidateSteps;
}

/** Subscribes to the version in Redux, returns the module-level data. The
 *  returned object is identity-stable until the next publishDebugData, so
 *  it's safe as a useMemo dependency. */
export function useDebugData(): GtfsDebugInfo | null {
    useSelector((s: RootState) => s.debug.dataVersion);
    return current;
}

export function useBfsCandidateSteps(): BfsCandidateStep[] {
    useSelector((s: RootState) => s.debug.dataVersion);
    return candidateSteps;
}
