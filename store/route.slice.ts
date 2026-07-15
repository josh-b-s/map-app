import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng } from '@/services/places';
import { computeGtfsRoute, GtfsRouteResult, GtfsJourney } from '@/services/gtfsRouter';

export const computeRoute = createAsyncThunk<
    GtfsRouteResult,
    { origin: LatLng; destination: LatLng },
    { rejectValue: string }
>('route/compute', async ({ origin, destination }, { rejectWithValue }) => {
    try {
        return await computeGtfsRoute(origin, destination);
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