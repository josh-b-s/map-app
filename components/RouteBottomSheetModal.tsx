import React, { forwardRef } from 'react';
import { Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { SharedValue } from 'react-native-reanimated';
import { useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import { SHADOW, TOP_SAFE, useThemeStyle } from '@/constants/themes';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ROUTE_TYPE_LABEL: Record<number, string> = {
    0: 'Tram',
    1: 'Metro',
    2: 'Train',
    3: 'Bus',
    4: 'Ferry',
};

type Props = {
    animatedPosition: SharedValue<number>;
};

const RouteBottomSheetModal = forwardRef<BottomSheetModal, Props>(
    ({ animatedPosition }, ref) => {
        const theme = useThemeStyle();
        const { legs = [], error } = useSelector((s: RootState) => s.route);

        return (
            <BottomSheetModal
                ref={ref}
                animatedPosition={animatedPosition}
                backgroundStyle={{
                    backgroundColor: theme.backgroundColor,
                    borderTopLeftRadius: 40,
                    borderTopRightRadius: 40,
                }}
                handleIndicatorStyle={{ backgroundColor: theme.color }}
                style={[SHADOW, { borderTopLeftRadius: 40, borderTopRightRadius: 40 }]}
                topInset={TOP_SAFE(useSafeAreaInsets())}
                snapPoints={['40%', '100%']}
                enableOverDrag={false}
            >
                <BottomSheetView style={{ flex: 1, padding: 24 }}>
                    {error ? (
                        <Text style={{ color: '#ef4444', fontSize: 16 }}>{error}</Text>
                    ) : legs.length > 0 ? (
                        <View style={{ gap: 16 }}>
                            {legs.map((leg, i) => (
                                <View key={i} style={{ gap: 4 }}>
                                    <Text
                                        style={{
                                            color: leg.routeTextColor ?? theme.color,
                                            fontSize: 20,
                                            fontWeight: '700',
                                        }}
                                    >
                                        {ROUTE_TYPE_LABEL[leg.routeType] ?? 'Transit'} {leg.routeName}
                                    </Text>
                                    <Text style={{ color: theme.color, opacity: 0.7 }}>
                                        Board at {leg.originStopName}
                                    </Text>
                                    <Text style={{ color: theme.color, opacity: 0.7 }}>
                                        Alight at {leg.destStopName}
                                    </Text>
                                    <View
                                        style={{
                                            height: 4,
                                            width: 42,
                                            borderRadius: 999,
                                            backgroundColor: leg.routeColor ?? '#2563eb',
                                            marginTop: 6,
                                        }}
                                    />
                                    {i < legs.length - 1 && (
                                        <Text style={{ color: '#f59e0b', marginTop: 4 }}>
                                            ↓ Transfer here
                                        </Text>
                                    )}
                                </View>
                            ))}
                        </View>
                    ) : (
                        <Text style={{ color: theme.color, opacity: 0.5 }}>Calculating route...</Text>
                    )}
                </BottomSheetView>
            </BottomSheetModal>
        );
    }
);

export default RouteBottomSheetModal;