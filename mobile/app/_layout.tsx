import React, { useEffect, useRef, useState } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AppState, View } from 'react-native';

import { useFonts } from 'expo-font';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';

import * as Notifications from 'expo-notifications';

import { restoreApiBaseUrl, setUnauthorizedHandler } from '../src/api/client';
import { updateGateVisible, useAppUpdate } from '../src/store/appUpdate';
import { useAuth } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { startConnectivityWatcher, useSync } from '../src/db/sync';
import { usePrinter } from '../src/printing/printer';
import { useReminder } from '../src/notifications/reminder';
import { LOCK_AFTER_BACKGROUND_MS, useScreenLock } from '../src/store/screenLock';
import { colors } from '../src/theme';
import { Loading } from '../src/ui/components';
import { FlyToCartProvider } from '../src/ui/flyToCart';
import { LockScreen } from '../src/ui/LockScreen';
import { UpdateGate } from '../src/ui/UpdateGate';

// A closing-time reminder is useless if it only appears while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Shop staff work on flaky rural connections; don't hammer a dying link.
      retry: 1,
      staleTime: 30_000,
      // Coming back to the app should show the current picture, not whatever
      // was on screen when it was backgrounded — the data here is shared
      // between tills and branches, so it goes stale without this device
      // doing anything. Still bounded by staleTime, so it is not a free-for-all.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

