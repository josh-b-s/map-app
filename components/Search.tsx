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
    return (
        <View
            className="absolute left-4 right-4 z-[9999]"
            style={{top: searchTop}}
        >
            <View className="flex-row items-center bg-white rounded-full px-3 py-2.5 elevation-5">
                <Ionicons name="search" size={20} color="#666" className="mr-2"/>
                <TextInput value={query} onChangeText={onChange} placeholder="Search places..."
                           className="flex-1 text-base text-[#333]"
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
                <View className="bg-white rounded-xl mt-2 max-h-[300px] elevation-5">
                    <FlatList data={results} keyExtractor={(i) => i.place_id} renderItem={({item}) => (
                        <TouchableOpacity className="flex-row items-center px-3 py-3 border-b border-[#f0f0f0]"
                                          onPress={() => onSelect(item)}>
                            <View className="flex-1">
                                <Text className="text-base font-semibold text-[#333] mb-0.5">{item.name}</Text>
                                <Text className="text-sm text-[#666]">{item.address}</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color="#666"/>
                        </TouchableOpacity>
                    )} keyboardShouldPersistTaps="handled"/>
                </View>
            )}
        </View>
    );
}
