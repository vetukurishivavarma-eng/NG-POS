import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  listPairedPrinters,
  printerStatus,
  sendToPrinter,
  testPrinterConnection,
  usePrinter,
} from '../src/printing/printer';
import { buildTestPage } from '../src/printing/receipt';
import { useStoreSelection } from '../src/store/storeSelection';
import type { PairedDevice } from '../modules/bt-printer';
import type { PaperWidth } from '../src/printing/escpos';
import { colors, font, radius, shadow, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Icon, Loading, SectionLabel } from '../src/ui/components';

export default function PrinterScreen() {
  const config = usePrinter((s) => s.config);
  const save = usePrinter((s) => s.save);
  const forget = usePrinter((s) => s.forget);
  const store = useStoreSelection((s) => s.selected);

  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAddress, setBusyAddress] = useState<string | null>(null);

  const status = printerStatus();

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scan() {
    if (!status.supported) {
      setError('Bluetooth printing is only available in the installed app, not Expo Go.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDevices(await listPairedPrinters());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list paired devices.');
    } finally {
      setLoading(false);
    }
  }

  async function choose(device: PairedDevice) {
    setBusyAddress(device.address);
    try {
      await testPrinterConnection(device.address);
      await save({
        address: device.address,
        name: device.name,
        width: config?.width ?? 32,
        openDrawer: config?.openDrawer ?? false,
      });
      Alert.alert('Printer connected', `${device.name} is now the default printer.`);
    } catch (err) {
      Alert.alert(
        'Could not connect',
        err instanceof Error ? err.message : 'The printer did not respond.'
      );
    } finally {
      setBusyAddress(null);
    }
  }

  async function printTest() {
    if (!config) return;
    setBusyAddress(config.address);
    try {
      await sendToPrinter(buildTestPage(config.width, store?.name ?? 'NG POS'), config.address);
    } catch (err) {
      Alert.alert('Print failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setBusyAddress(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.lg }}>
        <View style={styles.statusBar}>
          <View style={styles.statusLeft}>
            <View
              style={[
                styles.statusIcon,
                { backgroundColor: status.enabled ? colors.successSoft : colors.warningSoft },
              ]}
            >
              <Icon
                name="bluetooth"
                size={17}
                color={status.enabled ? colors.success : colors.warning}
              />
            </View>
            <View>
              <Text style={styles.statusTitle}>Bluetooth</Text>
              <Text style={styles.statusHint}>
                {!status.supported
                  ? 'Not available in this build'
                  : status.enabled
                    ? 'Ready'
                    : 'Turn it on in Android settings'}
              </Text>
            </View>
          </View>
          <Badge
            label={!status.supported ? 'Unavailable' : status.enabled ? 'On' : 'Off'}
            tone={!status.supported ? 'neutral' : status.enabled ? 'success' : 'warning'}
            dot
          />
        </View>

        {config ? (
          <View>
            <SectionLabel>Current Printer</SectionLabel>
            <View style={styles.card}>
              <View style={styles.currentRow}>
                <View style={styles.printerIcon}>
                  <Icon name="printer" size={20} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.deviceName}>{config.name}</Text>
                  <Text style={styles.deviceAddr}>{config.address}</Text>
                </View>
                <Badge label="Default" tone="success" dot />
              </View>

              <View style={styles.divider} />

              <Text style={styles.fieldLabel}>Paper width</Text>
              <View style={styles.widthRow}>
                {([32, 48] as PaperWidth[]).map((w) => {
                  const active = config.width === w;
                  return (
                    <Pressable
                      key={w}
                      onPress={() => void save({ ...config, width: w })}
                      style={[styles.widthBtn, active && styles.widthBtnActive]}
                    >
                      <Text style={[styles.widthText, active && styles.widthTextActive]}>
                        {w === 32 ? '58 mm' : '80 mm'}
                      </Text>
                      <Text style={styles.widthHint}>{w} characters</Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.divider} />

              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Open cash drawer</Text>
                  <Text style={styles.note}>Sends a kick pulse on the printer's drawer port.</Text>
                </View>
                <Switch
                  value={config.openDrawer}
                  onValueChange={(v) => void save({ ...config, openDrawer: v })}
                  trackColor={{ true: colors.primary }}
                />
              </View>

              <Button
                label="Print Test Page"
                variant="secondary"
                icon="file-text"
                onPress={printTest}
                loading={busyAddress === config.address}
                style={{ marginTop: spacing.md }}
              />
              <Button label="Forget Printer" variant="ghost" onPress={() => void forget()} />
            </View>
          </View>
        ) : null}

        <View>
          <View style={styles.sectionHeader}>
            <SectionLabel>Paired Devices</SectionLabel>
            <Pressable onPress={scan} hitSlop={8} style={styles.refreshBtn}>
              <Icon name="refresh-cw" size={13} color={colors.primary} />
              <Text style={styles.refresh}>Refresh</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <Text style={styles.note}>
              Pair the printer in Android Bluetooth settings first, then select it here.
            </Text>

            {loading ? (
              <Loading />
            ) : error ? (
              <View style={styles.errorBox}>
                <Icon name="alert-circle" size={15} color={colors.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : (devices ?? []).length === 0 ? (
              <EmptyState
                icon="printer"
                title="No paired devices"
                hint="Pair your thermal printer in Android settings, then refresh."
              />
            ) : (
              (devices ?? []).map((d, i) => {
                const isCurrent = d.address === config?.address;
                return (
                  <Pressable
                    key={d.address}
                    onPress={() => void choose(d)}
                    disabled={busyAddress !== null}
                    style={[styles.device, i > 0 && styles.deviceDivided, isCurrent && styles.deviceSelected]}
                  >
                    <View style={styles.deviceIcon}>
                      <Icon
                        name={d.isLikelyPrinter ? 'printer' : 'bluetooth'}
                        size={16}
                        color={colors.textMuted}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.deviceName}>{d.name}</Text>
                      <Text style={styles.deviceAddr}>{d.address}</Text>
                    </View>
                    {busyAddress === d.address ? (
                      <Text style={styles.connecting}>Connecting</Text>
                    ) : isCurrent ? (
                      <Badge label="Default" tone="success" />
                    ) : d.isLikelyPrinter ? (
                      <Badge label="Printer" tone="info" />
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  statusIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  statusTitle: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  statusHint: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 1 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  refreshBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: spacing.sm },
  refresh: { fontFamily: font.semibold, fontSize: 13, color: colors.primary },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadow.card,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },

  currentRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  printerIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },

  fieldLabel: { fontFamily: font.semibold, fontSize: 13, color: colors.text },
  note: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, lineHeight: 17 },

  widthRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  widthBtn: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
  },
  widthBtnActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  widthText: { fontFamily: font.bold, fontSize: 15, color: colors.textMuted },
  widthTextActive: { color: colors.primary },
  widthHint: { fontFamily: font.regular, fontSize: 10, color: colors.textFaint, marginTop: 1 },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },

  device: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  deviceDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  deviceSelected: { backgroundColor: colors.primarySoft, borderRadius: radius.sm, paddingHorizontal: spacing.sm },
  deviceIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  deviceAddr: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 1 },
  connecting: { fontFamily: font.medium, fontSize: 12, color: colors.textMuted },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  errorText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.danger },
});
