import React, { useMemo } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { users as usersApi } from '../../src/api/endpoints';
import { useCan } from '../../src/store/auth';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../../src/ui/components';
import { ROLE_LABELS, type Role, type User } from '../../src/api/types';

/** Sections in seniority order, which is also how a manager thinks about a rota. */
const ROLE_ORDER: Role[] = ['ORG_ADMIN', 'STORE_MANAGER', 'CASHIER'];

export default function StaffListScreen() {
  const layout = useLayout();
  const canView = useCan('users.view');
  const canWrite = useCan('users.write');

  const query = useQuery({
    queryKey: ['users'],
    enabled: canView,
    queryFn: () => usersApi.list(),
  });

  const staff = useMemo(() => query.data ?? [], [query.data]);
  const sections = useMemo(() => groupByRole(staff), [staff]);
  const activeCount = staff.filter((u) => u.is_active).length;

  if (!canView) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="You don't have access to staff records"
          hint="Ask an administrator if you need to see who works here."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {query.isLoading ? (
        <Loading label="Loading staff" />
      ) : query.isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load staff"
          hint="Staff records are served live — they need a connection."
          action={
            <Button
              label="Retry"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => void query.refetch()}
            />
          }
        />
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(item) => (item.kind === 'header' ? `h-${item.key}` : item.user.id)}
          contentContainerStyle={{
            padding: layout.gutter,
            paddingBottom: spacing.xxl,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void query.refetch()}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            staff.length > 0 ? (
              <View style={styles.tally}>
                <Icon name="users" size={16} color={colors.primary} />
                <Text style={styles.tallyText}>
                  {staff.length} on the books · {activeCount} active
                </Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="users"
              title="No staff yet"
              hint="Everyone who signs in to the till appears here."
            />
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <View style={styles.groupHead}>
                <Text style={styles.groupLabel}>{item.label}</Text>
                <Text style={styles.groupCount}>{item.count}</Text>
              </View>
            ) : (
              <StaffRow user={item.user} />
            )
          }
        />
      )}

      {canWrite ? (
        <View style={[styles.actionBar, { paddingHorizontal: layout.gutter }]}>
          <Button
            label="Add staff"
            icon="user-plus"
            size="lg"
            onPress={() => router.push('/users/new')}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function StaffRow({ user }: { user: User }) {
  const inactive = !user.is_active;
  const assigned = user.assigned_stores?.length ?? 0;

  return (
    <Pressable
      style={({ pressed }) => [styles.row, inactive && styles.rowInactive, pressed && styles.rowPressed]}
      onPress={() => router.push(`/users/${user.id}`)}
    >
      <View style={[styles.avatar, inactive && styles.avatarInactive]}>
        <Text style={[styles.avatarText, inactive && { color: colors.textFaint }]}>
          {initials(user.full_name)}
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text style={[styles.name, inactive && styles.nameInactive]} numberOfLines={1}>
          {user.full_name || 'Unnamed'}
        </Text>
        <Text style={styles.email} numberOfLines={1}>
          {user.email}
        </Text>
        <Text style={styles.scope} numberOfLines={1}>
          {assigned === 0 ? 'All stores' : `${assigned} store${assigned === 1 ? '' : 's'}`}
        </Text>
      </View>

      {inactive ? <Badge label="Inactive" tone="danger" dot /> : null}
      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

/* ------------------------------------------------------------------ grouping */

type Section =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'row'; user: User };

/**
 * Grouped rather than badged: a shop has a handful of staff, and "who are my
 * managers" is the question actually being asked at this screen.
 */
function groupByRole(users: User[]): Section[] {
  const buckets = new Map<string, User[]>();
  for (const user of users) {
    const key = roleKey(user.role) ?? 'OTHER';
    const list = buckets.get(key);
    if (list) list.push(user);
    else buckets.set(key, [user]);
  }

  const out: Section[] = [];
  const keys = [...ROLE_ORDER, 'OTHER'].filter((k) => buckets.has(k));

  for (const key of keys) {
    const list = (buckets.get(key) ?? []).sort((a, b) => a.full_name.localeCompare(b.full_name));
    out.push({
      kind: 'header',
      key,
      label: key === 'OTHER' ? 'Other' : ROLE_LABELS[key as Role],
      count: list.length,
    });
    for (const user of list) out.push({ kind: 'row', user });
  }

  return out;
}

/** `User.role` is a loose string, so match tolerantly rather than trusting casing. */
function roleKey(role: string): Role | null {
  const upper = (role ?? '').toUpperCase();
  if (upper in ROLE_LABELS) return upper as Role;
  const lower = (role ?? '').toLowerCase();
  if (lower.includes('admin')) return 'ORG_ADMIN';
  if (lower.includes('manager')) return 'STORE_MANAGER';
  if (lower.includes('cashier')) return 'CASHIER';
  return null;
}

function initials(name: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  tally: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  tallyText: { fontFamily: font.semibold, fontSize: 12, color: colors.primaryDeep },

  groupHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  groupLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  groupCount: { fontFamily: font.bold, fontSize: 13, color: colors.textMuted },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    minHeight: 72,
    ...shadow.card,
  },
  rowInactive: { backgroundColor: colors.surfaceSunken, borderColor: colors.borderStrong },
  rowPressed: { transform: [{ scale: 0.99 }], opacity: 0.92 },

  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInactive: { backgroundColor: colors.border },
  avatarText: { fontFamily: font.bold, fontSize: 14, color: colors.primary, letterSpacing: 0.4 },

  name: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  nameInactive: { color: colors.textMuted },
  email: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 2 },
  scope: { fontFamily: font.medium, fontSize: 11, color: colors.textFaint, marginTop: 3 },

  actionBar: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.canvas,
  },
});
