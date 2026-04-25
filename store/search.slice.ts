import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng, SearchPlace } from '@/services/places';
import { searchPlaces as searchPlacesService } from '@/services/places';

export type { SearchPlace };

export const searchPlaces = createAsyncThunk<
    SearchPlace[],
    { query: string; location?: LatLng; apiKey: string },
    { rejectValue: string }
>('search/searchPlaces', async (payload, { rejectWithValue }) => {
    try {
        return await searchPlacesService(payload.query, {
            apiKey: payload.apiKey,
            location: payload.location,
        });
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
    showResults: false,
};

const slice = createSlice({
    name: 'search',
    initialState,
    reducers: {
        setQuery(state, action: PayloadAction<string>) {
            state.query = action.payload;
        },
        selectPlace(state, action: PayloadAction<SearchPlace | null>) {
            state.selected = action.payload;
            state.showResults = false;
        },
        clearResults(state) {
            state.results = [];
            state.showResults = false;
        },
    },
    extraReducers: (builder) => {
        builder
            .addCase(searchPlaces.pending, (s) => { s.loading = true; s.error = null; })
            .addCase(searchPlaces.fulfilled, (s, a) => {
                s.loading = false;
                s.results = a.payload;
                s.showResults = a.payload.length > 0;
            })
            .addCase(searchPlaces.rejected, (s, a) => {
                s.loading = false;
                s.error = a.payload ?? String(a.error);
                s.results = [];
                s.showResults = false;
            });
    },
});

export const { setQuery, selectPlace, clearResults } = slice.actions;
export default slice.reducer;