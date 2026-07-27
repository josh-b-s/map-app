import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useThemeStyle } from '@/constants/themes';

export default function GtfsData() {
    const theme = useThemeStyle();

    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.backgroundColor }} contentContainerStyle={{ padding: 16 }}>
            <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13 }}>
                GTFS region/feed management — placeholder. No import flow wired up yet.
            </Text>
        </ScrollView>
    );
}