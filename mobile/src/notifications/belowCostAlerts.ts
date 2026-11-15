import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';

import { analytics } from '../api/endpoints';
import { useAuth, useCan } from '../store/auth';
import { formatKwacha } from '../theme';
import { ensureNotificationPermission } from './reminder';

const SEEN_KEY = 'below_cost_seen';
const CHANNEL = 'below-cost';
const EVERY_MS = 60_000;

/**
 * Tells an owner when a sale goes out below cost: asks the server once a
 * minute (while the app is open or recently backgrounded) for sales since the
 * last one it told about, and raises a local notification for each.
 * ponytail: polling, so nothing arrives while the app is fully closed. Real
 * push needs Firebase (FCM) set up for the app; add it if that matters.
 */
export function useBelowCostAlerts() {
  const user = useAuth((s) => s.user);
  const allowed = useCan('costs.view');

  useEffect(() => {
    if (!user || !allowed) return;
    let busy = false;

    const check = async () => {
      if (busy || AppState.currentState !== 'active') return;
      busy = true;
      try {
        const seen = await SecureStore.getItemAsync(SEEN_KEY);
        if (!seen) {
          // First run on this phone: start from now, don't replay history.
          await SecureStore.setItemAsync(SEEN_KEY, new Date().toISOString());
          return;
        }
        const rows = await analytics.belowCostSales({ since: seen });
        if (!rows.length) return;
        if (await ensureNotificationPermission()) {
          if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync(CHANNEL, {
              name: 'Below-cost sales',
              importance: Notifications.AndroidImportance.HIGH,
            });
          }
          for (const r of rows.slice(0, 5)) {
            await Notifications.scheduleNotificationAsync({
              content: {
                title: 'Sold below cost',
                body: `${r.product_name} × ${r.quantity} at ${r.store_name} by ${r.cashier_name || 'unknown'} — loss ${formatKwacha(r.loss)}`,
                data: { route: `/transaction/${r.transaction_id}` },
                ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
              },
              trigger: null,
            });
          }
        }
        const newest = Math.max(...rows.map((r) => new Date(r.created_at).getTime()));
        await SecureStore.setItemAsync(SEEN_KEY, new Date(newest + 1).toISOString());
      } catch {
        // Offline or a server hiccup: try again next minute.
      } finally {
        busy = false;
      }
    };

    void check();
    const timer = setInterval(check, EVERY_MS);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void check());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [user, allowed]);
}
