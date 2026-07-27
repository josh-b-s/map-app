import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeStyle } from '@/constants/themes';

export default function TabsLayout() {
    const theme = useThemeStyle();

    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                tabBarActiveTintColor: '#2563eb',
                tabBarInactiveTintColor: theme.color + '88',
                tabBarStyle: { backgroundColor: theme.backgroundColor },
            }}
        >
            <Tabs.Screen
                name="index"
                options={{
                    title: 'Map',
                    tabBarIcon: ({ color, size }) => <Ionicons name="map" size={size} color={color} />,
                }}
            />
            <Tabs.Screen
                name="settings"
                options={{
                    title: 'Settings',
                    tabBarIcon: ({ color, size }) => <Ionicons name="settings-sharp" size={size} color={color} />,
                }}
            />
        </Tabs>
    );
}