import React, { useEffect, useRef } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';

import { useFonts } from 'expo-font';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';

import * as Notifications from 'expo-notifications';

import { setUnauthorizedHandler } from '../src/api/client';
import { useAuth } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { startConnectivityWatcher, useSync } from '../src/db/sync';
import { usePrinter } from '../src/printing/printer';
import { useReminder } from '../src/notifications/reminder';
import { colors } from '../src/theme';
import { Loading } from '../src/ui/components';

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
      refetchOnWindowFocus: false,
    },
  },
});

export default function RootLayout() {
  const { user, hydrated, restore } = useAuth();
  const restoreStore = useStoreSelection((s) => s.restore);
  const storeHydrated = useStoreSelection((s) => s.hydrated);
  const restorePrinter = usePrinter((s) => s.restore);
  const restoreReminder = useReminder((s) => s.restore);
  const segments = useSegments();
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledResponse = useRef<string | null>(null);

  const [fontsLoaded] = useFonts({
    Jakarta_400Regular: PlusJakartaSans_400Regular,
    Jakarta_500Medium: PlusJakartaSans_500Medium,
    Jakarta_600SemiBold: PlusJakartaSans_600SemiBold,
    Jakarta_700Bold: PlusJakartaSans_700Bold,
    Jakarta_800ExtraBold: PlusJakartaSans_800ExtraBold,
  });

  useEffect(() => {
    void restore();
    void restoreStore();
    void restorePrinter();
    void restoreReminder();
  }, [restore, restoreStore, restorePrinter, restoreReminder]);

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

  // Route guard: unauthenticated users can only reach /login.
  useEffect(() => {
    if (!hydrated || !storeHydrated) return;
    const inAuthGroup = segments[0] === 'login';

    if (!user && !inAuthGroup) {
      router.replace('/login');
    } else if (user && inAuthGroup) {
      router.replace('/');
    }
  }, [user, hydrated, storeHydrated, segments]);

  if (!hydrated || !storeHydrated || !fontsLoaded) {
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
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="store-picker"
            options={{ presentation: 'modal', headerShown: true, title: 'Select Store' }}
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
          <Stack.Screen name="store-pricing" options={{ headerShown: true, title: 'Store Pricing' }} />
          <Stack.Screen name="users/index" options={{ headerShown: true, title: 'Staff' }} />
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
          <Stack.Screen name="settings" options={{ headerShown: true, title: 'Settings' }} />
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
