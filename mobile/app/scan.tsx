import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useStoreSelection } from '../src/store/storeSelection';
import { maxSellable, useCart } from '../src/store/cart';
import { useScanCapture } from '../src/store/scanCapture';
import { findCachedByBarcode } from '../src/db';
import { colors, font, radius, spacing } from '../src/theme';
import { Button, Icon } from '../src/ui/components';
import type { CatalogueResult } from '../src/hooks/useCatalogue';
import type { ProductWithStock } from '../src/api/types';

/** Read straight from the store: this runs inside a scan callback, not a render. */
function alreadyAtStockLimit(product: ProductWithStock): boolean {
  const line = useCart.getState().lines.find((l) => l.product.id === product.id);
  return line != null && line.quantity >= maxSellable(product);
}

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const store = useStoreSelection((s) => s.selected);
  const add = useCart((s) => s.add);
  const queryClient = useQueryClient();

  /** `capture` returns the raw code to the caller instead of selling it. */
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const capturing = mode === 'capture';
  const capture = useScanCapture((s) => s.capture);

  const [message, setMessage] = useState<string | null>(null);
  /** Barcode callbacks fire continuously; this gates one lookup at a time. */
  const busy = useRef(false);

  async function onScanned(data: string) {
    if (busy.current) return;
    busy.current = true;

    try {
      // Capture mode hands the code straight back — no catalogue lookup, and no
      // store needs to be selected, because the product may not exist yet.
      if (capturing) {
        capture(data);
        router.back();
        return;
      }

      if (!store) return;

      // Prefer whatever the sell screen already has loaded, so scanning behaves
      // identically online and offline.
      const cached = queryClient.getQueryData<CatalogueResult>(['catalogue', store.id]);
      const fromMemory = cached?.items.find((p) => p.barcode === data);
      const product = fromMemory ?? (await findCachedByBarcode(store.id, data));

      if (!product) {
        setMessage(`No product with barcode ${data}`);
      } else if (maxSellable(product) <= 0) {
        // Out of stock alone no longer refuses the scan — selling past zero is
        // allowed up to the oversell floor (cart.ts). This only fires once that
        // floor is actually reached.
        setMessage(`${product.name} is already oversold to the limit — count the shelf before selling more.`);
      } else if (alreadyAtStockLimit(product)) {
        // Without this the scanner would close on a scan that changed nothing —
        // the cart silently caps at the stock on hand, and a cashier scanning a
        // sixth unit of a five-unit product would have no way to tell.
        setMessage(
          product.quantity > 0
            ? `All ${product.quantity} of ${product.name} are already on this sale`
            : `${product.name} is already oversold to the limit — count the shelf before selling more.`
        );
      } else {
        add(product);
        router.back();
        return;
      }
    } finally {
      setTimeout(() => {
        busy.current = false;
      }, 1200);
    }
  }

  if (!permission) return <View style={styles.fill} />;

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.fill, styles.center]}>
        <View style={styles.permIcon}>
          <Icon name="camera-off" size={28} color={colors.accent} />
        </View>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permHint}>
          NG POS uses the camera to scan product barcodes at the till.
        </Text>
        <Button
          label="Grant Access"
          icon="camera"
          onPress={requestPermission}
          style={{ marginTop: spacing.xl, alignSelf: 'stretch' }}
        />
        <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{
          barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'],
        }}
        onBarcodeScanned={({ data }) => void onScanned(data)}
      />

      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.reticle}>
          <View style={[styles.corner, styles.cornerTL]} />
          <View style={[styles.corner, styles.cornerTR]} />
          <View style={[styles.corner, styles.cornerBL]} />
          <View style={[styles.corner, styles.cornerBR]} />
        </View>
        <Text style={styles.hint}>
          {capturing ? 'Scan the barcode to fill the field' : 'Point at a product barcode'}
        </Text>
      </View>

      {message ? (
        <View style={styles.toast}>
          <Icon name="alert-circle" size={15} color={colors.danger} />
          <Text style={styles.toastText}>{message}</Text>
        </View>
      ) : null}

      <SafeAreaView style={styles.footer} edges={['bottom']}>
        <Pressable style={styles.closeBtn} onPress={() => router.back()}>
          <Icon name="x" size={20} color={colors.text} />
          <Text style={styles.closeText}>Cancel</Text>
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const CORNER = 30;

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.ink },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl },

  permIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(223,160,44,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  permTitle: { fontFamily: font.bold, fontSize: 19, color: colors.onDark },
  permHint: {
    fontFamily: font.regular,
    fontSize: 14,
    color: colors.onDarkMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
    maxWidth: 300,
  },

  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: { width: 268, height: 172 },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: colors.accent },
  cornerTL: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 12 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 12 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 12 },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 12,
  },
  hint: {
    fontFamily: font.semibold,
    fontSize: 14,
    color: colors.onDark,
    marginTop: spacing.xl,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 6,
  },

  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: 130,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  toastText: { flex: 1, fontFamily: font.semibold, fontSize: 13, color: colors.danger },

  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', padding: spacing.xl },
  closeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  closeText: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
});
