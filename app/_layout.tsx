// app/_layout.tsx
import 'react-native-gesture-handler'; // MUST be first
import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Stack } from 'expo-router';
import { Provider } from 'react-redux';
import { store } from '@/store/store'; // adjust path

export default function Layout() {
    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaProvider>
                <BottomSheetModalProvider>
                    <Provider store={store}>
                        <Stack>
                            <Stack.Screen name="index" options={{ headerShown: false }} />
                        </Stack>
                    </Provider>
                </BottomSheetModalProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}
