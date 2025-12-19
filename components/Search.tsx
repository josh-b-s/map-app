// components/Search.tsx
import React, {useCallback, useEffect, useRef} from 'react';
import {Alert, FlatList, Keyboard, Platform, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import {useDispatch, useSelector} from 'react-redux';
import {AppDispatch, RootState} from '@/store/store';
import {clearResults, searchPlaces, selectPlace, setQuery} from '@/store/search.slice';
import {computeRoute} from '@/store/route.slice';
import type {LatLng} from '@/app/assets/services';
import {useSafeAreaInsets} from "react-native-safe-area-context";
import {FLOATING_SHADOW, useThemeStyle} from "@/constants/themes";

const GOOGLE_MAPS_APIKEY = process.env.EXPO_PUBLIC_API_KEY || '<YOUR_KEY>';

export default function Search() {
    const dispatch = useDispatch<AppDispatch>();
    const {query, results, showResults, loading} = useSelector((s: RootState) => s.search);
    const userLocation = useSelector((s: RootState) => s.location.userLocation);
    const debounceRef = useRef<number | null>(null);

    const onChange = (text: string) => dispatch(setQuery(text));

    useEffect(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        if (!query || query.trim().length < 3) {
            dispatch(clearResults());
            return;
        }
        debounceRef.current = setTimeout(() => {
            dispatch(searchPlaces({query, location: userLocation ?? undefined, apiKey: GOOGLE_MAPS_APIKEY}));
        }, 300) as unknown as number;
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [query, userLocation, dispatch]);

    const onSelect = useCallback(async (place: any) => {
        dispatch(selectPlace(place));
        Keyboard.dismiss();
        if (!userLocation) {
            Alert.alert('Waiting for user location');
            return;
        }
        dispatch(computeRoute({
            origin: userLocation as LatLng,
            destination: {latitude: place.latitude, longitude: place.longitude},
            apiKey: GOOGLE_MAPS_APIKEY,
            travelMode: 'DRIVE'
        }));
    }, [dispatch, userLocation]);

    const insets = useSafeAreaInsets();

    const searchTop =
        Platform.OS === "ios"
            ? insets.top + 12   // status bar + camera
            : insets.top + 16; // Android camera UI

    const theme = useThemeStyle();

    return (
        <View
            className="absolute left-4 right-4 z-[9999]"
            style={{top: searchTop}}
        >
            <View className={`flex-row items-center rounded-full px-3 py-2.5`}
                  style={[{backgroundColor: theme.backgroundColor}, FLOATING_SHADOW]}>
                <Ionicons name="search" size={20} color="#666" className="mr-4"/>
                <TextInput value={query} onChangeText={onChange} placeholder="Search places..."
                           className={`flex-1 text-base placeholder:text-gray-500`}
                           style={{backgroundColor: theme.backgroundColor, color: theme.color}}
                           returnKeyType="search"
                />
                {(query.length > 0 || loading) && (
                    <TouchableOpacity onPress={() => {
                        dispatch(setQuery(''));
                        dispatch(clearResults());
                        Keyboard.dismiss();
                    }} className="p-1.5 ml-1.5">
                        <Ionicons name={loading ? 'hourglass' : 'close'} size={20} color="#666"/>
                    </TouchableOpacity>
                )}
            </View>

            {showResults && results.length > 0 && (
                <View className={`rounded-3xl overflow-hidden mt-2 elevation-5`}
                      style={{backgroundColor: theme.backgroundColor}}>
                    <FlatList
                        data={results}
                        keyExtractor={(i) => i.place_id}
                        renderItem={({item, index}) => {
                            const isLast = index === results.length - 1;

                            return (
                                <TouchableOpacity
                                    onPress={() => onSelect(item)}
                                    className={`flex-row items-center px-3 py-3 ${isLast ? "" : "border-b border-gray-500"}`}
                                >
                                    <View className="flex-1">
                                        <Text className={`text-base font-semibold mb-0.5`} style={{color: theme.color}}>
                                            {item.name}
                                        </Text>
                                        <Text className={`text-sm`} style={{color: theme.color}}>
                                            {item.address}
                                        </Text>
                                    </View>

                                    <Ionicons name="chevron-forward" size={20} color="#666"/>
                                </TouchableOpacity>
                            );
                        }}
                        keyboardShouldPersistTaps="handled"
                    />

                </View>
            )}
        </View>
    );
}
