import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeStyle } from '@/constants/themes';
import { pickGtfsZip, importZipAsNewDatabase } from '@/services/gtfs/import/gtfsDbImport';
import {
    deleteDatabase,
    DuplicateNameError,
    getActiveDatabaseId,
    listDatabases,
    renameDatabase,
    setActiveDatabase,
    type GtfsDatabaseEntry,
} from '@/services/gtfs/import/gtfsDbRegistry';

type ImportState = { busy: false } | { busy: true; status: string };

/**
 * GTFS feed management — a list of imported databases (one per zip the user
 * has added) with the active one checked, plus an "Add zip" action that
 * picks a file, imports it via the native Rust importer, and adds it to the
 * list. Only one database can be active/selected at a time for now.
 *
 * Each row can also be renamed (pencil, inline text field) or deleted
 * (trash, with confirmation). Import-time name collisions are silently
 * disambiguated file-system style ("Melbourne", "Melbourne (1)", ...) by
 * gtfsDbRegistry.ts's registerDatabase() — renaming, in contrast, rejects
 * an exact collision outright (see handleSaveRename below) so the user
 * gets a chance to pick a different name rather than have one picked for
 * them mid-edit.
 */
export default function GtfsData() {
    const theme = useThemeStyle();
    const [databases, setDatabases] = useState<GtfsDatabaseEntry[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [importState, setImportState] = useState<ImportState>({ busy: false });
    const [switchingId, setSwitchingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [error, setError] = useState('');

    // Inline rename state — editingId names which row currently shows a
    // TextInput instead of static text, mirroring preferences.tsx's
    // walking-speed edit pattern.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftName, setDraftName] = useState('');

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

    function startRename(db: GtfsDatabaseEntry) {
        setError('');
        setEditingId(db.id);
        setDraftName(db.name);
    }

    function cancelRename() {
        setEditingId(null);
    }

    async function handleSaveRename() {
        if (!editingId) return;
        const trimmed = draftName.trim();
        if (!trimmed) {
            Alert.alert('Name required', 'Give the feed a name.');
            return;
        }
        try {
            await renameDatabase(editingId, trimmed);
            setEditingId(null);
            await refresh();
        } catch (err) {
            if (err instanceof DuplicateNameError) {
                Alert.alert('Name already exists', err.message);
            } else {
                Alert.alert('Rename failed', String(err));
            }
        }
    }

    function handleDelete(db: GtfsDatabaseEntry) {
        Alert.alert(
            'Delete feed?',
            db.id === activeId
                ? `"${db.name}" is currently selected. Deleting it will switch to another imported feed, if any.`
                : `This removes "${db.name}" and its imported data. This can't be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setError('');
                        setDeletingId(db.id);
                        try {
                            await deleteDatabase(db.id);
                            await refresh();
                        } catch (err) {
                            setError(`Delete failed: ${String(err)}`);
                        } finally {
                            setDeletingId(null);
                        }
                    },
                },
            ],
        );
    }

    const busy = importState.busy || switchingId !== null || deletingId !== null;

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
                const isDeleting = deletingId === db.id;
                const isEditing = editingId === db.id;
                const rowBusy = busy && !isSwitching && !isDeleting;

                return (
                    <View
                        key={db.id}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 14,
                            padding: 16,
                            borderRadius: 16,
                            backgroundColor: theme.backgroundColor,
                            opacity: rowBusy ? 0.5 : 1,
                            borderWidth: isActive ? 2 : 0,
                            borderColor: '#2563eb',
                        }}
                    >
                        <Pressable
                            onPress={() => handleSelect(db.id)}
                            disabled={busy || isEditing}
                            style={{
                                width: 40, height: 40, borderRadius: 12,
                                backgroundColor: '#2563eb22',
                                alignItems: 'center', justifyContent: 'center',
                            }}
                        >
                            {isSwitching || isDeleting ? (
                                <ActivityIndicator size="small" color="#2563eb" />
                            ) : (
                                <Ionicons name="bus-outline" size={20} color="#2563eb" />
                            )}
                        </Pressable>

                        {isEditing ? (
                            <>
                                <TextInput
                                    value={draftName}
                                    onChangeText={setDraftName}
                                    autoFocus
                                    placeholder="Feed name"
                                    placeholderTextColor={theme.color + '66'}
                                    style={{
                                        flex: 1, color: theme.color, fontSize: 16, fontWeight: '600',
                                        borderBottomWidth: 1, borderBottomColor: theme.color + '33', paddingVertical: 2,
                                    }}
                                />
                                <Pressable onPress={handleSaveRename} hitSlop={8} style={{ padding: 4 }}>
                                    <Ionicons name="checkmark-circle" size={24} color="#22c55e" />
                                </Pressable>
                                <Pressable onPress={cancelRename} hitSlop={8} style={{ padding: 4 }}>
                                    <Ionicons name="close-circle" size={24} color={theme.color} style={{ opacity: 0.4 }} />
                                </Pressable>
                            </>
                        ) : (
                            <>
                                <Pressable
                                    onPress={() => handleSelect(db.id)}
                                    disabled={busy}
                                    style={{ flex: 1 }}
                                >
                                    <Text style={{ color: theme.color, fontSize: 16, fontWeight: '600' }}>{db.name}</Text>
                                    <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13, marginTop: 2 }}>
                                        Imported {new Date(db.importedAt).toLocaleDateString()}
                                    </Text>
                                </Pressable>
                                {isActive && <Ionicons name="checkmark-circle" size={20} color="#2563eb" />}
                                <Pressable
                                    onPress={() => startRename(db)}
                                    disabled={busy}
                                    hitSlop={8}
                                    style={{ padding: 4 }}
                                >
                                    <Ionicons name="pencil-outline" size={18} color={theme.color} style={{ opacity: 0.6 }} />
                                </Pressable>
                                <Pressable
                                    onPress={() => handleDelete(db)}
                                    disabled={busy}
                                    hitSlop={8}
                                    style={{ padding: 4 }}
                                >
                                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                                </Pressable>
                            </>
                        )}
                    </View>
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
