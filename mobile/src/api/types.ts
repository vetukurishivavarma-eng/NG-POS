/**
 * Shapes verified against live responses from the NG POS API on 2026-08-03.
 * See SPEC.md section 5.
 */

export type TaxType = 'exempt' | 'vat';
export type PaymentMethod = 'cash' | 'card' | 'mobile';
export type TransactionType = 'sale' | 'refund' | 'credit_note';
export type TransactionStatus = 'completed' | 'refunded' | 'voided' | 'pending';

export interface Product {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  sku: string;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  cost_price: number;
  selling_price: number;
  tax_type: TaxType;
  unit: string | null;
  variants: unknown[];
  is_active: boolean;
  image_base64: string | null;
  created_at: string;
  updated_at: string;
}

/** `/products/with-stock/{store_id}` — product joined with that store's stock. */
export interface ProductWithStock extends Product {
  quantity: number;
  reorder_level: number;
}

export interface Store {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  address: {
    street: string;
    city: string;
    province: string;
    postal_code: string;
    country: string;
  };
  location: { latitude: number | null; longitude: number | null };
  phone: string;
  email: string;
  is_active: boolean;
  last_sync_at: string | null;
}

export interface TransactionItem {
  product_id: string;
  product_name: string;
  sku: string;
  brand: string | null;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  tax_type: TaxType;
  tax_amount: number;
  line_total: number;
}

export interface Payment {
  method: PaymentMethod;
  amount: number;
  reference: string | null;
}

