import React, { useEffect, useRef } from 'react';
import MapView, { Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Keyboard, StyleSheet, View } from 'react-native';
import * as Location from 'expo-location';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '@/store/store';
import { setUserLocation } from '@/store/location.slice';
import type { LatLng } from '@/services/places';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSharedValue } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import Search from '@/components/Search';
import LocationButton from '@/components/LocationButton';
import RouteBottomSheetModal from '@/components/RouteBottomSheetModal';
import {MAP_STYLE_DARK} from "@/constants/themes";

export default function Index() {
    const mapRef = useRef<MapView>(null);
    const modalRef = useRef<BottomSheetModal>(null);
    const dispatch = useDispatch<AppDispatch>();
    const bottomSheetPosition = useSharedValue(0);
    const { colorScheme } = useColorScheme();

    const userLocation = useSelector((s: RootState) => s.location.userLocation);
    const routeCoords = useSelector((s: RootState) => s.route.coords);

    // Request location on mount
    useEffect(() => {
        let mounted = true;
        (async () => {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') return;
            const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
            if (!mounted) return;
            dispatch(setUserLocation({ latitude: coords.latitude, longitude: coords.longitude } as LatLng));
            mapRef.current?.animateToRegion(
                { latitude: coords.latitude, longitude: coords.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 },
                700
            );
        })();
        return () => { mounted = false; };
    }, [dispatch]);

    // Fit map to route whenever coords update
    useEffect(() => {
        if (!routeCoords?.length) return;
        if (routeCoords.length > 1) {
            mapRef.current?.fitToCoordinates(routeCoords, {
                edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
                animated: true,
            });
        } else {
            const p = routeCoords[0];
            mapRef.current?.animateToRegion(
                { latitude: p.latitude, longitude: p.longitude, latitudeDelta: 0.02, longitudeDelta: 0.02 },
                700
            );
        }
    }, [routeCoords]);

    return (
        <View style={{ flex: 1 }}>
            <Search />
            <MapView
                ref={mapRef}
                key={colorScheme}
                style={StyleSheet.absoluteFillObject}
                showsUserLocation
                showsMyLocationButton={false}
                showsCompass={false}
                userInterfaceStyle={colorScheme ?? 'light'}
                customMapStyle={colorScheme === 'dark' ? MAP_STYLE_DARK : []}
                onMapReady={() => {
                    if (userLocation) {
                        mapRef.current?.animateToRegion(
                            { ...userLocation, latitudeDelta: 0.01, longitudeDelta: 0.01 },
                            700
                        );
                    }
                }}
                onPress={() => Keyboard.dismiss()}
            >
                {routeCoords.length > 0 && (
                    <Polyline coordinates={routeCoords} strokeWidth={4} strokeColor="blue" />
                )}
            </MapView>
            <LocationButton mapRef={mapRef} animatedPosition={bottomSheetPosition} />
            <RouteBottomSheetModal ref={modalRef} animatedPosition={bottomSheetPosition} />
        </View>
    );
}