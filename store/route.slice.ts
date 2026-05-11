import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng } from '@/services/places';
import { computeGtfsRoute, GtfsRouteResult } from '@/services/gtfsRouter';

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
    coords: LatLng[];
    segments: GtfsRouteResult['segments'];
    legs: GtfsRouteResult['legs'];
    routeName?: string;
    routeType?: number;
    routeColor?: string;
    routeTextColor?: string;
    originStopName?: string;
    destStopName?: string;
    transferStopName?: string;
    loading: boolean;
    error?: string | null;
};

const initialState: State = {
    coords: [],
    segments: [],
    legs: [],
    loading: false,
    error: null,
};

const slice = createSlice({
    name: 'route',
    initialState,
    reducers: {
        setRoute(state, action: PayloadAction<GtfsRouteResult>) {
            Object.assign(state, action.payload);
        },
        clearRoute(state) {
            state.coords = [];
            state.segments = [];
            state.legs = [];
            state.routeName = undefined;
            state.routeType = undefined;
            state.routeColor = undefined;
            state.routeTextColor = undefined;
            state.originStopName = undefined;
            state.destStopName = undefined;
            state.transferStopName = undefined;
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
                s.coords = a.payload.coords;
                s.segments = a.payload.segments;
                s.legs = a.payload.legs;
                s.routeName = a.payload.routeName;
                s.routeType = a.payload.routeType;
                s.routeColor = a.payload.routeColor;
                s.routeTextColor = a.payload.routeTextColor;
                s.originStopName = a.payload.originStopName;
                s.destStopName = a.payload.destStopName;
                s.transferStopName = a.payload.transferStopName;
            })
            .addCase(computeRoute.rejected, (s, a) => {
                s.loading = false;
                s.error = a.payload ?? String(a.error);
            });
    },
});

export const { setRoute, clearRoute } = slice.actions;
export default slice.reducer;