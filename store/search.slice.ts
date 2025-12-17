// src/store/search.slice.ts
import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { searchPlaces as searchPlacesService } from '@/app/assets/services';
import type { LatLng } from '@/app/assets/services';

export type SearchPlace = {
    place_id: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
};

export const searchPlaces = createAsyncThunk<
    SearchPlace[],
    { query: string; location?: LatLng; apiKey: string },
    { rejectValue: string }
>('search/searchPlaces', async (payload, { rejectWithValue }) => {
    try {
        const res = await searchPlacesService(payload.query, {
            apiKey: payload.apiKey,
            location: payload.location
        });
        return res as SearchPlace[];
    } catch (err) {
        return rejectWithValue(String(err));
    }
});

type State = {
    query: string;
    results: SearchPlace[];
    selected: SearchPlace | null;
    loading: boolean;
    error?: string | null;
    showResults: boolean;
};

const initialState: State = {
    query: '',
    results: [],
    selected: null,
    loading: false,
    error: null,
    showResults: false
};

const slice = createSlice({
    name: 'search',
    initialState,
    reducers: {
        setQuery(state, action: PayloadAction<string>) {
            state.query = action.payload;
        },
        setShowResults(state, action: PayloadAction<boolean>) {
            state.showResults = action.payload;
        },
        selectPlace(state, action: PayloadAction<SearchPlace | null>) {
            state.selected = action.payload;
            state.showResults = false;
        },
        clearResults(state) {
            state.results = [];
            state.showResults = false;
        }
    },
    extraReducers: (builder) => {
        builder
            .addCase(searchPlaces.pending, (s) => {
                s.loading = true;
                s.error = null;
            })
            .addCase(searchPlaces.fulfilled, (s, a) => {
                s.loading = false;
                s.results = a.payload;
                s.showResults = a.payload.length > 0;
            })
            .addCase(searchPlaces.rejected, (s, a) => {
                s.loading = false;
                s.error = a.payload || String(a.error);
                s.results = [];
                s.showResults = false;
            });
    }
});

export const { setQuery, setShowResults, selectPlace, clearResults } = slice.actions;
export default slice.reducer;
