import React, { useEffect, useRef } from 'react';
import MapView, { Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { ActivityIndicator, Keyboard, StyleSheet, View } from 'react-native';
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
import { MAP_STYLE_DARK } from '@/constants/themes';
import { useGoToUserLocation} from '../hooks/goToUserLocation';

export default function Index() {
    const mapRef   = useRef<MapView>(null);
    const modalRef = useRef<BottomSheetModal>(null);
    const dispatch = useDispatch<AppDispatch>();
    const bottomSheetPosition = useSharedValue(1000);
    const { colorScheme } = useColorScheme();

    const userLocation   = useSelector((s: RootState) => s.location.userLocation);
    const routeCoords    = useSelector((s: RootState) => s.route.coords);
    const routeLoading   = useSelector((s: RootState) => s.route.loading);
    const selectedPlace  = useSelector((s: RootState) => s.search.selected);
    const routeSegments = useSelector((s: RootState) => s.route.segments);
    const routeColor = useSelector((s: RootState) => s.route.routeColor);

    const goToUserLocation = useGoToUserLocation(mapRef);
    useEffect(() => { goToUserLocation(); }, []);

    // Open bottom sheet when a place is selected
    useEffect(() => {
        if (selectedPlace) modalRef.current?.present();
    }, [selectedPlace]);

    // Fit map to route when coords update
    useEffect(() => {
        if (!routeCoords?.length) return;
        if (routeCoords.length > 1) {
            mapRef.current?.fitToCoordinates(routeCoords, {
                edgePadding: { top: 80, right: 60, bottom: 300, left: 60 },
                animated: true,
            });
        } else {
            const p = routeCoords[0];
            mapRef.current?.animateToRegion(
                { latitude: p.latitude, longitude: p.longitude, latitudeDelta: 0.02, longitudeDelta: 0.02 },
                700,
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
                            700,
                        );
                    }
                }}
                onPress={() => Keyboard.dismiss()}
            >
                {routeSegments.length > 0 ? (
                    routeSegments.map((segment, index) => (
                        <Polyline
                            key={index}
                            coordinates={segment.coords}
                            strokeWidth={4}
                            strokeColor={segment.routeColor ?? routeColor ?? "#2563eb"}
                        />
                    ))
                ) : routeCoords.length > 0 ? (
                    <Polyline
                        coordinates={routeCoords}
                        strokeWidth={4}
                        strokeColor={routeColor ?? "#2563eb"}
                    />
                ) : null}
            </MapView>

            {/* Routing spinner — sits above the map */}
            {routeLoading && (
                <View
                    style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: 'rgba(0,0,0,0.15)',
                    }}
                    pointerEvents="none"
                >
                    <ActivityIndicator size="large" color="#2563eb" />
                </View>
            )}

            <LocationButton mapRef={mapRef} animatedPosition={bottomSheetPosition} />
            <RouteBottomSheetModal ref={modalRef} animatedPosition={bottomSheetPosition} />
        </View>
    );
}