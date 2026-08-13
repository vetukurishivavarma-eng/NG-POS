import type { Store, StoreDirectoryEntry } from '../api/types';

/**
 * What to call the place somebody is standing in.
 *
 * The organisation runs shops and one warehouse, and the warehouse is a store
 * row like any other — `staff_full_access` is the only thing that marks it.
 * That is right for the data and wrong for the screen: somebody at the
 * warehouse does not sell to walk-in customers, and being asked to "choose a
 * shop" or told "stock can only leave the shop you work at" reads as the app
 * not knowing where they are.
 *
 * One place to ask, so the answer cannot differ between two screens.
 */

type AnyStore = Pick<Store, 'staff_full_access'> | Pick<StoreDirectoryEntry, 'staff_full_access'>;

export function isWarehouse(store: AnyStore | null | undefined): boolean {
  // An older server omits the field. Absent means an ordinary shop — never
  // "unknown", because a screen has to print one word or the other.
  return store?.staff_full_access === true;
}

/** "warehouse" or "shop", for dropping into a sentence. */
export function placeNoun(store: AnyStore | null | undefined): string {
  return isWarehouse(store) ? 'warehouse' : 'shop';
}

/** "Warehouse" or "Shop", for starting one. */
export function PlaceNoun(store: AnyStore | null | undefined): string {
  return isWarehouse(store) ? 'Warehouse' : 'Shop';
}

/**
 * The name with its role attached, for a list where both kinds appear together.
 * "Lusaka · Warehouse" answers the question a picker of six identical-looking
 * names cannot.
 */
export function placeLabel(store: { name: string } & AnyStore): string {
  return isWarehouse(store) ? `${store.name} · Warehouse` : store.name;
}

/**
 * Warehouse first, then shops by name.
 *
 * The warehouse is one end of most transfers — stock goes out to the shops from
 * it, and comes back to it — so it is the entry most often being looked for.
 * Everything else keeps the server's alphabetical order.
 */
export function warehouseFirst<T extends { name: string } & AnyStore>(stores: T[]): T[] {
  return [...stores].sort((a, b) => {
    if (isWarehouse(a) !== isWarehouse(b)) return isWarehouse(a) ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
