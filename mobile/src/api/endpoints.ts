import { api } from './client';
import type {
  DailyReport,
  DashboardAnalytics,
  InventoryRow,
  LoginResponse,
  Organization,
  Product,
  ProductWithStock,
  RefundRequest,
  Store,
  Transaction,
  TransactionDraft,
  TransactionListParams,
  User,
} from './types';

export const auth = {
  login: (email: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { email, password }).then((r) => r.data),
};

export const organizations = {
  current: () => api.get<Organization>('/organizations/current').then((r) => r.data),
};

export const stores = {
  list: () => api.get<Store[]>('/stores').then((r) => r.data),
  get: (id: string) => api.get<Store>(`/stores/${id}`).then((r) => r.data),
};

export const products = {
  list: (params?: { limit?: number; offset?: number; search?: string }) =>
    api.get<Product[]>('/products', { params }).then((r) => r.data),
  withStock: (storeId: string) =>
    api.get<ProductWithStock[]>(`/products/with-stock/${storeId}`).then((r) => r.data),
  brands: () => api.get<string[]>('/products/brands').then((r) => r.data),
  create: (body: Partial<Product>) => api.post<Product>('/products', body).then((r) => r.data),
  update: (id: string, body: Partial<Product>) =>
    api.put<Product>(`/products/${id}`, body).then((r) => r.data),
  remove: (id: string) => api.delete(`/products/${id}`).then((r) => r.data),
};

export const inventory = {
  list: (storeId: string) =>
    api.get<InventoryRow[]>('/inventory', { params: { store_id: storeId } }).then((r) => r.data),
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
};

export const analytics = {
  dashboard: (storeId: string) =>
    api
      .get<DashboardAnalytics>('/analytics/dashboard', { params: { store_id: storeId } })
      .then((r) => r.data),
  salesTrend: (storeId: string, days = 14) =>
    api
      .get<{ date: string; total: number }[]>('/analytics/sales-trend', {
        params: { store_id: storeId, days },
      })
      .then((r) => r.data),
  topProducts: (storeId: string, limit = 5) =>
    api
      .get<{ product_name: string; quantity: number; total: number }[]>('/analytics/top-products', {
        params: { store_id: storeId, limit },
      })
      .then((r) => r.data),
  salesPerBranch: (period: 'daily' | 'weekly' | 'monthly' = 'monthly') =>
    api.get('/analytics/sales-per-branch', { params: { period } }).then((r) => r.data),
  profitPerBranch: (period: 'daily' | 'weekly' | 'monthly' = 'monthly') =>
    api.get('/analytics/profit-per-branch', { params: { period } }).then((r) => r.data),
};

export const sync = {
  pull: (storeId: string, lastSync?: string | null) =>
    api
      .get<{ products?: Product[]; inventory?: InventoryRow[]; server_time?: string }>('/sync/pull', {
        params: { store_id: storeId, ...(lastSync ? { last_sync: lastSync } : {}) },
      })
      .then((r) => r.data),
};
