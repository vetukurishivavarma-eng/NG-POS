import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';

import { transactions as transactionsApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { shareStatementPdf } from '../src/printing/print';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, spacing } from '../src/theme';
import { EmptyState, Field, Icon, Loading } from '../src/ui/components';
import type { CustomerSummary } from '../src/api/types';

/**
 * A statement per customer: every sale and refund, and how each was paid.
 *
 * There is no customer record — a customer is the name typed on the sale at
 * the till — so this lists those names and builds the statement from the
 * sales carrying one. Spelling a name two ways makes two customers.
 */
export default function CustomerStatementsScreen() {
  const layout = useLayout();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useQuery({
    queryKey: ['customers', term],
    queryFn: () => transactionsApi.customers(term || undefined),
  });

  async function download(c: CustomerSummary) {
    const key = `${c.name}|${c.phone}`;
    setBusyKey(key);
    try {
      const rows = await transactionsApi.customerStatement(c.name, c.phone || undefined);
      const counted = rows.filter((r) => r.status !== 'voided');
      const total = counted.reduce((sum, r) => sum + r.total, 0);
      const paid = counted.reduce(
        (sum, r) => sum + r.payments.reduce((s, p) => s + p.amount, 0),
        0
      );

      await shareStatementPdf(
        {
          title: 'Customer statement',
          subject: c.name,
          meta: [c.phone, `${rows.length} receipt${rows.length === 1 ? '' : 's'}`].filter(Boolean),
          columns: [
            { label: 'Date' },
            { label: 'Receipt' },
            { label: 'Shop' },
            { label: 'Type' },
            { label: 'Paid by' },
            { label: 'Amount', align: 'right' },
            { label: 'Paid', align: 'right' },
          ],
          rows: rows.map((r) => [
            new Date(r.created_at).toLocaleDateString(),
            r.receipt_number,
            r.store_name,
            r.status === 'voided' ? 'void' : r.transaction_type.replace(/_/g, ' '),
            r.payments.map((p) => p.method).join(', '),
            formatKwacha(r.total),
            formatKwacha(r.payments.reduce((s, p) => s + p.amount, 0)),
          ]),
          totals: ['', '', '', '', 'Total', formatKwacha(total), formatKwacha(paid)],
          empty: 'No sales found for this customer.',
        },
        `Statement-${c.name}`
      );
    } catch (err) {
      Alert.alert("Couldn't load the statement", errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  const rows = list.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.lead}>
          Customers are the names typed on sales at the till. Tap one to download every sale and
          payment as a PDF.
        </Text>

        <Field
          label="Customer"
          placeholder="Search by name"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="words"
        />

        {list.isLoading ? (
          <Loading label="Loading customers" />
        ) : list.isError ? (
          <EmptyState icon="cloud-off" title="Couldn't load customers" hint={errorMessage(list.error)} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="users"
            title={term ? 'No customer by that name' : 'No named customers yet'}
            hint="A customer appears here once their name is entered on a sale."
          />
        ) : (
          rows.map((c) => {
            const key = `${c.name}|${c.phone}`;
            return (
              <Pressable
                key={key}
                onPress={() => void download(c)}
                disabled={busyKey !== null}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {[c.phone, `${c.transaction_count} sale${c.transaction_count === 1 ? '' : 's'}`, formatKwacha(c.total)]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Text style={styles.action}>{busyKey === key ? 'Preparing…' : 'Statement'}</Text>
                <Icon name="download" size={16} color={colors.primary} />
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  lead: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  name: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  sub: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 2 },
  action: { fontFamily: font.semibold, fontSize: 13, color: colors.primary },
});
