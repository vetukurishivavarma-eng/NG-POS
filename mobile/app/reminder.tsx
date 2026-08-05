import React, { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  formatTime,
  useReminder,
  type ReminderConfig,
} from '../src/notifications/reminder';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, spacing } from '../src/theme';
import { Button, Icon } from '../src/ui/components';

/** Closing times that actually occur in a shop rota. */
const PRESETS: { hour: number; minute: number }[] = [
  { hour: 17, minute: 0 },
  { hour: 18, minute: 0 },
  { hour: 19, minute: 30 },
  { hour: 20, minute: 30 },
  { hour: 21, minute: 0 },
];

export default function ReminderScreen() {
  const layout = useLayout();
  const config = useReminder((s) => s.config);
  const save = useReminder((s) => s.save);

  const [draft, setDraft] = useState<ReminderConfig>(config);
  const [busy, setBusy] = useState(false);

  const dirty =
    draft.enabled !== config.enabled ||
    draft.hour !== config.hour ||
    draft.minute !== config.minute;

  function shift(minutes: number) {
    const total = (draft.hour * 60 + draft.minute + minutes + 24 * 60) % (24 * 60);
    setDraft({ ...draft, hour: Math.floor(total / 60), minute: total % 60 });
  }

  async function apply() {
    setBusy(true);
    try {
      const scheduled = await save(draft);

      if (draft.enabled && !scheduled) {
        // Permission was refused. Saying nothing here is how a shop discovers
        // weeks later that the reminder never fired.
        Alert.alert(
          'Notifications are blocked',
          'Android is not letting NG POS post notifications, so the reminder cannot be set. Allow notifications for this app and try again.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => void Linking.openSettings() },
          ]
        );
        setDraft(useReminder.getState().config);
        return;
      }

      if (scheduled) {
        Alert.alert(
          'Reminder set',
          `You'll be prompted to close the day at ${formatTime(draft.hour, draft.minute)} every day.`
        );
      }
    } catch (err) {
      Alert.alert(
        'Could not set the reminder',
        err instanceof Error ? err.message : 'Notifications may be blocked for this app.',
        [
          { text: 'OK', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Daily reminder</Text>
              <Text style={styles.toggleHint}>
                A notification at closing time to print the day report and end the session.
              </Text>
            </View>
            <Switch
              value={draft.enabled}
              onValueChange={(enabled) => setDraft({ ...draft, enabled })}
              trackColor={{ false: colors.borderStrong, true: colors.primary }}
              thumbColor={colors.surface}
            />
          </View>
        </View>

        <View style={[styles.card, !draft.enabled && { opacity: 0.45 }]} pointerEvents={draft.enabled ? 'auto' : 'none'}>
          <Text style={styles.cardLabel}>Time</Text>

          <View style={styles.clock}>
            <Pressable onPress={() => shift(-30)} style={styles.clockBtn} hitSlop={6}>
              <Icon name="minus" size={20} color={colors.text} />
            </Pressable>
            <Text style={styles.clockValue}>{formatTime(draft.hour, draft.minute)}</Text>
            <Pressable onPress={() => shift(30)} style={styles.clockBtn} hitSlop={6}>
              <Icon name="plus" size={20} color={colors.text} />
            </Pressable>
          </View>

          <View style={styles.presets}>
            {PRESETS.map((p) => {
              const active = draft.hour === p.hour && draft.minute === p.minute;
              return (
                <Pressable
                  key={formatTime(p.hour, p.minute)}
                  onPress={() => setDraft({ ...draft, ...p })}
                  style={[styles.preset, active && styles.presetActive]}
                >
                  <Text style={[styles.presetText, active && styles.presetTextActive]}>
                    {formatTime(p.hour, p.minute)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.note}>
          <Icon name="info" size={15} color={colors.info} />
          <Text style={styles.noteText}>
            The reminder is scheduled on this device, so it fires with or without a connection. The
            server still snapshots the day's figures on its own schedule either way.
          </Text>
        </View>

        <Button
          label={draft.enabled ? 'Save Reminder' : 'Turn Off Reminder'}
          icon="check"
          loading={busy}
          disabled={!dirty}
          onPress={() => void apply()}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  toggleLabel: { fontFamily: font.semibold, fontSize: 16, color: colors.text },
  toggleHint: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 3,
    lineHeight: 17,
  },

  clock: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.lg,
    padding: spacing.sm,
  },
  clockBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockValue: {
    fontFamily: font.extrabold,
    fontSize: 34,
    color: colors.text,
    letterSpacing: -1,
  },

  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.md },
  preset: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSunken,
  },
  presetActive: { backgroundColor: colors.primary },
  presetText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },
  presetTextActive: { color: '#fff' },

  note: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.infoSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noteText: { flex: 1, fontFamily: font.regular, fontSize: 12, color: colors.info, lineHeight: 17 },
});
