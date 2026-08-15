import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '../store/auth';
import {
  biometricSupport,
  MAX_ATTEMPTS,
  promptBiometric,
  useScreenLock,
  type BiometricSupport,
} from '../store/screenLock';
import { colors, font, radius, spacing } from '../theme';
import { Icon } from './components';

export const PIN_LENGTH = 4;

/**
 * The way back into a till that locked itself.
 *
 * Deliberately not a route. It renders over everything from the root layout,
 * so there is no navigation state a back gesture could unwind to reach the app
 * behind it — the only exits are the right PIN, a matching fingerprint, or
 * signing out.
 *
 * Four digits and a keypad rather than a text field: this is typed dozens of
 * times a day, often one-handed while holding something, and a keyboard that
 * covers half the screen and offers autocorrect on a number is the wrong tool.
 */
export function LockScreen() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const verify = useScreenLock((s) => s.verify);
  const biometricEnabled = useScreenLock((s) => s.biometricEnabled);
  const attempts = useScreenLock((s) => s.attempts);
  const unlock = useScreenLock((s) => s.unlock);

  const [entry, setEntry] = useState('');
  const [checking, setChecking] = useState(false);
  const [shake, setShake] = useState(false);
  const [support, setSupport] = useState<BiometricSupport | null>(null);
  /** The sensor is offered once per lock; re-prompting a cancel is nagging. */
  const offered = useRef(false);

  const remaining = MAX_ATTEMPTS - attempts;

  const endSession = useCallback(
    async (reason: string) => {
      await signOut();
      unlock();
      Alert.alert('Signed out', reason);
    },
    [signOut, unlock]
  );

  const submit = useCallback(
    async (pin: string) => {
      setChecking(true);
      try {
        const ok = await verify(pin);
        if (ok) {
          setEntry('');
          return;
        }
        // Read after the store has counted this failure.
        if (useScreenLock.getState().attempts >= MAX_ATTEMPTS) {
          await endSession('Too many wrong PINs. Sign in with your password to continue.');
          setEntry('');
          return;
        }
        setShake(true);
        setTimeout(() => setShake(false), 400);
        setEntry('');
      } finally {
        setChecking(false);
      }
    },
    [verify, endSession]
  );

  const tryBiometric = useCallback(async () => {
    if (await promptBiometric()) unlock();
  }, [unlock]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const found = await biometricSupport();
      if (!alive) return;
      setSupport(found);

      // Offered the moment the screen appears when it is switched on, so the
      // common case is a thumb on the sensor and no typing at all.
      if (found.available && biometricEnabled && !offered.current) {
        offered.current = true;
        await tryBiometric();
      }
    })();
    return () => {
      alive = false;
    };
  }, [biometricEnabled, tryBiometric]);

  function press(digit: string) {
    if (checking || entry.length >= PIN_LENGTH) return;
    const next = entry + digit;
    setEntry(next);
    if (next.length === PIN_LENGTH) void submit(next);
  }

  function backspace() {
    if (checking) return;
    setEntry((current) => current.slice(0, -1));
  }

  function forgotten() {
    Alert.alert(
      'Forgotten your PIN?',
      'Signing out clears it. You will need your email and password to get back in, and can set a new PIN afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => void endSession('Sign in and set a new PIN.'),
        },
      ]
    );
  }

  const showBiometric = support?.available && biometricEnabled;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        <View style={styles.brand}>
          <View style={styles.badge}>
            <Icon name="lock" size={24} color={colors.onDark} />
          </View>
          <Text style={styles.title}>NG POS is locked</Text>
          <Text style={styles.who} numberOfLines={1}>
            {user?.full_name ?? 'Enter your PIN to continue'}
          </Text>
        </View>

        <View style={[styles.dots, shake && styles.dotsWrong]}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i < entry.length && styles.dotFilled,
                shake && styles.dotWrong,
              ]}
            />
          ))}
        </View>

        <Text style={[styles.message, shake && styles.messageWrong]}>
          {shake
            ? `Wrong PIN — ${remaining} ${remaining === 1 ? 'try' : 'tries'} left`
            : 'Enter your 4-digit PIN'}
        </Text>

        <View style={styles.pad}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <Key key={digit} label={digit} onPress={() => press(digit)} />
          ))}

          {showBiometric ? (
            <Key icon="unlock" onPress={() => void tryBiometric()} />
          ) : (
            <View style={styles.key} />
          )}

          <Key label="0" onPress={() => press('0')} />
          <Key icon="delete" onPress={backspace} />
        </View>

        <Pressable onPress={forgotten} hitSlop={12} style={styles.forgot}>
          <Text style={styles.forgotText}>Forgotten your PIN?</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function Key({
  label,
  icon,
  onPress,
}: {
  label?: string;
  icon?: 'delete' | 'unlock';
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
      // A keypad on a till gets hit fast and slightly off-centre.
      hitSlop={4}
    >
      {label ? (
        <Text style={styles.keyText}>{label}</Text>
      ) : (
        <Icon name={icon === 'delete' ? 'delete' : 'unlock'} size={22} color={colors.onDark} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /**
   * Positioned absolutely rather than `flex: 1`, for the same reason
   * `UpdateGate` is — and this screen predates that fix by a session.
   *
   * It renders as a sibling of the navigator, so a flexed child is handed half
   * the column: the keypad took the bottom half and left the till it exists to
   * cover visible, and tappable, in the top half. `elevation` is what orders it
   * on Android, where z-order follows elevation rather than paint order. Below
   * `UpdateGate`'s 100 on purpose — a withdrawn build outranks a locked till.
   */
  safe: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.primaryDeep,
    zIndex: 50,
    elevation: 50,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.lg,
  },

  brand: { alignItems: 'center', gap: spacing.sm },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  title: { fontFamily: font.bold, fontSize: 20, color: colors.onDark, letterSpacing: -0.3 },
  who: { fontFamily: font.regular, fontSize: 13, color: colors.onDarkMuted },

  dots: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  dotsWrong: {},
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  dotFilled: { backgroundColor: colors.onDark, borderColor: colors.onDark },
  dotWrong: { borderColor: colors.accent, backgroundColor: 'transparent' },

  message: { fontFamily: font.medium, fontSize: 12, color: colors.onDarkMuted },
  messageWrong: { color: colors.accent },

  pad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.md,
    maxWidth: 300,
    marginTop: spacing.sm,
  },
  key: {
    width: 76,
    height: 62,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  keyPressed: { backgroundColor: 'rgba(255,255,255,0.22)' },
  keyText: { fontFamily: font.semibold, fontSize: 24, color: colors.onDark },

  forgot: { marginTop: spacing.lg },
  forgotText: {
    fontFamily: font.medium,
    fontSize: 13,
    color: colors.onDarkMuted,
    textDecorationLine: 'underline',
  },
});
