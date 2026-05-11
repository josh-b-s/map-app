import React, { RefObject } from 'react';
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

export default function RouteBottomSheetModal({ ref, animatedPosition }: {
    ref: RefObject<BottomSheetModal | null>;
    animatedPosition: SharedValue<number>;
}) {
    const theme = useThemeStyle();
    const { routeName, routeType, originStopName, destStopName, error } =
        useSelector((s: RootState) => s.route);

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
                ) : routeName ? (
                    <View style={{ gap: 8 }}>
                        <Text style={{ color: theme.color, fontSize: 22, fontWeight: '700' }}>
                            {ROUTE_TYPE_LABEL[routeType ?? 3] ?? 'Transit'} {routeName}
                        </Text>
                        <Text style={{ color: theme.color, opacity: 0.7, fontSize: 15 }}>
                            Board at {originStopName}
                        </Text>
                        <Text style={{ color: theme.color, opacity: 0.7, fontSize: 15 }}>
                            Alight at {destStopName}
                        </Text>
                    </View>
                ) : (
                    <Text style={{ color: theme.color, opacity: 0.5 }}>
                        Calculating route…
                    </Text>
                )}
            </BottomSheetView>
        </BottomSheetModal>
    );
}