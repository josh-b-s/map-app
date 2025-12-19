import React, {RefObject} from 'react';
import {Text} from 'react-native';
import {BottomSheetModal, BottomSheetView} from '@gorhom/bottom-sheet';
import {SharedValue} from 'react-native-reanimated';
import {SHADOW, TOP_SAFE, useThemeStyle} from "@/constants/themes";
import {useSafeAreaInsets} from "react-native-safe-area-context";

export default function RouteBottomSheetModal({
                                                  ref,
                                                  animatedPosition,
                                              }: {
    ref: RefObject<BottomSheetModal | null>;
    animatedPosition: SharedValue<number>;
}) {
    return (
        <BottomSheetModal ref={ref} animatedPosition={animatedPosition}
                          backgroundStyle={{
                              backgroundColor: useThemeStyle().backgroundColor,
                              borderTopLeftRadius: 40,
                              borderTopRightRadius: 40,
                          }}
                          handleIndicatorStyle={{backgroundColor: useThemeStyle().color}}
                          style={[SHADOW, {
                              borderTopLeftRadius: 40,
                              borderTopRightRadius: 40,
                          }]}
                          topInset={TOP_SAFE(useSafeAreaInsets())}
                          snapPoints={["100%"]}
                          enableOverDrag={false}
        >
            <BottomSheetView className={`flex-1 items-center justify-center`}>
                <Text className="text-red-800">Awesome 🎉</Text>
            </BottomSheetView>
        </BottomSheetModal>
    );
}
