import { api } from './client';
import type {
  AnalyticsPeriod,
  DailyReport,
  DashboardAnalytics,
  InventoryRow,
  LoginResponse,
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
  StorePriceRow,
  TopProduct,
  Transaction,
  TransactionDraft,
  TransactionListParams,
  Transfer,
  TransferDraft,
  User,
  UserDraft,
  Warehouse,
  WarehouseStockRow,
} from './types';

export const auth = {
  login: (email: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { email, password }).then((r) => r.data),
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
};

export const sync = {
  pull: (storeId: string, lastSync?: string | null) =>
    api
      .get<{ products?: Product[]; inventory?: InventoryRow[]; server_time?: string }>('/sync/pull', {
        params: { store_id: storeId, ...(lastSync ? { last_sync: lastSync } : {}) },
      })
      .then((r) => r.data),
};
