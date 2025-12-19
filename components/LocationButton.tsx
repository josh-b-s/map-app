import React, {RefObject} from "react";
import {TouchableOpacity} from "react-native";
import {Ionicons} from "@expo/vector-icons";
import Animated, {SharedValue} from "react-native-reanimated";
import {useDispatch} from "react-redux";
import {AppDispatch} from "@/store/store";
import {setUserLocation} from "@/store/location.slice";
import MapView, {LatLng} from "react-native-maps";
import * as Location from "expo-location";
import {useColor, useThemeStyle} from "@/constants/themes";


export default function LocationButton({mapRef, animatedPosition}: {
    mapRef: RefObject<MapView | null>,
    animatedPosition: SharedValue<number>
}) {
    const dispatch = useDispatch<AppDispatch>();

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

    return (
        <Animated.View style={{top: animatedPosition}}>
            <TouchableOpacity
                className={`absolute bottom-5 right-5 w-16 h-16 rounded-full items-center justify-center elevation-4`}
                style={{backgroundColor: useThemeStyle().backgroundColor}}
                onPress={goToUser}>
                <Ionicons name="locate" size={28} color={useColor()}/>
            </TouchableOpacity>
        </Animated.View>
    )
}