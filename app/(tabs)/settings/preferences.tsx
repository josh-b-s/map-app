import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { nanoid } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '@/store/store';
import { useThemeStyle } from '@/constants/themes';
import {
    addWalkingSpeed,
    removeWalkingSpeed,
    resetPreferences,
    setThemeMode,
    updateWalkingSpeed,
    type ThemeMode,
} from '@/store/preferences.slice';

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { mode: 'system', label: 'System', icon: 'phone-portrait-outline' },
    { mode: 'light', label: 'Light', icon: 'sunny-outline' },
    { mode: 'dark', label: 'Dark', icon: 'moon-outline' },
];

function SectionLabel({ text, theme }: { text: string; theme: ReturnType<typeof useThemeStyle> }) {
    return (
        <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13, fontWeight: '600', marginBottom: 4, marginTop: 4 }}>
            {text}
        </Text>
    );
}

export default function Preferences() {
    const theme = useThemeStyle();
    const dispatch = useDispatch<AppDispatch>();
    const themeMode = useSelector((s: RootState) => s.preferences.themeMode);
    const walkingSpeeds = useSelector((s: RootState) => s.preferences.walkingSpeeds);

    // Inline-edit state for the walking speed list — editingId names which
    // row is currently showing text inputs instead of static text; the two
    // drafts hold that row's in-progress values until Save is pressed.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftLabel, setDraftLabel] = useState('');
    const [draftMps, setDraftMps] = useState('');

    function startEditing(id: string, label: string, mps: number) {
        setEditingId(id);
        setDraftLabel(label);
        setDraftMps(String(mps));
    }

    function cancelEditing() {
        setEditingId(null);
    }

    function saveEditing() {
        if (!editingId) return;
        const mps = parseFloat(draftMps);
        const label = draftLabel.trim();
        if (!label || !Number.isFinite(mps) || mps <= 0) {
            Alert.alert('Invalid speed', 'Give it a name and a speed greater than 0.');
            return;
        }
        dispatch(updateWalkingSpeed({ id: editingId, label, mps }));
        setEditingId(null);
    }

    function handleAddSpeed() {
        const id = nanoid();
        dispatch(addWalkingSpeed({ id, label: 'New speed', mps: 1.2 }));
        // Drop straight into edit mode so the user names/sets it right away
        // instead of leaving a placeholder "New speed" row sitting there.
        startEditing(id, 'New speed', 1.2);
    }

    function handleRemoveSpeed(id: string) {
        if (walkingSpeeds.length <= 1) {
            Alert.alert("Can't remove", 'Keep at least one walking speed.');
            return;
        }
        Alert.alert('Remove speed?', 'This preset will be removed from the list.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Remove', style: 'destructive', onPress: () => dispatch(removeWalkingSpeed(id)) },
        ]);
    }

    function handleReset() {
        Alert.alert(
            'Reset to defaults?',
            'Theme and walking speeds will be reset to their default values.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Reset', style: 'destructive', onPress: () => { setEditingId(null); dispatch(resetPreferences()); } },
            ],
        );
    }

    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.surfaceColor }} contentContainerStyle={{ padding: 16, gap: 8 }}>
            <SectionLabel text="Theme" theme={theme} />
            <View
                className="flex-row rounded-2xl overflow-hidden"
                style={{ backgroundColor: theme.backgroundColor }}
            >
                {THEME_OPTIONS.map((opt) => {
                    const active = opt.mode === themeMode;
                    return (
                        <Pressable
                            key={opt.mode}
                            onPress={() => dispatch(setThemeMode(opt.mode))}
                            style={{
                                flex: 1,
                                alignItems: 'center',
                                justifyContent: 'center',
                                paddingVertical: 14,
                                gap: 4,
                                backgroundColor: active ? '#2563eb' : 'transparent',
                            }}
                        >
                            <Ionicons name={opt.icon} size={18} color={active ? '#fff' : theme.color} />
                            <Text style={{ color: active ? '#fff' : theme.color, fontSize: 12, fontWeight: '600' }}>
                                {opt.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>

            <SectionLabel text="Walking speeds" theme={theme} />
            <Text style={{ color: theme.color, opacity: 0.5, fontSize: 12, marginBottom: 4 }}>
                These are the presets the walking-speed pill on the search bar cycles through.
            </Text>

            {walkingSpeeds.map((option) => {
                const isEditing = editingId === option.id;
                return (
                    <View
                        key={option.id}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            padding: 14,
                            borderRadius: 16,
                            backgroundColor: theme.backgroundColor,
                        }}
                    >
                        <View
                            style={{
                                width: 36, height: 36, borderRadius: 10,
                                backgroundColor: '#2563eb22',
                                alignItems: 'center', justifyContent: 'center',
                            }}
                        >
                            <Ionicons name="walk-outline" size={18} color="#2563eb" />
                        </View>

                        {isEditing ? (
                            <>
                                <View style={{ flex: 1, gap: 6 }}>
                                    <TextInput
                                        value={draftLabel}
                                        onChangeText={setDraftLabel}
                                        placeholder="Name"
                                        placeholderTextColor={theme.color + '66'}
                                        style={{
                                            color: theme.color, fontSize: 15, fontWeight: '600',
                                            borderBottomWidth: 1, borderBottomColor: theme.color + '33', paddingVertical: 2,
                                        }}
                                    />
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <TextInput
                                            value={draftMps}
                                            onChangeText={setDraftMps}
                                            placeholder="1.4"
                                            placeholderTextColor={theme.color + '66'}
                                            keyboardType="decimal-pad"
                                            style={{
                                                color: theme.color, fontSize: 13, opacity: 0.8, width: 64,
                                                borderBottomWidth: 1, borderBottomColor: theme.color + '33', paddingVertical: 2,
                                            }}
                                        />
                                        <Text style={{ color: theme.color, opacity: 0.5, fontSize: 12 }}>m/s</Text>
                                    </View>
                                </View>
                                <Pressable onPress={saveEditing} hitSlop={8} style={{ padding: 4 }}>
                                    <Ionicons name="checkmark-circle" size={24} color="#22c55e" />
                                </Pressable>
                                <Pressable onPress={cancelEditing} hitSlop={8} style={{ padding: 4 }}>
                                    <Ionicons name="close-circle" size={24} color={theme.color} style={{ opacity: 0.4 }} />
                                </Pressable>
                            </>
                        ) : (
                            <>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ color: theme.color, fontSize: 15, fontWeight: '600' }}>{option.label}</Text>
                                    <Text style={{ color: theme.color, opacity: 0.5, fontSize: 12, marginTop: 1 }}>
                                        {option.mps.toFixed(1)} m/s
                                    </Text>
                                </View>
                                <Pressable
                                    onPress={() => startEditing(option.id, option.label, option.mps)}
                                    hitSlop={8}
                                    style={{ padding: 4 }}
                                >
                                    <Ionicons name="pencil-outline" size={18} color={theme.color} style={{ opacity: 0.6 }} />
                                </Pressable>
                                <Pressable
                                    onPress={() => handleRemoveSpeed(option.id)}
                                    hitSlop={8}
                                    style={{ padding: 4, opacity: walkingSpeeds.length <= 1 ? 0.3 : 1 }}
                                >
                                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                                </Pressable>
                            </>
                        )}
                    </View>
                );
            })}

            <Pressable
                onPress={handleAddSpeed}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: 14,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: theme.color + '55',
                }}
            >
                <Ionicons name="add-circle-outline" size={18} color={theme.color} />
                <Text style={{ color: theme.color, fontSize: 14, fontWeight: '600' }}>Add speed</Text>
            </Pressable>

            <SectionLabel text="Reset" theme={theme} />
            <Pressable
                onPress={handleReset}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: 14,
                    borderRadius: 16,
                    backgroundColor: theme.backgroundColor,
                }}
            >
                <Ionicons name="refresh-outline" size={18} color="#ef4444" />
                <Text style={{ color: '#ef4444', fontSize: 14, fontWeight: '600' }}>Reset settings to default</Text>
            </Pressable>
        </ScrollView>
    );
}
