import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import type { Store } from '../api/types';

const KEY = 'pos_selected_store';

/**
 * Every query in this app is scoped to one store. Selection is persisted so a
 * cashier who reopens the app lands back on their own till, not store #1.
 */
interface StoreSelectionState {
  selected: Store | null;
  hydrated: boolean;
  select: (store: Store) => Promise<void>;
  restore: () => Promise<void>;
  clear: () => Promise<void>;
}

export const useStoreSelection = create<StoreSelectionState>((set) => ({
  selected: null,
  hydrated: false,

  restore: async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      set({ selected: raw ? (JSON.parse(raw) as Store) : null, hydrated: true });
    } catch {
      set({ selected: null, hydrated: true });
    }
  },

  select: async (store) => {
    await SecureStore.setItemAsync(KEY, JSON.stringify(store));
    set({ selected: store });
  },

  clear: async () => {
    await SecureStore.deleteItemAsync(KEY);
    set({ selected: null });
  },
}));
