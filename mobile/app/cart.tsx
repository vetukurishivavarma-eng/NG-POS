import React from 'react';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';

import { CartPanel } from '../src/ui/CartPanel';
import { colors } from '../src/theme';

/** Phone-only route. On tablets the same panel is docked beside the products. */
export default function CartScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <CartPanel onDone={() => router.back()} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
});
