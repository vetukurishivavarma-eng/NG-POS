import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface PairedDevice {
  name: string;
  address: string;
  /** Heuristic from the Bluetooth device class / name — used only for sorting. */
  isLikelyPrinter: boolean;
}

interface BtPrinterNativeModule {
  isSupported(): boolean;
  isEnabled(): boolean;
  hasPermission(): boolean;
  getPairedDevices(): Promise<PairedDevice[]>;
  printBase64(address: string, base64Data: string): Promise<boolean>;
  testConnection(address: string): Promise<boolean>;
}

/**
 * Android-only. On any other platform we hand back a stub that reports "not
 * supported" rather than throwing at import time, so the app still runs in
 * Expo Go and on iOS.
 */
const stub: BtPrinterNativeModule = {
  isSupported: () => false,
  isEnabled: () => false,
  hasPermission: () => false,
  getPairedDevices: async () => [],
  printBase64: async () => false,
  testConnection: async () => false,
};

let native: BtPrinterNativeModule = stub;

if (Platform.OS === 'android') {
  try {
    native = requireNativeModule<BtPrinterNativeModule>('BtPrinter');
  } catch {
    // Running in Expo Go, where this custom module isn't bundled.
    native = stub;
  }
}

export default native;
