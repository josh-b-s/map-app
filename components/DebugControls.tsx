import React, { useEffect } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '@/store/store';
import { advanceStep, CORRIDOR_CHUNK_COUNT, DebugPhase, retreatStep, setPlaying, toggleDebugEnabled } from '@/store/debug.slice';
import { SHADOW, useThemeStyle } from '@/constants/themes';

const PHASE_LABELS: Record<DebugPhase, string> = {
    bfs:      'BFS exploring',
    seed:     'Seed paths',
    corridor: 'Corridor',
    raptor:   'RAPTOR',
};

const STEP_INTERVAL_MS = 300;

/**
 * Debug-mode toggle + phased-replay transport controls (prev/play/next),
 * floated bottom-left (mirrors LocationButton's bottom-right placement).
 * The transport row only appears once debug mode is on AND a debug-mode
 * search has actually produced data.
 *
 * TODO once a settings screen exists: move the enabled toggle there and
 * keep only the transport controls floating, per the original ask ("turn
 * off-able in settings later").
 */
export default function DebugControls() {
    const dispatch = useDispatch<AppDispatch>();
    const theme = useThemeStyle();
    const { enabled, data, phase, stepIndex, playing } = useSelector((s: RootState) => s.debug);

    // Auto-advance timer — lives here (not in the slice) since Redux
    // reducers must stay synchronous; this just dispatches advanceStep on an
    // interval while playing=true. advanceStep itself sets playing=false
    // when it runs out of steps, which naturally clears this effect's
    // interval on the next render.
    useEffect(() => {
        if (!playing) return;
        const id = setInterval(() => dispatch(advanceStep()), STEP_INTERVAL_MS);
        return () => clearInterval(id);
    }, [playing, dispatch]);

    const hasData = !!data;
    const stepLabel = phase === 'bfs' ? `Level ${stepIndex}/${Math.max(0, (data?.bfsLevels.length ?? 1) - 1)}`
        : phase === 'raptor' ? `Round ${stepIndex}/${Math.max(0, (data?.roundMarkedStops.length ?? 1) - 1)}`
        : phase === 'corridor' ? `Chunk ${stepIndex + 1}/${CORRIDOR_CHUNK_COUNT}`
        : PHASE_LABELS[phase];

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
                    </View>
                </View>
            )}
        </View>
    );
}
