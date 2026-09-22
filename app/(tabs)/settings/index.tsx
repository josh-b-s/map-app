import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useThemeStyle } from '@/constants/themes';

type MenuItem = {
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    subtitle: string;
    route: '/settings/preferences' | '/settings/gtfs';
};

const ITEMS: MenuItem[] = [
    {
        icon: 'options-outline',
        title: 'Preferences',
        subtitle: 'Theme, default walking speed, units',
        route: '/settings/preferences',
    },
    {
        icon: 'bus-outline',
        title: 'GTFS Data',
        subtitle: 'Manage transit regions and feeds',
        route: '/settings/gtfs',
    },
];

export default function SettingsMenu() {
    const theme = useThemeStyle();
    const router = useRouter();

    return (
        <ScrollView style={{ flex: 1, backgroundColor: theme.surfaceColor }} contentContainerStyle={{ padding: 16, gap: 12 }}>
            {ITEMS.map((item) => (
                <Pressable
                    key={item.route}
                    onPress={() => router.push(item.route)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 14,
                        padding: 16,
                        borderRadius: 16,
                        backgroundColor: theme.backgroundColor,
                    }}
                >
                    <View
                        style={{
                            width: 40, height: 40, borderRadius: 12,
                            backgroundColor: '#2563eb22',
                            alignItems: 'center', justifyContent: 'center',
                        }}
                    >
                        <Ionicons name={item.icon} size={20} color="#2563eb" />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={{ color: theme.color, fontSize: 16, fontWeight: '600' }}>{item.title}</Text>
                        <Text style={{ color: theme.color, opacity: 0.5, fontSize: 13, marginTop: 2 }}>{item.subtitle}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={theme.color + '66'} />
                </Pressable>
            ))}
        </ScrollView>
    );
}