import React, {RefObject} from 'react';
import {StyleSheet, Text} from 'react-native';
import {BottomSheetModal, BottomSheetView,} from '@gorhom/bottom-sheet';
import {SharedValue, useSharedValue} from "react-native-reanimated";

export default function RouteBottomSheetModal({ref, animatedPosition}:
                                              {
                                                  ref: RefObject<BottomSheetModal | null>,
                                                  animatedPosition: SharedValue<number>
                                              }) {


    return (
        <BottomSheetModal ref={ref}
                          animatedPosition={animatedPosition}>
            <BottomSheetView style={styles.contentContainer}>
                <Text>Awesome 🎉</Text>
            </BottomSheetView>
        </BottomSheetModal>
    )
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 24,
        justifyContent: 'center',
        backgroundColor: 'grey',
    },
    contentContainer: {
        flex: 1,
        alignItems: 'center',
    },
});
