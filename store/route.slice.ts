// src/store/route.slice.ts
import {createAsyncThunk, createSlice} from '@reduxjs/toolkit';
import type {LatLng} from '@/app/assets/services';
import {computeRoute as computeRouteService, TravelMode} from '@/app/assets/services';

export const computeRoute = createAsyncThunk<
    { coords: LatLng[]; raw: any },
    { origin: LatLng; destination: LatLng; apiKey: string; travelMode?: string },
    { rejectValue: string }
>('route/compute', async (payload, {rejectWithValue}) => {
    try {
        return await computeRouteService(payload.origin, payload.destination, {
            apiKey: payload.apiKey,
            travelMode: payload.travelMode as TravelMode
        });
    } catch (err) {
        return rejectWithValue(String(err));
    }
});

type State = {
    coords: LatLng[];
    raw?: any;
    loading: boolean;
    error?: string | null;
};

const initialState: State = {coords: [], raw: undefined, loading: false, error: null};

const slice = createSlice({
    name: 'route',
    initialState,
    reducers: {
        clearRoute(state) {
            state.coords = [];
            state.raw = undefined;
        }
    },
    extraReducers: (builder) => {
        builder
            .addCase(computeRoute.pending, (s) => {
                s.loading = true;
                s.error = null;
            })
            .addCase(computeRoute.fulfilled, (s, a) => {
                s.loading = false;
                s.coords = a.payload.coords;
                s.raw = a.payload.raw;
            })
            .addCase(computeRoute.rejected, (s, a) => {
                s.loading = false;
                s.error = a.payload || String(a.error);
            });
    }
});

export const {clearRoute} = slice.actions;
export default slice.reducer;
