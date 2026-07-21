import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '@/store/store';
import { advanceStep, BFS_REVEAL_STEPS, CORRIDOR_CHUNK_COUNT, DebugPhase, retreatStep, setPlaying, toggleDebugEnabled } from '@/store/debug.slice';
import { SHADOW, useThemeStyle } from '@/constants/themes';
import * as FileSystem from 'expo-file-system/legacy';
import { getOrCreateDbForImport } from '@/services/gtfsDb';
import { ensureImportFolders, INCOMING_DIR } from '@/services/gtfsImporter';
import { runRustImport } from '@/services/rustGtfsImporter';
import { runInsertBenchmark } from '@/services/gtfsInsertBenchmark';

const PHASE_LABELS: Record<DebugPhase, string> = {
    bfs:      'BFS exploring',
    seed:     'Seed paths',
    corridor: 'Corridor',
    raptor:   'RAPTOR',
};

const STEP_INTERVAL_MS = 300;

// A rough guess is fine here — only used to label the benchmark's
// extrapolated estimate. Update to match your actual feed's real
// stop_times count (see preprocess-gtfs.ts's own console output) once you
// have a current number.
const APPROX_REAL_STOP_TIMES_ROWS = 11_860_000;

type ImportBusyState = 'idle' | 'preparing' | 'benchmarking' | 'importing';

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

    // Local (non-Redux) state for the GTFS import sub-panel — this is a
    // dev-only, one-shot tool, not app state anything else needs to react
    // to, so it doesn't belong in the debug slice.
    const [importBusy, setImportBusy] = useState<ImportBusyState>('idle');
    const [importStatus, setImportStatus] = useState<string>('');

    async function handleListIncoming() {
        setImportBusy('preparing');
        try {
            await ensureImportFolders();
            const entries = await FileSystem.readDirectoryAsync(INCOMING_DIR);
            if (entries.length === 0) {
                setImportStatus(`Dir exists but is empty:\n${INCOMING_DIR}`);
            } else {
                // Stat each entry too — this is what actually distinguishes
                // "file's there but unreadable" (getInfoAsync throws or
                // reports exists:false/size:0) from a genuine path miss,
                // which a bare directory listing can't tell you on its own.
                const details = await Promise.all(entries.map(async name => {
                    try {
                        const info = await FileSystem.getInfoAsync(`${INCOMING_DIR}${name}`);
                        return `${name} (${info.exists ? `${(info as any).size ?? '?'} bytes` : 'STAT FAILED'})`;
                    } catch (e) {
                        return `${name} (STAT THREW: ${String(e)})`;
                    }
                }));
                setImportStatus(`Found:\n${details.join('\n')}`);
            }
        } catch (err) {
            setImportStatus(`List failed: ${String(err)}`);
        } finally {
            setImportBusy('idle');
        }
    }

    async function handlePrepFolders() {
        setImportBusy('preparing');
        try {
            await ensureImportFolders();
            // Logging the real path is the point here — see this file's
            // header note on why you can't just drag a file into it.
            setImportStatus(`Ready. Copy the GTFS zip into:\n${INCOMING_DIR}`);
            console.log('[DebugControls] GTFS incoming dir:', INCOMING_DIR);
        } catch (err) {
            setImportStatus(`Prep failed: ${String(err)}`);
        } finally {
            setImportBusy('idle');
        }
    }

    async function handleRunBenchmark() {
        setImportBusy('benchmarking');
        setImportStatus('Running insert benchmark…');
        try {
            const db = await getOrCreateDbForImport();
            const result = await runInsertBenchmark(
                db,
                APPROX_REAL_STOP_TIMES_ROWS,
                undefined,
                line => setImportStatus(line),
            );
            const secs = (result.estimatedMsForRealRowCount / 1000).toFixed(1);
            setImportStatus(`Done. Estimated real import: ~${secs}s. Check console for per-stage detail.`);
        } catch (err) {
            setImportStatus(`Benchmark failed: ${String(err)}`);
        } finally {
            setImportBusy('idle');
        }
    }

    async function handleRunImport() {
        console.log('[DebugControls] import button pressed (native Rust import)');
        setImportBusy('importing');
        setImportStatus('Importing… this can take a while, watch the console.');
        const t0 = Date.now();
        try {
            // Native side (import.rs) logs its own per-table/per-agency
            // progress via the same callback — this handler only drives the
            // small live status line in the debug panel, same UX as the old
            // TS importLatestZip path, just fed from Rust's onProgress now.
            await runRustImport(p => {
                const secs = ((Date.now() - t0) / 1000).toFixed(1);
                setImportStatus(`${p.table}: ${p.inserted}/${p.total} (${secs}s elapsed)`);
            });
            setImportStatus(`Import complete in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
        } catch (err) {
            setImportStatus(`Import failed: ${String(err)}`);
        } finally {
            setImportBusy('idle');
        }
    }

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
    // "BFS exploring" no longer maps to a real level count — it's now a
    // fixed number of reveal-chunks over bfsTreeEdges in true discovery
    // order (see debug.slice.ts's BFS_REVEAL_STEPS), so the label shows
    // reveal progress rather than a level number.
    const stepLabel = phase === 'bfs' ? `Exploring ${stepIndex + 1}/${BFS_REVEAL_STEPS}`
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

            {enabled && (
                <View
                    className="rounded-2xl px-3 py-2"
                    style={[{ backgroundColor: theme.backgroundColor }, SHADOW]}
                >
                    <Text style={{ color: theme.color, opacity: 0.6, fontSize: 11, fontWeight: '600', marginBottom: 4 }}>
                        GTFS import
                    </Text>
                    <View className="flex-row items-center" style={{ gap: 4 }}>
                        <TouchableOpacity
                            className="p-1.5"
                            disabled={importBusy !== 'idle'}
                            onPress={handlePrepFolders}
                        >
                            <Ionicons name="folder-outline" size={18} color={theme.color} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            className="p-1.5"
                            disabled={importBusy !== 'idle'}
                            onPress={handleListIncoming}
                        >
                            <Ionicons name="search-outline" size={18} color={theme.color} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            className="p-1.5"
                            disabled={importBusy !== 'idle'}
                            onPress={handleRunBenchmark}
                        >
                            <Ionicons name="speedometer-outline" size={18} color={theme.color} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            className="p-1.5"
                            disabled={importBusy !== 'idle'}
                            onPress={handleRunImport}
                        >
                            <Ionicons name="download-outline" size={18} color={theme.color} />
                        </TouchableOpacity>
                        {importBusy !== 'idle' && (
                            <Text style={{ color: theme.color, fontSize: 11 }}>{importBusy}…</Text>
                        )}
                    </View>
                    {!!importStatus && (
                        <Text style={{ color: theme.color, opacity: 0.7, fontSize: 10, marginTop: 4, maxWidth: 220 }}>
                            {importStatus}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}