import type { Prisma } from '@prisma/client';

/**
 * Prisma returns `Decimal` objects for NUMERIC columns, which would serialise as
 * strings. Clients expect JSON numbers, so every money/quantity value passes
 * through here on the way out.
 *
 * Exactness is preserved in the database; this conversion is presentation only.
 */
export function num(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : value.toNumber();
}

type StoreRow = {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  street: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  phone: string;
  email: string;
  isActive: boolean;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function serializeStore(s: StoreRow) {
  return {
    id: s.id,
    organization_id: s.organizationId,
    name: s.name,
    code: s.code,
    address: {
      street: s.street,
      city: s.city,
      province: s.province,
      postal_code: s.postalCode,
      country: s.country,
    },
    location: { latitude: s.latitude, longitude: s.longitude },
    phone: s.phone,
    email: s.email,
    is_active: s.isActive,
    last_sync_at: s.lastSyncAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function serializeProduct(p: {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  sku: string;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  costPrice: Prisma.Decimal;
  sellingPrice: Prisma.Decimal;
  taxType: string;
  unit: string | null;
  variants: unknown;
  isActive: boolean;
  imageBase64: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: p.id,
    organization_id: p.organizationId,
    name: p.name,
    description: p.description,
    sku: p.sku,
    barcode: p.barcode,
    brand: p.brand,
    category: p.category,
    cost_price: num(p.costPrice),
    selling_price: num(p.sellingPrice),
    tax_type: p.taxType,
    unit: p.unit,
    variants: p.variants ?? [],
    is_active: p.isActive,
    image_base64: p.imageBase64,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

/** Product joined with a store's stock level and any store-specific price. */
export function serializeProductWithStock(
  p: Parameters<typeof serializeProduct>[0],
  quantity: Prisma.Decimal | number,
  reorderLevel: Prisma.Decimal | number,
  overridePrice?: Prisma.Decimal | null
) {
  const base = serializeProduct(p);
  return {
    ...base,
    selling_price: overridePrice ? num(overridePrice) : base.selling_price,
    /** Present so a client can tell an override from the catalogue price. */
    default_selling_price: base.selling_price,
    quantity: num(quantity),
    reorder_level: num(reorderLevel),
  };
}

export function serializeTransaction(t: {
  id: string;
  organizationId: string;
  storeId: string;
  receiptNumber: string;
  transactionType: string;
  status: string;
  subtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  cashierId: string | null;
  cashierName: string;
  customerName: string | null;
  customerPhone: string | null;
  notes: string;
  clientReference: string | null;
  reversesId: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: {
    productId: string | null;
    productName: string;
    sku: string;
    brand: string | null;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    discountAmount: Prisma.Decimal;
    taxType: string;
    taxAmount: Prisma.Decimal;
    lineTotal: Prisma.Decimal;
  }[];
  payments: { method: string; amount: Prisma.Decimal; reference: string | null }[];
}) {
  return {
    id: t.id,
    organization_id: t.organizationId,
    store_id: t.storeId,
    receipt_number: t.receiptNumber,
    transaction_type: t.transactionType,
    status: t.status,
    items: t.items.map((i) => ({
      product_id: i.productId,
      product_name: i.productName,
      sku: i.sku,
      brand: i.brand,
      quantity: num(i.quantity),
      unit_price: num(i.unitPrice),
      discount_amount: num(i.discountAmount),
      tax_type: i.taxType,
      tax_amount: num(i.taxAmount),
      line_total: num(i.lineTotal),
    })),
    subtotal: num(t.subtotal),
    discount_amount: num(t.discountAmount),
    tax_amount: num(t.taxAmount),
    total: num(t.total),
    payments: t.payments.map((p) => ({
      method: p.method,
      amount: num(p.amount),
      reference: p.reference,
    })),
    cashier_id: t.cashierId,
    cashier_name: t.cashierName,
    customer_name: t.customerName,
    customer_phone: t.customerPhone,
    notes: t.notes,
    client_reference: t.clientReference,
    reverses_id: t.reversesId,
    voided_at: t.voidedAt,
    void_reason: t.voidReason,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

export function serializeUser(u: {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  role: string;
  assignedStores: string[];
  isActive: boolean;
}) {
  return {
    id: u.id,
    organization_id: u.organizationId,
    email: u.email,
    full_name: u.fullName,
    role: u.role,
    // Empty means "all stores"; the client renders that as "All stores".
    assigned_stores: u.assignedStores.length > 0 ? u.assignedStores : null,
    is_active: u.isActive,
  };
}

export function serializeDevice(d: {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string | null;
  lastSeenAt: Date;
  lastIp: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  user?: { id: string; fullName: string; email: string; role: string } | null;
}) {
  return {
    id: d.id,
    user_id: d.userId,
    // The raw device id is never sent out. It is the value the app proves
    // itself with, so an admin screen listing every one of them would hand
    // anyone who can read that screen the means to impersonate any till.
    device_name: d.deviceName,
    platform: d.platform,
    app_version: d.appVersion,
    last_seen_at: d.lastSeenAt.toISOString(),
    last_ip: d.lastIp,
    created_at: d.createdAt.toISOString(),
    revoked_at: d.revokedAt?.toISOString() ?? null,
    revoked_reason: d.revokedReason,
    is_active: d.revokedAt == null,
    user: d.user
      ? { id: d.user.id, full_name: d.user.fullName, email: d.user.email, role: d.user.role }
      : null,
  };
}
