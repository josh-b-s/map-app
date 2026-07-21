import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SHADOW, useThemeStyle } from '@/constants/themes';

type Props = {
    visible: boolean;
    /** Current value, or null for "leave now." */
    value: number | null;
    onClose: () => void;
    /** Called with epoch ms on Confirm, or null on "Leave now." */
    onConfirm: (epochMs: number | null) => void;
};

const DAY_LABELS_AHEAD = 6; // "Today" + next 6 days, a week's worth of horizontal choices

function startOfDay(d: Date): Date {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

function dayLabel(d: Date, todayStart: Date): string {
    const diffDays = Math.round((startOfDay(d).getTime() - todayStart.getTime()) / 86_400_000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

function clampMinutes(m: number): number {
    return ((m % 60) + 60) % 60;
}
function clampHours(h: number): number {
    return ((h % 24) + 24) % 24;
}

/**
 * Custom departure date/time picker — deliberately NOT
 * @react-native-community/datetimepicker. That library's mode="datetime"
 * chains a native date-dialog then a time-dialog internally on Android,
 * and that chained reopen/dismiss cycle is a longstanding, still-open
 * upstream bug (react-native-datetimepicker#768/#907 — "Cannot read
 * property 'dismiss' of undefined") with no real fix, only workarounds.
 * Splitting into two sequential single-mode pickers avoided the crash but
 * still flashed a jarring native dialog transition. This custom modal
 * sidesteps the whole class of bug (and matches the rest of the app's
 * pill/card visual language) at the cost of a slightly less "native feel"
 * date scroller — a day-strip + hour/minute steppers, rather than a wheel.
 */
export default function DepartureTimeModal({ visible, value, onClose, onConfirm }: Props) {
    const theme = useThemeStyle();

    // Working copy — only committed to the parent on Confirm, so
    // dismissing (backdrop tap / Cancel) never mutates the real value.
    const [draft, setDraft] = useState<Date>(value ? new Date(value) : new Date());

    // Re-sync the draft whenever the modal opens with a (possibly changed)
    // external value — otherwise reopening after a Confirm would keep
    // showing whatever was left over from the previous session.
    useEffect(() => {
        if (visible) setDraft(value ? new Date(value) : new Date());
    }, [visible, value]);

    const todayStart = startOfDay(new Date());
    const days = Array.from({ length: DAY_LABELS_AHEAD + 1 }, (_, i) => {
        const d = new Date(todayStart);
        d.setDate(d.getDate() + i);
        return d;
    });

    function selectDay(d: Date) {
        setDraft(prev => {
            const next = new Date(d);
            next.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
            return next;
        });
    }

    function adjustHour(delta: number) {
        setDraft(prev => {
            const next = new Date(prev);
            next.setHours(clampHours(prev.getHours() + delta));
            return next;
        });
    }

    function adjustMinute(delta: number) {
        setDraft(prev => {
            const next = new Date(prev);
            next.setMinutes(clampMinutes(prev.getMinutes() + delta));
            return next;
        });
    }

    const selectedDayIdx = days.findIndex(d => startOfDay(d).getTime() === startOfDay(draft).getTime());

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable
                style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 }}
                onPress={onClose}
            >
                {/* Inner Pressable with no-op onPress stops the backdrop's onPress
                    from firing when tapping inside the card itself. */}
                <Pressable onPress={() => {}}>
                    <View
                        style={[
                            { backgroundColor: theme.backgroundColor, borderRadius: 28, padding: 20, gap: 16 },
                            SHADOW,
                        ]}
                    >
                        <Text style={{ color: theme.color, fontSize: 18, fontWeight: '700' }}>
                            Departure time
                        </Text>

                        {/* Day strip */}
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {days.map((d, i) => {
                                const active = i === selectedDayIdx;
                                return (
                                    <TouchableOpacity
                                        key={i}
                                        onPress={() => selectDay(d)}
                                        style={{
                                            paddingHorizontal: 12,
                                            paddingVertical: 8,
                                            borderRadius: 999,
                                            backgroundColor: active ? '#2563eb' : theme.color + '11',
                                        }}
                                    >
                                        <Text style={{ color: active ? '#fff' : theme.color, fontSize: 13, fontWeight: '600' }}>
                                            {dayLabel(d, todayStart)}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>

                        {/* Hour / minute steppers */}
                        <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 20 }}>
                            <Stepper
                                label={String(draft.getHours()).padStart(2, '0')}
                                onIncrement={() => adjustHour(1)}
                                onDecrement={() => adjustHour(-1)}
                                color={theme.color}
                            />
                            <Text style={{ color: theme.color, fontSize: 28, fontWeight: '700' }}>:</Text>
                            <Stepper
                                label={String(draft.getMinutes()).padStart(2, '0')}
                                onIncrement={() => adjustMinute(5)}
                                onDecrement={() => adjustMinute(-5)}
                                color={theme.color}
                            />
                        </View>

                        {/* Actions */}
                        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                            <TouchableOpacity
                                style={{ flex: 1, paddingVertical: 12, borderRadius: 16, alignItems: 'center', backgroundColor: theme.color + '11' }}
                                onPress={() => { onConfirm(null); onClose(); }}
                            >
                                <Text style={{ color: theme.color, fontWeight: '600' }}>Leave now</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={{ flex: 1, paddingVertical: 12, borderRadius: 16, alignItems: 'center', backgroundColor: '#2563eb' }}
                                onPress={() => { onConfirm(draft.getTime()); onClose(); }}
                            >
                                <Text style={{ color: '#fff', fontWeight: '700' }}>Confirm</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

function Stepper({ label, onIncrement, onDecrement, color }: {
    label: string; onIncrement: () => void; onDecrement: () => void; color: string;
}) {
    return (
        <View style={{ alignItems: 'center', gap: 6 }}>
            <TouchableOpacity onPress={onIncrement} hitSlop={10}>
                <Ionicons name="chevron-up" size={20} color={color} />
            </TouchableOpacity>
            <Text style={{ color, fontSize: 32, fontWeight: '700', minWidth: 56, textAlign: 'center' }}>
                {label}
            </Text>
            <TouchableOpacity onPress={onDecrement} hitSlop={10}>
                <Ionicons name="chevron-down" size={20} color={color} />
            </TouchableOpacity>
        </View>
    );
}
