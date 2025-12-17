import React, {RefObject} from 'react';
import {StyleSheet, Text} from 'react-native';
import {BottomSheetModal, BottomSheetView,} from '@gorhom/bottom-sheet';

export default function RouteBottomSheetModal({ref}: { ref: RefObject<BottomSheetModal | null> }) {
    return (
        <BottomSheetModal ref={ref}>
            <BottomSheetView style={styles.contentContainer}>
                <Text>Awesome 🎉</Text>
            </BottomSheetView>
        </BottomSheetModal>
    )
        ;
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
