import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng } from '@/services/places';

type State = {
    coords: LatLng[];
    raw?: any;
};

const initialState: State = { coords: [], raw: undefined };

const slice = createSlice({
    name: 'route',
    initialState,
    reducers: {
        setRoute(state, action: PayloadAction<{ coords: LatLng[]; raw?: any }>) {
            state.coords = action.payload.coords;
            state.raw = action.payload.raw;
        },
        clearRoute(state) {
            state.coords = [];
            state.raw = undefined;
        },
    },
});

export const { setRoute, clearRoute } = slice.actions;
export default slice.reducer;