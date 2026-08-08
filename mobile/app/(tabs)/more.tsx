import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useAuth, roleLevel, useCan } from '../../src/store/auth';
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

  // Each of these mirrors a `requireRole` guard on the server, so a cashier is
  // never shown a screen whose every action would come back 403.
  const canWriteProducts = useCan('products.write');
  const canAdjustStock = useCan('stock.adjust');
  const canPrice = useCan('pricing.write');
  const canTransfer = useCan('transfers.create');
  const canViewStaff = useCan('users.view');
  const canWarehouses = useCan('warehouses.write');
  const canSettings = useCan('settings.write');
  const canImport = useCan('products.import');
  const canShops = useCan('stores.write');
  const canBuy = useCan('purchases.write');
  const seesReports = roleLevel(user) !== 'cashier';

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

        {canWriteProducts || canAdjustStock || canPrice ? (
          <View>
            <SectionLabel>Catalogue &amp; Stock</SectionLabel>
            <View style={styles.card}>
              {canWriteProducts ? (
                <>
                  <LinkRow
                    icon="package"
                    label="Products"
                    value="Add, edit and price the catalogue"
                    onPress={() => router.push('/products')}
                  />
                  <View style={styles.divider} />
                </>
              ) : null}
              {canImport ? (
                <>
                  <LinkRow
                    icon="upload"
                    label="Bulk Stock Upload"
                    value="Load a whole catalogue from a spreadsheet"
                    onPress={() => router.push('/stock-import')}
                  />
                  <View style={styles.divider} />
                </>
              ) : null}
              {canAdjustStock ? (
                <>
                  <LinkRow
                    icon="plus-square"
                    label="Adjust Stock"
                    value="Correct a count, write off damage"
                    onPress={() => router.push('/stock-adjust')}
                  />
                  <View style={styles.divider} />
                  <LinkRow
                    icon="activity"
                    label="Stock Movements"
                    value="Every change and who made it"
                    onPress={() => router.push('/movements')}
                  />
                  <View style={styles.divider} />
                </>
              ) : null}
              {canPrice ? (
                <LinkRow
                  icon="tag"
                  label="Store Pricing"
                  value="Prices that differ from the catalogue"
                  onPress={() => router.push('/store-pricing')}
                />
              ) : null}
            </View>
          </View>
        ) : null}

        {canBuy ? (
          <View>
            <SectionLabel>Buying</SectionLabel>
            <View style={styles.card}>
              <LinkRow
                icon="file-text"
                label="Supplier Invoices"
                value="Deliveries received and what is still owed"
                onPress={() => router.push('/purchases')}
              />
              <View style={styles.divider} />
              <LinkRow
                icon="download"
                label="Record a Delivery"
                value="Stock in, invoice filed, payment tracked"
                onPress={() => router.push('/purchases/new')}
              />
              <View style={styles.divider} />
              <LinkRow
                icon="truck"
                label="Suppliers"
                value="Who we buy from, and what we owe them"
                onPress={() => router.push('/suppliers')}
              />
            </View>
          </View>
        ) : null}

        {canTransfer || canWarehouses ? (
          <View>
            <SectionLabel>Distribution</SectionLabel>
            <View style={styles.card}>
              {canTransfer ? (
                <LinkRow
                  icon="truck"
                  label="Transfers"
                  value="Move stock between stores"
                  onPress={() => router.push('/transfers')}
                />
              ) : null}
              {canTransfer && canWarehouses ? <View style={styles.divider} /> : null}
              {canWarehouses ? (
                <LinkRow
                  icon="grid"
                  label="Warehouses"
                  value="Holding stock outside the shops"
                  onPress={() => router.push('/warehouses')}
                />
              ) : null}
            </View>
          </View>
        ) : null}

        {seesReports || canViewStaff || canSettings || canShops ? (
          <View>
            <SectionLabel>Business</SectionLabel>
            <View style={styles.card}>
              {canShops ? (
                <>
                  <LinkRow
                    icon="home"
                    label="Shops"
                    value="Open a branch, edit its address"
                    onPress={() => router.push('/shops')}
                  />
                  <View style={styles.divider} />
                </>
              ) : null}
              {seesReports ? (
                <LinkRow
                  icon="bar-chart-2"
                  label="Analytics"
                  value="Sales and profit by branch and product"
                  onPress={() => router.push('/analytics')}
                />
              ) : null}
              {seesReports && (canViewStaff || canSettings) ? <View style={styles.divider} /> : null}
              {canViewStaff ? (
                <LinkRow
                  icon="users"
                  label="Staff"
                  value="Who can sign in, and where"
                  onPress={() => router.push('/users')}
                />
              ) : null}
              {canViewStaff && canSettings ? <View style={styles.divider} /> : null}
              {canSettings ? (
                <LinkRow
                  icon="sliders"
                  label="Settings"
                  value="Organisation, VAT rate and currency"
                  onPress={() => router.push('/settings')}
                />
              ) : null}
            </View>
          </View>
        ) : null}

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
