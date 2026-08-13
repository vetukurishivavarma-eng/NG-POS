import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';

import { history as historyApi } from '../src/api/endpoints';
import { useStoreSelection } from '../src/store/storeSelection';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, spacing } from '../src/theme';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Loading,
  Select,
  type IconName,
} from '../src/ui/components';
import type { AuditEntry } from '../src/api/types';

const PAGE_SIZE = 40;

/**
 * Who changed what, and when.
 *
 * Two screens in one, chosen by the route parameters:
 *
 *  - `/history` — the whole shop's activity, filtered by what kind of thing
 *    changed. This is the one reached from More.
 *  - `/history?entity=transaction&entity_id=…` — the trail of one record,
 *    reached from the receipt or the product it belongs to. Nothing is filtered
 *    there; a record's history is short and all of it matters.
 *
 * Entries are written by the server's data layer rather than by each endpoint,
 * so this shows every change made through the API — including ones made by
 * parts of the app that know nothing about this screen.
 */

type Scope = 'all' | 'money' | 'catalogue' | 'people' | 'stock';

/**
 * The filters are grouped by the question being asked, not by table.
 *
 * "Who has been changing prices?" is one question that spans products and
 * per-shop overrides; offering `product` and `store_price` as separate chips
 * would make the person asking it check two lists and hope.
 */
const SCOPES: { value: Scope; label: string; entity?: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'money', label: 'Sales & money', entity: 'transaction,supplier_invoice,supplier_payment' },
  { value: 'catalogue', label: 'Products & prices', entity: 'product,store_price' },
  { value: 'stock', label: 'Stock', entity: 'stock_movement,transfer,inventory,import' },
  { value: 'people', label: 'Staff & access', entity: 'user,auth,device,store,organization' },
];

export default function HistoryScreen() {
  const params = useLocalSearchParams<{ entity?: string; entity_id?: string; title?: string }>();
  const store = useStoreSelection((s) => s.selected);
  const layout = useLayout();

  const singleRecord = Boolean(params.entity && params.entity_id);

  const [scope, setScope] = useState<Scope>('all');
  const [search, setSearch] = useState('');
  const [thisStoreOnly, setThisStoreOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const trail = useQuery({
    queryKey: ['history-record', params.entity, params.entity_id],
    enabled: singleRecord,
    queryFn: () => historyApi.forRecord(params.entity as string, params.entity_id as string),
  });

  const feed = useInfiniteQuery({
    queryKey: ['history', scope, thisStoreOnly ? store?.id : null, search.trim()],
    enabled: !singleRecord,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      historyApi.list({
        limit: PAGE_SIZE,
        offset: pageParam,
        ...(SCOPES.find((s) => s.value === scope)?.entity
          ? { entity: SCOPES.find((s) => s.value === scope)?.entity }
          : {}),
        ...(thisStoreOnly && store ? { store_id: store.id } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      }),
    // A short page means the server has nothing left to give.
    getNextPageParam: (last, all) =>
      last.entries.length < PAGE_SIZE ? undefined : all.length * PAGE_SIZE,
  });

  const rows = useMemo(
    () => (singleRecord ? (trail.data?.entries ?? []) : (feed.data?.pages.flatMap((p) => p.entries) ?? [])),
    [singleRecord, trail.data, feed.data]
  );

  const sections = useMemo(() => groupByDay(rows), [rows]);

  const loading = singleRecord ? trail.isLoading : feed.isLoading;
  const failed = singleRecord ? trail.isError : feed.isError;
  const refreshing = singleRecord ? trail.isRefetching : feed.isRefetching;
  const refetch = () => void (singleRecord ? trail.refetch() : feed.refetch());

  if (loading) return <Loading label="Loading history" />;

  if (failed) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="cloud-off"
          title={singleRecord ? 'No history for this record' : "Couldn't load history"}
          hint={
            singleRecord
              ? 'It may have been created before the history trail was switched on.'
              : 'History is kept on the server, so this needs a connection.'
          }
          action={<Button label="Retry" icon="refresh-cw" variant="secondary" onPress={refetch} />}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {singleRecord ? (
        <View style={[styles.recordHead, { paddingHorizontal: layout.gutter }]}>
          <Text style={styles.recordLabel} numberOfLines={1}>
            {trail.data?.label || params.entity_id}
          </Text>
          <Text style={styles.recordMeta}>
            {entityLabel(params.entity as string)} · {rows.length} change
            {rows.length === 1 ? '' : 's'}
          </Text>
        </View>
      ) : (
        <View style={[styles.toolbar, { paddingHorizontal: layout.gutter }]}>
          <Select<Scope>
            value={scope}
            onChange={setScope}
            options={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
          />
          <Field
            label="Search"
            placeholder="A product, a receipt number, a person"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          {store ? (
            <Pressable
              style={[styles.storeChip, thisStoreOnly && styles.storeChipOn]}
              onPress={() => setThisStoreOnly((v) => !v)}
            >
              <Icon
                name={thisStoreOnly ? 'check-square' : 'square'}
                size={14}
                color={thisStoreOnly ? colors.primary : colors.textFaint}
              />
              <Text style={[styles.storeChipText, thisStoreOnly && styles.storeChipTextOn]}>
                {store.name} only
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}

      <FlatList
        data={sections}
        keyExtractor={(item) => (item.kind === 'header' ? `h-${item.day}` : item.entry.id)}
        contentContainerStyle={{
          paddingHorizontal: layout.gutter,
          paddingBottom: spacing.xxl,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refetch} tintColor={colors.primary} />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (!singleRecord && feed.hasNextPage && !feed.isFetchingNextPage) {
            void feed.fetchNextPage();
          }
        }}
        ListEmptyComponent={
          <EmptyState
            icon="clock"
            title="Nothing recorded yet"
            hint="Every change made from here on is kept — who made it, when, and what it was before."
          />
        }
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <Loading />
          ) : rows.length > 0 && !singleRecord && !feed.hasNextPage ? (
            <Text style={styles.footNote}>That's the whole trail.</Text>
          ) : null
        }
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <View style={styles.dayHeader}>
              <Text style={styles.dayLabel}>{item.label}</Text>
              <Text style={styles.dayCount}>
                {item.count} change{item.count === 1 ? '' : 's'}
              </Text>
            </View>
          ) : (
            <EntryRow
              entry={item.entry}
              open={expanded === item.entry.id}
              onToggle={() => setExpanded((id) => (id === item.entry.id ? null : item.entry.id))}
            />
          )
        }
      />
    </SafeAreaView>
  );
}

