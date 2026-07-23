import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng } from '@/services/places/places';
import { computeGtfsRoute, GtfsRouteResult, GtfsJourney } from '@/services/gtfs/router/raptorRouter';
import { computeGtfsRouteNative } from '@/services/gtfs/router/gtfsRouterNative';
import { setDebugData } from './debug.slice';

// Flip to compare the Rust engine against the existing TS/op-sqlite path —
// both are called with the exact same args and return the exact same
// GtfsRouteResult/GtfsJourney shape, so nothing downstream needs to change
// either way.
const USE_NATIVE_ROUTER = true;

export const computeRoute = createAsyncThunk<
    GtfsRouteResult,
    {
        origin: LatLng;
        destination: LatLng;
        debugMode?: boolean;
        /** Undefined -> computeGtfsRoute's own default (`new Date()` at call
         *  time, i.e. "leave now"). Passed through as-is, not defaulted here,
         *  so "now" is always the actual moment of search. */
        departureTime?: Date;
        /** Undefined -> computeGtfsRoute's own default (WALK_SPEED_MPS.NORMAL). */
        walkingSpeedMps?: number;
    },
    { rejectValue: string }
>('route/compute', async ({ origin, destination, debugMode = false, departureTime, walkingSpeedMps }, { rejectWithValue, dispatch }) => {
    try {
        const result = USE_NATIVE_ROUTER
            ? await computeGtfsRouteNative(origin, destination, departureTime, walkingSpeedMps, debugMode)
            : await computeGtfsRoute(origin, destination, departureTime, walkingSpeedMps, debugMode);
        // Dispatched here (inside the thunk) rather than via route.slice's own
        // extraReducers, since debug data belongs in debug.slice, not route
        // state — this keeps "what journey is displayed" and "what did the
        // search look like internally" as separate concerns.
        dispatch(setDebugData(debugMode ? (result.debug ?? null) : null));
        return result;
    } catch (err) {
        return rejectWithValue(String(err));
    }
});

type State = {
    // All journeys found for the current search (Pareto-optimal set: fastest,
    // least walking, fewest transfers, etc). Populated by computeRoute; used
    // by the bottom sheet to let the user pick/sort between options.
    journeys: GtfsJourney[];
    selectedJourneyIndex: number;

    // The CURRENTLY DISPLAYED journey's fields, flattened for convenience —
    // this is what the map (index.tsx) reads. Kept in sync with
    // journeys[selectedJourneyIndex] whenever journeys change or a different
    // journey is selected, so index.tsx needs no changes.
    coords: LatLng[];
    segments: GtfsJourney['segments'];
    legs: GtfsJourney['legs'];
    routeName?: string;
    routeType?: number;
    routeColor?: string;
    routeTextColor?: string;
    originStopName?: string;
    destStopName?: string;
    transferStopName?: string;
    totalDurationMin?: number;
    totalWalkingMeters?: number;
    transferCount?: number;
    departureTime?: string;
    arrivalTime?: string;

    loading: boolean;
    error?: string | null;
};

const emptyDisplayFields = {
    coords: [] as LatLng[],
    segments: [] as GtfsJourney['segments'],
    legs: [] as GtfsJourney['legs'],
    routeName: undefined,
    routeType: undefined,
    routeColor: undefined,
    routeTextColor: undefined,
    originStopName: undefined,
    destStopName: undefined,
    transferStopName: undefined,
    totalDurationMin: undefined,
    totalWalkingMeters: undefined,
    transferCount: undefined,
    departureTime: undefined,
    arrivalTime: undefined,
};

const initialState: State = {
    journeys: [],
    selectedJourneyIndex: 0,
    ...emptyDisplayFields,
    loading: false,
    error: null,
};

/** Copies a journey's fields into the flat "currently displayed" state slots. */
function applyJourneyToState(state: State, journey: GtfsJourney | undefined) {
    if (!journey) {
        Object.assign(state, emptyDisplayFields);
        return;
    }
    state.coords = journey.coords;
    state.segments = journey.segments;
    state.legs = journey.legs;
    state.routeName = journey.routeName;
    state.routeType = journey.routeType;
    state.routeColor = journey.routeColor;
    state.routeTextColor = journey.routeTextColor;
    state.originStopName = journey.originStopName;
    state.destStopName = journey.destStopName;
    state.transferStopName = journey.transferStopName;
    state.totalDurationMin = journey.totalDurationMin;
    state.totalWalkingMeters = journey.totalWalkingMeters;
    state.transferCount = journey.transferCount;
    state.departureTime = journey.departureTime;
    state.arrivalTime = journey.arrivalTime;
}

const slice = createSlice({
    name: 'route',
    initialState,
    reducers: {
        /** Directly set a full result (e.g. from a non-thunk source). */
        setRoute(state, action: PayloadAction<GtfsRouteResult>) {
            state.journeys = action.payload.journeys;
            state.selectedJourneyIndex = 0;
            applyJourneyToState(state, action.payload.journeys[0]);
            state.loading = false;
            state.error = null;
        },
        /** Switch which journey is currently displayed on the map — used by
         *  the bottom sheet when the user taps a different option in the list. */
        selectJourney(state, action: PayloadAction<number>) {
            const idx = action.payload;
            if (idx < 0 || idx >= state.journeys.length) return;
            state.selectedJourneyIndex = idx;
            applyJourneyToState(state, state.journeys[idx]);
        },
        clearRoute(state) {
            state.journeys = [];
            state.selectedJourneyIndex = 0;
            Object.assign(state, emptyDisplayFields);
            state.error = null;
        },
    },
    extraReducers: builder => {
        builder
            .addCase(computeRoute.pending, s => {
                s.loading = true;
                s.error = null;
            })
            .addCase(computeRoute.fulfilled, (s, a) => {
                s.loading = false;
                s.journeys = a.payload.journeys;
                s.selectedJourneyIndex = 0;
                applyJourneyToState(s, a.payload.journeys[0]);
            })
            .addCase(computeRoute.rejected, (s, a) => {
                s.loading = false;
                s.error = a.payload ?? String(a.error);
            });
    },
});

export const { setRoute, selectJourney, clearRoute } = slice.actions;
export default slice.reducer;