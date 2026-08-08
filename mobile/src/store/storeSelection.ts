import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { stores as storesApi } from '../api/endpoints';
import { isNetworkError } from '../api/client';
import type { Store } from '../api/types';

const KEY = 'pos_selected_store';

/**
 * Every query in this app is scoped to one store. Selection is persisted so a
 * cashier who reopens the app lands back on their own till, not store #1.
 *
 * The persisted copy is a full `Store` row, so its `id` can outlive the row it
 * came from — a reseeded database or a build repointed at another server hands
 * out fresh UUIDs, and every store-scoped call then 404s "Store not found."
 * `reconcile()` re-checks the saved selection against the live store list and
 * is what keeps that from becoming permanent.
 */
interface StoreSelectionState {
  selected: Store | null;
  hydrated: boolean;
  select: (store: Store) => Promise<void>;
  restore: () => Promise<void>;
  reconcile: () => Promise<void>;
  clear: () => Promise<void>;
}

export const useStoreSelection = create<StoreSelectionState>((set, get) => ({
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

  /**
   * Re-binds the saved selection to the store list the server actually has.
   * Called on cold start and after sign-in.
   *
   * `code` is the natural key (unique per organisation, and what the seed and
   * the staff both use to name a shop), so it survives a reseed even when the
   * id does not — rebinding on it keeps the till pointed at the same physical
   * shop instead of silently dropping to no selection.
   */
  reconcile: async () => {
    const current = get().selected;
    if (!current) return;

    let list: Store[];
    try {
      list = await storesApi.list();
    } catch (err) {
      // Offline, or the server is down. The cached catalogue is still the right
      // one to sell from, so keep the selection and re-check later.
      if (isNetworkError(err)) return;
      // A 401 already bounces to /login via the response interceptor; anything
      // else here is not good enough evidence to throw away a working till.
      return;
    }

    const match = list.find((s) => s.id === current.id) ?? list.find((s) => s.code === current.code);

    if (!match) {
      await SecureStore.deleteItemAsync(KEY);
      set({ selected: null });
      return;
    }

    // Also refreshes a renamed or deactivated store's cached fields.
    if (JSON.stringify(match) !== JSON.stringify(current)) {
      await SecureStore.setItemAsync(KEY, JSON.stringify(match));
      set({ selected: match });
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
