import React from 'react';
import { Stack } from 'expo-router';
import { useThemeStyle } from '@/constants/themes';

export default function SettingsLayout() {
    const theme = useThemeStyle();

    return (
        <Stack
            screenOptions={{
                headerStyle: { backgroundColor: theme.backgroundColor },
                headerTintColor: theme.color,
                headerShadowVisible: false,
            }}
        >
            <Stack.Screen name="index" options={{ title: 'Settings' }} />
            <Stack.Screen name="preferences" options={{ title: 'Preferences' }} />
            <Stack.Screen name="gtfs" options={{ title: 'GTFS Data' }} />
        </Stack>
    );
}