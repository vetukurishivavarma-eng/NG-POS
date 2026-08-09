import React, { useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { devices as devicesApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useAuth } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { bevel, colors, font, radius, shadow, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../src/ui/components';
import type { DeviceSession } from '../src/api/types';

/**
 * Which phone is holding which account.
 *
 * One account signs in on one device, so when a cashier says "it won't let me
 * in", this screen is the answer: it names the handset that has the account and
 * lets an administrator release it.
 */
export default function DevicesScreen() {
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === 'ORG_ADMIN';
  const layout = useLayout();
  const queryClient = useQueryClient();

  const [showRemoved, setShowRemoved] = useState(false);

  const query = useQuery({
    queryKey: ['devices', showRemoved],
    queryFn: () => devicesApi.list({ include_revoked: showRemoved }),
    // Someone is usually standing at the till while this is open.
    refetchInterval: 30_000,
  });

  const remove = useMutation({
    mutationFn: (device: DeviceSession) => devicesApi.remove(device.id, 'Removed by administrator'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err) => Alert.alert("Couldn't remove the device", errorMessage(err)),
  });

  const rows = query.data ?? [];
  const active = useMemo(() => rows.filter((d) => d.is_active).length, [rows]);

  function confirmRemove(device: DeviceSession) {
    const who = device.user?.full_name ?? 'this account';
    Alert.alert(
      `Remove ${device.device_name}?`,
      `${who} will be signed out on that device straight away, and will be able to sign in on a different one. Their sales already synced are not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => remove.mutate(device) },
      ]
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={[styles.head, { paddingHorizontal: layout.gutter }]}>
        <Text style={styles.lede}>
          Each account may be signed in on one device at a time. Removing a device frees the account
          so it can be used on another one.
        </Text>
        <View style={styles.headRow}>
          <Badge label={`${active} signed in`} tone={active > 0 ? 'success' : 'neutral'} dot />
          <Pressable onPress={() => setShowRemoved((v) => !v)} hitSlop={8}>
            <Text style={styles.toggle}>{showRemoved ? 'Hide removed' : 'Show removed'}</Text>
          </Pressable>
        </View>
      </View>

      {query.isLoading ? (
        <Loading label="Loading devices" />
      ) : query.isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load devices"
          hint={errorMessage(query.error)}
          action={<Button label="Retry" icon="refresh-cw" variant="secondary" onPress={() => void query.refetch()} />}
        />
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ paddingHorizontal: layout.gutter, paddingBottom: spacing.xxl }}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={query.refetch} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <EmptyState
              icon="smartphone"
              title="Nobody is signed in"
              hint="Devices appear here as staff sign in to the app."
            />
          }
          renderItem={({ item }) => (
            <DeviceCard
              device={item}
              canRemove={isAdmin && item.is_active}
              busy={remove.isPending && remove.variables?.id === item.id}
              onRemove={() => confirmRemove(item)}
            />
          )}
        />
      )}

      {!isAdmin ? (
        <View style={styles.readOnly}>
          <Icon name="eye" size={14} color={colors.textMuted} />
          <Text style={styles.readOnlyText}>
            Only an administrator can remove a device.
          </Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function DeviceCard({
  device,
  canRemove,
  busy,
  onRemove,
}: {
  device: DeviceSession;
  canRemove: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <View style={[styles.card, !device.is_active && styles.cardRemoved]}>
      <View style={styles.cardTop}>
        <View style={[styles.icon, !device.is_active && styles.iconRemoved]}>
          <Icon
            name="smartphone"
            size={18}
            color={device.is_active ? colors.primary : colors.textFaint}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {device.device_name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {device.user?.full_name ?? 'Unknown user'}
            {device.user?.email ? ` · ${device.user.email}` : ''}
          </Text>
        </View>
        {device.is_active ? (
          <Badge label="Signed in" tone="success" dot />
        ) : (
          <Badge label="Removed" tone="neutral" />
        )}
      </View>

      <View style={styles.facts}>
        <Fact label="Last used" value={relativeTime(device.last_seen_at)} />
        <Fact label="Signed in" value={shortDate(device.created_at)} />
        <Fact label="App" value={device.app_version ?? '—'} />
      </View>

      {!device.is_active && device.revoked_reason ? (
        <Text style={styles.removedNote}>
          {device.revoked_reason} · {shortDate(device.revoked_at ?? device.created_at)}
        </Text>
      ) : null}

      {canRemove ? (
        <Button label="Remove device" variant="danger" icon="log-out" loading={busy} onPress={onRemove} />
      ) : null}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/**
 * "4 minutes ago" answers the question an admin is actually asking — is this
 * still in use? — where a timestamp makes them do the arithmetic.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { paddingVertical: spacing.md, gap: spacing.sm },
  lede: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggle: { fontFamily: font.semibold, fontSize: 13, color: colors.primary },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderLeftColor: colors.border,
    borderRightColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.md,
    ...bevel.light,
    ...shadow.tile,
  },
  cardRemoved: { opacity: 0.72, backgroundColor: colors.surfaceSunken },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    ...bevel.light,
  },
  iconRemoved: { backgroundColor: colors.surfaceSunken },
  name: { fontFamily: font.bold, fontSize: 15, color: colors.text },
  meta: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 1 },

  facts: { flexDirection: 'row', gap: spacing.md },
  fact: { flex: 1 },
  factLabel: {
    fontFamily: font.semibold,
    fontSize: 10,
    color: colors.textFaint,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  factValue: { fontFamily: font.semibold, fontSize: 13, color: colors.text, marginTop: 2 },

  removedNote: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted },

  readOnly: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceSunken,
  },
  readOnlyText: { fontFamily: font.medium, fontSize: 12, color: colors.textMuted },
});
