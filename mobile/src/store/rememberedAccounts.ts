import * as SecureStore from 'expo-secure-store';

/**
 * Logins saved on this device so staff can tap a name instead of typing.
 *
 * The password is kept here in the platform keystore (same store as the auth
 * token, excluded from cloud backup). This is a deliberate trade the owner
 * asked for — a shared till with quick shift changes — against the usual
 * objections: a saved password outlives a remote "remove this device", and the
 * audit trail names the account that was tapped. Two things keep it honest:
 *
 *  - a saved login that the server rejects (password changed, account
 *    deactivated) is forgotten on the spot — see `forgetAccount` calls in the
 *    sign-in flow;
 *  - nothing is saved unless the person ticks the box.
 */
const KEY = 'pos_remembered_accounts';
const MAX = 6;

export interface RememberedAccount {
  email: string;
  password: string;
  full_name: string;
  role: string;
}

export async function listRememberedAccounts(): Promise<RememberedAccount[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is RememberedAccount =>
        a && typeof a.email === 'string' && typeof a.password === 'string'
    );
  } catch {
    return [];
  }
}

async function write(accounts: RememberedAccount[]): Promise<void> {
  try {
    if (accounts.length === 0) {
      await SecureStore.deleteItemAsync(KEY);
    } else {
      await SecureStore.setItemAsync(KEY, JSON.stringify(accounts.slice(0, MAX)));
    }
  } catch {
    /* keystore unavailable — the picker just won't have this entry next time */
  }
}

/** Adds or refreshes one login. Most-recently-used first. */
export async function rememberAccount(account: RememberedAccount): Promise<void> {
  const email = account.email.trim().toLowerCase();
  const existing = await listRememberedAccounts();
  const next = [
    { ...account, email },
    ...existing.filter((a) => a.email.toLowerCase() !== email),
  ];
  await write(next);
}

export async function forgetAccount(email: string): Promise<void> {
  const target = email.trim().toLowerCase();
  const existing = await listRememberedAccounts();
  await write(existing.filter((a) => a.email.toLowerCase() !== target));
}

export async function forgetAllAccounts(): Promise<void> {
  await write([]);
}
