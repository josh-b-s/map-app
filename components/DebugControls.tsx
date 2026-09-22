import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '@/store/store';
import { advanceStep, BFS_STEP_INTERVAL_MS, DebugPhase, retreatStep, setBfsCandidateMode, setPlaying, toggleDebugEnabled, toggleHopColorMode } from '@/store/debug.slice';
import { SHADOW, useThemeStyle } from '@/constants/themes';
import {compareRouters} from "@/services/gtfs/router/routeCompare";

// TEMPORARY hardcoded test pair for the "Compare routers" button below —
// Flinders St Station -> Melbourne Central. Swap for whatever
// location.slice/search.slice actually stores once you point me at it;
// this is just so you can A/B test right now without wiring real search
// state into the debug panel.
const TEST_ORIGIN = {latitude: -37.8183, longitude: 144.9671};
const TEST_DESTINATION = {latitude: -37.8103, longitude: 144.9628};

// Only 2 phases now — corridor-finding (bfs, which subsumes what used to
// be separate seed/corridor phases; see DebugMapOverlay.tsx) and raptor
// (individual candidate-route checks, not rounds). If DebugPhase in
// debug.slice.ts still lists 'seed'/'corridor', that's the other half of
// this change — trim it to 'bfs' | 'raptor' there too.
const PHASE_LABELS: Record<DebugPhase, string> = {
    bfs:    'Finding corridor',
    raptor: 'RAPTOR',
};

// Step interval for the 'raptor' phase's route-check reveals — these are
// discrete "here's the next candidate route" pops, not a smooth animation,
// so a slower human-watchable pace reads better than a fast blur.
// 'bfs' uses BFS_STEP_INTERVAL_MS instead (rounds still auto-advance
// faster since there are usually far fewer of them than the old
// per-point reveal had, but a round is a bigger visual jump than a single
// point was, so keep it on the same faster interval rather than the slow
// one — tune to taste once you see it running).
const STEP_INTERVAL_MS = 300;

/**
 * Debug-mode toggle + phased-replay transport controls (prev/play/next),
 * floated bottom-left (mirrors LocationButton's bottom-right placement).
 * The transport row only appears once debug mode is on AND a debug-mode
 * search has actually produced data.
 *
 * Two phases: 'bfs' steps one round at a time (hull + cumulative candidate
 * routes found so far), 'raptor' steps one individual candidate-route
 * check at a time (not accumulated) — see DebugMapOverlay.tsx.
 *
 * TODO once a settings screen exists: move the enabled toggle there and
 * keep only the transport controls floating, per the original ask ("turn
 * off-able in settings later").
 */
