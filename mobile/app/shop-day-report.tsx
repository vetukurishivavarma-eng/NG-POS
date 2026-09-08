import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';

import { stores as storesApi } from '../src/api/endpoints';
import { useCan } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import DayReportView from '../src/reports/DayReportView';
import { colors, spacing } from '../src/theme';
import { EmptyState, Loading, SectionLabel, Select } from '../src/ui/components';

/**
 * The Z-report for any shop, for an owner who is not standing at that till.
 *
 * The till's own "Day Report" screen only ever shows the shop selected on the
 * Sell tab; this is the one place a shop can be picked by name without changing
 * what the rest of the app is pointed at. Same figures, same print/PDF.
 */
export default function ShopDayReportScreen() {
  const layout = useLayout();
  const canPick = useCan('costs.view');
  const [storeId, setStoreId] = useState('');

  const shopsQuery = useQuery({ queryKey: ['stores'], queryFn: storesApi.list, enabled: canPick });
  const shops = shopsQuery.data ?? [];
  const store = shops.find((s) => s.id === storeId) ?? null;

  if (!canPick) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="Not available for your role"
          hint="Only an owner can read another shop's day report. Your own is under More → Day Report."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={{ padding: layout.gutter, paddingBottom: 0 }}>
        <SectionLabel>Shop</SectionLabel>
        {shopsQuery.isLoading ? (
          <Loading label="Loading shops" />
        ) : (
          <Select
            value={storeId}
            onChange={setStoreId}
            options={[
              { value: '', label: 'Choose a shop' },
              ...shops.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        )}
      </View>

      {store ? (
        <DayReportView store={store} />
      ) : (
        <ScrollView contentContainerStyle={styles.empty}>
          <EmptyState
            icon="clipboard"
            title="Pick a shop"
            hint="Its full day report — takings by method, reconciliation and top items — appears here, the same as the printed Z-report."
          />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  empty: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
});
