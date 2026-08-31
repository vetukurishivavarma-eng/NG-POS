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
  /** Re-read the account from the server, so permissions cannot go stale. */
  refresh: () => Promise<void>;
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

  /**
   * Re-reads the account on cold start.
   *
   * The cached copy is written once, at sign-in, and tokens last thirty days —
   * so without this a capability granted today stays invisible for a month, and
   * the only cure is signing out, which nobody would think to try because the
   * app looks like it is working. Exactly how "App Updates" and "History" went
   * missing for an account that was entitled to both.
   *
   * Failure is deliberately silent: offline is the normal case for a till, and
   * the cached account is a perfectly good answer. A 401 is handled by the
   * response interceptor, which ends the session properly.
   */
  refresh: async () => {
    try {
      const fresh = await authApi.me();
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(fresh));
      set({ user: fresh });
    } catch {
      /* offline, or the session ended — the interceptor deals with the latter */
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
  | 'costs.view'
  | 'transfers.create'
  | 'stores.write'
  | 'stores.delete'
  | 'suppliers.write'
  | 'suppliers.delete'
  | 'suppliers.view'
  | 'purchases.write'
  | 'purchases.delete'
  | 'users.view'
  | 'users.write'
  | 'settings.write'
  | 'refunds.issue'
  | 'transactions.void'
  | 'reports.rebuild'
  | 'devices.remove'
  | 'audit.read'
  | 'releases.publish';

const PERMISSIONS: Record<Permission, RoleLevel[]> = {
  'products.write': ['admin', 'manager'],
  'products.delete': ['admin'],
  'products.import': ['admin', 'manager'],
  'stock.adjust': ['admin', 'manager'],
  'pricing.write': ['admin', 'manager'],
  // Buying prices are the owner's business with his suppliers, so this is the
  // one capability a manager does not get. The fallback matters more here than
  // elsewhere: if it were wrong, a handset on an old token would show the cost
  // price rather than merely offer a button the server then refuses.
  'costs.view': ['admin'],
  'transfers.create': ['admin', 'manager'],
  // Opening a shop is an organisation-level act, so admin only — the same guard
  // the server puts on POST /stores.
  'stores.write': ['admin'],
  // The one irreversible act in the app, so it stays with the owner's account —
  // warehouse staff are given everything else but not this.
  'stores.delete': ['admin'],
  'suppliers.write': ['admin', 'manager'],
  'suppliers.delete': ['admin'],
  // Browsing the full supplier ledger (who is owed what) — separate from
  // `suppliers.write`, which a manager keeps for adding a supplier and
  // recording a delivery. Withdrawn from the shop login 2026-08-17.
  'suppliers.view': ['admin'],
  'purchases.write': ['admin', 'manager'],
  'purchases.delete': ['admin'],
  // Staff and Devices withdrawn from the shop login 2026-08-17, at the
  // owner's request — same change as `audit.read` below.
  'users.view': ['admin'],
  'users.write': ['admin'],
  'settings.write': ['admin'],
  'refunds.issue': ['admin', 'manager'],
  'transactions.void': ['admin'],
  'reports.rebuild': ['admin'],
  'devices.remove': ['admin'],
  // Was ['admin', 'manager'] — withdrawn from the shop login 2026-08-17 at the
  // owner's request.
  'audit.read': ['admin'],
  'releases.publish': ['admin'],
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
