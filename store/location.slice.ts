import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng } from '@/services/places';

type State = { userLocation: LatLng | null };

const slice = createSlice({
    name: 'location',
    initialState: { userLocation: null } as State,
    reducers: {
        setUserLocation(state, action: PayloadAction<LatLng | null>) {
            state.userLocation = action.payload;
        },
    },
});

export const { setUserLocation } = slice.actions;
export default slice.reducer;