import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { auth as authApi } from '../api/endpoints';
import { clearToken, setToken, getToken } from '../api/client';
import { deviceIdentity } from './device';
import { useScreenLock } from './screenLock';
import type { User } from '../api/types';

const USER_KEY = 'pos_user';

interface AuthState {
  user: User | null;
  /** False until we've checked SecureStore on cold start. */
  hydrated: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  restore: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  hydrated: false,

  restore: async () => {
    try {
      const [token, raw] = await Promise.all([getToken(), SecureStore.getItemAsync(USER_KEY)]);
      set({ user: token && raw ? (JSON.parse(raw) as User) : null, hydrated: true });
    } catch {
      set({ user: null, hydrated: true });
    }
  },

  signIn: async (email, password) => {
    const res = await authApi.login(email, password, await deviceIdentity());
    await setToken(res.access_token);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(res.user));
    set({ user: res.user });
  },

  signOut: async () => {
    // Release the device server-side first, so the account is free for the next
    // shift immediately rather than when the token expires in thirty days.
    // Best-effort: a till with no signal must still be able to sign out, and
    // the local state below is what actually ends the session on this handset.
    try {
      await authApi.logout();
    } catch {
      /* offline, or the session was already revoked by an admin */
    }
    await clearToken();
    await SecureStore.deleteItemAsync(USER_KEY);

    // The PIN guards a signed-in session, so it dies with one. Kept, it would
    // lock the next person out with a code belonging to whoever had the handset
    // before them — and signing out is precisely the act of handing the device
    // to the next shift.
    await useScreenLock.getState().disable();

    set({ user: null });
  },
}));

/**
 * The web app filters its sidebar by role. Mirror that here so a cashier
 * doesn't see store administration.
 */
export type Capability = 'sell' | 'stock' | 'reports' | 'admin';

export function capabilitiesFor(user: User | null): Capability[] {
  const role = (user?.role ?? '').toLowerCase();
  if (role.includes('admin')) return ['sell', 'stock', 'reports', 'admin'];
  if (role.includes('manager')) return ['sell', 'stock', 'reports'];
  return ['sell'];
}

/** Normalised role, tolerant of whatever casing the API returns. */
export type RoleLevel = 'admin' | 'manager' | 'cashier';

export function roleLevel(user: User | null): RoleLevel {
  const role = (user?.role ?? '').toLowerCase();
  if (role.includes('admin')) return 'admin';
  if (role.includes('manager')) return 'manager';
  return 'cashier';
}

/**
 * Mirrors the backend's `requireRole` guards one-for-one. Hiding a control the
 * server would reject is the whole point — but this is presentation only, and
 * the server is still the thing that decides.
 */
export type Permission =
  | 'products.write'
  | 'products.delete'
  | 'products.import'
  | 'stock.adjust'
  | 'pricing.write'
  | 'warehouses.write'
  | 'transfers.create'
  | 'stores.write'
  | 'suppliers.write'
  | 'suppliers.delete'
  | 'purchases.write'
  | 'purchases.delete'
  | 'users.view'
  | 'users.write'
  | 'settings.write'
  | 'refunds.issue'
  | 'transactions.void'
  | 'reports.rebuild'
  | 'devices.remove';

const PERMISSIONS: Record<Permission, RoleLevel[]> = {
  'products.write': ['admin', 'manager'],
  'products.delete': ['admin'],
  'products.import': ['admin', 'manager'],
  'stock.adjust': ['admin', 'manager'],
  'pricing.write': ['admin', 'manager'],
  'warehouses.write': ['admin'],
  'transfers.create': ['admin', 'manager'],
  // Opening a shop is an organisation-level act, so admin only — the same guard
  // the server puts on POST /stores.
  'stores.write': ['admin'],
  'suppliers.write': ['admin', 'manager'],
  'suppliers.delete': ['admin'],
  'purchases.write': ['admin', 'manager'],
  'purchases.delete': ['admin'],
  'users.view': ['admin', 'manager'],
  'users.write': ['admin'],
  'settings.write': ['admin'],
  'refunds.issue': ['admin', 'manager'],
  'transactions.void': ['admin'],
  'reports.rebuild': ['admin'],
  'devices.remove': ['admin'],
};

/**
 * What this account may do.
 *
 * The server now decides — permissions depend on which store someone works at
 * and, for product entry, on a date — and sends the answer with the account.
 * The role table below is only the fallback for a token issued by a server old
 * enough not to send one, so the app still behaves if the two are out of step.
 */
export function can(user: User | null, permission: Permission): boolean {
  if (user?.capabilities) return user.capabilities.includes(permission);
  return PERMISSIONS[permission].includes(roleLevel(user));
}

/**
 * Why a control is missing, when the reason is a closed window rather than the
 * person's role — worth saying out loud on the screen that lost the button.
 */
export function productEntryClosed(user: User | null): boolean {
  return Boolean(user?.capabilities) && user?.product_entry_open === false;
}

/** Hook form, for use inside screens. */
export function useCan(permission: Permission): boolean {
  return can(useAuth((s) => s.user), permission);
}
