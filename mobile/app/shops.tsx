import React, { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { stores as storesApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../src/theme';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Loading,
  SectionLabel,
  Toggle,
} from '../src/ui/components';
import type { Store } from '../src/api/types';

/**
 * The shops the organisation trades from.
 *
 * A shop is the unit everything else hangs off — stock levels, receipt numbers,
 * day reports and prices are all per shop — so opening one is the first thing
 * that has to happen before anybody can sell.
 */
export default function ShopsScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const canWrite = useCan('stores.write');
  const selected = useStoreSelection((s) => s.selected);

  const [editing, setEditing] = useState<Store | 'new' | null>(null);

  const list = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list() });
  const rows = list.data ?? [];

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['stores'] });
  }

  function confirmDeactivate(store: Store) {
    Alert.alert(
      `Close ${store.name}?`,
      'It stops appearing as a place to sell from. Nothing is deleted — its sales, stock and day reports stay on record.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Close shop',
          style: 'destructive',
          onPress: () => {
            void storesApi
              .deactivate(store.id)
              .then(refresh)
              .catch((err: unknown) => Alert.alert("Couldn't close the shop", errorMessage(err)));
          },
        },
      ]
    );
  }

  if (editing) {
    return (
      <ShopForm
        store={editing === 'new' ? null : editing}
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
        {canWrite ? <Button label="New Shop" icon="plus" onPress={() => setEditing('new')} /> : null}

        {list.isLoading ? (
          <Loading label="Loading shops" />
        ) : list.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load the shops"
            hint="The shop list is served live — it needs a connection."
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
            icon="home"
            title="No shops yet"
            hint="Add the first shop — its name and town are what appear on every receipt printed there."
          />
        ) : (
          <>
            <SectionLabel>
              {rows.length} shop{rows.length === 1 ? '' : 's'}
            </SectionLabel>
            {rows.map((store) => (
              <ShopCard
                key={store.id}
                store={store}
                current={selected?.id === store.id}
                canWrite={canWrite}
                onEdit={() => setEditing(store)}
                onDeactivate={() => confirmDeactivate(store)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ShopCard({
  store,
  current,
  canWrite,
  onEdit,
  onDeactivate,
}: {
  store: Store;
  current: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
}) {
  const where = [store.address.street, store.address.city, store.address.province]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(', ');

  return (
    <View style={[styles.card, current && styles.cardCurrent]}>
      <View style={styles.cardHead}>
        <View style={[styles.cardIcon, current && { backgroundColor: colors.primary }]}>
          <Icon name="home" size={19} color={current ? colors.onDark : colors.primary} />
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {store.name}
          </Text>
          <Text style={styles.where} numberOfLines={1}>
            {where || 'No address yet'}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Badge label={store.code} tone={store.is_active ? 'accent' : 'neutral'} />
          {!store.is_active ? <Badge label="CLOSED" tone="danger" /> : null}
          {current ? <Badge label="SELLING HERE" tone="success" dot /> : null}
          {/* Anyone assigned here gets every administrator capability, which is
              too consequential to be visible only in the database. */}
          {store.staff_full_access ? <Badge label="WAREHOUSE" tone="accent" dot /> : null}
        </View>
      </View>

      {store.phone || store.email ? (
        <View style={styles.contact}>
          {store.phone ? (
            <View style={styles.contactItem}>
              <Icon name="phone" size={13} color={colors.textFaint} />
              <Text style={styles.contactText}>{store.phone}</Text>
            </View>
          ) : null}
          {store.email ? (
            <View style={styles.contactItem}>
              <Icon name="mail" size={13} color={colors.textFaint} />
              <Text style={styles.contactText} numberOfLines={1}>
                {store.email}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {canWrite ? (
        <View style={styles.cardActions}>
          <Pressable onPress={onEdit} style={styles.action} hitSlop={6}>
            <Icon name="edit-2" size={14} color={colors.primary} />
            <Text style={styles.actionText}>Edit</Text>
          </Pressable>
          {store.is_active ? (
            <Pressable onPress={onDeactivate} style={styles.action} hitSlop={6}>
              <Icon name="slash" size={14} color={colors.danger} />
              <Text style={[styles.actionText, { color: colors.danger }]}>Close</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------- form */

function ShopForm({
  store,
  onDone,
  onCancel,
}: {
  store: Store | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const layout = useLayout();

  const [name, setName] = useState(store?.name ?? '');
  // Shown uppercased as it is typed, because that is what the server stores —
  // a field that silently changes its own value on save is worse than one that
  // says what it is doing.
  const [code, setCode] = useState(store?.code ?? '');
  const [street, setStreet] = useState(store?.address.street ?? '');
  const [city, setCity] = useState(store?.address.city ?? '');
  const [province, setProvince] = useState(store?.address.province ?? '');
  const [phone, setPhone] = useState(store?.phone ?? '');
  const [email, setEmail] = useState(store?.email ?? '');
  const [warehouse, setWarehouse] = useState(store?.staff_full_access === true);
  const [busy, setBusy] = useState(false);

  const cleanCode = code.toUpperCase().replace(/\s+/g, '');
  const emailInvalid = email.trim().length > 0 && !email.includes('@');
  const canSave = name.trim().length > 0 && cleanCode.length > 0 && !emailInvalid && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        code: cleanCode,
        address: {
          street: street.trim(),
          city: city.trim(),
          province: province.trim(),
          country: store?.address.country || 'Zambia',
        },
        phone: phone.trim(),
        email: email.trim(),
        is_warehouse: warehouse,
      };

      if (store) {
        await storesApi.update(store.id, body);
        Alert.alert('Shop updated', `${body.name} has been saved.`);
      } else {
        await storesApi.create(body);
        Alert.alert(
          'Shop opened',
          `${body.name} is ready. Load its stock next — either one product at a time, or from a spreadsheet.`
        );
      }
      onDone();
    } catch (err) {
      Alert.alert(store ? "Couldn't save the shop" : "Couldn't open the shop", errorMessage(err));
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
        <View>
          <Text style={styles.formTitle}>{store ? 'Edit shop' : 'New shop'}</Text>
          <Text style={styles.formLead}>
            The name and town print at the top of every receipt sold here.
          </Text>
        </View>

        <View style={{ gap: spacing.md }}>
          <Field
            label="Shop name"
            value={name}
            onChangeText={setName}
            placeholder="Katende"
            autoFocus={!store}
            autoCapitalize="words"
          />
          <Field
            label="Shop code"
            value={cleanCode}
            onChangeText={setCode}
            placeholder="KATENDE"
            autoCapitalize="characters"
            hint="Short, no spaces. It becomes the front of every receipt number here — KATENDE-20260809-000001."
          />
        </View>

        <View style={{ gap: spacing.md }}>
          <SectionLabel>Where it is</SectionLabel>
          <Field
            label="Street or area"
            value={street}
            onChangeText={setStreet}
            placeholder="Main road, opposite the market"
            autoCapitalize="words"
          />
          <Field
            label="Town"
            value={city}
            onChangeText={setCity}
            placeholder="Katende"
            autoCapitalize="words"
          />
          <Field
            label="Province"
            value={province}
            onChangeText={setProvince}
            placeholder="Central"
            autoCapitalize="words"
          />
        </View>

        <View style={{ gap: spacing.md }}>
          <SectionLabel>Contact</SectionLabel>
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
            placeholder="katende@mamamaxx.co.zm"
            keyboardType="email-address"
            autoCapitalize="none"
            error={emailInvalid ? 'That does not look like an email address.' : null}
          />
        </View>

        <View style={{ gap: spacing.sm }}>
          <SectionLabel>Role</SectionLabel>
          <Toggle
            label="This is the warehouse"
            value={warehouse}
            onChange={(next) => {
              // Turning it off is a demotion and needs no warning. Turning it on
              // hands every person assigned here the powers of an administrator,
              // and somebody ticking a box in a form deserves to be told that
              // before it happens rather than after.
              if (!next) {
                setWarehouse(false);
                return;
              }
              Alert.alert(
                'Make this the warehouse?',
                'Everyone assigned to this shop will get every administrator power — including changing staff passwords, editing roles and closing shops. It is granted by assignment and taken away the same way.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Make it the warehouse', onPress: () => setWarehouse(true) },
                ]
              );
            }}
            hint="The warehouse is offered first when stock is transferred, and shown as the warehouse rather than as a shop."
          />
        </View>

        <Button
          label={store ? 'Save Shop' : 'Open Shop'}
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

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  cardCurrent: { borderColor: colors.primary, borderWidth: 1.5 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontFamily: font.bold, fontSize: 16, color: colors.text, letterSpacing: -0.3 },
  where: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 3 },

  contact: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  contactItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  contactText: { fontFamily: font.medium, fontSize: 12, color: colors.textMuted },

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
  formLead: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 4,
    lineHeight: 18,
  },
});
