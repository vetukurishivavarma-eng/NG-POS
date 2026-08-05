import NetInfo from '@react-native-community/netinfo';
import { create } from 'zustand';
import { products as productsApi, transactions as txApi } from '../api/endpoints';
import { errorMessage, isNetworkError } from '../api/client';
import {
  cacheProducts,
  countPending,
  markPendingFailed,
  readPending,
  removePending,
  setLastSync,
} from './index';

interface SyncState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export const useSync = create<SyncState & {
  setOnline: (online: boolean) => void;
  refreshPendingCount: (storeId?: string) => Promise<void>;
  _set: (patch: Partial<SyncState>) => void;
}>((set) => ({
  online: true,
  syncing: false,
  pendingCount: 0,
  lastSyncedAt: null,
  lastError: null,
  setOnline: (online) => set({ online }),
  refreshPendingCount: async (storeId) => set({ pendingCount: await countPending(storeId) }),
  _set: (patch) => set(patch),
}));

/**
 * Watches connectivity and drains the offline sale queue the moment the device
 * gets a usable connection back. Call once from the root layout.
 */
export function startConnectivityWatcher(getStoreId: () => string | null): () => void {
  let wasOnline = true;

  const unsubscribe = NetInfo.addEventListener((state) => {
    const online = Boolean(state.isConnected && state.isInternetReachable !== false);
    useSync.getState().setOnline(online);

    if (online && !wasOnline) {
      const storeId = getStoreId();
      if (storeId) void pushPending(storeId);
    }
    wasOnline = online;
  });

  return unsubscribe;
}

/**
 * Replays queued sales oldest-first. Stops on the first network failure so the
 * queue keeps its order; a server *rejection* (4xx) drops the sale from the
 * queue rather than blocking every sale behind it forever.
 */
export async function pushPending(storeId: string): Promise<{ sent: number; failed: number }> {
  const { syncing } = useSync.getState();
  if (syncing) return { sent: 0, failed: 0 };

  useSync.getState()._set({ syncing: true, lastError: null });
  let sent = 0;
  let failed = 0;

  try {
    const queue = await readPending(storeId);
    for (const item of queue) {
      try {
        await txApi.create(item.payload);
        await removePending(item.local_id);
        sent += 1;
      } catch (err) {
        if (isNetworkError(err)) {
          // Still offline — leave the rest queued and preserve ordering.
          break;
        }
        failed += 1;
        await markPendingFailed(item.local_id, errorMessage(err));
        if (item.attempts + 1 >= 5) {
          // Repeatedly rejected by the server; stop retrying it every sync.
          await removePending(item.local_id);
        }
      }
    }
  } finally {
    await useSync.getState().refreshPendingCount(storeId);
    useSync.getState()._set({ syncing: false });
  }

  return { sent, failed };
}

/**
 * Refreshes the local catalogue for a store. Uses the plain products endpoint
 * rather than /sync/pull because the latter's delta response shape has not been
 * verified against live data yet — see SPEC.md section 8.
 */
export async function pullCatalogue(storeId: string): Promise<number> {
  useSync.getState()._set({ syncing: true, lastError: null });
  try {
    const items = await productsApi.withStock(storeId);
    await cacheProducts(storeId, items);
    const now = new Date().toISOString();
    await setLastSync(storeId, now);
    useSync.getState()._set({ lastSyncedAt: now });
    return items.length;
  } catch (err) {
    useSync.getState()._set({ lastError: errorMessage(err) });
    throw err;
  } finally {
    useSync.getState()._set({ syncing: false });
  }
}

/** Full round trip: push queued sales, then refresh the catalogue. */
export async function syncAll(storeId: string): Promise<void> {
  await pushPending(storeId);
  await pullCatalogue(storeId);
}
