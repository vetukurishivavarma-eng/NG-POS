import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { stores as storesApi, users as usersApi } from '../../src/api/endpoints';
import { errorMessage } from '../../src/api/client';
import { useAuth, useCan } from '../../src/store/auth';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, radius, spacing } from '../../src/theme';
import {
  Button,
  EmptyState,
  Field,
  Icon,
  Loading,
  SectionLabel,
  Select,
  Toggle,
} from '../../src/ui/components';
import { ROLE_LABELS, type Role, type UserDraft } from '../../src/api/types';

const MIN_PASSWORD = 8;

const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as Role[]).map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));

interface FormState {
  fullName: string;
  email: string;
  password: string;
  role: Role;
  isActive: boolean;
  stores: string[];
}

export default function StaffMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const layout = useLayout();
  const queryClient = useQueryClient();
  const canWrite = useCan('users.write');
  const me = useAuth((s) => s.user);

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
  });

  const storesQuery = useQuery({
    queryKey: ['stores'],
    queryFn: () => storesApi.list(),
  });

  // There is no single-user GET on the API — the list is the only read path, so
  // the record for this screen is picked out of it.
  const existing = useMemo(
    () => (isNew ? null : usersQuery.data?.find((u) => u.id === id) ?? null),
    [usersQuery.data, id, isNew]
  );

  const [form, setForm] = useState<FormState | null>(isNew ? blankForm() : null);
  const [errors, setErrors] = useState<{ fullName?: string; email?: string; password?: string }>({});

  useEffect(() => {
    if (form || !existing) return;
    setForm({
      fullName: existing.full_name,
      email: existing.email,
      password: '',
      role: normaliseRole(existing.role),
      isActive: existing.is_active,
      stores: existing.assigned_stores ?? [],
    });
  }, [existing, form]);

  const save = useMutation({
    mutationFn: (draft: UserDraft) =>
      isNew ? usersApi.create(draft) : usersApi.update(id as string, draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      router.back();
    },
    onError: (err) => Alert.alert('Could not save', errorMessage(err)),
  });

  const deactivate = useMutation({
    mutationFn: () => usersApi.deactivate(id as string),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      router.back();
    },
    onError: (err) => Alert.alert('Could not deactivate', errorMessage(err)),
  });

  if (!isNew && usersQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading record" />
      </SafeAreaView>
    );
  }

  if (!isNew && !existing) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon={usersQuery.isError ? 'cloud-off' : 'user-x'}
          title={usersQuery.isError ? "Couldn't load staff" : 'Staff member not found'}
          hint={
            usersQuery.isError
              ? 'Staff records are served live — they need a connection.'
              : 'This record may have been removed.'
          }
          action={<Button label="Close" variant="secondary" onPress={() => router.back()} />}
        />
      </SafeAreaView>
    );
  }

  if (!form) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading />
      </SafeAreaView>
    );
  }

  const value = form;
  const set = (patch: Partial<FormState>) => setForm({ ...value, ...patch });

  const allStores = storesQuery.data ?? [];
  const cashierEverywhere = value.role === 'CASHIER' && value.stores.length === 0;
  const isSelf = !isNew && !!me && me.id === id;

  function toggleStore(storeId: string) {
    set({
      stores: value.stores.includes(storeId)
        ? value.stores.filter((s) => s !== storeId)
        : [...value.stores, storeId],
    });
  }

  function submit() {
    const next: typeof errors = {};
    if (!value.fullName.trim()) next.fullName = 'A name is required.';
    if (!/^\S+@\S+\.\S+$/.test(value.email.trim())) next.email = 'Enter a valid email address.';
    // The server rejects anything shorter, so catch it here rather than losing
    // the whole form to a round trip.
    if (isNew && value.password.length < MIN_PASSWORD) {
      next.password = `At least ${MIN_PASSWORD} characters.`;
    } else if (!isNew && value.password.length > 0 && value.password.length < MIN_PASSWORD) {
      next.password = `At least ${MIN_PASSWORD} characters, or leave blank.`;
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const draft: UserDraft = {
      full_name: value.fullName.trim(),
      email: value.email.trim().toLowerCase(),
      role: value.role,
      assigned_stores: value.stores,
      is_active: value.isActive,
      // Omitted entirely on edit when blank: sending an empty string would be
      // read as "set the password to nothing".
      ...(value.password ? { password: value.password } : {}),
    };

    save.mutate(draft);
  }

  function confirmDeactivate() {
    Alert.alert(
      'Deactivate this account?',
      `${value.fullName || 'This person'} will no longer be able to sign in. Past sales stay on record.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Deactivate', style: 'destructive', onPress: () => deactivate.mutate() },
      ]
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {!canWrite ? (
          <View style={styles.note}>
            <Icon name="eye" size={16} color={colors.textMuted} />
            <Text style={styles.noteText}>
              Read only. Staff records can only be changed by an administrator.
            </Text>
          </View>
        ) : null}

        <View style={{ gap: spacing.lg }}>
          <SectionLabel>Who they are</SectionLabel>
          <Field
            label="Full name"
            value={value.fullName}
            onChangeText={(t) => set({ fullName: t })}
            placeholder="Chanda Mwansa"
            autoCapitalize="words"
            editable={canWrite}
            error={errors.fullName}
            autoFocus={isNew}
          />
          <Field
            label="Email"
            value={value.email}
            onChangeText={(t) => set({ email: t })}
            placeholder="name@shop.co.zm"
            autoCapitalize="none"
            keyboardType="email-address"
            editable={canWrite}
            error={errors.email}
            hint="This is what they sign in with."
          />
          <Field
            label={isNew ? 'Password' : 'New password'}
            value={value.password}
            onChangeText={(t) => set({ password: t })}
            placeholder={isNew ? `At least ${MIN_PASSWORD} characters` : '••••••••'}
            autoCapitalize="none"
            secureTextEntry
            editable={canWrite}
            error={errors.password}
            hint={
              isNew
                ? `At least ${MIN_PASSWORD} characters.`
                : 'Leave blank to keep the current password.'
            }
          />
        </View>

        <View style={{ gap: spacing.lg }}>
          <SectionLabel>What they can do</SectionLabel>
          {canWrite ? (
            <Select
              label="Role"
              value={value.role}
              options={ROLE_OPTIONS}
              onChange={(role) => set({ role })}
              hint={ROLE_HINTS[value.role]}
            />
          ) : (
            <Field
              label="Role"
              value={ROLE_LABELS[value.role]}
              onChangeText={() => undefined}
              editable={false}
              hint={ROLE_HINTS[value.role]}
            />
          )}

          <Toggle
            label="Active"
            hint={value.isActive ? 'Can sign in to the till.' : 'Sign-in is blocked.'}
            value={value.isActive}
            onChange={(isActive) => set({ isActive })}
            disabled={!canWrite}
          />
        </View>

        <View style={{ gap: spacing.md }}>
          <SectionLabel>Assigned stores</SectionLabel>
          <Text style={styles.explain}>
            {value.stores.length === 0
              ? 'Nothing selected — this account reaches every store.'
              : `Limited to ${value.stores.length} of ${allStores.length || value.stores.length} stores.`}
          </Text>

          {storesQuery.isLoading ? (
            <Loading />
          ) : allStores.length === 0 ? (
            <Text style={styles.explain}>No stores to assign.</Text>
          ) : (
            <View style={styles.chipWrap}>
              {allStores.map((store) => {
                const active = value.stores.includes(store.id);
                return (
                  <Pressable
                    key={store.id}
                    disabled={!canWrite}
                    onPress={() => toggleStore(store.id)}
                    style={({ pressed }) => [
                      styles.chip,
                      active && styles.chipActive,
                      !canWrite && { opacity: 0.6 },
                      pressed && canWrite && { opacity: 0.8 },
                    ]}
                  >
                    {active ? <Icon name="check" size={14} color={colors.onDark} /> : null}
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {store.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {cashierEverywhere ? (
            <View style={styles.warn}>
              <Icon name="alert-triangle" size={16} color={colors.warning} />
              <Text style={styles.warnText}>
                A cashier with no stores selected can sell at every store. Pick the tills they
                actually work on.
              </Text>
            </View>
          ) : null}
        </View>

        {canWrite ? (
          <View style={{ gap: spacing.sm }}>
            <Button
              label={isNew ? 'Create staff member' : 'Save changes'}
              icon="check"
              size="lg"
              loading={save.isPending}
              onPress={submit}
            />
            <Button label="Cancel" variant="ghost" onPress={() => router.back()} />

            {/* The server refuses to deactivate the caller's own account, so the
                control is never shown for it. */}
            {!isNew && !isSelf && existing?.is_active ? (
              <Button
                label="Deactivate account"
                icon="user-x"
                variant="danger"
                loading={deactivate.isPending}
                onPress={confirmDeactivate}
                style={{ marginTop: spacing.md }}
              />
            ) : null}
          </View>
        ) : (
          <Button label="Close" variant="secondary" onPress={() => router.back()} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const ROLE_HINTS: Record<Role, string> = {
  ORG_ADMIN: 'Everything, including staff, pricing and settings.',
  STORE_MANAGER: 'Sell, stock, reports and pricing. Cannot change staff.',
  CASHIER: 'Sell only.',
};

function blankForm(): FormState {
  return {
    fullName: '',
    email: '',
    password: '',
    role: 'CASHIER',
    isActive: true,
    stores: [],
  };
}

/** The API returns `role` as a loose string; the form needs one of the three keys. */
function normaliseRole(role: string): Role {
  const upper = (role ?? '').toUpperCase();
  if (upper in ROLE_LABELS) return upper as Role;
  const lower = (role ?? '').toLowerCase();
  if (lower.includes('admin')) return 'ORG_ADMIN';
  if (lower.includes('manager')) return 'STORE_MANAGER';
  return 'CASHIER';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noteText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.textMuted },

  explain: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, lineHeight: 18 },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: font.semibold, fontSize: 13, color: colors.textMuted },
  chipTextActive: { color: colors.onDark },

  warn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  warnText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.warning, lineHeight: 17 },
});
