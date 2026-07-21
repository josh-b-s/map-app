import React, { forwardRef, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { SharedValue } from 'react-native-reanimated';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '@/store/store';
import { SHADOW, TOP_SAFE, useThemeStyle } from '@/constants/themes';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { selectJourney } from '@/store/route.slice';
import { classifyRouteType } from '@/services/routeTypeUtil';

type Props = {
    animatedPosition: SharedValue<number>;
};

type SortKey = 'arrival' | 'walking' | 'transfers';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: 'arrival',   label: 'Fastest' },
    { key: 'walking',   label: 'Least walking' },
    { key: 'transfers', label: 'Fewest transfers' },
];

const RouteBottomSheetModal = forwardRef<BottomSheetModal, Props>(
    ({ animatedPosition }, ref) => {
        const theme = useThemeStyle();
        const dispatch = useDispatch<AppDispatch>();
        const { journeys = [], selectedJourneyIndex, error } = useSelector((s: RootState) => s.route);
        const [sortKey, setSortKey] = useState<SortKey>('arrival');

        // Sort for DISPLAY only — selection is always by original journeys[]
        // index so the map/state stays in sync regardless of sort order.
        const sorted = useMemo(
            () => journeys.map((j, i) => ({ journey: j, originalIndex: i }))
                .sort((a, b) => {
                    switch (sortKey) {
                        case 'walking':   return a.journey.totalWalkingMeters - b.journey.totalWalkingMeters;
                        case 'transfers': return a.journey.transferCount - b.journey.transferCount;
                        case 'arrival':
                        default:          return a.journey.arrivalTime.localeCompare(b.journey.arrivalTime);
                    }
                }),
            [journeys, sortKey],
        );

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
                snapPoints={['10%', '40%', '100%']}
                enableOverDrag={false}
                enablePanDownToClose={false}
            >
                <BottomSheetView style={{ flex: 1, paddingTop: 16 }}>
                    {error ? (
                        <View style={{ padding: 24 }}>
                            <Text style={{ color: '#ef4444', fontSize: 16 }}>{error}</Text>
                        </View>
                    ) : journeys.length === 0 ? (
                        <View style={{ padding: 24 }}>
                            <Text style={{ color: theme.color, opacity: 0.5 }}>Calculating route...</Text>
                        </View>
                    ) : (
                        <>
                            {/* Sort control — only worth showing when there's more than one option */}
                            {journeys.length > 1 && (
                                <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 24, paddingBottom: 12 }}>
                                    {SORT_OPTIONS.map(opt => {
                                        const active = sortKey === opt.key;
                                        return (
                                            <Pressable
                                                key={opt.key}
                                                onPress={() => setSortKey(opt.key)}
                                                style={{
                                                    paddingHorizontal: 12,
                                                    paddingVertical: 6,
                                                    borderRadius: 999,
                                                    backgroundColor: active ? '#2563eb' : theme.backgroundColor,
                                                    borderWidth: 1,
                                                    borderColor: active ? '#2563eb' : theme.color + '33',
                                                }}
                                            >
                                                <Text style={{ color: active ? '#fff' : theme.color, fontSize: 13, fontWeight: '600' }}>
                                                    {opt.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            )}

                            <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24, gap: 12 }}>
                                {sorted.map(({ journey, originalIndex }) => {
                                    const isSelected = originalIndex === selectedJourneyIndex;
                                    return (
                                        <Pressable
                                            key={originalIndex}
                                            onPress={() => dispatch(selectJourney(originalIndex))}
                                            style={{
                                                borderRadius: 20,
                                                borderWidth: 2,
                                                borderColor: isSelected ? '#2563eb' : theme.color + '22',
                                                backgroundColor: isSelected ? '#2563eb11' : 'transparent',
                                                padding: 16,
                                                gap: 8,
                                            }}
                                        >
                                            {/* Summary row: times + duration */}
                                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                                                <Text style={{ color: theme.color, fontSize: 22, fontWeight: '700' }}>
                                                    {journey.departureTime} → {journey.arrivalTime}
                                                </Text>
                                                <Text style={{ color: theme.color, opacity: 0.6, fontSize: 14 }}>
                                                    {journey.totalDurationMin} min
                                                </Text>
                                            </View>

                                            {/* Meta row: walking distance + transfer count */}
                                            <Text style={{ color: theme.color, opacity: 0.6, fontSize: 13 }}>
                                                {Math.round(journey.totalWalkingMeters)}m walking · {journey.transferCount} transfer{journey.transferCount === 1 ? '' : 's'}
                                            </Text>

                                            {/* Leg pills */}
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                                                {journey.legs.map((leg, i) => (
                                                    <View
                                                        key={i}
                                                        style={{
                                                            flexDirection: 'row',
                                                            alignItems: 'center',
                                                            gap: 6,
                                                            paddingHorizontal: 10,
                                                            paddingVertical: 5,
                                                            borderRadius: 999,
                                                            backgroundColor: leg.routeColor ?? '#2563eb',
                                                        }}
                                                    >
                                                        <Text style={{ color: leg.routeTextColor ?? '#fff', fontSize: 13, fontWeight: '700' }}>
                                                            {classifyRouteType(leg.routeType).label} {leg.routeName}
                                                        </Text>
                                                    </View>
                                                ))}
                                            </View>

                                            {isSelected && (
                                                <View style={{ gap: 4, marginTop: 8 }}>
                                                    {journey.legs.map((leg, i) => (
                                                        <View key={i}>
                                                            <Text style={{ color: theme.color, opacity: 0.7, fontSize: 13 }}>
                                                                Board at {leg.originStopName}{leg.departureTime ? ` (${leg.departureTime})` : ''}
                                                            </Text>
                                                            <Text style={{ color: theme.color, opacity: 0.7, fontSize: 13 }}>
                                                                Alight at {leg.destStopName}{leg.arrivalTime ? ` (${leg.arrivalTime})` : ''}
                                                            </Text>
                                                            {i < journey.legs.length - 1 && (
                                                                <Text style={{ color: '#f59e0b', fontSize: 13, marginTop: 2 }}>
                                                                    ↓ Transfer
                                                                </Text>
                                                            )}
                                                        </View>
                                                    ))}
                                                </View>
                                            )}
                                        </Pressable>
                                    );
                                })}
                            </BottomSheetScrollView>
                        </>
                    )}
                </BottomSheetView>
            </BottomSheetModal>
        );
    }
);

export default RouteBottomSheetModal;