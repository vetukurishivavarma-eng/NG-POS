import { create } from 'zustand';

/**
 * A one-shot channel for handing a scanned barcode back to the screen that
 * opened the scanner.
 *
 * expo-router can push params forward but has no way to return a value, and the
 * scan screen's normal job is to add to the cart rather than report a code. So
 * `/scan?mode=capture` drops the raw barcode here and the caller consumes it.
 */
interface ScanCaptureState {
  /** Set only between a capture scan and the caller reading it. */
  value: string | null;
  capture: (value: string) => void;
  consume: () => void;
}

export const useScanCapture = create<ScanCaptureState>((set) => ({
  value: null,
  capture: (value) => set({ value }),
  consume: () => set({ value: null }),
}));
