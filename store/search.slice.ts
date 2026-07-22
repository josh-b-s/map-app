import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng, SearchPlace } from '@/services/places/places';
import { searchPlaces as searchPlacesService } from '@/services/places/places';

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
    /** Epoch ms for the planned departure. null = "leave now" — computeRoute
     *  passes `undefined` through to computeGtfsRoute in that case, which
     *  falls back to `new Date()` at call time, so "now" always reflects
     *  the actual moment of search rather than whenever this was picked. */
    departureTime: number | null;
    /** Meters/sec. Mirrors WALK_SPEED_MPS.NORMAL from raptorRouter.ts as the
     *  default so an untouched picker matches computeGtfsRoute's own default. */
    walkingSpeedMps: number;
};

const DEFAULT_WALKING_SPEED_MPS = 1.4; // WALK_SPEED_MPS.NORMAL

const initialState: State = {
    query: '',
    results: [],
    selected: null,
    loading: false,
    error: null,
    showResults: false,
    departureTime: null,
    walkingSpeedMps: DEFAULT_WALKING_SPEED_MPS,
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
        setDepartureTime(state, action: PayloadAction<number | null>) {
            state.departureTime = action.payload;
        },
        setWalkingSpeed(state, action: PayloadAction<number>) {
            state.walkingSpeedMps = action.payload;
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

export const { setQuery, selectPlace, clearResults, setDepartureTime, setWalkingSpeed } = slice.actions;
export default slice.reducer;