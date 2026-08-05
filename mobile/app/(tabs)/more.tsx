import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useAuth } from '../../src/store/auth';
import { useStoreSelection } from '../../src/store/storeSelection';
import { useSync, syncAll } from '../../src/db/sync';
import { usePrinter } from '../../src/printing/printer';
import { formatTime, useReminder } from '../../src/notifications/reminder';
import { errorMessage } from '../../src/api/client';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, Icon, SectionLabel, type IconName } from '../../src/ui/components';

export default function MoreScreen() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const store = useStoreSelection((s) => s.selected);
  const layout = useLayout();

  const online = useSync((s) => s.online);
  const syncing = useSync((s) => s.syncing);
  const pendingCount = useSync((s) => s.pendingCount);
  const lastSyncedAt = useSync((s) => s.lastSyncedAt);
  const printerName = usePrinter((s) => s.config?.name ?? null);
  const reminder = useReminder((s) => s.config);

  const [busy, setBusy] = useState(false);

  async function runSync() {
    if (!store) return;
    setBusy(true);
    try {
      await syncAll(store.id);
      Alert.alert('Sync complete', 'Queued sales sent and catalogue refreshed.');
    } catch (err) {
      Alert.alert('Sync failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmSignOut() {
    if (pendingCount > 0) {
      Alert.alert(
        'Unsent sales',
        `${pendingCount} offline sale(s) haven't reached the server yet. Sync before signing out, or they stay on this device.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign out anyway', style: 'destructive', onPress: () => void signOut() },
        ]
      );
      return;
    }
    void signOut();
  }

  const initials = (user?.full_name ?? '?')
    .split(' ')
    .map((p) => p.charAt(0))
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, gap: spacing.lg, paddingBottom: spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.profile}>
          <View style={styles.profileGlow} />
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.name}>{user?.full_name ?? 'Unknown user'}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          <View style={styles.rolePill}>
            <Icon name="shield" size={12} color={colors.accent} />
            <Text style={styles.roleText}>{user?.role ?? 'user'}</Text>
          </View>
        </View>

        <View>
          <SectionLabel>Day</SectionLabel>
          <View style={styles.card}>
            <LinkRow
              icon="file-text"
              label="Sales History"
              value="Receipts, refunds, reprints"
              onPress={() => router.push('/sales')}
            />
            <View style={styles.divider} />
            <LinkRow
              icon="clipboard"
              label="Day Report"
              value="Z-report and End Session"
              onPress={() => router.push('/day-report')}
            />
            <View style={styles.divider} />
            <LinkRow
              icon="bell"
              label="Closing Reminder"
              value={reminder.enabled ? `Daily at ${formatTime(reminder.hour, reminder.minute)}` : 'Off'}
              onPress={() => router.push('/reminder')}
            />
          </View>
        </View>

        <View>
          <SectionLabel>Configuration</SectionLabel>
          <View style={styles.card}>
            <LinkRow
              icon="home"
              label="Current Store"
              value={store?.name ?? 'None selected'}
              onPress={() => router.push('/store-picker')}
            />
            <View style={styles.divider} />
            <LinkRow
              icon="printer"
              label="Receipt Printer"
              value={printerName ?? 'Not set up'}
              onPress={() => router.push('/printer')}
            />
          </View>
        </View>

        <View>
          <SectionLabel>Sync</SectionLabel>
          <View style={styles.card}>
            <View style={styles.statRow}>
              <View style={styles.statLeft}>
                <Icon name={online ? 'wifi' : 'wifi-off'} size={16} color={colors.textMuted} />
                <Text style={styles.statLabel}>Connection</Text>
              </View>
              <Badge label={online ? 'Online' : 'Offline'} tone={online ? 'success' : 'warning'} dot />
            </View>

            <View style={styles.divider} />

            <View style={styles.statRow}>
              <View style={styles.statLeft}>
                <Icon name="upload-cloud" size={16} color={colors.textMuted} />
                <Text style={styles.statLabel}>Queued sales</Text>
              </View>
              <Text style={[styles.statValue, pendingCount > 0 && { color: colors.warning }]}>
                {pendingCount}
              </Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.statRow}>
              <View style={styles.statLeft}>
                <Icon name="clock" size={16} color={colors.textMuted} />
                <Text style={styles.statLabel}>Last sync</Text>
              </View>
              <Text style={styles.statValue}>
                {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : 'Never'}
              </Text>
            </View>

            <Button
              label={syncing || busy ? 'Syncing' : 'Sync Now'}
              icon="refresh-cw"
              onPress={runSync}
              loading={syncing || busy}
              disabled={!store || !online}
              variant="secondary"
              style={{ marginTop: spacing.md }}
            />
            {!online ? (
              <Text style={styles.note}>
                Queued sales send themselves as soon as the connection returns.
              </Text>
            ) : null}
          </View>
        </View>

        <Button label="Sign Out" variant="danger" icon="log-out" onPress={confirmSignOut} />
      </ScrollView>
    </SafeAreaView>
  );
}

function LinkRow({
  icon,
  label,
  value,
  onPress,
}: {
  icon: IconName;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.linkRow} onPress={onPress}>
      <View style={styles.linkIcon}>
        <Icon name={icon} size={17} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.linkLabel}>{label}</Text>
        <Text style={styles.linkValue} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  profile: {
    alignItems: 'center',
    backgroundColor: colors.primaryDeep,
    borderRadius: radius.xl,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    overflow: 'hidden',
    ...shadow.raised,
  },
  profileGlow: {
    position: 'absolute',
    top: -80,
    left: -60,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: colors.primaryBright,
    opacity: 0.35,
  },
  avatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontFamily: font.extrabold, fontSize: 24, color: colors.primaryDeep },
  name: {
    fontFamily: font.bold,
    fontSize: 20,
    color: colors.onDark,
    marginTop: spacing.md,
    letterSpacing: -0.3,
  },
  email: { fontFamily: font.regular, fontSize: 13, color: colors.onDarkMuted, marginTop: 2 },
  rolePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.13)',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.pill,
    marginTop: spacing.md,
  },
  roleText: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.onDark,
    textTransform: 'capitalize',
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },

  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  linkIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkLabel: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  linkValue: { fontFamily: font.semibold, fontSize: 15, color: colors.text, marginTop: 1 },

  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statLabel: { fontFamily: font.medium, fontSize: 14, color: colors.textMuted },
  statValue: { fontFamily: font.semibold, fontSize: 13, color: colors.text },

  note: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});
