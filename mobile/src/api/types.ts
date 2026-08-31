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
  /** The active ingredient, e.g. "Pirimiphos-methyl 1.6%". */
  chemical_name: string | null;
  /** `YYYY-MM-DD`, or null for a line that does not expire. */
  expiry_date: string | null;
  /** Inbound transport per unit. Already inside `cost_price`. */
  transport_cost: number;
  /** The LANDED cost: transport included. */
  cost_price: number;
  selling_price: number;
  tax_type: TaxType;
  unit: string | null;
  variants: unknown[];
  is_active: boolean;
  image_base64: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Only present when the request was scoped to a store (`?store_id=`),
   * whether via `with-stock` or `GET /products/:id?store_id=`. That store's
   * own price/expiry may be overriding these — this is what "no override"
   * falls back to, so the editor can show both.
   */
  default_selling_price?: number;
  default_expiry_date?: string | null;
  /**
   * Only present on the master record (`GET /products/:id` with no
   * `store_id`) — every shop that has diverged from the base price and/or
   * expiry above, so admin can see a shop quietly charging something else
   * without checking each one by hand.
   */
  store_overrides?: {
    store_id: string;
    store_name: string;
    price: number | null;
    expiry_date: string | null;
  }[];
}

/** `/products/with-stock/{store_id}` — product joined with that store's stock. */
export interface ProductWithStock extends Product {
  quantity: number;
  reorder_level: number;
}

/**
 * A shop as it appears in a picker of *other* shops — the destination of a
 * transfer, say. Name and code only: needing to know a sister shop exists is
 * not the same as being entitled to its address, phone and sync state.
 */
