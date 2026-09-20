import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng } from '@/services/places/places';
import { computeGtfsRoute, GtfsRouteResult, GtfsJourney } from '@/services/gtfs/router/raptorRouter';
import { computeGtfsRouteNative } from '@/services/gtfs/router/gtfsRouterNative';
import { setDebugData } from './debug.slice';
import { publishDebugData } from '@/services/gtfs/debug/debugDataStore';
import { USE_NATIVE_ROUTER } from '@/services/gtfs/router/routerConfig';

// Flip USE_NATIVE_ROUTER (routerConfig.ts) to compare the Rust engine
// against the existing TS/op-sqlite path — both are called with the exact
// same args and return the exact same GtfsRouteResult/GtfsJourney shape.

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
            // maxWalkDistanceM (undefined -> computeGtfsRouteNative's own
            // hardcoded default) not yet exposed on this thunk's args — see
            // TODO in gtfsRouterNative.ts.
            ? await computeGtfsRouteNative(origin, destination, departureTime, walkingSpeedMps, undefined, debugMode)
            : await computeGtfsRoute(origin, destination, departureTime, walkingSpeedMps, debugMode);
        // Dispatched here (inside the thunk) rather than via route.slice's own
        // extraReducers, since debug data belongs in debug.slice, not route
        // state — this keeps "what journey is displayed" and "what did the
        // search look like internally" as separate concerns.
        // The big debug payload goes to the module-level store; only its
        // small meta enters Redux. Also DON'T return `result` as-is: a
        // thunk's return value becomes the `fulfilled` action payload, which
        // RTK's dev middleware deep-walks — so strip `debug` from it.
        dispatch(setDebugData(publishDebugData(debugMode ? result.debug : null)));
        return { journeys: result.journeys };
    } catch (err) {
        console.error('[route.slice] computeRoute failed:', err);
        if (err instanceof Error) console.error(err.stack);
        return rejectWithValue(String(err));
    }
});

type State = {
    // All journeys found for the current search (Pareto-optimal set: fastest,
    // least walking, fewest transfers, etc). Populated by computeRoute; used
    // by the bottom sheet to let the user pick/sort between options.
    journeys: GtfsJourney[];
    selectedJourneyIndex: number;

    // NOTE: the displayed journey is NOT copied into flat state fields any
    // more (that held every polyline twice in the store, and Immer froze /
    // RTK's dev middleware walked both copies). Read it with the
    // `selectDisplayedJourney` selector below — journeys[selectedJourneyIndex].

    loading: boolean;
    error?: string | null;
};

const initialState: State = {
    journeys: [],
    selectedJourneyIndex: 0,
    loading: false,
    error: null,
};

const slice = createSlice({
    name: 'route',
    initialState,
    reducers: {
        /** Directly set a full result (e.g. from a non-thunk source). */
        setRoute(state, action: PayloadAction<GtfsRouteResult>) {
            state.journeys = action.payload.journeys;
            state.selectedJourneyIndex = 0;
            state.loading = false;
            state.error = null;
        },
        /** Switch which journey is currently displayed on the map — used by
         *  the bottom sheet when the user taps a different option in the list. */
        selectJourney(state, action: PayloadAction<number>) {
            const idx = action.payload;
            if (idx < 0 || idx >= state.journeys.length) return;
            state.selectedJourneyIndex = idx;
        },
        clearRoute(state) {
            state.journeys = [];
            state.selectedJourneyIndex = 0;
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
            })
            .addCase(computeRoute.rejected, (s, a) => {
                s.loading = false;
                s.error = a.payload ?? String(a.error);
            });
    },
});

export const { setRoute, selectJourney, clearRoute } = slice.actions;

/** The journey currently shown on the map (reference-stable: it's the same
 *  object stored in `journeys`, so useSelector doesn't re-render on it). */
export const selectDisplayedJourney = (s: { route: State }): GtfsJourney | undefined =>
    s.route.journeys[s.route.selectedJourneyIndex];
export default slice.reducer;