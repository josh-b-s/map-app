import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { colorScheme as nativewindColorScheme } from 'nativewind';
import {
    DEFAULT_THEME_MODE,
    DEFAULT_WALKING_SPEEDS,
    loadStoredPreferences,
    saveStoredPreferences,
    type ThemeMode,
    type WalkingSpeedOption,
} from '@/services/preferences/preferencesStore';

export type { ThemeMode, WalkingSpeedOption };

type State = {
    themeMode: ThemeMode;
    walkingSpeeds: WalkingSpeedOption[];
    /** True once loadPreferences() has resolved — screens can use this to
     *  avoid flashing default values before the real ones load. */
    loaded: boolean;
};

const initialState: State = {
    themeMode: DEFAULT_THEME_MODE,
    walkingSpeeds: DEFAULT_WALKING_SPEEDS,
    loaded: false,
};

// Fire-and-forget persistence — every reducer below mutates state via Immer
// and then calls this with the plain resulting values. Not awaited: a
// preferences write failing shouldn't block the UI update that triggered it,
// only log so it's visible in dev.
function persist(state: State) {
    saveStoredPreferences({ themeMode: state.themeMode, walkingSpeeds: state.walkingSpeeds }).catch(err => {
        console.warn('[preferences] failed to persist:', err);
    });
}

/** Call once at app startup (see app/_layout.tsx) — loads the saved file
 *  and applies the saved theme mode to nativewind immediately. */
export const loadPreferences = createAsyncThunk('preferences/load', async () => {
    return loadStoredPreferences();
});

const slice = createSlice({
    name: 'preferences',
    initialState,
    reducers: {
        setThemeMode(state, action: PayloadAction<ThemeMode>) {
            state.themeMode = action.payload;
            nativewindColorScheme.set(action.payload);
            persist(state);
        },
        addWalkingSpeed(state, action: PayloadAction<WalkingSpeedOption>) {
            state.walkingSpeeds.push(action.payload);
            persist(state);
        },
        updateWalkingSpeed(state, action: PayloadAction<{ id: string; label?: string; mps?: number }>) {
            const option = state.walkingSpeeds.find(o => o.id === action.payload.id);
            if (!option) return;
            if (action.payload.label !== undefined) option.label = action.payload.label;
            if (action.payload.mps !== undefined) option.mps = action.payload.mps;
            persist(state);
        },
        removeWalkingSpeed(state, action: PayloadAction<string>) {
            // Always keep at least one preset — the pill needs something to show/cycle.
            if (state.walkingSpeeds.length <= 1) return;
            state.walkingSpeeds = state.walkingSpeeds.filter(o => o.id !== action.payload);
            persist(state);
        },
        resetPreferences(state) {
            state.themeMode = DEFAULT_THEME_MODE;
            state.walkingSpeeds = DEFAULT_WALKING_SPEEDS.map(o => ({ ...o }));
            nativewindColorScheme.set(DEFAULT_THEME_MODE);
            persist(state);
        },
    },
    extraReducers: (builder) => {
        builder.addCase(loadPreferences.fulfilled, (state, action) => {
            state.themeMode = action.payload.themeMode;
            state.walkingSpeeds = action.payload.walkingSpeeds;
            state.loaded = true;
            nativewindColorScheme.set(action.payload.themeMode);
        });
    },
});

export const {
    setThemeMode,
    addWalkingSpeed,
    updateWalkingSpeed,
    removeWalkingSpeed,
    resetPreferences,
} = slice.actions;
export default slice.reducer;
