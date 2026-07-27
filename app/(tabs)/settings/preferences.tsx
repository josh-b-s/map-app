import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useThemeStyle } from '@/constants/themes';

export default function Preferences() {
    const theme = useThemeStyle();

    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.backgroundColor }} contentContainerStyle={{ padding: 16 }}>
            <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13 }}>
                Preferences (theme, default walking speed, units) — placeholder screen, not wired up yet.
            </Text>
        </ScrollView>
    );
}