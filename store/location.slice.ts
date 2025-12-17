// src/store/location.slice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LatLng } from '@/app/assets/services';

type State = { userLocation: LatLng | null };
const initialState: State = { userLocation: null };

const slice = createSlice({
    name: 'location',
    initialState,
    reducers: {
        setUserLocation(state, action: PayloadAction<LatLng | null>) {
            state.userLocation = action.payload;
        }
    }
});

export const { setUserLocation } = slice.actions;
export default slice.reducer;
