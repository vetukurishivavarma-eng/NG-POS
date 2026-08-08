import { useQuery } from '@tanstack/react-query';
import { products as productsApi } from '../api/endpoints';
import { cacheProducts, readCachedProducts } from '../db';
import { useSync } from '../db/sync';
import type { ProductWithStock } from '../api/types';

export interface CatalogueResult {
  items: ProductWithStock[];
  /** True when the network failed and we served the local SQLite copy. */
  fromCache: boolean;
}

/**
 * Store catalogue with stock levels. Always tries the network first so prices
 * and stock are fresh, but never leaves a cashier stranded: on any failure it
 * falls back to the last synced copy.
 */
export function useCatalogue(storeId: string | null) {
  const online = useSync((s) => s.online);

  return useQuery<CatalogueResult>({
    queryKey: ['catalogue', storeId],
    enabled: Boolean(storeId),

    // Stock is not owned by this device. Another till sells, a manager transfers
    // between branches, someone adds a product — and a catalogue that only
    // refreshes on navigation shows a transfer that has already landed as
    // though it never happened.
    //
    // Polls only while online and only while a screen using it is on top:
    // offline, the queued-sales path and the SQLite copy take over, and there
    // is no point hammering a link that is already failing.
    refetchInterval: online ? 20_000 : false,
    refetchIntervalInBackground: false,
    // Overrides the global 30s. Returning to a stock screen should re-read the
    // server, not show what was there when it was last backgrounded.
    staleTime: 0,

    queryFn: async () => {
      if (!storeId) return { items: [], fromCache: false };
      try {
        const items = await productsApi.withStock(storeId);
        // Fire-and-forget: a cache write must never delay the sell screen.
        void cacheProducts(storeId, items);
        return { items, fromCache: false };
      } catch (err) {
        const cached = await readCachedProducts(storeId);
        if (cached.length > 0) return { items: cached, fromCache: true };
        throw err;
      }
    },
  });
}

/** Case-insensitive match across the fields a cashier would actually type. */
export function filterCatalogue(
  items: ProductWithStock[],
  search: string,
  brand: string | null
): ProductWithStock[] {
  const q = search.trim().toLowerCase();
  return items.filter((p) => {
    if (brand && p.brand !== brand) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.sku ?? '').toLowerCase().includes(q) ||
      (p.barcode ?? '').toLowerCase().includes(q) ||
      (p.brand ?? '').toLowerCase().includes(q)
    );
  });
}