export default function RootLayout() {
  const { user, hydrated, restore } = useAuth();
  const restoreStore = useStoreSelection((s) => s.restore);
  const storeHydrated = useStoreSelection((s) => s.hydrated);
  const restorePrinter = usePrinter((s) => s.restore);
  const restoreReminder = useReminder((s) => s.restore);
  const restoreLock = useScreenLock((s) => s.restore);
  const lockConfigured = useScreenLock((s) => s.configured);
  const locked = useScreenLock((s) => s.locked);
  const segments = useSegments();
  const updateBlocking = useAppUpdate(updateGateVisible);
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledResponse = useRef<string | null>(null);
  // Nothing may render until the saved server address is loaded, or the first
  // request would go to the address baked into the build instead.
  const [apiReady, setApiReady] = useState(false);

  const [fontsLoaded] = useFonts({
    Jakarta_400Regular: PlusJakartaSans_400Regular,
    Jakarta_500Medium: PlusJakartaSans_500Medium,
    Jakarta_600SemiBold: PlusJakartaSans_600SemiBold,
    Jakarta_700Bold: PlusJakartaSans_700Bold,
    Jakarta_800ExtraBold: PlusJakartaSans_800ExtraBold,
  });

  useEffect(() => {
    void restoreApiBaseUrl().finally(() => setApiReady(true));
    void restore();
    void restoreStore();
    void restorePrinter();
    void restoreReminder();
    void restoreLock();
  }, [restore, restoreStore, restorePrinter, restoreReminder, restoreLock]);

  /**
   * Relock when the app has been away long enough.
   *
   * The gap is measured rather than locking on every `background`, because iOS
   * and Android both send that for a notification shade pull, a permission
   * dialog and an incoming call — none of which mean the phone left the
   * counter. See `LOCK_AFTER_BACKGROUND_MS`.
   */
  useEffect(() => {
    if (!lockConfigured) return;

    let leftAt: number | null = null;

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (leftAt !== null && Date.now() - leftAt >= LOCK_AFTER_BACKGROUND_MS) {
          useScreenLock.getState().lock();
        }
        leftAt = null;
      } else if (next === 'background' || next === 'inactive') {
        // Only the first of a run: iOS sends `inactive` then `background`, and
        // resetting on the second would shorten the window it is measuring.
        leftAt ??= Date.now();
      }
    });

    return () => subscription.remove();
  }, [lockConfigured]);

  // The saved store is a snapshot of a server row and can outlive it (reseeded
  // database, build repointed at another server). Left unchecked, every
  // store-scoped call — including Sync Now — fails with "Store not found" until
  // the app is reinstalled, so re-bind it as soon as we can talk to the server.
  useEffect(() => {
    if (!user || !hydrated || !storeHydrated || !apiReady) return;
    void useStoreSelection.getState().reconcile();
  }, [user, hydrated, storeHydrated, apiReady]);

  // Tapping the closing-time reminder should land on the report itself, not
  // wherever the app happened to be left. `useLastNotificationResponse` also
  // covers the cold-start case, where the tap is what launched the app — but it
  // keeps returning that same response, so each one is navigated to only once.
  useEffect(() => {
    if (!user || !hydrated || !lastResponse) return;

    const id = lastResponse.notification.request.identifier;
    if (handledResponse.current === id) return;
    handledResponse.current = id;

    const route = lastResponse.notification.request.content.data?.route;
    if (typeof route === 'string') router.push(route as never);
  }, [lastResponse, user, hydrated]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void useAuth.getState().signOut();
      router.replace('/login');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    const stop = startConnectivityWatcher(() => useStoreSelection.getState().selected?.id ?? null);
    void useSync.getState().refreshPendingCount();
    return stop;
  }, []);

  /**
   * Ask whether this build is still the current one — on opening, and again
   * whenever the app is brought back to the foreground.
   *
   * The foreground case is not decoration: a till is rarely restarted. Left to
   * cold starts alone, a shop could run a build for a week after it was
   * withdrawn. The store throttles the calls, so a shift's worth of switching
   * between apps is one request every half hour.
   */
  useEffect(() => {
    if (!apiReady) return;
    void useAppUpdate.getState().check();

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void useAppUpdate.getState().check();
    });
    return () => subscription.remove();
  }, [apiReady]);

  // Route guard: unauthenticated users can only reach the sign-in screens.
  // Password recovery has to be in this set — the person using it cannot sign
  // in by definition, so guarding it as a private route bounces them straight
  // back to /login the moment the screen mounts.
  useEffect(() => {
    if (!hydrated || !storeHydrated) return;
    const inAuthGroup = segments[0] === 'login' || segments[0] === 'forgot-password';

    if (!user && !inAuthGroup) {
      router.replace('/login');
      // Only /login is wrong for a signed-in user; landing on recovery while
      // signed in is a deliberate act, so let it be.
    } else if (user && segments[0] === 'login') {
      router.replace('/');
    }
  }, [user, hydrated, storeHydrated, segments]);

  // `lockConfigured === null` means SecureStore has not been read yet. Waiting
  // for it matters: render the app first and a locked till flashes its takings
  // on screen for a frame before the lock lands over the top.
  if (!hydrated || !storeHydrated || !fontsLoaded || !apiReady || lockConfigured === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas, justifyContent: 'center' }}>
        <Loading />
      </View>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {/* Wraps the navigator so a token can fly over the whole app, including
            across a modal — the cart bar it lands on belongs to the screen
            underneath. */}
        <FlyToCartProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="forgot-password" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="store-picker"
            // Not "Select Store": the list holds the warehouse as well as the
            // shops, and somebody who works at the warehouse is not picking one.
            options={{ presentation: 'modal', headerShown: true, title: 'Shops & Warehouse' }}
          />
          <Stack.Screen
            name="cart"
            options={{ presentation: 'modal', headerShown: true, title: 'Cart' }}
          />
          <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen
            name="printer"
            options={{ presentation: 'modal', headerShown: true, title: 'Receipt Printer' }}
          />
          <Stack.Screen
            name="screen-lock"
            options={{ presentation: 'modal', headerShown: true, title: 'Screen Lock' }}
          />
          <Stack.Screen name="sales" options={{ headerShown: true, title: 'Sales History' }} />
          <Stack.Screen name="transaction/[id]" options={{ headerShown: true, title: 'Receipt' }} />
          <Stack.Screen
            name="refund"
            options={{ presentation: 'modal', headerShown: true, title: 'Issue Refund' }}
          />
          <Stack.Screen name="day-report" options={{ headerShown: true, title: 'Day Report' }} />
          <Stack.Screen
            name="reminder"
            options={{ presentation: 'modal', headerShown: true, title: 'Closing Reminder' }}
          />

          <Stack.Screen name="products/index" options={{ headerShown: true, title: 'Products' }} />
          <Stack.Screen
            name="products/[id]"
            options={{ presentation: 'modal', headerShown: true, title: 'Product' }}
          />
          <Stack.Screen
            name="stock-adjust"
            options={{ presentation: 'modal', headerShown: true, title: 'Adjust Stock' }}
          />
          <Stack.Screen name="movements" options={{ headerShown: true, title: 'Stock Movements' }} />
          <Stack.Screen
            name="stock-import"
            options={{ headerShown: true, title: 'Bulk Stock Upload' }}
          />
          <Stack.Screen name="shops" options={{ headerShown: true, title: 'Shops' }} />
          <Stack.Screen name="suppliers" options={{ headerShown: true, title: 'Suppliers' }} />
          <Stack.Screen
            name="purchases/index"
            options={{ headerShown: true, title: 'Supplier Invoices' }}
          />
          <Stack.Screen
            name="purchases/new"
            options={{ headerShown: true, title: 'Record a Delivery' }}
          />
          <Stack.Screen name="purchases/[id]" options={{ headerShown: true, title: 'Invoice' }} />
          <Stack.Screen name="store-pricing" options={{ headerShown: true, title: 'Store Pricing' }} />
          <Stack.Screen name="users/index" options={{ headerShown: true, title: 'Staff' }} />
          <Stack.Screen name="devices" options={{ headerShown: true, title: 'Devices' }} />
          <Stack.Screen
            name="users/[id]"
            options={{ presentation: 'modal', headerShown: true, title: 'Staff Member' }}
          />
          <Stack.Screen name="transfers/index" options={{ headerShown: true, title: 'Transfers' }} />
          <Stack.Screen
            name="transfers/new"
            options={{ presentation: 'modal', headerShown: true, title: 'New Transfer' }}
          />
          <Stack.Screen name="warehouses" options={{ headerShown: true, title: 'Warehouses' }} />
          <Stack.Screen name="analytics" options={{ headerShown: true, title: 'Analytics' }} />
          <Stack.Screen name="history" options={{ headerShown: true, title: 'History' }} />
          <Stack.Screen
            name="app-releases"
            options={{ headerShown: true, title: 'App Updates' }}
          />
          <Stack.Screen name="settings" options={{ headerShown: true, title: 'Settings' }} />
        </Stack>
        {/* Over the navigator, not inside it. A route could be dismissed by a
            back gesture or a deep link; a sibling that covers the screen cannot
            be navigated away from. Only shown to someone already signed in —
            the lock protects a live session, it does not replace the password. */}
        {locked && user ? <LockScreen /> : null}
        {/* Above the lock screen as well as the navigator, and shown whether or
            not anybody is signed in: a build the server has withdrawn should not
            get as far as the login form. */}
        {updateBlocking ? <UpdateGate /> : null}
        </FlyToCartProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