export default function DebugControls() {
    const dispatch = useDispatch<AppDispatch>();
    const theme = useThemeStyle();
    const { enabled, hasData, phase, stepIndex, playing, bfsCandidateMode, hopColorMode, bfsRoundCount, bfsCandidateCount, raptorStepCount: raptorStepTotal } = useSelector((s: RootState) => s.debug);

    // GTFS import (prep folders / list incoming / benchmark / run import)
    // has moved to app/(tabs)/settings/gtfs.tsx as a proper screen — this
    // panel now only keeps the router A/B compare tool, which doesn't fit
    // that settings screen.
    const [compareBusy, setCompareBusy] = useState(false);
    const [compareStatus, setCompareStatus] = useState<string>('');

    async function handleCompareRouters() {
        setCompareBusy(true);
        setCompareStatus('Comparing TS vs Rust routers…');
        try {
            const {tsMs, rustMs, tsResult, rustResult} = await compareRouters(TEST_ORIGIN, TEST_DESTINATION);
            const speedup = (tsMs / rustMs).toFixed(2);
            setCompareStatus(
                `TS: ${tsMs.toFixed(0)}ms (${tsResult.journeys.length}j) | ` +
                `Rust: ${rustMs.toFixed(0)}ms (${rustResult.journeys.length}j) | ` +
                `${speedup}x. Full detail in console.`
            );
        } catch (err) {
            setCompareStatus(`Compare failed: ${String(err)}`);
        } finally {
            setCompareBusy(false);
        }
    }

    // Total steps for the CURRENT phase — this is the one thing that
    // genuinely differs per phase (and, for bfs, per candidate mode) now:
    // 'bfs' + cumulative steps are rounds (bfsLevels.length); 'bfs' +
    // single steps are individual candidates (flattenBfsCandidates length);
    // 'raptor' steps are individual route-checks flattened across all
    // rounds (raptorStepCount), NOT round count. See debugBfsPoints.ts's
    // flatten helpers — shared with debug.slice.ts and DebugMapOverlay.tsx
    // so all three agree on what a "step" means without duplicated logic
    // drifting out of sync. hopColorMode doesn't affect any of this — it's
    // a coloring toggle, not a stepping mode; see debug.slice.ts.

    // Auto-advance timer — lives here (not in the slice) since Redux
    // reducers must stay synchronous; this just dispatches advanceStep on an
    // interval while playing=true. advanceStep itself sets playing=false
    // when it runs out of steps, which naturally clears this effect's
    // interval on the next render. advanceStep needs to know which of the
    // totals above applies for the current phase/mode to know when to stop
    // — see debug.slice.ts's phaseLength.
    useEffect(() => {
        if (!playing) return;
        const intervalMs = phase === 'bfs' ? BFS_STEP_INTERVAL_MS : STEP_INTERVAL_MS;
        const id = setInterval(() => dispatch(advanceStep()), intervalMs);
        return () => clearInterval(id);
    }, [playing, dispatch, phase]);

    const stepLabel = phase === 'bfs'
        ? (bfsCandidateMode === 'single'
            ? `Candidate ${stepIndex + 1}/${Math.max(1, bfsCandidateCount)}`
            : `Round ${stepIndex + 1}/${Math.max(1, bfsRoundCount)}`)
        : `Route ${stepIndex + 1}/${Math.max(1, raptorStepTotal)}`;

    return (
        <View className="absolute bottom-5 left-5" style={{ gap: 8 }}>
            <TouchableOpacity
                className="w-16 h-16 rounded-full items-center justify-center"
                style={[{ backgroundColor: enabled ? '#2563eb' : theme.backgroundColor }, SHADOW]}
                onPress={() => dispatch(toggleDebugEnabled())}
            >
                <Ionicons name="bug" size={26} color={enabled ? '#fff' : theme.color} />
            </TouchableOpacity>

            {enabled && hasData && (
                <View
                    className="rounded-2xl px-3 py-2"
                    style={[{ backgroundColor: theme.backgroundColor }, SHADOW]}
                >
                    <Text style={{ color: theme.color, opacity: 0.6, fontSize: 11, fontWeight: '600', marginBottom: 2 }}>
                        {PHASE_LABELS[phase]}
                    </Text>
                    <View className="flex-row items-center" style={{ gap: 4 }}>
                        <TouchableOpacity className="p-1.5" onPress={() => dispatch(retreatStep())}>
                            <Ionicons name="play-back" size={16} color={theme.color} />
                        </TouchableOpacity>
                        <TouchableOpacity className="p-1.5" onPress={() => dispatch(setPlaying(!playing))}>
                            <Ionicons name={playing ? 'pause' : 'play'} size={18} color={theme.color} />
                        </TouchableOpacity>
                        <TouchableOpacity className="p-1.5" onPress={() => dispatch(advanceStep())}>
                            <Ionicons name="play-forward" size={16} color={theme.color} />
                        </TouchableOpacity>
                        <Text style={{ color: theme.color, fontSize: 12, fontWeight: '600', minWidth: 70, textAlign: 'center' }}>
                            {stepLabel}
                        </Text>
                        {/* Only meaningful during bfs — toggles whether
                            candidates show all-at-once (cumulative, the
                            default) or one-at-a-time (single), same as
                            raptor's route-checks already do. Icons: a
                            layered/stack icon for cumulative, a single
                            git-branch-style icon for "one at a time" —
                            swap for whatever icon set fits your taste. */}
                        {phase === 'bfs' && (
                            <TouchableOpacity
                                className="p-1.5"
                                onPress={() => dispatch(setBfsCandidateMode(bfsCandidateMode === 'single' ? 'cumulative' : 'single'))}
                            >
                                <Ionicons
                                    name={bfsCandidateMode === 'single' ? 'layers-outline' : 'layers'}
                                    size={16}
                                    color={theme.color}
                                />
                            </TouchableOpacity>
                        )}
                        {/* Separate toggle from the one above — this one
                            controls HOW a visible candidate's shape is
                            colored (per-hop palette vs flat amber/depth
                            color), not WHICH candidates are visible. Shows
                            every hop of whichever candidate(s)
                            bfsCandidateMode/stepIndex currently has visible
                            — see DebugMapOverlay.tsx and debug.slice.ts's
                            hopColorMode doc comment. */}
                        {phase === 'bfs' && (
                            <TouchableOpacity
                                className="p-1.5"
                                onPress={() => dispatch(toggleHopColorMode())}
                            >
                                <Ionicons
                                    name={hopColorMode ? 'color-palette' : 'color-palette-outline'}
                                    size={16}
                                    color={theme.color}
                                />
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            )}

            {enabled && (
                <View
                    className="rounded-2xl px-3 py-2"
                    style={[{ backgroundColor: theme.backgroundColor }, SHADOW]}
                >
                    <Text style={{ color: theme.color, opacity: 0.6, fontSize: 11, fontWeight: '600', marginBottom: 4 }}>
                        Router compare
                    </Text>
                    <View className="flex-row items-center" style={{ gap: 4 }}>
                        <TouchableOpacity
                            className="p-1.5"
                            disabled={compareBusy}
                            onPress={handleCompareRouters}
                        >
                            <Ionicons name="git-compare-outline" size={18} color={theme.color} />
                        </TouchableOpacity>
                        {compareBusy && (
                            <Text style={{ color: theme.color, fontSize: 11 }}>comparing…</Text>
                        )}
                    </View>
                    {!!compareStatus && (
                        <Text style={{ color: theme.color, opacity: 0.7, fontSize: 10, marginTop: 4, maxWidth: 220 }}>
                            {compareStatus}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
