import React, { useCallback, useEffect, useRef, useState } from 'react';
import {Alert, FlatList, Keyboard, Text, TextInput, TouchableOpacity, View} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '@/store/store';
import { clearResults, searchPlaces, selectPlace, setQuery, setDepartureTime, setWalkingSpeed } from '@/store/search.slice';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SHADOW, TOP_SAFE, useThemeStyle } from '@/constants/themes';
import {computeRoute} from "@/store/route.slice";
import DepartureTimeModal from '@/components/DepartureTimeModal';

const GOOGLE_MAPS_APIKEY = process.env.EXPO_PUBLIC_API_KEY ?? '';

// Cycle order for the walking-speed pill — tapping steps through these in
// order and wraps back to SLOW. Mirrors raptorRouter.ts's WALK_SPEED_MPS
// (only the three pedestrian-realistic tiers are exposed here; JOG/RUN/
// SPRINT aren't meaningful walking-speed options for a transit planner).
const WALK_SPEED_CYCLE: { label: string; mps: number }[] = [
    { label: 'Slow',   mps: 0.8 },
    { label: 'Normal', mps: 1.4 },
    { label: 'Fast',   mps: 1.8 },
];

export default function Search() {
    const dispatch = useDispatch<AppDispatch>();
    const { query, results, showResults, loading, departureTime, walkingSpeedMps } = useSelector((s: RootState) => s.search);
    const userLocation = useSelector((s: RootState) => s.location.userLocation);
    const debugEnabled = useSelector((s: RootState) => s.debug.enabled);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const theme = useThemeStyle();
    const [showTimeModal, setShowTimeModal] = useState(false);

    const speedLabel = WALK_SPEED_CYCLE.find(o => o.mps === walkingSpeedMps)?.label ?? 'Normal';

    const cycleWalkingSpeed = useCallback(() => {
        const idx = WALK_SPEED_CYCLE.findIndex(o => o.mps === walkingSpeedMps);
        const next = WALK_SPEED_CYCLE[(idx + 1) % WALK_SPEED_CYCLE.length];
        dispatch(setWalkingSpeed(next.mps));
    }, [walkingSpeedMps, dispatch]);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (!query || query.trim().length < 3) { dispatch(clearResults()); return; }

        debounceRef.current = setTimeout(() => {
            dispatch(searchPlaces({ query, location: userLocation ?? undefined, apiKey: GOOGLE_MAPS_APIKEY }));
        }, 300);

        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [query, userLocation, dispatch]);

    const onSelect = useCallback((place: any) => {
        dispatch(selectPlace(place));
        Keyboard.dismiss();
        if (!userLocation) {
            Alert.alert('Location unavailable', 'Waiting for your current location.');
            return;
        }
        dispatch(computeRoute({
            origin:          userLocation,
            destination:     { latitude: place.latitude, longitude: place.longitude },
            debugMode:       debugEnabled,
            departureTime:   departureTime ? new Date(departureTime) : undefined,
            walkingSpeedMps,
        }));
    }, [dispatch, userLocation, debugEnabled, departureTime, walkingSpeedMps]);

    return (
        <View className="absolute left-4 right-4 z-[9999]" style={{ top: TOP_SAFE(useSafeAreaInsets()) }}>
            <View className="flex-row items-center rounded-full px-3 py-2.5"
                  style={[{ backgroundColor: theme.backgroundColor }, SHADOW]}>
                <Ionicons name="search" size={20} color="#666" className="mx-2" />
                <TextInput
                    value={query}
                    onChangeText={(t) => dispatch(setQuery(t))}
                    placeholder="Search places..."
                    className="text-xl flex-1 placeholder:text-gray-500"
                    style={{ backgroundColor: theme.backgroundColor, color: theme.color }}
                    returnKeyType="search"
                />
                {(query.length > 0 || loading) && (
                    <TouchableOpacity onPress={() => { dispatch(setQuery('')); dispatch(clearResults()); Keyboard.dismiss(); }}
                                      className="p-1.5 ml-1.5">
                        <Ionicons name={loading ? 'hourglass' : 'close'} size={20} color="#666" />
                    </TouchableOpacity>
                )}
            </View>

            {/* Departure-time + walking-speed pills — hidden while the results
                dropdown is open so they don't crowd it. */}
            {!(showResults && results.length > 0) && (
                <View className="flex-row mt-2" style={{ gap: 8 }}>
                    <TouchableOpacity
                        className="flex-row items-center rounded-full px-3 py-2"
                        style={[{ backgroundColor: theme.backgroundColor }, SHADOW]}
                        onPress={() => setShowTimeModal(true)}
                    >
                        <Ionicons name="time-outline" size={16} color={theme.color} />
                        <Text style={{ color: theme.color, marginLeft: 6, fontSize: 13, fontWeight: '600' }}>
                            {departureTime
                                ? new Date(departureTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                : 'Leave now'}
                        </Text>
                        {departureTime !== null && (
                            <TouchableOpacity
                                onPress={() => dispatch(setDepartureTime(null))}
                                hitSlop={8}
                                style={{ marginLeft: 6 }}
                            >
                                <Ionicons name="close-circle" size={14} color={theme.color} style={{ opacity: 0.5 }} />
                            </TouchableOpacity>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        className="flex-row items-center rounded-full px-3 py-2"
                        style={[{ backgroundColor: theme.backgroundColor }, SHADOW]}
                        onPress={cycleWalkingSpeed}
                    >
                        <Ionicons name="walk-outline" size={16} color={theme.color} />
                        <Text style={{ color: theme.color, marginLeft: 6, fontSize: 13, fontWeight: '600' }}>
                            {speedLabel}
                        </Text>
                    </TouchableOpacity>
                </View>
            )}

            <DepartureTimeModal
                visible={showTimeModal}
                value={departureTime}
                onClose={() => setShowTimeModal(false)}
                onConfirm={(epochMs) => dispatch(setDepartureTime(epochMs))}
            />

            {showResults && results.length > 0 && (
                <View className="rounded-3xl overflow-hidden mt-2" style={[{ backgroundColor: theme.backgroundColor }, SHADOW]}>
                    <FlatList
                        data={results}
                        keyExtractor={(i) => i.place_id}
                        keyboardShouldPersistTaps="handled"
                        renderItem={({ item, index }) => (
                            <TouchableOpacity
                                onPress={() => onSelect(item)}
                                className={`flex-row items-center px-3 py-3 ${index < results.length - 1 ? 'border-b border-gray-500' : ''}`}
                            >
                                <View className="flex-1">
                                    <Text className="text-lg font-semibold mb-0.5" style={{ color: theme.color }}>{item.name}</Text>
                                    <Text className="opacity-50" style={{ color: theme.color }}>{item.address}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={20} color="#666" />
                            </TouchableOpacity>
                        )}
                    />
                </View>
            )}
        </View>
    );
}