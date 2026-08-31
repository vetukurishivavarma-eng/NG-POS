import { prisma } from '../prisma.js';

/**
 * What a signed-in person is allowed to do.
 *
 * Until now this followed from role alone. It now also depends on *where they
 * work*: the Lusaka store is the organisation's warehouse, and the people
 * working there run the business rather than a till, so they get the whole
 * operational set whatever their role. Staff at the ordinary shops get a small
 * named grant on top of their role, one part of which is deliberately temporary.
 *
 * The server is the authority. The app is told the answer (see `/auth/me` and
 * the login response) rather than working it out again, because two copies of
 * a permission rule drift and the copy on the handset is the one that cannot
 * be trusted anyway.
 */
export const CAPABILITIES = [
  'products.write',
  'products.delete',
  'products.import',
  'stock.adjust',
  'pricing.write',
  // Seeing what the business paid, as opposed to what it charges. Held apart
  // from every other capability because it guards *reading* rather than doing:
  // shop staff price, count and sell stock all day without ever needing to know
  // the margin on it, and the owner asked for it that way — the buying price is
  // his business with his suppliers.
  'costs.view',
  'transfers.create',
  'stores.write',
  'stores.delete',
  'suppliers.write',
  'suppliers.delete',
  // Browsing the full supplier ledger — every wholesaler and what is owed to
  // each. Deliberately separate from `suppliers.write`: a manager still needs
  // to add a supplier and pick one while recording a delivery (both check
  // `suppliers.write`/authentication alone), but the owner asked that the shop
  // login not have a menu item that opens straight to "who are we behind
  // with" — the same money-owed sensitivity as `costs.view`.
  'suppliers.view',
  'purchases.write',
  'purchases.delete',
  'users.view',
  'users.write',
  'settings.write',
  'refunds.issue',
  'transactions.void',
  'reports.rebuild',
  'devices.remove',
  'audit.read',
  'releases.publish',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<string, Capability[]> = {
  ORG_ADMIN: [...CAPABILITIES],
  STORE_MANAGER: [
    'products.write',
    'products.import',
    'stock.adjust',
    'pricing.write',
    'transfers.create',
    'suppliers.write',
    'purchases.write',
    'refunds.issue',
    // Staff (users.view — also gates Devices), History (audit.read) and the
    // supplier ledger (suppliers.view) were withdrawn from the shop login at
    // the owner's explicit request 2026-08-17. `suppliers.write` stays: a
    // manager can still add a supplier and record a delivery.
  ],
  CASHIER: [],
};

/**
 * The permanent half of what shop staff were given.
 *
 * `products.import` sits here rather than in the closing grant below, even
 * though loading a catalogue is the finite job that grant exists for. What the
 * shops actually upload is the buyer's price master, and prices are reissued
 * every time they move — so this is recurring work, and a window that shut
 * would take the monthly repricing with it.
 */
const SHOP_STAFF_GRANT: Capability[] = [
  'pricing.write',
  'transfers.create',
  'products.import',
  // Correcting the stock figure is the other half of running a shop's
  // catalogue, and it was the one part shop staff never had: a cashier could
  // load a whole spreadsheet of stock but not fix a single wrong count by hand.
  // Added 2026-08-16 at the owner's instruction, alongside the deliberate
  // decision that deleting anything stays with an administrator.
  'stock.adjust',
];

/** The half that closes on a date: entering the catalogue is a finite job. */
const SHOP_STAFF_GRANT_WHILE_OPEN: Capability[] = ['products.write'];

export interface CapabilityInput {
  role: string;
  /** Explicitly assigned to a store flagged `staffFullAccess` — the warehouse. */
  warehouseStaff: boolean;
  /** The organisation's product-entry window is still open. */
  productEntryOpen: boolean;
}

export function capabilitiesFor(input: CapabilityInput): Capability[] {
  if (input.role === 'ORG_ADMIN') return [...CAPABILITIES];

  // Warehouse staff are administrators in everything but the name on the
  // account: every capability, including managing accounts, opening and closing
  // shops, and organisation settings. Asked for explicitly, and it cuts both
  // ways — anyone here can change the owner's own password or deactivate their
  // account, so this list is granted by assignment and taken away the same way.
  //
  // With one carve-out, added later at the owner's explicit instruction:
  // removing a shop outright is the only irreversible act in the application,
  // and it stays with the account that owns the organisation. Everything else a
  // warehouse worker might do wrong can be undone — a closed shop reopens, a
  // deactivated product comes back. This cannot.
  if (input.warehouseStaff) return CAPABILITIES.filter((c) => c !== 'stores.delete');

  const granted = new Set<Capability>(ROLE_CAPABILITIES[input.role] ?? []);

  for (const capability of SHOP_STAFF_GRANT) granted.add(capability);
  if (input.productEntryOpen) {
    for (const capability of SHOP_STAFF_GRANT_WHILE_OPEN) granted.add(capability);
  }

  return CAPABILITIES.filter((c) => granted.has(c));
}

/**
 * Whether this account may see buying prices, without loading the whole
 * capability context.
 *
 * `costs.view` is checked on ordinary reads — the catalogue every till pulls on
 * launch — rather than only on guarded writes, so the two queries
 * `capabilityContext` runs would be paid on the hottest route in the API. This
 * answers the same question with one query at most, and none at all for the
 * owner. It must stay in step with `capabilitiesFor`: the capability is granted
 * to an organisation administrator and to warehouse staff, and to nobody else.
 */
export async function mayViewCosts(user: {
  role: string;
  organizationId: string;
  assignedStores: string[];
}): Promise<boolean> {
  if (user.role === 'ORG_ADMIN') return true;
  // Warehouse access comes from an explicit store assignment, so an account
  // with none cannot have it and there is nothing to look up.
  if (user.assignedStores.length === 0) return false;

  const warehouseCount = await prisma.store.count({
    where: {
      organizationId: user.organizationId,
      id: { in: user.assignedStores },
      staffFullAccess: true,
    },
  });
  return warehouseCount > 0;
}

export interface CapabilityContext {
  capabilities: Capability[];
  warehouseStaff: boolean;
  productEntryOpen: boolean;
  productEntryUntil: Date | null;
}

/**
 * Reads the two facts the rule needs, then applies it.
 *
 * An empty `assignedStores` conventionally means "every store", but it does
 * **not** confer warehouse access: this privilege has to be given deliberately,
 * and an unassigned till account is exactly what should not inherit it.
 */
export async function capabilityContext(user: {
  role: string;
  organizationId: string;
  assignedStores: string[];
}): Promise<CapabilityContext> {
  const [warehouseCount, organization] = await Promise.all([
    user.assignedStores.length > 0
      ? prisma.store.count({
          where: {
            organizationId: user.organizationId,
            id: { in: user.assignedStores },
            staffFullAccess: true,
          },
        })
      : Promise.resolve(0),
    prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { staffProductAddUntil: true },
    }),
  ]);

  const until = organization?.staffProductAddUntil ?? null;
  // No date configured means the window was never closed, not that it shut.
  const productEntryOpen = until === null || until.getTime() > Date.now();
  const warehouseStaff = warehouseCount > 0;

  return {
    capabilities: capabilitiesFor({ role: user.role, warehouseStaff, productEntryOpen }),
    warehouseStaff,
    productEntryOpen,
    productEntryUntil: until,
  };
}

/** The shape the app receives with its own account, on login and on /auth/me. */
export async function capabilitySummary(user: {
  role: string;
  organizationId: string;
  assignedStores: string[];
}) {
  const context = await capabilityContext(user);
  return {
    capabilities: context.capabilities,
    warehouse_staff: context.warehouseStaff,
    product_entry_open: context.productEntryOpen,
    product_entry_until: context.productEntryUntil,
  };
}
