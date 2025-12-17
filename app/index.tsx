// app/index.tsx
import React, {useEffect, useRef, useState} from "react";
import MapView, {Polyline, PROVIDER_GOOGLE} from "react-native-maps";
import {Keyboard, StyleSheet, TouchableOpacity, View} from "react-native";
import * as Location from "expo-location";
import {Ionicons} from "@expo/vector-icons";
import Search from "@/components/Search";
import RouteBottomSheetModal from "@/components/RouteBottomSheetModal";
import {styles} from "@/constants/styles";
import {useDispatch, useSelector} from "react-redux";
import {AppDispatch, RootState} from "@/store/store";
import {setUserLocation} from "@/store/location.slice";
import type {LatLng} from "@/app/assets/services";
import {BottomSheetModal} from "@gorhom/bottom-sheet";
import Animated, {useSharedValue} from "react-native-reanimated";

/**
 * Fixed, self-contained main screen:
 * - uses Redux for persisted route coords (route.coords) but also supports a local
 *   selectedCoords state so selecting an alternative immediately shows on the map
 *   without requiring additional store reducers.
 * - fits to coordinates safely (fallback for single-point routes).
 * - decodes polylines using @mapbox/polyline (dynamic require to avoid runtime errors).
 */

export default function Index() {
    const mapRef = useRef<MapView>(null);
    const modalRef = useRef<BottomSheetModal>(null);
    const dispatch = useDispatch<AppDispatch>();

    const userLocation = useSelector((s: RootState) => s.location.userLocation);
    const routeCoordsFromStore = useSelector((s: RootState) => s.route.coords);
    const routeRaw = useSelector((s: RootState) => s.route.raw);

    // Local selected alternative coords — used when user picks an alt route in the sheet
    const [selectedCoords, setSelectedCoords] = useState<LatLng[]>([]);


    const bottomSheetPosition = useSharedValue<number>(0);

    // initial user location -> store
    useEffect(() => {
        let mounted = true;
        (async () => {
            const {status} = await Location.requestForegroundPermissionsAsync();
            if (status !== "granted") return;
            const {coords} = await Location.getCurrentPositionAsync({accuracy: Location.Accuracy.Highest});
            if (!mounted) return;
            dispatch(setUserLocation({latitude: coords.latitude, longitude: coords.longitude} as LatLng));
            mapRef.current?.animateToRegion(
                {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    latitudeDelta: 0.01,
                    longitudeDelta: 0.01
                },
                700
            );
        })();
        return () => {
            mounted = false;
        };
    }, [dispatch]);

    // animate map when route coords (from store) change
    useEffect(() => {
        const coords = selectedCoords.length > 0 ? selectedCoords : routeCoordsFromStore;
        if (!coords || coords.length === 0) return;
        if (coords.length > 1) {
            mapRef.current?.fitToCoordinates(coords, {
                edgePadding: {top: 60, right: 60, bottom: 60, left: 60},
                animated: true
            });
        } else {
            const p = coords[0];
            mapRef.current?.animateToRegion(
                {latitude: p.latitude, longitude: p.longitude, latitudeDelta: 0.02, longitudeDelta: 0.02},
                700
            );
        }
    }, [routeCoordsFromStore, selectedCoords]);

    // open bottom-sheet modal when routeRaw contains alternatives
    useEffect(() => {
        const rawRoutes = routeRaw?.routes || [];
        if (rawRoutes.length > 0) {
            modalRef.current?.present(rawRoutes);
        }
    }, [routeRaw]);
    modalRef.current?.present();
    const goToUser = async () => {
        try {
            const {status} = await Location.requestForegroundPermissionsAsync();
            if (status !== "granted") return;
            const {coords} = await Location.getCurrentPositionAsync();
            dispatch(setUserLocation({latitude: coords.latitude, longitude: coords.longitude} as LatLng));
            mapRef.current?.animateToRegion(
                {latitude: coords.latitude, longitude: coords.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01},
                700
            );
        } catch (err) {
            console.error(err);
        }
    };

    // apply route selected from modal: decode encoded polyline and show it immediately
    const applyRoute = (encoded: string, idx: number, raw: any) => {
        if (!encoded) return;
        try {
            // dynamic require so app doesn't crash in environments without the package installed
            // Ensure you have @mapbox/polyline installed: `npm i @mapbox/polyline`
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const polyline = require("@mapbox/polyline");
            const pts: number[][] = polyline.decode(encoded);
            const coords = pts.map(([lat, lng]) => ({latitude: lat, longitude: lng}));
            setSelectedCoords(coords);

            // fit map to coordinates (safe)
            if (coords.length > 1) {
                mapRef.current?.fitToCoordinates(coords, {
                    edgePadding: {top: 60, right: 60, bottom: 60, left: 60},
                    animated: true
                });
            } else {
                const p = coords[0];
                mapRef.current?.animateToRegion(
                    {latitude: p.latitude, longitude: p.longitude, latitudeDelta: 0.02, longitudeDelta: 0.02},
                    700
                );
            }
        } catch (err) {
            console.error("decode error", err);
        }
    };

    // Which coordinates to render on the map: prefer selectedCoords (immediate alt), else store coords
    const coordsToRender = selectedCoords.length > 0 ? selectedCoords : routeCoordsFromStore;

    return (
        <View style={{flex: 1}}>
            <Search/>

            <MapView
                ref={mapRef}
                style={StyleSheet.absoluteFillObject}
                provider={PROVIDER_GOOGLE}
                showsUserLocation
                showsMyLocationButton={false}
                onMapReady={() => {
                    if (userLocation) {
                        mapRef.current?.animateToRegion(
                            {
                                latitude: userLocation.latitude,
                                longitude: userLocation.longitude,
                                latitudeDelta: 0.01,
                                longitudeDelta: 0.01
                            },
                            700
                        );
                    }
                }}
                onPress={() => {
                    Keyboard.dismiss();
                }}
            >
                {/* polylines */}
                {coordsToRender && coordsToRender.length > 0 && (
                    <Polyline coordinates={coordsToRender} strokeWidth={4} strokeColor="blue"/>
                )}
            </MapView>

            <Animated.View style={{top: bottomSheetPosition}}>
                <TouchableOpacity style={styles.myLocationBtn} onPress={goToUser}>
                    <Ionicons name="locate" size={24}/>
                </TouchableOpacity>
            </Animated.View>
            <RouteBottomSheetModal ref={modalRef} animatedPosition={bottomSheetPosition}/>
        </View>
    );
}
