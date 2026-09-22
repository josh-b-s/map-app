import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeStyle } from '@/constants/themes';
import { pickGtfsZip, importZipAsNewDatabase } from '@/services/gtfs/import/gtfsDbImport';
import {
    getActiveDatabaseId,
    listDatabases,
    setActiveDatabase,
    type GtfsDatabaseEntry,
} from '@/services/gtfs/import/gtfsDbRegistry';

type ImportState = { busy: false } | { busy: true; status: string };

/**
 * GTFS feed management — a list of imported databases (one per zip the user
 * has added) with the active one checked, plus an "Add zip" action that
 * picks a file, imports it via the native Rust importer, and adds it to the
 * list. Only one database can be active/selected at a time for now.
 */
export default function GtfsData() {
    const theme = useThemeStyle();
    const [databases, setDatabases] = useState<GtfsDatabaseEntry[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [importState, setImportState] = useState<ImportState>({ busy: false });
    const [switchingId, setSwitchingId] = useState<string | null>(null);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        const [dbs, active] = await Promise.all([listDatabases(), getActiveDatabaseId()]);
        setDatabases(dbs);
        setActiveId(active);
        setLoaded(true);
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function handleAddZip() {
        setError('');
        try {
            const zip = await pickGtfsZip();
            if (!zip) return; // user cancelled the picker — not an error

            setImportState({ busy: true, status: `Importing ${zip.name}…` });
            const t0 = Date.now();
            await importZipAsNewDatabase(zip, (p) => {
                const secs = ((Date.now() - t0) / 1000).toFixed(1);
                setImportState({ busy: true, status: `${p.table}: ${p.inserted}/${p.total} (${secs}s)` });
            });
            await refresh();
        } catch (err) {
            setError(`Import failed: ${String(err)}`);
        } finally {
            setImportState({ busy: false });
        }
    }

    async function handleSelect(id: string) {
        if (id === activeId) return;
        setError('');
        setSwitchingId(id);
        try {
            await setActiveDatabase(id);
            setActiveId(id);
        } catch (err) {
            setError(`Couldn't switch database: ${String(err)}`);
        } finally {
            setSwitchingId(null);
        }
    }

    const busy = importState.busy || switchingId !== null;

    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.surfaceColor }} contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13 }}>
                Each imported feed becomes its own database — pick which one the app should route against.
            </Text>

            {loaded && databases.length === 0 && !importState.busy && (
                <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13, fontStyle: 'italic' }}>
                    No feeds imported yet — add one below.
                </Text>
            )}

            {databases.map((db) => {
                const isActive = db.id === activeId;
                const isSwitching = switchingId === db.id;
                return (
                    <Pressable
                        key={db.id}
                        disabled={busy}
                        onPress={() => handleSelect(db.id)}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 14,
                            padding: 16,
                            borderRadius: 16,
                            backgroundColor: theme.backgroundColor,
                            opacity: busy && !isSwitching ? 0.5 : 1,
                            borderWidth: isActive ? 2 : 0,
                            borderColor: '#2563eb',
                        }}
                    >
                        <View
                            style={{
                                width: 40, height: 40, borderRadius: 12,
                                backgroundColor: '#2563eb22',
                                alignItems: 'center', justifyContent: 'center',
                            }}
                        >
                            {isSwitching ? (
                                <ActivityIndicator size="small" color="#2563eb" />
                            ) : (
                                <Ionicons name="bus-outline" size={20} color="#2563eb" />
                            )}
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text style={{ color: theme.color, fontSize: 16, fontWeight: '600' }}>{db.name}</Text>
                            <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13, marginTop: 2 }}>
                                Imported {new Date(db.importedAt).toLocaleDateString()}
                            </Text>
                        </View>
                        {isActive && <Ionicons name="checkmark-circle" size={22} color="#2563eb" />}
                    </Pressable>
                );
            })}

            <Pressable
                disabled={busy}
                onPress={handleAddZip}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: 16,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: theme.color + '55',
                    opacity: busy ? 0.5 : 1,
                }}
            >
                <Ionicons name="add-circle-outline" size={20} color={theme.color} />
                <Text style={{ color: theme.color, fontSize: 15, fontWeight: '600' }}>Add zip</Text>
            </Pressable>

            {importState.busy && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
                    <ActivityIndicator size="small" color={theme.color} />
                    <Text style={{ color: theme.color, fontSize: 13, flex: 1 }}>{importState.status}</Text>
                </View>
            )}

            {!!error && (
                <View style={{ padding: 12, borderRadius: 12, backgroundColor: theme.backgroundColor }}>
                    <Text style={{ color: '#ef4444', fontSize: 12 }}>{error}</Text>
                </View>
            )}
        </ScrollView>
    );
}
