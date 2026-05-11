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
    routeName?: string;
    routeType?: number;
    originStopName?: string;
    destStopName?: string;
    loading: boolean;
    error?: string | null;
};

const initialState: State = {
    coords: [],
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
            state.routeName = undefined;
            state.routeType = undefined;
            state.originStopName = undefined;
            state.destStopName = undefined;
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
                s.coords         = a.payload.coords;
                s.routeName      = a.payload.routeName;
                s.routeType      = a.payload.routeType;
                s.originStopName = a.payload.originStopName;
                s.destStopName   = a.payload.destStopName;
            })
            .addCase(computeRoute.rejected, (s, a) => {
                s.loading = false;
                s.error = a.payload ?? String(a.error);
            });
    },
});

export const { setRoute, clearRoute } = slice.actions;
export default slice.reducer;