import React from 'react';
import { Tabs } from 'expo-router';
import { type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { capabilitiesFor, useAuth } from '../../src/store/auth';
import { colors, font } from '../../src/theme';
import { Icon, type IconName } from '../../src/ui/components';

function tabIcon(name: IconName) {
  return ({ color }: { color: ColorValue }) => (
    <Icon name={name} size={21} color={color as string} />
  );
}

// Height of the row the icons and labels actually occupy, before any system UI.
const TAB_CONTENT_HEIGHT = 56;

export default function TabsLayout() {
  const user = useAuth((s) => s.user);
  const caps = capabilitiesFor(user);
  // Android draws edge-to-edge, so the tab bar sits under the back/home/recents
  // buttons unless it reserves their space itself. Gesture navigation reports a
  // tiny inset, hence the floor so the labels never hug the screen edge.
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 10);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          height: TAB_CONTENT_HEIGHT + bottomInset,
          paddingBottom: bottomInset,
          paddingTop: 8,
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: { fontFamily: font.semibold, fontSize: 11, letterSpacing: 0.2 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Sell', tabBarIcon: tabIcon('shopping-bag') }} />
      <Tabs.Screen
        name="stock"
        options={{
          title: 'Stock',
          href: caps.includes('stock') ? undefined : null,
          tabBarIcon: tabIcon('package'),
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'Reports',
          href: caps.includes('reports') ? undefined : null,
          tabBarIcon: tabIcon('bar-chart-2'),
        }}
      />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: tabIcon('menu') }} />
    </Tabs>
  );
}
