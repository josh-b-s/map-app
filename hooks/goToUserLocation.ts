import { useCallback } from 'react';
import { RefObject } from 'react';
import MapView, { LatLng } from 'react-native-maps';
import * as Location from 'expo-location';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '@/store/store';
import { setUserLocation } from '@/store/location.slice';

export function useGoToUserLocation(mapRef: RefObject<MapView | null>, animate = true) {
    const dispatch = useDispatch<AppDispatch>();

    return useCallback(async () => {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;

        const pan = (coords: Location.LocationObjectCoords) => {
            const { latitude, longitude } = coords;
            dispatch(setUserLocation({ latitude, longitude } as LatLng));
            if (animate) {
                mapRef.current?.animateToRegion(
                    { latitude, longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 },
                    300
                );
            }
        };

        const last = await Location.getLastKnownPositionAsync();
        if (last) pan(last.coords);

        const fresh = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
        });
        // Always update store; only re-pan on startup (when there was no cached position)
        if (!last) pan(fresh.coords);
        else dispatch(setUserLocation({
            latitude: fresh.coords.latitude,
            longitude: fresh.coords.longitude,
        } as LatLng));
    }, [mapRef, animate, dispatch]);
}