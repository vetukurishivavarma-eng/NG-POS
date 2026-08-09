import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type LayoutRectangle } from 'react-native';

import { bevel, colors, font, motion, radius, shadow } from '../theme';

/**
 * The product-to-cart flight.
 *
 * A till is used without looking. The cashier's eyes are on the customer and
 * the goods, not the screen, so "did that tap register?" is a question they
 * would otherwise answer by stopping and reading the cart count. A token that
 * physically leaves the product and lands on the cart answers it in peripheral
 * vision, which is the only place there is attention to spare.
 *
 * Built on React Native's own `Animated` rather than Reanimated. Reanimated is
 * present in node_modules as a transitive dependency, but it is not declared in
 * package.json and pulling it in would mean a new native module, a Babel plugin
 * and another way for the release build to break — for an arc and a scale that
 * the native driver already runs off the JS thread.
 */

interface Flight {
  id: number;
  from: LayoutRectangle;
  label: string;
  progress: Animated.Value;
}

interface FlyContext {
  /** Records where the cart sits, in window coordinates. Safe to call repeatedly. */
  setTarget: (rect: LayoutRectangle | null) => void;
  /** Sends a token from `from` to the cart. No-op when the cart is off-screen. */
  fly: (from: LayoutRectangle, label: string) => void;
  /** Scale to hang off the cart badge so it recoils as each token lands. */
  bump: Animated.Value;
}

const Ctx = createContext<FlyContext | null>(null);

export function FlyToCartProvider({ children }: { children: React.ReactNode }) {
  const target = useRef<LayoutRectangle | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const nextId = useRef(0);
  const bump = useRef(new Animated.Value(1)).current;

  const setTarget = useCallback((rect: LayoutRectangle | null) => {
    target.current = rect;
  }, []);

  const fly = useCallback(
    (from: LayoutRectangle, label: string) => {
      // No cart on screen yet — the very first add, before the cart bar exists.
      // The bar animating itself in is feedback enough; a token flying to a
      // place with nothing in it would be worse than none.
      if (!target.current) return;

      const id = nextId.current++;
      const progress = new Animated.Value(0);
      setFlights((f) => [...f, { id, from, label, progress }]);

      Animated.timing(progress, {
        toValue: 1,
        duration: motion.travel,
        // Slow out of the product, fast into the cart: the token looks thrown
        // rather than dragged, and the landing is what the eye catches.
        easing: Easing.bezier(0.35, 0, 0.35, 1),
        useNativeDriver: true,
      }).start(({ finished }) => {
        setFlights((f) => f.filter((x) => x.id !== id));
        if (!finished) return;
        Animated.sequence([
          Animated.timing(bump, { toValue: 1.3, duration: 90, useNativeDriver: true }),
          Animated.spring(bump, { toValue: 1, ...motion.spring, useNativeDriver: true }),
        ]).start();
      });
    },
    [bump]
  );

  const value = useMemo<FlyContext>(() => ({ setTarget, fly, bump }), [setTarget, fly, bump]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Above everything, and deaf to touch — a cashier mid-sale must never
          have a tap swallowed by decoration. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {flights.map((flight) => (
          <FlyingToken key={flight.id} flight={flight} to={target.current} />
        ))}
      </View>
    </Ctx.Provider>
  );
}

function FlyingToken({ flight, to }: { flight: Flight; to: LayoutRectangle | null }) {
  if (!to) return null;

  const from = flight.from;
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);

  // The lift is what stops this reading as a slide. It scales with the distance
  // travelled, so a short hop across a tablet's split view arcs less than the
  // full drop down a phone screen, and neither looks wrong.
  const lift = Math.min(120, Math.max(40, Math.abs(dy) * 0.35));

  const translateX = flight.progress.interpolate({ inputRange: [0, 1], outputRange: [0, dx] });
  const translateY = flight.progress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, dy / 2 - lift, dy],
  });
  const scale = flight.progress.interpolate({
    inputRange: [0, 0.15, 1],
    outputRange: [0.6, 1, 0.35],
  });
  const opacity = flight.progress.interpolate({
    inputRange: [0, 0.1, 0.75, 1],
    outputRange: [0, 1, 1, 0],
  });
  const rotate = flight.progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '22deg'],
  });

  return (
    <Animated.View
      style={[
        styles.token,
        {
          left: from.x + from.width / 2 - TOKEN / 2,
          top: from.y + from.height / 2 - TOKEN / 2,
          opacity,
          transform: [{ translateX }, { translateY }, { scale }, { rotate }],
        },
      ]}
    >
      <Text style={styles.tokenText}>{flight.label}</Text>
    </Animated.View>
  );
}

/**
 * Sends products to the cart. Returns a no-op flight outside the provider so a
 * screen rendered on its own (a test, a modal route) still works.
 */
export function useFlyToCart(): FlyContext {
  return (
    useContext(Ctx) ?? {
      setTarget: () => {},
      fly: () => {},
      bump: new Animated.Value(1),
    }
  );
}

const TOKEN = 44;

const styles = StyleSheet.create({
  token: {
    position: 'absolute',
    width: TOKEN,
    height: TOKEN,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...bevel.dark,
    ...shadow.raised,
  },
  tokenText: { fontFamily: font.extrabold, fontSize: 18, color: '#fff' },
});
