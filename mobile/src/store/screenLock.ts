import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';

/**
 * A lock on the app itself, for a handset that lives on a shop counter.
 *
 * The session deliberately outlives the shift — nobody should be typing a
 * password between customers — which leaves one real exposure: an unattended,
 * unlocked till that anyone can pick up and issue a refund from. This closes
 * that without reintroducing the password.
 *
 * The PIN is the credential and it belongs to this app. It is not the phone's
 * unlock code, it is not shared with the operating system, and the device
 * passcode is explicitly refused as a fallback (`disableDeviceFallback`) — so
 * knowing how to unlock the handset does not get anyone into NG POS.
 *
 * Fingerprint and face are a shortcut on top, never the credential. The sensor
 * is the phone's and always will be: biometric templates live in secure
 * hardware that hands out a yes or a no and nothing else, so no application can
 * enrol its own. What the app owns is everything around it — whether the lock
 * exists, who turned it on, what the prompt says, and what happens when it
 * fails, which is the PIN and not the device.
 */

const PIN_KEY = 'pos_lock_pin';
const BIOMETRIC_KEY = 'pos_lock_biometric';

/**
 * How long the app may sit in the background before it relocks.
 *
 * Not zero. A cashier checks a price in WhatsApp or answers a call mid-sale,
 * and a till that demanded a PIN every time would be turned off within a day —
 * a lock people disable protects nothing. A minute is long enough to cover
 * that and far short of leaving the counter.
 */
export const LOCK_AFTER_BACKGROUND_MS = 60_000;

/**
 * Failed attempts before the session ends entirely.
 *
 * This, not the hash, is what protects four digits. Ten thousand combinations
 * fall to a patient thumb in an afternoon; five do not. Running out signs the
 * user out, so the way back in is the password — recoverable for staff,
 * useless to whoever found the phone.
 */
export const MAX_ATTEMPTS = 5;

interface StoredPin {
  salt: string;
  hash: string;
}

interface ScreenLockState {
  /** Null until SecureStore has been read on cold start. */
  configured: boolean | null;
  biometricEnabled: boolean;
  /** Whether the app is currently demanding the PIN. */
  locked: boolean;
  attempts: number;
  restore: () => Promise<void>;
  setPin: (pin: string) => Promise<void>;
  verify: (pin: string) => Promise<boolean>;
  disable: () => Promise<void>;
  setBiometricEnabled: (on: boolean) => Promise<void>;
  lock: () => void;
  unlock: () => void;
  resetAttempts: () => void;
}

/**
 * Salted SHA-256, once.
 *
 * Not stretched, and deliberately so. Stretching exists to make guessing a
 * secret expensive, and four digits is ten thousand guesses — a number that
 * falls in under a second whether it is hashed once or a million times. Paying
 * for iterations here would buy nothing against anyone holding the stored
 * value, while costing a native bridge call apiece on a screen that is used
 * dozens of times a day; a PIN pad that thinks for four seconds is a PIN pad
 * that gets switched off.
 *
 * What actually protects the PIN is elsewhere and not cryptographic:
 * SecureStore keeps this in the Keychain or Keystore so it is not readable in
 * the first place, and `MAX_ATTEMPTS` ends the session long before a thumb gets
 * through the keyspace. The salt is here to stop one shared PIN across a shop's
 * handsets being visibly the same value on each.
 */
async function derive(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

/** Compares in constant time, so a wrong PIN cannot be found one digit at a time. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const useScreenLock = create<ScreenLockState>((set, get) => ({
  configured: null,
  biometricEnabled: false,
  locked: false,
  attempts: 0,

  restore: async () => {
    try {
      const [pin, biometric] = await Promise.all([
        SecureStore.getItemAsync(PIN_KEY),
        SecureStore.getItemAsync(BIOMETRIC_KEY),
      ]);
      const configured = Boolean(pin);
      set({
        configured,
        biometricEnabled: configured && biometric === '1',
        // Locked from the moment it is known to be configured. The alternative
        // is a frame or two of the till visible before the lock lands, which
        // is exactly long enough to read the takings off the dashboard.
        locked: configured,
        attempts: 0,
      });
    } catch {
      set({ configured: false, biometricEnabled: false, locked: false });
    }
  },

  setPin: async (pin) => {
    const salt = Crypto.randomUUID();
    const stored: StoredPin = { salt, hash: await derive(pin, salt) };
    await SecureStore.setItemAsync(PIN_KEY, JSON.stringify(stored));
    set({ configured: true, locked: false, attempts: 0 });
  },

  verify: async (pin) => {
    const raw = await SecureStore.getItemAsync(PIN_KEY);
    if (!raw) return false;

    const stored = JSON.parse(raw) as StoredPin;
    const ok = sameSecret(await derive(pin, stored.salt), stored.hash);

    if (ok) set({ locked: false, attempts: 0 });
    else set({ attempts: get().attempts + 1 });
    return ok;
  },

  disable: async () => {
    await SecureStore.deleteItemAsync(PIN_KEY);
    await SecureStore.deleteItemAsync(BIOMETRIC_KEY);
    set({ configured: false, biometricEnabled: false, locked: false, attempts: 0 });
  },

  setBiometricEnabled: async (on) => {
    await SecureStore.setItemAsync(BIOMETRIC_KEY, on ? '1' : '0');
    set({ biometricEnabled: on });
  },

  lock: () => {
    if (get().configured) set({ locked: true, attempts: 0 });
  },
  unlock: () => set({ locked: false, attempts: 0 }),
  resetAttempts: () => set({ attempts: 0 }),
}));

/* ------------------------------------------------------------- biometrics */

export interface BiometricSupport {
  available: boolean;
  /** "Fingerprint", "Face ID", "Face unlock" — whatever this handset actually has. */
  label: string;
}

/**
 * What this phone can offer, described the way its owner would describe it.
 *
 * Both questions matter and they are different: `hasHardwareAsync` is "is there
 * a sensor", `isEnrolledAsync` is "has anyone registered a finger on it". A
 * shop phone straight out of the box has the first and not the second, and
 * offering the toggle there produces a prompt that can only fail.
 */
export async function biometricSupport(): Promise<BiometricSupport> {
  try {
    const [hardware, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    if (!hardware || !enrolled) return { available: false, label: 'Biometrics' };

    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);

    return {
      available: true,
      label: face && finger ? 'Fingerprint or face' : face ? 'Face unlock' : 'Fingerprint',
    };
  } catch {
    return { available: false, label: 'Biometrics' };
  }
}

/**
 * Offers the sensor, and takes only a yes for an answer.
 *
 * `disableDeviceFallback` is the line between an app lock and a device lock.
 * Left on, a couple of failed scans drop the user to the phone's own unlock
 * code — and anyone who can unlock the handset is then inside NG POS, which
 * defeats the entire point. Off, the only way past this screen is the PIN.
 */
export async function promptBiometric(): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock NG POS',
      cancelLabel: 'Use PIN',
      disableDeviceFallback: true,
      requireConfirmation: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