function EntryRow({
  entry,
  open,
  onToggle,
}: {
  entry: AuditEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const look = lookFor(entry.action);
  const changes = useMemo(() => changedPairs(entry), [entry]);

  return (
    <Pressable style={styles.row} onPress={onToggle}>
      <View style={styles.rowTop}>
        <View style={[styles.rowIcon, { backgroundColor: look.soft }]}>
          <Icon name={look.icon} size={15} color={look.ink} />
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.label || entityLabel(entry.entity)}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {entry.actor_name || 'System'} · {time(entry.created_at)}
          </Text>
        </View>

        <Badge label={actionLabel(entry.action)} tone={look.tone} />
      </View>

      <Text style={styles.summary} numberOfLines={open ? undefined : 2}>
        {entry.summary}
      </Text>

      {open ? (
        <View style={styles.detail}>
          {changes.length > 0 ? (
            changes.map((change) => (
              <View key={change.field} style={styles.change}>
                <Text style={styles.changeField}>{change.field}</Text>
                <View style={styles.changeValues}>
                  <Text style={styles.was} numberOfLines={2}>
                    {change.before}
                  </Text>
                  <Icon name="arrow-right" size={12} color={colors.textFaint} />
                  <Text style={styles.now} numberOfLines={2}>
                    {change.after}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.noDetail}>
              {entry.action === 'create'
                ? 'Created with the values it still has.'
                : entry.action === 'delete'
                  ? 'Removed. The full record is kept in this entry.'
                  : 'No field-by-field detail was recorded.'}
            </Text>
          )}

          <View style={styles.provenance}>
            <Text style={styles.provenanceText} numberOfLines={1}>
              {entry.actor_role ? `${entry.actor_role.replace(/_/g, ' ').toLowerCase()} · ` : ''}
              {entry.device_name ?? 'unknown device'}
            </Text>
            <Text style={styles.provenanceText}>{entry.entity}</Text>
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

/* --------------------------------------------------------------- shaping */

/**
 * The before/after pairs a person can read.
 *
 * The snapshots are whole rows, so showing them raw would bury the one field
 * that moved under thirty that did not. `changed_fields` is the server's answer
 * to which ones those were, and the values are pulled from the two snapshots.
 */
function changedPairs(entry: AuditEntry): { field: string; before: string; after: string }[] {
  if (!entry.changed_fields?.length) return [];
  return entry.changed_fields.slice(0, 12).map((field) => ({
    field: humanField(field),
    before: readable(entry.before?.[field]),
    after: readable(entry.after?.[field]),
  }));
}

/** Mirrors the server's own labelling, so a row and its detail agree. */
const FIELD_LABELS: Record<string, string> = {
  isActive: 'Active',
  sku: 'SKU',
  vatRate: 'VAT rate',
  taxType: 'Tax type',
  staffFullAccess: 'Warehouse access',
};

function humanField(field: string): string {
  const named = FIELD_LABELS[field];
  if (named) return named;

  const spaced = field
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function readable(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.length ? `${value.length} item(s)` : 'none';
  if (typeof value === 'object') return '…';
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

const ENTITY_LABELS: Record<string, string> = {
  transaction: 'Sale',
  product: 'Product',
  store_price: 'Shop price',
  inventory: 'Stock level',
  stock_movement: 'Stock movement',
  transfer: 'Transfer',
  supplier: 'Supplier',
  supplier_invoice: 'Supplier invoice',
  supplier_payment: 'Supplier payment',
  user: 'Staff account',
  store: 'Shop',
  organization: 'Organisation',
  warehouse: 'Warehouse',
  daily_report: 'Day report',
  device: 'Device',
  auth: 'Sign-in',
  app_release: 'App release',
  import: 'Bulk import',
};

function entityLabel(entity: string): string {
  return ENTITY_LABELS[entity] ?? humanField(entity);
}

const ACTION_LABELS: Record<string, string> = {
  create: 'Added',
  update: 'Changed',
  delete: 'Deleted',
  deactivate: 'Deactivated',
  void: 'Voided',
  login: 'Signed in',
  logout: 'Signed out',
  login_failed: 'Refused',
  password_changed: 'Password',
  device_removed: 'Device removed',
  update_many: 'Bulk change',
  delete_many: 'Bulk delete',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanField(action);
}

type Look = { icon: IconName; tone: 'success' | 'warning' | 'danger' | 'accent' | 'neutral'; soft: string; ink: string };

const LOOKS: Record<string, Look> = {
  create: { icon: 'plus', tone: 'success', soft: colors.successSoft, ink: colors.success },
  update: { icon: 'edit-3', tone: 'warning', soft: colors.warningSoft, ink: colors.warning },
  delete: { icon: 'trash-2', tone: 'danger', soft: colors.dangerSoft, ink: colors.danger },
  deactivate: { icon: 'slash', tone: 'neutral', soft: colors.surfaceSunken, ink: colors.textMuted },
  void: { icon: 'x-octagon', tone: 'danger', soft: colors.dangerSoft, ink: colors.danger },
  login: { icon: 'log-in', tone: 'neutral', soft: colors.surfaceSunken, ink: colors.textMuted },
  logout: { icon: 'log-out', tone: 'neutral', soft: colors.surfaceSunken, ink: colors.textMuted },
  login_failed: { icon: 'shield-off', tone: 'danger', soft: colors.dangerSoft, ink: colors.danger },
  password_changed: { icon: 'key', tone: 'accent', soft: colors.accentSoft, ink: colors.accentDeep },
  device_removed: { icon: 'smartphone', tone: 'danger', soft: colors.dangerSoft, ink: colors.danger },
};

/** An action this build has never heard of is still worth showing. */
const UNKNOWN_LOOK: Look = {
  icon: 'activity',
  tone: 'neutral',
  soft: colors.surfaceSunken,
  ink: colors.textMuted,
};

function lookFor(action: string): Look {
  return LOOKS[action] ?? UNKNOWN_LOOK;
}

/* -------------------------------------------------------------- grouping */

type Section =
  | { kind: 'header'; day: string; label: string; count: number }
  | { kind: 'row'; entry: AuditEntry };

function groupByDay(rows: AuditEntry[]): Section[] {
  const out: Section[] = [];
  let currentDay: string | null = null;
  let headerIndex = -1;

  for (const entry of rows) {
    const day = new Date(entry.created_at).toDateString();
    if (day !== currentDay) {
      currentDay = day;
      headerIndex = out.length;
      out.push({ kind: 'header', day, label: dayLabel(entry.created_at), count: 0 });
    }
    const header = out[headerIndex];
    if (header?.kind === 'header') header.count += 1;
    out.push({ kind: 'row', entry });
  }

  return out;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  toolbar: { paddingTop: spacing.md, gap: spacing.sm, backgroundColor: colors.canvas },

  recordHead: { paddingTop: spacing.lg, paddingBottom: spacing.sm },
  recordLabel: { fontFamily: font.extrabold, fontSize: 20, color: colors.ink },
  recordMeta: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 2 },

  storeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
  },
  storeChipOn: {},
  storeChipText: { fontFamily: font.medium, fontSize: 12, color: colors.textFaint },
  storeChipTextOn: { color: colors.primary },

  dayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    backgroundColor: colors.canvas,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  dayLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  dayCount: { fontFamily: font.semibold, fontSize: 11, color: colors.textMuted },

  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  meta: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  summary: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },

  detail: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  change: { gap: 2 },
  changeField: {
    fontFamily: font.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textFaint,
  },
  changeValues: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  was: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  now: { flex: 1, fontFamily: font.semibold, fontSize: 13, color: colors.text },
  noDetail: { fontFamily: font.regular, fontSize: 12, color: colors.textFaint, lineHeight: 18 },

  provenance: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  provenanceText: { fontFamily: font.regular, fontSize: 10, color: colors.textFaint },

  footNote: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
