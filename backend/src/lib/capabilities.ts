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
  'warehouses.write',
  'transfers.create',
  'stores.write',
  'suppliers.write',
  'suppliers.delete',
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
    'users.view',
    'refunds.issue',
    // A manager can read the history of their own shops — the route narrows it
    // to the stores they are assigned to. Who changed a price or corrected a
    // stock figure is the question they are asked, and sending them to the
    // owner for the answer is how the answer stops being asked for.
    'audit.read',
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
const SHOP_STAFF_GRANT: Capability[] = ['pricing.write', 'transfers.create', 'products.import'];

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
  if (input.warehouseStaff) return [...CAPABILITIES];

  const granted = new Set<Capability>(ROLE_CAPABILITIES[input.role] ?? []);

  for (const capability of SHOP_STAFF_GRANT) granted.add(capability);
  if (input.productEntryOpen) {
    for (const capability of SHOP_STAFF_GRANT_WHILE_OPEN) granted.add(capability);
  }

  return CAPABILITIES.filter((c) => granted.has(c));
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
