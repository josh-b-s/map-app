/**
 * preferencesStore.ts — on-disk persistence for user-editable app
 * preferences (theme mode, the walking-speed presets Search.tsx's pill
 * cycles through). Same one-JSON-file approach as gtfsDbRegistry.ts, for
 * the same reason: a handful of values, no need for a real table.
 *
 * store/preferences.slice.ts owns the in-memory/redux side and calls into
 * this file to load at startup and persist on every change; nothing else
 * should read/write PREFS_PATH directly.
 */

import * as FileSystem from 'expo-file-system/legacy';

export type ThemeMode = 'system' | 'light' | 'dark';

export type WalkingSpeedOption = {
    id: string;
    label: string;
    /** Meters/second. */
    mps: number;
};

export type StoredPreferences = {
    themeMode: ThemeMode;
    walkingSpeeds: WalkingSpeedOption[];
};

export const DEFAULT_THEME_MODE: ThemeMode = 'system';

// Same three tiers Search.tsx's WALK_SPEED_CYCLE used to hardcode.
export const DEFAULT_WALKING_SPEEDS: WalkingSpeedOption[] = [
    { id: 'slow', label: 'Slow', mps: 0.8 },
    { id: 'normal', label: 'Normal', mps: 1.4 },
    { id: 'fast', label: 'Fast', mps: 1.8 },
];

const PREFS_PATH = `${FileSystem.documentDirectory}preferences.json`;

export async function loadStoredPreferences(): Promise<StoredPreferences> {
    try {
        const raw = await FileSystem.readAsStringAsync(PREFS_PATH);
        const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
        return {
            themeMode: parsed.themeMode ?? DEFAULT_THEME_MODE,
            walkingSpeeds: parsed.walkingSpeeds?.length ? parsed.walkingSpeeds : DEFAULT_WALKING_SPEEDS,
        };
    } catch {
        // No file yet (fresh install) — defaults, not an error.
        return { themeMode: DEFAULT_THEME_MODE, walkingSpeeds: DEFAULT_WALKING_SPEEDS };
    }
}

export async function saveStoredPreferences(prefs: StoredPreferences): Promise<void> {
    await FileSystem.writeAsStringAsync(PREFS_PATH, JSON.stringify(prefs, null, 2));
}
