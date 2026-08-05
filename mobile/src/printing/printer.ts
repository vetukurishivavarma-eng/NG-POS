import { create } from 'zustand';
import { PermissionsAndroid, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import BtPrinter, { type PairedDevice } from '../../modules/bt-printer';
import type { PaperWidth } from './escpos';

const KEY = 'pos_printer';

export interface PrinterConfig {
  address: string;
  name: string;
  width: PaperWidth;
  openDrawer: boolean;
}

interface PrinterState {
  config: PrinterConfig | null;
  hydrated: boolean;
  restore: () => Promise<void>;
  save: (config: PrinterConfig) => Promise<void>;
  forget: () => Promise<void>;
}

export const usePrinter = create<PrinterState>((set) => ({
  config: null,
  hydrated: false,

  restore: async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      set({ config: raw ? (JSON.parse(raw) as PrinterConfig) : null, hydrated: true });
    } catch {
      set({ config: null, hydrated: true });
    }
  },

  save: async (config) => {
    await SecureStore.setItemAsync(KEY, JSON.stringify(config));
    set({ config });
  },

  forget: async () => {
    await SecureStore.deleteItemAsync(KEY);
    set({ config: null });
  },
}));

/**
 * Android 12+ gates paired-device access behind a runtime permission. Below
 * that the install-time manifest permissions are enough.
 */
export async function ensureBluetoothPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (Number(Platform.Version) < 31) return true;

  const permission = 'android.permission.BLUETOOTH_CONNECT' as Parameters<
    typeof PermissionsAndroid.request
  >[0];

  const already = await PermissionsAndroid.check(permission);
  if (already) return true;

  const result = await PermissionsAndroid.request(permission, {
    title: 'Allow Bluetooth',
    message: 'NG POS needs Bluetooth to send receipts to your thermal printer.',
    buttonPositive: 'Allow',
    buttonNegative: 'Not now',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export interface PrinterStatus {
  supported: boolean;
  enabled: boolean;
  permitted: boolean;
}

export function printerStatus(): PrinterStatus {
  return {
    supported: BtPrinter.isSupported(),
    enabled: BtPrinter.isEnabled(),
    permitted: BtPrinter.hasPermission(),
  };
}

export async function listPairedPrinters(): Promise<PairedDevice[]> {
  const granted = await ensureBluetoothPermission();
  if (!granted) throw new Error('Bluetooth permission denied.');

  const devices = await BtPrinter.getPairedDevices();
  // Likely printers first; everything else stays visible because the class
  // heuristic is not reliable across cheap hardware.
  return [...devices].sort((a, b) => Number(b.isLikelyPrinter) - Number(a.isLikelyPrinter));
}

export async function sendToPrinter(base64: string, address?: string): Promise<void> {
  const target = address ?? usePrinter.getState().config?.address;
  if (!target) throw new Error('No printer selected.');

  const granted = await ensureBluetoothPermission();
  if (!granted) throw new Error('Bluetooth permission denied.');

  await BtPrinter.printBase64(target, base64);
}

export async function testPrinterConnection(address: string): Promise<void> {
  const granted = await ensureBluetoothPermission();
  if (!granted) throw new Error('Bluetooth permission denied.');
  await BtPrinter.testConnection(address);
}

/** Human-readable reason a print can't happen, or null when it can. */
export function printBlockedReason(): string | null {
  if (!BtPrinter.isSupported()) {
    return 'Bluetooth printing needs the installed app — it is not available in Expo Go.';
  }
  if (!BtPrinter.isEnabled()) return 'Bluetooth is turned off.';
  if (!usePrinter.getState().config) return 'No printer selected yet.';
  return null;
}