export interface Transaction {
  id: string;
  organization_id: string;
  store_id: string;
  /** Server-assigned, sequential per store per day: STORECODE-YYYYMMDD-NNNNNN. */
  receipt_number: string;
  transaction_type: TransactionType;
  status: TransactionStatus;
  items: TransactionItem[];
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  payments: Payment[];
  cashier_id: string;
  cashier_name: string;
  customer_name: string | null;
  customer_phone: string | null;
  notes: string;
  /** Set on a refund/credit note: the sale it reverses. */
  reverses_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionListParams {
  limit?: number;
  offset?: number;
  type?: TransactionType;
  status?: TransactionStatus;
  /** ISO datetime, inclusive. */
  from?: string;
  /** ISO datetime, inclusive. */
  to?: string;
}

/**
 * Only product ids and quantities go up — the server reprices from the original
 * sale, so a tampered or stale client can't inflate a refund.
 */
export interface RefundRequest {
  reason?: string;
  /** Omit to refund the whole sale. */
  items?: { product_id: string; quantity: number }[];
  client_reference?: string | null;
}

/** `GET /transactions/reports/daily` — the Z-report figures for one store-day. */
export interface DailyReport {
  store_id: string;
  /** YYYY-MM-DD. */
  date: string;
  transaction_count: number;
  gross_total: number;
  tax_total: number;
  refund_total: number;
  by_payment_method: { cash: number; card: number; mobile: number };
}

/**
 * What we POST to create a sale. Deliberately omits `receipt_number` — the
 * server assigns it, which is what makes offline queueing safe.
 */
export interface TransactionDraft {
  store_id: string;
  transaction_type: TransactionType;
  /**
   * Idempotency key generated on the device before the sale is queued.
   * If a sale is sent, the response is lost, and the queue replays it, the
   * server matches on this key and returns the original instead of charging
   * the customer twice.
   */
  client_reference: string;
  items: TransactionItem[];
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  payments: Payment[];
  customer_name?: string | null;
  customer_phone?: string | null;
  notes?: string;
}

/**
 * Idempotency key for a sale. Not a security token, so a crypto-grade random
 * source isn't needed — it only has to be unique across the devices of one
 * organisation, which time plus randomness comfortably achieves.
 */
export function newClientReference(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const rand2 = Math.random().toString(36).slice(2, 10);
  return `${time}-${rand}${rand2}`;
}

export interface InventoryRow {
  product_id: string;
  store_id: string;
  product_name?: string;
  sku?: string;
  quantity: number;
  reorder_level: number;
  value?: number;
}

export interface User {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  role: string;
  assigned_stores: string[] | null;
  is_active: boolean;
}

/** The three roles the backend accepts. `User.role` stays a string for tolerance. */
export type Role = 'ORG_ADMIN' | 'STORE_MANAGER' | 'CASHIER';

export const ROLE_LABELS: Record<Role, string> = {
  ORG_ADMIN: 'Organisation Admin',
  STORE_MANAGER: 'Store Manager',
  CASHIER: 'Cashier',
};

/** `password` is required on create, optional on update (omit to leave it alone). */
export interface UserDraft {
  email: string;
  full_name: string;
  password?: string;
  role: Role;
  assigned_stores: string[];
  is_active: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_base64?: string | null;
  invoice_logo_base64?: string | null;
  /** Fraction, not percent: 0.16 is 16%. */
  vat_rate: number;
  currency_symbol: string;
}

export interface OrganizationUpdate {
  name?: string;
  slug?: string;
  logo_base64?: string | null;
  invoice_logo_base64?: string | null;
  vat_rate?: number;
  currency_symbol?: string;
}

export interface LoginResponse {
  access_token: string;
  token_type?: string;
  user: User;
}

export interface DashboardAnalytics {
  today_sales: number;
  today_transactions: number;
  week_sales: number;
  week_transactions: number;
  month_sales: number;
  month_transactions: number;
  tax_collected_today: number;
  active_stores: number;
  total_products: number;
  low_stock_count: number;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ products */

/** What POST/PUT `/products` accepts. `id` and timestamps are server-owned. */
export interface ProductDraft {
  name: string;
  description?: string | null;
  sku: string;
  barcode?: string | null;
  brand?: string | null;
  category?: string | null;
  cost_price: number;
  selling_price: number;
  tax_type: TaxType;
  unit?: string | null;
  is_active?: boolean;
  image_base64?: string | null;
}

/* --------------------------------------------------------------- stock moves */

/**
 * `purchase` for stock received, `adjustment` for a correction after a count.
 * The transfer types are written by the transfers endpoint, never posted directly.
 */
export type MovementType = 'purchase' | 'adjustment' | 'transfer_in' | 'transfer_out';

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  purchase: 'Stock received',
  adjustment: 'Adjustment',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
};

/**
 * `quantity` is a *delta*, not a new total — signed for adjustments, positive
 * for purchases. Sending the counted total instead would double the stock.
 */
export interface StockMovementDraft {
  store_id: string;
  product_id: string;
  type: MovementType;
  quantity: number;
  note?: string;
  reorder_level?: number;
}

export interface StockMovement {
  id: string;
  product_id: string;
  product_name: string;
  sku: string;
  type: MovementType;
  quantity: number;
  /** Stock level immediately after this movement. */
  balance: number;
  reference: string | null;
  note: string | null;
  created_at: string;
}

/** What `POST /inventory/movements` returns: the inventory row after the change. */
export interface StockLevel {
  product_id: string;
  store_id: string;
  quantity: number;
  reorder_level: number;
}

/* --------------------------------------------------------------- store price */

export interface StorePriceRow {
  id: string;
  store_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  brand: string | null;
  /** The catalogue price this override replaces. */
  default_price: number;
  store_price: number;
  /** `store_price - default_price`; negative means this store sells cheaper. */
  difference: number;
}

/* ---------------------------------------------------------------- warehouses */

export interface Warehouse {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  is_active: boolean;
  /** Number of distinct products held, not total units. */
  stock_items: number;
  created_at: string;
}

export interface WarehouseStockRow {
  product_id: string;
  product: Product;
  quantity: number;
}

/* ----------------------------------------------------------------- transfers */

export interface TransferItem {
  product_id: string;
  product_name: string;
  sku: string;
  quantity: number;
}

export interface Transfer {
  id: string;
  /** Server-assigned, e.g. `TRF-M8X2K1`. */
  reference: string;
  from_store_id: string;
  from_store: string | null;
  to_store_id: string;
  to_store: string | null;
  status: string;
  items: TransferItem[];
  created_at: string;
}

export interface TransferDraft {
  from_store_id: string;
  to_store_id: string;
  items: { product_id: string; quantity: number }[];
  notes?: string;
}

/* ----------------------------------------------------------------- analytics */

export type AnalyticsPeriod = 'daily' | 'weekly' | 'monthly';

export const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  daily: 'Today',
  weekly: 'This week',
  monthly: 'This month',
};

export interface SalesTrendPoint {
  /** YYYY-MM-DD. Days with no sales are present with zeroes. */
  date: string;
  total: number;
  count: number;
}

export interface TopProduct {
  product_id: string | null;
  product_name: string;
  quantity: number;
  total: number;
}

export interface SalesPerProductRow {
  product_id: string | null;
  product_name: string;
  brand: string | null;
  quantity: number;
  sales: number;
}

export interface ProfitPerProductRow extends SalesPerProductRow {
  /** Net of tax and the cost price captured on the line at sale time. */
  profit: number;
}

export interface SalesPerBranchRow {
  store_id: string;
  branch: string;
  transactions: number;
  sales: number;
}

export interface ProfitPerBranchRow {
  store_id: string;
  branch: string;
  sales: number;
  profit: number;
}

export interface SalesSummary {
  total_sales: number;
  tax_collected: number;
  discounts: number;
  transactions: number;
  average_transaction: number;
}
