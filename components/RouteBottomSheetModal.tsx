import React, { RefObject } from 'react';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { SharedValue } from 'react-native-reanimated';
import { SHADOW, TOP_SAFE, useThemeStyle } from '@/constants/themes';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function RouteBottomSheetModal({ ref, animatedPosition }: {
    ref: RefObject<BottomSheetModal | null>;
    animatedPosition: SharedValue<number>;
}) {
    const theme = useThemeStyle();

    return (
        <BottomSheetModal
            ref={ref}
            animatedPosition={animatedPosition}
            backgroundStyle={{ backgroundColor: theme.backgroundColor, borderTopLeftRadius: 40, borderTopRightRadius: 40 }}
            handleIndicatorStyle={{ backgroundColor: theme.color }}
            style={[SHADOW, { borderTopLeftRadius: 40, borderTopRightRadius: 40 }]}
            topInset={TOP_SAFE(useSafeAreaInsets())}
            snapPoints={['40%', '100%']}
            enableOverDrag={false}
        >
            <BottomSheetView className="flex-1 items-center justify-center">
                TODO: render GTFS route options here
            </BottomSheetView>
        </BottomSheetModal>
    );
}