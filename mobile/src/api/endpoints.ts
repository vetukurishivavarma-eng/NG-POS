import { api } from './client';
import type { DeviceIdentity } from '../store/device';
import type {
  AnalyticsPeriod,
  BulkUploadRequest,
  BulkUploadResult,
  DailyReport,
  DashboardAnalytics,
  InventoryRow,
  LoginResponse,
  MarginSummary,
  Organization,
  OrganizationUpdate,
  Product,
  ProductDraft,
  ProductWithStock,
  ProfitPerBranchRow,
  ProfitPerProductRow,
  RefundRequest,
  SalesPerBranchRow,
  SalesPerProductRow,
  SalesSummary,
  SalesTrendPoint,
  StockLevel,
  StockMovement,
  StockMovementDraft,
  Store,
  StoreDraft,
  StorePriceRow,
  Supplier,
  SupplierDraft,
  SupplierInvoice,
  SupplierInvoiceDraft,
  SupplierInvoiceStatus,
  SupplierOutstandingSummary,
  SupplierPaymentDraft,
  TopProduct,
  Transaction,
  TransactionDraft,
  TransactionListParams,
  Transfer,
  DeviceSession,
  TransferDraft,
  User,
  UserDraft,
  Warehouse,
  WarehouseStockRow,
} from './types';

export const auth = {
  /**
   * The device is sent with the credentials, not after them: the server binds
   * the session to it at sign-in and refuses a second handset, so there is no
   * moment where a token exists without a device attached.
   */
  login: (email: string, password: string, device: DeviceIdentity) =>
    api.post<LoginResponse>('/auth/login', { email, password, device }).then((r) => r.data),

  /** Releases this device so the account can be used on another one. */
  logout: () => api.post<{ detail: string }>('/auth/logout').then((r) => r.data),

  /**
   * Asks the server to mail a one-time code to the organisation's administrator.
   * The answer is the same whether or not the address is known, so it can't be
   * used to find out who has an account.
   */
  forgotPassword: (email: string) =>
    api.post<{ detail: string }>('/auth/forgot-password', { email }).then((r) => r.data),

  resetPassword: (email: string, code: string, newPassword: string) =>
    api
      .post<{ detail: string }>('/auth/reset-password', {
        email,
        code,
        new_password: newPassword,
      })
      .then((r) => r.data),
};

export const devices = {
  /** Everything signed in across the organisation. Admin and manager. */
  list: (params?: { user_id?: string; include_revoked?: boolean }) =>
    api
      .get<DeviceSession[]>('/devices', {
        params: {
          ...(params?.user_id ? { user_id: params.user_id } : {}),
          ...(params?.include_revoked ? { include_revoked: 'true' } : {}),
        },
      })
      .then((r) => r.data),

  /** This handset's own session. */
  me: () => api.get<DeviceSession>('/devices/me').then((r) => r.data),

  /** Release a device. Admin only; takes effect on that handset immediately. */
  remove: (id: string, reason?: string) =>
    api
      .delete<DeviceSession>(`/devices/${id}`, { data: reason ? { reason } : undefined })
      .then((r) => r.data),
};

export const organizations = {
  current: () => api.get<Organization>('/organizations/current').then((r) => r.data),
  /** Admin only. Partial — omitted fields are left as they are. */
  update: (body: OrganizationUpdate) =>
    api.put<Organization>('/organizations/current', body).then((r) => r.data),
};

export const stores = {
  list: () => api.get<Store[]>('/stores').then((r) => r.data),
  get: (id: string) => api.get<Store>(`/stores/${id}`).then((r) => r.data),
  /** Admin only. `code` is uppercased and stripped of spaces by the server. */
  create: (body: StoreDraft) => api.post<Store>('/stores', body).then((r) => r.data),
  update: (id: string, body: Partial<StoreDraft>) =>
    api.put<Store>(`/stores/${id}`, body).then((r) => r.data),
  /** Deactivates rather than deletes — receipts still reference the shop. */
  deactivate: (id: string) =>
    api.delete<{ detail: string }>(`/stores/${id}`).then((r) => r.data),
};

export const suppliers = {
  /** Each row carries `outstanding_balance`, so the list can lead with the debt. */
  list: () => api.get<Supplier[]>('/suppliers').then((r) => r.data),
  create: (body: SupplierDraft) => api.post<Supplier>('/suppliers', body).then((r) => r.data),
  update: (id: string, body: Partial<SupplierDraft>) =>
    api.put<Supplier>(`/suppliers/${id}`, body).then((r) => r.data),
  deactivate: (id: string) =>
    api.delete<{ detail: string }>(`/suppliers/${id}`).then((r) => r.data),
};

