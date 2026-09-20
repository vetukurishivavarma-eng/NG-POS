import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useLayout } from '../src/ui/responsive';
import { colors, font, spacing } from '../src/theme';
import { ChainStockLookup } from '../src/ui/ChainStockLookup';

/**
 * "How many does the other shop have?" — on its own screen, for everyone.
 *
 * The same control sits on the bulk-upload screen, but that one is gated on
 * `products.import`, so a cashier could never reach it. This is the version
 * behind the till: no capability check, because the answer is quantities at
 * shops in your own organisation and the alternative is a phone call.
 */
export default function StockByShopScreen() {
  const layout = useLayout();

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View>
          <Text style={styles.title}>Stock by shop</Text>
          <Text style={styles.lead}>
            Search a product to see what every shop is holding right now. Nothing here changes any
            stock.
          </Text>
        </View>

        <ChainStockLookup />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  title: { fontFamily: font.bold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  lead: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
});
