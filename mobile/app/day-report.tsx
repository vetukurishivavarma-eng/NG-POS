import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useAuth } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { useSync } from '../src/db/sync';
import DayReportView from '../src/reports/DayReportView';
import { colors } from '../src/theme';
import { Button, EmptyState } from '../src/ui/components';

export default function DayReportScreen() {
  const store = useStoreSelection((s) => s.selected);
  const pendingCount = useSync((s) => s.pendingCount);
  const signOut = useAuth((s) => s.signOut);

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="home" title="No store selected" hint="Choose a store from the Sell tab." />
      </SafeAreaView>
    );
  }

  function endSession(print: () => Promise<void>) {
    const warn =
      pendingCount > 0
        ? `\n\n${pendingCount} offline sale(s) haven't reached the server — they are not in these figures and stay on this device until it syncs.`
        : '';

    Alert.alert('End session?', `Print the day report, then sign out of ${store?.name}.${warn}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Print & Sign Out',
        onPress: async () => {
          await print();
          await signOut();
          router.replace('/login');
        },
      },
      {
        text: 'Sign Out Only',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/login');
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <DayReportView
        store={store}
        renderFooter={({ print, offset }) =>
          offset === 0 ? (
            <Button
              label="End Session"
              icon="log-out"
              variant="danger"
              onPress={() => endSession(print)}
            />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
});
