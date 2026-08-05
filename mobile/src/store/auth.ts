import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { auth as authApi } from '../api/endpoints';
import { clearToken, setToken, getToken } from '../api/client';
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
    const res = await authApi.login(email, password);
    await setToken(res.access_token);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(res.user));
    set({ user: res.user });
  },

  signOut: async () => {
    await clearToken();
    await SecureStore.deleteItemAsync(USER_KEY);
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
