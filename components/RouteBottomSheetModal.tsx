import React, {RefObject} from 'react';
import {Text} from 'react-native';
import {BottomSheetModal, BottomSheetView} from '@gorhom/bottom-sheet';
import {SharedValue} from 'react-native-reanimated';
import {useThemeStyle} from "@/constants/themes";

export default function RouteBottomSheetModal({
                                                  ref,
                                                  animatedPosition,
                                              }: {
    ref: RefObject<BottomSheetModal | null>;
    animatedPosition: SharedValue<number>;
}) {
    return (
        <BottomSheetModal ref={ref} animatedPosition={animatedPosition}
                          backgroundStyle={{backgroundColor: useThemeStyle().backgroundColor}}>
            <BottomSheetView className={`flex-1 items-center justify-center`}>
                <Text className="text-red-800">Awesome 🎉</Text>
            </BottomSheetView>
        </BottomSheetModal>
    );
}
