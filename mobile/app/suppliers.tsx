import React, { useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { suppliers as suppliersApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Field, Icon, Loading, SectionLabel } from '../src/ui/components';
import type { Supplier } from '../src/api/types';

/**
 * The wholesalers the shop buys from, each carrying what is still owed to them.
 *
 * The balance leads because that is the question actually asked of this screen —
 * not "who do we buy from" but "who are we behind with".
 */
export default function SuppliersScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const canWrite = useCan('suppliers.write');
  const canDelete = useCan('suppliers.delete');

  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);

  const list = useQuery({ queryKey: ['suppliers'], queryFn: () => suppliersApi.list() });
  const rows = list.data ?? [];

  const owed = useMemo(
    () => rows.reduce((sum, s) => sum + (s.outstanding_balance ?? 0), 0),
    [rows]
  );

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
  }

  function confirmDeactivate(supplier: Supplier) {
    Alert.alert(
      `Remove ${supplier.name}?`,
      'They stop appearing when a delivery is entered. Their past invoices and payments stay on record.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void suppliersApi
              .deactivate(supplier.id)
              .then(refresh)
              .catch((err: unknown) => Alert.alert("Couldn't remove supplier", errorMessage(err)));
          },
        },
      ]
    );
  }

  if (editing) {
    return (
      <SupplierForm
        supplier={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          refresh();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.md,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => void list.refetch()}
            tintColor={colors.primary}
          />
        }
      >
        {rows.length > 0 ? (
          <View style={styles.owedCard}>
            <View style={styles.owedGlow} />
            <Text style={styles.owedLabel}>Owed to suppliers</Text>
            <Text style={styles.owedValue}>{formatKwacha(owed)}</Text>
            <Text style={styles.owedFoot}>
              across {rows.filter((s) => (s.outstanding_balance ?? 0) > 0).length} supplier
              {rows.filter((s) => (s.outstanding_balance ?? 0) > 0).length === 1 ? '' : 's'}
            </Text>
          </View>
        ) : null}

        {canWrite ? (
          <Button label="New Supplier" icon="plus" onPress={() => setEditing('new')} />
        ) : null}

        {list.isLoading ? (
          <Loading label="Loading suppliers" />
        ) : list.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load suppliers"
            hint="The supplier list is served live — it needs a connection."
            action={
              <Button
                label="Retry"
                icon="refresh-cw"
                variant="secondary"
                onPress={() => void list.refetch()}
              />
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="truck"
            title="No suppliers yet"
            hint="Add the wholesalers you buy from. Once one exists you can enter their invoices, and the stock goes on the shelf as part of the same act."
          />
        ) : (
          <>
            <SectionLabel>
              {rows.length} supplier{rows.length === 1 ? '' : 's'}
            </SectionLabel>
            {rows.map((supplier) => (
              <SupplierCard
                key={supplier.id}
                supplier={supplier}
                canWrite={canWrite}
                canDelete={canDelete}
                onEdit={() => setEditing(supplier)}
                onDeactivate={() => confirmDeactivate(supplier)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SupplierCard({
  supplier,
  canWrite,
  canDelete,
  onEdit,
  onDeactivate,
}: {
  supplier: Supplier;
  canWrite: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
}) {
  const balance = supplier.outstanding_balance ?? 0;

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardIcon}>
          <Icon name="truck" size={19} color={colors.accentDeep} />
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {supplier.name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {[supplier.contact_name, supplier.phone].filter(Boolean).join(' · ') || 'No contact yet'}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Text style={[styles.balance, balance > 0 && { color: colors.danger }]}>
            {formatKwacha(balance)}
          </Text>
          {balance > 0 ? (
            <Badge label="OWED" tone="danger" dot />
          ) : (
            <Badge label="SETTLED" tone="success" />
          )}
        </View>
      </View>

      {!supplier.is_active ? <Badge label="REMOVED" tone="neutral" /> : null}

      <View style={styles.cardActions}>
        <Pressable
          onPress={() => router.push(`/purchases?supplier_id=${supplier.id}`)}
          style={styles.action}
          hitSlop={6}
        >
          <Icon name="file-text" size={14} color={colors.primary} />
          <Text style={styles.actionText}>
            {supplier.invoice_count ?? 0} invoice{(supplier.invoice_count ?? 0) === 1 ? '' : 's'}
          </Text>
        </Pressable>

        {canWrite ? (
          <Pressable onPress={onEdit} style={styles.action} hitSlop={6}>
            <Icon name="edit-2" size={14} color={colors.primary} />
            <Text style={styles.actionText}>Edit</Text>
          </Pressable>
        ) : null}

        {canDelete && supplier.is_active ? (
          <Pressable onPress={onDeactivate} style={styles.action} hitSlop={6}>
            <Icon name="slash" size={14} color={colors.danger} />
            <Text style={[styles.actionText, { color: colors.danger }]}>Remove</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function SupplierForm({
  supplier,
  onDone,
  onCancel,
}: {
  supplier: Supplier | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const layout = useLayout();

  const [name, setName] = useState(supplier?.name ?? '');
  const [contact, setContact] = useState(supplier?.contact_name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [email, setEmail] = useState(supplier?.email ?? '');
  const [address, setAddress] = useState(supplier?.address ?? '');
  const [notes, setNotes] = useState(supplier?.notes ?? '');
  const [busy, setBusy] = useState(false);

  const emailInvalid = email.trim().length > 0 && !email.includes('@');
  const canSave = name.trim().length > 0 && !emailInvalid && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        contact_name: contact.trim(),
        phone: phone.trim(),
        email: email.trim(),
        address: address.trim(),
        notes: notes.trim(),
      };
      if (supplier) await suppliersApi.update(supplier.id, body);
      else await suppliersApi.create(body);
      onDone();
    } catch (err) {
      Alert.alert("Couldn't save the supplier", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.formTitle}>{supplier ? 'Edit supplier' : 'New supplier'}</Text>

        <View style={{ gap: spacing.md }}>
          <Field
            label="Supplier name"
            value={name}
            onChangeText={setName}
            placeholder="Novatek Wholesale"
            autoFocus={!supplier}
            autoCapitalize="words"
            hint="One row per wholesaler. Entering the same one twice would split their balance in two."
          />
          <Field
            label="Contact person"
            value={contact}
            onChangeText={setContact}
            placeholder="Mr Banda"
            autoCapitalize="words"
          />
          <Field
            label="Phone"
            value={phone}
            onChangeText={setPhone}
            placeholder="0977 000 000"
            keyboardType="phone-pad"
          />
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="sales@novatek.co.zm"
            keyboardType="email-address"
            autoCapitalize="none"
            error={emailInvalid ? 'That does not look like an email address.' : null}
          />
          <Field
            label="Address"
            value={address}
            onChangeText={setAddress}
            placeholder="Plot 12, Industrial Area, Lusaka"
            multiline
          />
          <Field
            label="Notes"
            value={notes}
            onChangeText={setNotes}
            placeholder="30 days credit. Delivers Tuesdays."
            multiline
            hint="Agreed terms, account number, delivery days."
          />
        </View>

        <Button
          label={supplier ? 'Save Supplier' : 'Add Supplier'}
          icon="check"
          size="lg"
          loading={busy}
          disabled={!canSave}
          onPress={() => void save()}
        />
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  owedCard: {
    backgroundColor: colors.primaryDeep,
    borderRadius: radius.xl,
    padding: spacing.xl,
    overflow: 'hidden',
    ...shadow.raised,
  },
  owedGlow: {
    position: 'absolute',
    top: -70,
    right: -50,
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: colors.primaryBright,
    opacity: 0.38,
  },
  owedLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    color: colors.onDarkMuted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  owedValue: {
    fontFamily: font.extrabold,
    fontSize: 38,
    color: colors.onDark,
    letterSpacing: -1.4,
    marginTop: 4,
  },
  owedFoot: { fontFamily: font.regular, fontSize: 12, color: colors.onDarkMuted, marginTop: 2 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontFamily: font.bold, fontSize: 16, color: colors.text, letterSpacing: -0.3 },
  sub: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 3 },
  balance: { fontFamily: font.extrabold, fontSize: 17, color: colors.textMuted, letterSpacing: -0.5 },

  cardActions: {
    flexDirection: 'row',
    gap: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionText: { fontFamily: font.semibold, fontSize: 13, color: colors.primary },

  formTitle: { fontFamily: font.bold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
});
