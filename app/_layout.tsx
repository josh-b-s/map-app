import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Stack } from 'expo-router';
import { Provider } from 'react-redux';
import { store } from '@/store/store';
import '@/global.css';
import { warmUpGtfsEngine } from '@/services/gtfs/warmup/gtfsWarmup';
import { loadPreferences } from '@/store/preferences.slice';
import { restoreActiveDatabase } from '@/services/gtfs/import/gtfsDbRegistry';

export default function Layout() {
    useEffect(() => {
        // Must resolve BEFORE warmUpGtfsEngine() reads getCurrentDbPath() —
        // otherwise warmup (and any search before this finishes) targets
        // sqliteDb.ts's default legacy path instead of whatever feed the
        // user actually had selected last session.
        (async () => {
            await restoreActiveDatabase();
            warmUpGtfsEngine(); // deliberately not awaited from here on — shouldn't block first paint
        })();
        store.dispatch(loadPreferences()); // applies the saved theme mode via nativewind as soon as it resolves
    }, []);

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaProvider>
                <BottomSheetModalProvider>
                    <Provider store={store}>
                        <Stack screenOptions={{ headerShown: false }}>
                            <Stack.Screen name="(tabs)" />
                        </Stack>
                    </Provider>
                </BottomSheetModalProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}