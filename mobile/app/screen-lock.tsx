import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenLockSection } from '../src/ui/ScreenLockSection';
import { useLayout } from '../src/ui/responsive';
import { colors, spacing } from '../src/theme';

/**
 * Its own screen rather than a section of Settings.
 *
 * Settings is gated on `settings.write`, which a cashier does not have — and a
 * till lock that only an administrator can set is a till lock nobody on the
 * counter has. This is a preference belonging to a person and a handset, in the
 * same category as which printer this device pairs with, so it sits beside it
 * under Configuration and is reachable by everyone who can sign in.
 */
export default function ScreenLockScreen() {
  const layout = useLayout();

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenLockSection />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
});
