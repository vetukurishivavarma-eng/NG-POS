import { create } from 'zustand';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';

const KEY = 'pos_day_reminder';
const CHANNEL_ID = 'day-report';

export interface ReminderConfig {
  enabled: boolean;
  /** 24-hour local time the shop closes up. */
  hour: number;
  minute: number;
}

export const DEFAULT_REMINDER: ReminderConfig = { enabled: false, hour: 20, minute: 30 };

interface ReminderState {
  config: ReminderConfig;
  hydrated: boolean;
  restore: () => Promise<void>;
  /** Resolves true only if a notification is actually scheduled. */
  save: (config: ReminderConfig) => Promise<boolean>;
}

/**
 * A local daily reminder to close the session.
 *
 * Local rather than push on purpose: it has to fire on a till sitting in a shop
 * with no signal, which is exactly when the day is most likely to go unclosed.
 */
export const useReminder = create<ReminderState>((set) => ({
  config: DEFAULT_REMINDER,
  hydrated: false,

  restore: async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      const config = raw ? ({ ...DEFAULT_REMINDER, ...JSON.parse(raw) } as ReminderConfig) : DEFAULT_REMINDER;
      set({ config, hydrated: true });
      // Android clears scheduled notifications on some OEM "force stop" paths,
      // so re-assert the schedule on every launch rather than trusting it.
      await applyReminder(config);
    } catch {
      set({ config: DEFAULT_REMINDER, hydrated: true });
    }
  },

  save: async (config) => {
    const scheduled = await applyReminder(config);
    // If the OS refused permission, remember the setting as off rather than
    // showing a reminder the device will never actually fire.
    const stored = scheduled ? config : { ...config, enabled: false };
    await SecureStore.setItemAsync(KEY, JSON.stringify(stored));
    set({ config: stored });
    return scheduled;
  },
}));

/** Android 13+ needs an explicit grant; below that the request resolves granted. */
export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;

  const asked = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: false, allowSound: true },
  });
  return asked.granted;
}

/**
 * Replaces whatever was scheduled with the current setting. Cancelling first is
 * what stops a changed time from leaving yesterday's reminder behind.
 */
export async function applyReminder(config: ReminderConfig): Promise<boolean> {
  await cancelReminder();
  if (!config.enabled) return false;

  if (!(await ensureNotificationPermission())) return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'End of day',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0F5F47',
    });
  }

  await Notifications.scheduleNotificationAsync({
    identifier: KEY,
    content: {
      title: 'Close the day',
      body: "Print the day report and end the session before you lock up.",
      data: { route: '/day-report' },
      ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: config.hour,
      minute: config.minute,
    },
  });

  return true;
}

export async function cancelReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(KEY);
  } catch {
    // Nothing was scheduled under that identifier — fine.
  }
}

/** `20:30` — 24-hour, because that is how a shop rota is written. */
export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
