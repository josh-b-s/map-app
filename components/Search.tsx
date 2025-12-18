// components/Search.tsx
import React, {useCallback, useEffect, useRef} from 'react';
import {Alert, FlatList, Keyboard, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {Ionicons} from '@expo/vector-icons';
import {useDispatch, useSelector} from 'react-redux';
import {AppDispatch, RootState} from '@/store/store';
import {clearResults, searchPlaces, selectPlace, setQuery} from '@/store/search.slice';
import {computeRoute} from '@/store/route.slice';
import {styles} from '@/constants/styles';
import type {LatLng} from '@/app/assets/services';

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

    return (
        <View style={styles.searchContainer} pointerEvents="box-none">
            <View style={styles.searchBar}>
                <Ionicons name="search" size={20} color="#666" style={styles.searchIcon}/>
                <TextInput value={query} onChangeText={onChange} placeholder="Search places..."
                           style={styles.searchInput} returnKeyType="search"/>
                {(query.length > 0 || loading) && (
                    <TouchableOpacity onPress={() => {
                        dispatch(setQuery(''));
                        dispatch(clearResults());
                        Keyboard.dismiss();
                    }} style={styles.clearButton}>
                        <Ionicons name={loading ? 'hourglass' : 'close'} size={20} color="#666"/>
                    </TouchableOpacity>
                )}
            </View>

            {showResults && results.length > 0 && (
                <View style={styles.searchResultsContainer}>
                    <FlatList data={results} keyExtractor={(i) => i.place_id} renderItem={({item}) => (
                        <TouchableOpacity style={styles.searchResultItem} onPress={() => onSelect(item)}>
                            <View style={styles.searchResultContent}>
                                <Text style={styles.searchResultName}>{item.name}</Text>
                                <Text style={styles.searchResultAddress}>{item.address}</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color="#666"/>
                        </TouchableOpacity>
                    )} keyboardShouldPersistTaps="handled"/>
                </View>
            )}
        </View>
    );
}