export interface StoreDirectoryEntry {
  id: string;
  name: string;
  code: string;
  /**
   * The warehouse. Optional because an older server does not send it — treat a
   * missing value as "an ordinary shop", never as "unknown".
   */
  staff_full_access?: boolean;
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
  /** The warehouse: everyone assigned here gets every administrator capability. */
  staff_full_access?: boolean;
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

export interface StoreStockRow {
  store_id: string;
  store_name: string;
  is_warehouse: boolean;
  quantity: number;
  reorder_level: number;
}

/** One product's stock at every active shop, plus the chain-wide total. */
export interface ProductStockByStore {
  product_id: string;
  product_name: string;
  sku: string;
  total_quantity: number;
  stores: StoreStockRow[];
}

export interface User {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  role: string;
  assigned_stores: string[] | null;
  is_active: boolean;
  /**
   * What this account may do, decided by the server from role *and* the store
   * it works at. Sent only with your own account (login and `/auth/me`), so it
   * is absent on the users list and on tokens from an older server.
   */
  capabilities?: string[];
  /** True when this account works at a store flagged as the warehouse. */
  warehouse_staff?: boolean;
  /** Shop staff may add products until this date; null means no limit. */
  product_entry_open?: boolean;
  product_entry_until?: string | null;
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
  device?: DeviceSession;
}

/**
 * One device's claim on one account. The raw device id is never sent back —
 * it is what the app authenticates with, so an admin screen listing every one
 * of them would hand anyone who can read that screen the means to impersonate
 * a till.
 */
export interface DeviceSession {
  id: string;
  user_id: string;
  device_name: string;
  platform: string;
  app_version: string | null;
  last_seen_at: string;
  last_ip: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  is_active: boolean;
  user: { id: string; full_name: string; email: string; role: Role } | null;
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
/** `GET /products/categories` — the fixed heads, counted, plus the backlog. */
export interface CategorySummary {
  categories: { name: string; count: number }[];
  uncategorized: number;
}

export interface ProductDraft {
  name: string;
  description?: string | null;
  sku: string;
  barcode?: string | null;
  brand?: string | null;
  category?: string | null;
  /**
   * Left out entirely by an account without `costs.view`, which is sent 0 in
   * place of the real buying price and must not post that 0 back. The server
   * treats a missing cost price as "says nothing about it" and keeps what it
   * has, so an omission is safe where a zero would not be.
   */
  cost_price?: number;
  /** Left out by an account without `costs.view`, for the same reason. */
  transport_cost?: number;
  selling_price: number;
  tax_type: TaxType;
  unit?: string | null;
  chemical_name?: string | null;
  /** `YYYY-MM-DD`. The server refuses anything else rather than guess. */
  expiry_date?: string | null;
  is_active?: boolean;
  image_base64?: string | null;
  /**
   * Scopes a `selling_price` change to one store's own StorePrice instead of
   * the org-wide base price. Left out (or "" in the picker) on an admin edit
   * means "All Shops" — the base price, clearing every store's override, same
   * as before this field existed. A shop login must always send its own
   * store's id; the server rejects a price change with neither.
   */
  store_id?: string;
}

/* --------------------------------------------------------------- stock moves */

/**
 * `purchase` for stock received, `adjustment` for a correction after a count.
 * The transfer types are written by the transfers endpoint, never posted directly.
 */
/**
 * Every kind of movement the server can record — including the two it writes
 * itself on every sale and every refund. Leaving those out is what made the
 * movements screen crash: they are by far the most common rows in the table.
 */
export type MovementType =
  | 'purchase'
  | 'sale'
  | 'adjustment'
  | 'transfer_in'
  | 'transfer_out'
  | 'refund';

/**
 * The subset a client may post. `sale` and `refund` are consequences of a
 * transaction and are refused by `POST /inventory/movements`, so they must not
 * be offerable on the stock-adjustment form.
 */
export type PostableMovementType = 'purchase' | 'adjustment' | 'transfer_in' | 'transfer_out';

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  purchase: 'Stock received',
  sale: 'Sale',
  adjustment: 'Adjustment',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  refund: 'Refund',
};

/**
 * `quantity` is a *delta*, not a new total — signed for adjustments, positive
 * for purchases. Sending the counted total instead would double the stock.
 */
export interface StockMovementDraft {
  store_id: string;
  product_id: string;
  type: PostableMovementType;
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
  /** Free text typed when the transfer was made; printed on the transfer note. */
  notes?: string;
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

export type AnalyticsPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/**
 * Every period is calendar-aligned in `REPORT_TIMEZONE`, not a trailing window:
 * "this month" runs from the 1st, and the week starts on Monday. The labels say
 * "this" rather than "last 30 days" because that is what the figures mean.
 */
export const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  daily: 'Today',
  weekly: 'This week',
  monthly: 'This month',
  quarterly: 'This quarter',
  yearly: 'This year',
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
  /** What the goods cost, captured on the line at sale time. */
  cost: number;
  /** VAT charged on the line — it belongs to ZRA, not to the shop. */
  tax: number;
  /** `sales - tax - cost`. Net of tax and the cost price captured at sale time. */
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
  cost: number;
  tax: number;
  profit: number;
}

/**
 * What a period's takings were actually made of. `cost_price + tax +
 * gross_profit === selling_price` exactly, which is what makes it drawable as
 * one ring — cost and profit are parts of the selling price, not peers of it.
 */
export interface MarginSummary {
  period: AnalyticsPeriod;
  /** First day of the period, YYYY-MM-DD in `timezone`. */
  period_start: string;
  timezone: string;
  selling_price: number;
  cost_price: number;
  tax: number;
  gross_profit: number;
  /** Gross profit as a share of the selling price; null when nothing sold. */
  margin_percent: number | null;
  units: number;
  transactions: number;
}

export interface SalesSummary {
  total_sales: number;
  tax_collected: number;
  discounts: number;
  transactions: number;
  average_transaction: number;
}

/* ------------------------------------------------------------------ shops */

/** What `POST /stores` accepts. Address and location are nested, as they are read. */
export interface StoreDraft {
  name: string;
  code: string;
  address?: Partial<Store['address']>;
  location?: Partial<Store['location']>;
  phone?: string;
  email?: string;
  is_active?: boolean;
  /**
   * Mark this as the warehouse. Not cosmetic: everyone assigned to a warehouse
   * gets every administrator capability. Omit to leave it as it is.
   */
  is_warehouse?: boolean;
}

/* -------------------------------------------------------------- suppliers */

export interface Supplier {
  id: string;
  organization_id: string;
  name: string;
  contact_name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  is_active: boolean;
  /** Present on the list, not on a single create/update response. */
  outstanding_balance?: number;
  invoice_count?: number;
  created_at: string;
}

export interface SupplierDraft {
  name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  is_active?: boolean;
}

/* ------------------------------------------------- supplier invoices */

export type SupplierInvoiceStatus = 'unpaid' | 'partial' | 'paid';

export type SupplierPaymentMethod =
  | 'cash'
  | 'bank_transfer'
  | 'mobile'
  | 'cheque'
  | 'card'
  | 'other';

export interface SupplierInvoiceItem {
  id: string;
  product_id: string | null;
  product_name: string;
  sku: string;
  quantity: number;
  unit_cost: number;
  line_total: number;
}

export interface SupplierPaymentRow {
  id: string;
  amount: number;
  method: SupplierPaymentMethod;
  reference: string;
  note: string;
  paid_at: string;
  user_name: string;
}

export interface SupplierInvoice {
  id: string;
  organization_id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_phone: string;
  store_id: string;
  store_name: string;
  store_code: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  subtotal: number;
  tax_amount: number;
  other_charges: number;
  discount_amount: number;
  total: number;
  amount_paid: number;
  /** Total minus what has been paid. The figure every screen leads with. */
  balance: number;
  status: SupplierInvoiceStatus;
  notes: string;
  created_by_name: string;
  items: SupplierInvoiceItem[];
  payments: SupplierPaymentRow[];
  created_at: string;
  updated_at: string;
}

export interface SupplierPaymentDraft {
  amount: number;
  method?: SupplierPaymentMethod;
  reference?: string;
  note?: string;
  paid_at?: string;
}

export interface SupplierInvoiceDraft {
  supplier_id: string;
  store_id: string;
  invoice_number: string;
  invoice_date?: string;
  due_date?: string | null;
  items: { product_id: string; quantity: number; unit_cost: number }[];
  tax_amount?: number;
  other_charges?: number;
  discount_amount?: number;
  notes?: string;
  /** A delivery is when the true cost is known, so this defaults to true. */
  update_cost_price?: boolean;
  /** Omit entirely for goods taken on credit. */
  payment?: SupplierPaymentDraft;
}

export interface SupplierOutstandingSummary {
  outstanding_total: number;
  open_invoice_count: number;
  overdue_total: number;
  overdue_count: number;
  by_supplier: {
    supplier_id: string;
    supplier_name: string;
    balance: number;
    invoices: number;
  }[];
}

/* ------------------------------------------------------------ bulk upload */

/**
 * `set` reads the quantity column as the number counted on the shelf — what an
 * opening stock take means. `add` reads it as a delivery to be added on.
 */
export type BulkUploadMode = 'set' | 'add';

export interface BulkUploadRequest {
  /**
   * Normally absent. The sheet carries every shop in its own columns, so the
   * screen no longer asks which shop is uploading. Kept for a one-shop file
   * with a single bare quantity column.
   */
  store_id?: string;
  /** The sheet as CSV text. Exactly one of `csv` or `xlsx_base64`. */
  csv?: string;
  /** The .xlsx itself, so nobody has to remember to save it as CSV first. */
  xlsx_base64?: string;
  /** Which sheet of a workbook to read. Defaults to the first visible one. */
  sheet?: string;
  mode?: BulkUploadMode;
  create_missing_products?: boolean;
  update_existing_products?: boolean;
  /** Whether the per-shop price columns are written. Server default is true. */
  apply_shop_prices?: boolean;
  /** The same switch for the per-shop closing stock columns. */
  apply_shop_stock?: boolean;
  /**
   * What a row with every closing stock cell empty means. Left off it means
   * "says nothing", and those shelves are untouched; sent true it means "none
   * of these shops has any", and they are written to zero so the product reads
   * as out of stock. The screen asks before sending it.
   */
  zero_missing_stock?: boolean;
  validate_only?: boolean;
  reference?: string;
  note?: string;
}

/**
 * A spreadsheet column that named one of the organisation's shops.
 *
 * Anything other than `ok` has to reach the operator: a price column that
 * quietly did nothing is the worst way this import can fail, because the shop
 * believes the chain was repriced and finds out at the till.
 */
export interface BulkUploadShopColumn {
  column: string;
  /** That shop's closing stock, or that shop's selling price. */
  kind: 'stock' | 'price';
  store_id: string | null;
  store_name: string | null;
  status: 'ok' | 'unknown_shop' | 'no_access' | 'no_permission';
  /** How many rows carry a value in this column. */
  values: number;
}

export interface BulkUploadRowPreview {
  row: number;
  sku: string;
  name: string;
  product_action: 'create' | 'update' | 'unchanged';
  /** How many shops this row counts. */
  shops: number;
  /** True where the file lists the product but counts it in no shop. */
  unstocked: boolean;
  /** Summed across the shops the row counts, not one shop's shelf. */
  quantity_before: number;
  quantity_after: number;
  change: number;
}

export interface BulkUploadResult {
  applied: boolean;
  detail: string;
  /** Only set when a single-shop file named one. Normally null. */
  store_id: string | null;
  mode: BulkUploadMode;
  total_rows: number;
  products_to_create: number;
  products_to_update: number;
  /** Rows that move at least one shelf. */
  stock_rows: number;
  /** Shelves moved, counting each shop separately. */
  shop_stock_writes: number;
  shops_counted: number;
  /** Rows the file lists but counts in no shop — what the popup is about. */
  rows_without_stock: number;
  /** The first twenty of them by name, so the popup can show which. */
  products_without_stock: string[];
  /** What this request did with them. */
  zeroed_missing_stock: boolean;
  /** Every shop-named column found, applied or not, with the reason. */
  shop_columns: BulkUploadShopColumn[];
  /** Rows that price at least one shop. */
  shop_price_rows: number;
  shop_prices_to_write: number;
  /** Headings that matched neither a field nor a shop, and were skipped. */
  ignored_columns: string[];
  warnings: string[];
  /** Only on a dry run. */
  preview?: BulkUploadRowPreview[];
  reference?: string;
}

/** The 422 body when a file cannot be read. Nothing was imported. */
export interface BulkUploadRejection {
  applied: false;
  detail: string;
  total_rows: number;
  errors: { row: number; sku: string; message: string }[];
  error_count: number;
  warnings: string[];
}

/* -------------------------------------------------------------- history */

/**
 * One recorded change. Written by the server's data layer, so every mutation
 * has one whether or not the endpoint that made it knew about the trail.
 */
export interface AuditEntry {
  id: string;
  /** `transaction`, `product`, `store_price`, `auth`, `device` … */
  entity: string;
  entity_id: string;
  /** `create` | `update` | `delete` | `void` | `deactivate` | `login` … */
  action: string;
  /** What the record was called at the time — a receipt number, a product name. */
  label: string;
  /** One line: "Selling price 85.00 → 90.00". */
  summary: string;
  changed_fields: string[];
  /** Whole snapshots. Null on a create (before) and on a delete (after). */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_id: string | null;
  actor_name: string;
  actor_role: string;
  device_name: string | null;
  store_id: string | null;
  ip: string | null;
  route: string;
  minor: boolean;
  created_at: string;
}

export interface AuditPage {
  total: number;
  limit: number;
  offset: number;
  entries: AuditEntry[];
}

export interface AuditTrail {
  entity: string;
  entity_id: string;
  label: string;
  entries: AuditEntry[];
}

/* ------------------------------------------------------- app updates */

export interface AppReleaseInfo {
  version: string;
  build: number;
  minimum_build: number;
  download_url: string;
  notes: string;
  published_at: string;
}

/**
 * The answer to "am I current?".
 *
 * `grace_count` is how many times "Later" may be tapped before the update is
 * compulsory — server-side policy, so a release that must not be postponed can
 * say so without a new app being shipped to enforce it.
 */
export interface VersionCheck {
  platform: string;
  update_available: boolean;
  mandatory: boolean;
  grace_count: number;
  current_build: number | null;
  latest: AppReleaseInfo | null;
}

export interface AppRelease extends AppReleaseInfo {
  id: string;
  platform: string;
  grace_count: number;
  mandatory: boolean;
  is_active: boolean;
  published_by: string;
}

export interface AppReleaseDraft {
  platform?: 'android' | 'ios';
  version: string;
  build: number;
  minimum_build?: number;
  download_url: string;
  notes?: string;
  grace_count?: number;
  mandatory?: boolean;
}
