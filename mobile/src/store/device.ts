import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * This installation's identity, as far as the server is concerned.
 *
 * One account may only be signed in on one device, so the server needs
 * something stable to hold that claim against. It lives in SecureStore rather
 * than AsyncStorage because it is effectively half a credential: anything
 * holding this value *and* a password can take over the account's single slot.
 *
 * It is deliberately per-install, not per-handset. There is no reliable, stable
 * hardware id on modern Android without privileged permissions, and reaching
 * for one would mean asking a shop for a permission it should refuse. A
 * reinstall therefore reads as a new device — correct, since the old install's
 * token went with it, and an administrator can release the stale claim.
 */

const DEVICE_ID_KEY = 'ngpos.device.id';

export interface DeviceIdentity {
  device_id: string;
  device_name: string;
  platform: string;
  app_version?: string;
}

let cached: string | null = null;

async function deviceId(): Promise<string> {
  if (cached) return cached;

  const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (stored) {
    cached = stored;
    return stored;
  }

  // `randomUUID` is not in React Native's crypto, and expo-crypto is not a
  // dependency. Two of these colliding would have to happen inside one
  // organisation to matter at all, and the server keys on (user, device).
  const fresh = `${Platform.OS}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;

  await SecureStore.setItemAsync(DEVICE_ID_KEY, fresh);
  cached = fresh;
  return fresh;
}

/**
 * What the administrator reads in the Devices list.
 *
 * `deviceName` is the user-set name where the platform exposes it, which is far
 * more use to somebody deciding whether to remove a phone than a model number
 * — a shop calls it "Till 2", not "SM-A125F".
 */
function displayName(): string {
  const named = Constants.deviceName?.trim();
  if (named) return named;
  return Platform.OS === 'android' ? 'Android device' : Platform.OS === 'ios' ? 'iPhone' : 'Device';
}

export async function deviceIdentity(): Promise<DeviceIdentity> {
  return {
    device_id: await deviceId(),
    device_name: displayName(),
    platform: `${Platform.OS} ${Platform.Version}`,
    app_version: Constants.expoConfig?.version ?? undefined,
  };
}

/**
 * Forgets this installation's identity, so the next sign-in registers a new
 * device. Only for a deliberate reset — signing out normally keeps the id, or
 * every shift change would fill the admin's list with one-off rows.
 */
export async function forgetDeviceIdentity(): Promise<void> {
  cached = null;
  await SecureStore.deleteItemAsync(DEVICE_ID_KEY);
}