export const purchases = {
  list: (params?: {
    store_id?: string;
    supplier_id?: string;
    status?: SupplierInvoiceStatus | 'outstanding';
    search?: string;
    limit?: number;
    offset?: number;
  }) => api.get<SupplierInvoice[]>('/supplier-invoices', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get<SupplierInvoice>(`/supplier-invoices/${id}`).then((r) => r.data),

  /**
   * Records the delivery, the debt and the stock in one server transaction.
   * The invoice number is unique per supplier, so a second attempt at the same
   * paperwork comes back 409 rather than doubling both.
   */
  create: (body: SupplierInvoiceDraft) =>
    api.post<SupplierInvoice>('/supplier-invoices', body).then((r) => r.data),

  /** One instalment. Refused if it would take the invoice past its total. */
  pay: (id: string, body: SupplierPaymentDraft) =>
    api.post<SupplierInvoice>(`/supplier-invoices/${id}/payments`, body).then((r) => r.data),

  /** Only the paperwork fields; the money and the stock are settled events. */
  update: (id: string, body: { notes?: string; due_date?: string | null }) =>
    api.put<SupplierInvoice>(`/supplier-invoices/${id}`, body).then((r) => r.data),

  /** Reverses the stock too. Refused once anything has been paid against it. */
  remove: (id: string) =>
    api.delete<{ detail: string }>(`/supplier-invoices/${id}`).then((r) => r.data),

  summary: (storeId?: string) =>
    api
      .get<SupplierOutstandingSummary>('/supplier-invoices/summary', {
        params: storeId ? { store_id: storeId } : undefined,
      })
      .then((r) => r.data),
};

export const products = {
  list: (params?: {
    limit?: number;
    offset?: number;
    search?: string;
    brand?: string;
    category?: string;
  }) => api.get<Product[]>('/products', { params }).then((r) => r.data),
  get: (id: string) => api.get<Product>(`/products/${id}`).then((r) => r.data),
  withStock: (storeId: string) =>
    api.get<ProductWithStock[]>(`/products/with-stock/${storeId}`).then((r) => r.data),
  brands: () => api.get<string[]>('/products/brands').then((r) => r.data),
  create: (body: ProductDraft) => api.post<Product>('/products', body).then((r) => r.data),
  update: (id: string, body: Partial<ProductDraft>) =>
    api.put<Product>(`/products/${id}`, body).then((r) => r.data),
  /** Soft delete — past receipts still reference the product. */
  remove: (id: string) =>
    api.delete<{ detail: string }>(`/products/${id}`).then((r) => r.data),
};

export const inventory = {
  list: (storeId: string, lowOnly = false) =>
    api
      .get<InventoryRow[]>('/inventory', {
        params: { store_id: storeId, ...(lowOnly ? { low_only: true } : {}) },
      })
      .then((r) => r.data),
  /**
   * Applies a stock delta and records why. Inventory is never edited directly,
   * so every discrepancy can be traced back to a movement row.
   */
  adjust: (body: StockMovementDraft) =>
    api.post<StockLevel>('/inventory/movements', body).then((r) => r.data),
  movements: (storeId: string, params?: { product_id?: string; limit?: number }) =>
    api
      .get<StockMovement[]>('/inventory/movements', { params: { store_id: storeId, ...params } })
      .then((r) => r.data),

  /**
   * Loads a whole spreadsheet at once. All or nothing: one unreadable line
   * rejects the file with 422 and a list of line numbers, and nothing is
   * written — so `validate_only` first is free, and worth doing every time.
   */
  bulkUpload: (body: BulkUploadRequest) =>
    api.post<BulkUploadResult>('/inventory/bulk-upload', body).then((r) => r.data),

  /** The blank spreadsheet, as CSV text, to save or share from the device. */
  bulkUploadTemplate: () =>
    api
      .get<string>('/inventory/bulk-upload/template', { responseType: 'text' })
      .then((r) => r.data),
};

export const transactions = {
  list: (storeId: string, params?: TransactionListParams) =>
    api
      .get<Transaction[]>('/transactions', { params: { store_id: storeId, ...params } })
      .then((r) => r.data),
  get: (id: string) => api.get<Transaction>(`/transactions/${id}`).then((r) => r.data),
  create: (draft: TransactionDraft) =>
    api.post<Transaction>('/transactions', draft).then((r) => r.data),
  /** Reverses a sale in full or in part; returns the linked refund transaction. */
  refund: (id: string, body: RefundRequest) =>
    api.post<Transaction>(`/transactions/${id}/refund`, body).then((r) => r.data),
  void: (id: string, reason: string) =>
    api.post<Transaction>(`/transactions/${id}/void`, { reason }).then((r) => r.data),
  /** Z-report for one store on one day. `date` is YYYY-MM-DD; omit for today. */
  dailyReport: (storeId: string, date?: string) =>
    api
      .get<DailyReport>('/transactions/reports/daily', {
        params: { store_id: storeId, ...(date ? { date } : {}) },
      })
      .then((r) => r.data),
};

export const users = {
  list: () => api.get<User[]>('/users').then((r) => r.data),
  create: (body: UserDraft) => api.post<User>('/users', body).then((r) => r.data),
  update: (id: string, body: Partial<UserDraft>) =>
    api.put<User>(`/users/${id}`, body).then((r) => r.data),
  /** Deactivates rather than deletes; the server refuses your own account. */
  deactivate: (id: string) => api.delete<{ detail: string }>(`/users/${id}`).then((r) => r.data),
};

export const storePricing = {
  list: (storeId: string) =>
    api.get<StorePriceRow[]>('/store-pricing', { params: { store_id: storeId } }).then((r) => r.data),
  /** Upsert — one override per store/product pair. */
  set: (storeId: string, productId: string, price: number) =>
    api
      .post<{ id: string; store_price: number }>('/store-pricing', {
        store_id: storeId,
        product_id: productId,
        price,
      })
      .then((r) => r.data),
  /** Removes the override so the catalogue price applies again. */
  remove: (id: string) =>
    api.delete<{ detail: string }>(`/store-pricing/${id}`).then((r) => r.data),
};

export const warehouses = {
  list: () => api.get<Warehouse[]>('/warehouses').then((r) => r.data),
  /**
   * Returns only these four fields — not a full `Warehouse`. Refetch the list
   * for `stock_items` and `created_at` rather than trusting this response.
   */
  create: (name: string, code: string) =>
    api
      .post<Pick<Warehouse, 'id' | 'name' | 'code' | 'is_active'>>('/warehouses', { name, code })
      .then((r) => r.data),
  stock: (id: string) =>
    api.get<WarehouseStockRow[]>(`/warehouses/${id}/stock`).then((r) => r.data),
  remove: (id: string) => api.delete<{ detail: string }>(`/warehouses/${id}`).then((r) => r.data),
};

export const transfers = {
  list: () => api.get<Transfer[]>('/transfers').then((r) => r.data),
  /** Both stock movements happen in one server transaction; it is all-or-nothing. */
  create: (body: TransferDraft) =>
    api
      .post<{ id: string; reference: string; status: string }>('/transfers', body)
      .then((r) => r.data),
};

export const analytics = {
  dashboard: (storeId: string) =>
    api
      .get<DashboardAnalytics>('/analytics/dashboard', { params: { store_id: storeId } })
      .then((r) => r.data),
  salesTrend: (storeId: string | null, days = 14) =>
    api
      .get<SalesTrendPoint[]>('/analytics/sales-trend', {
        params: { ...(storeId ? { store_id: storeId } : {}), days },
      })
      .then((r) => r.data),
  topProducts: (storeId: string | null, limit = 5, period: AnalyticsPeriod = 'monthly') =>
    api
      .get<TopProduct[]>('/analytics/top-products', {
        params: { ...(storeId ? { store_id: storeId } : {}), limit, period },
      })
      .then((r) => r.data),
  salesPerProduct: (storeId: string | null, period: AnalyticsPeriod = 'monthly') =>
    api
      .get<SalesPerProductRow[]>('/analytics/sales-per-product', {
        params: { ...(storeId ? { store_id: storeId } : {}), period },
      })
      .then((r) => r.data),
  profitPerProduct: (storeId: string | null, period: AnalyticsPeriod = 'monthly') =>
    api
      .get<ProfitPerProductRow[]>('/analytics/profit-per-product', {
        params: { ...(storeId ? { store_id: storeId } : {}), period },
      })
      .then((r) => r.data),
  /** Org-wide by design: the backend ignores any store filter here. */
  salesPerBranch: (period: AnalyticsPeriod = 'monthly') =>
    api
      .get<SalesPerBranchRow[]>('/analytics/sales-per-branch', { params: { period } })
      .then((r) => r.data),
  profitPerBranch: (period: AnalyticsPeriod = 'monthly') =>
    api
      .get<ProfitPerBranchRow[]>('/analytics/profit-per-branch', { params: { period } })
      .then((r) => r.data),
  salesSummary: (storeId: string | null, period: AnalyticsPeriod = 'monthly') =>
    api
      .get<SalesSummary>('/analytics/sales-summary', {
        params: { ...(storeId ? { store_id: storeId } : {}), period },
      })
      .then((r) => r.data),
  /** Cost of goods, VAT and gross profit — the three parts of the selling price. */
  marginSummary: (storeId: string | null, period: AnalyticsPeriod = 'monthly') =>
    api
      .get<MarginSummary>('/analytics/margin-summary', {
        params: { ...(storeId ? { store_id: storeId } : {}), period },
      })
      .then((r) => r.data),
};

export const sync = {
  pull: (storeId: string, lastSync?: string | null) =>
    api
      .get<{ products?: Product[]; inventory?: InventoryRow[]; server_time?: string }>('/sync/pull', {
        params: { store_id: storeId, ...(lastSync ? { last_sync: lastSync } : {}) },
      })
      .then((r) => r.data),
};
