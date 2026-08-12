import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  biometricSupport,
  promptBiometric,
  useScreenLock,
  type BiometricSupport,
} from '../store/screenLock';
import { colors, font, radius, spacing } from '../theme';
import { Button, Card, Icon, RowDivider, SectionLabel } from './components';
import { PIN_LENGTH } from './LockScreen';

/**
 * Turning the till lock on, off, or into a different PIN.
 *
 * Opt-in rather than imposed. A lock forced onto every handset on the morning
 * of an update is a lock that gets worked around — one PIN shared by the whole
 * counter, or written on the back of the phone — and either is worse than not
 * having one.
 */
export function ScreenLockSection() {
  const configured = useScreenLock((s) => s.configured);
  const biometricEnabled = useScreenLock((s) => s.biometricEnabled);
  const setPin = useScreenLock((s) => s.setPin);
  const verify = useScreenLock((s) => s.verify);
  const disable = useScreenLock((s) => s.disable);
  const setBiometricEnabled = useScreenLock((s) => s.setBiometricEnabled);

  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void biometricSupport().then((found) => {
      if (alive) setSupport(found);
    });
    return () => {
      alive = false;
    };
  }, []);

  function reset() {
    setEditing(false);
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  }

  async function save() {
    setError(null);

    if (next.length !== PIN_LENGTH) return setError(`The PIN must be ${PIN_LENGTH} digits.`);
    if (next !== confirm) return setError('The two PINs do not match.');
    // Not a rule anyone will thank us for, but 1234 and 0000 are the first two
    // guesses and this is the only gate on a phone sitting in a shop.
    if (/^(\d)\1+$/.test(next)) return setError('Four of the same digit is too easy to guess.');
    if (next === '1234' || next === '0000') return setError('That PIN is too easy to guess.');

    setBusy(true);
    try {
      // Changing a PIN needs the old one; setting the first does not, because
      // getting this far already required signing in.
      if (configured && !(await verify(current))) {
        setError('That is not your current PIN.');
        return;
      }
      await setPin(next);
      reset();
      Alert.alert('PIN saved', 'NG POS will ask for it when the till has been left alone.');
    } finally {
      setBusy(false);
    }
  }

  function confirmDisable() {
    Alert.alert(
      'Turn off the till lock?',
      'Anyone who picks up this phone will be able to use NG POS without a PIN.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: () => {
            void disable();
            reset();
          },
        },
      ]
    );
  }

  async function toggleBiometric(on: boolean) {
    if (!on) {
      await setBiometricEnabled(false);
      return;
    }
    // Proved once here, so the toggle cannot be switched on by someone whose
    // finger the phone does not actually recognise.
    if (await promptBiometric()) {
      await setBiometricEnabled(true);
    } else {
      Alert.alert(
        "That didn't match",
        `${support?.label ?? 'Biometrics'} was not recognised, so it has been left switched off.`
      );
    }
  }

  return (
    <View>
      <SectionLabel>Screen lock</SectionLabel>
      <Card style={{ gap: spacing.md }}>
        <View style={styles.head}>
          <View style={styles.icon}>
            <Icon name="lock" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{configured ? 'PIN is on' : 'PIN is off'}</Text>
            <Text style={styles.lead}>
              {configured
                ? 'NG POS locks itself when the phone has been left alone, and asks for this PIN to reopen. Signing in is unaffected.'
                : 'Your session stays signed in so nobody types a password all day. A PIN stops someone picking the phone up off the counter and using it.'}
            </Text>
          </View>
        </View>

        {editing ? (
          <View style={{ gap: spacing.md }}>
            {configured ? (
              <PinField label="Current PIN" value={current} onChange={setCurrent} />
            ) : null}
            <PinField label="New PIN" value={next} onChange={setNext} />
            <PinField label="Confirm new PIN" value={confirm} onChange={setConfirm} />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.actions}>
              <Button label="Cancel" variant="secondary" onPress={reset} />
              <Button label="Save PIN" loading={busy} onPress={() => void save()} />
            </View>
          </View>
        ) : (
          <View style={styles.actions}>
            <Button
              label={configured ? 'Change PIN' : 'Set a PIN'}
              icon="lock"
              variant={configured ? 'secondary' : 'primary'}
              onPress={() => setEditing(true)}
            />
            {configured ? (
              <Button label="Turn Off" variant="ghost" onPress={confirmDisable} />
            ) : null}
          </View>
        )}

        {configured && support?.available ? (
          <>
            <RowDivider />
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Unlock with {support.label.toLowerCase()}</Text>
                <Text style={styles.switchHint}>
                  A shortcut, not a replacement — your PIN still works, and is the only way in if
                  this phone does not recognise you. Uses the {support.label.toLowerCase()} already
                  registered on the handset, so anyone enrolled on it can unlock.
                </Text>
              </View>
              <Switch
                value={biometricEnabled}
                onValueChange={(on) => void toggleBiometric(on)}
                trackColor={{ true: colors.primary, false: colors.borderStrong }}
                thumbColor={colors.surface}
              />
            </View>
          </>
        ) : null}

        {configured && support && !support.available ? (
          <>
            <RowDivider />
            <Text style={styles.switchHint}>
              This phone has no fingerprint or face unlock registered, so the PIN is the only way
              in. Add one in the phone&apos;s own settings and the shortcut will appear here.
            </Text>
          </>
        ) : null}
      </Card>
    </View>
  );
}

function PinField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, PIN_LENGTH))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={PIN_LENGTH}
        // Autofill would offer a saved password for a four-digit field.
        autoComplete="off"
        textContentType="none"
        style={styles.field}
        placeholder={'•'.repeat(PIN_LENGTH)}
        placeholderTextColor={colors.textFaint}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: font.bold, fontSize: 15, color: colors.text },
  lead: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: 2,
  },

  fieldLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  field: {
    fontFamily: font.semibold,
    fontSize: 20,
    letterSpacing: 8,
    color: colors.text,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
  },

  error: { fontFamily: font.medium, fontSize: 12, color: colors.danger },
  actions: { flexDirection: 'row', gap: spacing.sm },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  switchHint: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    lineHeight: 16,
    marginTop: 2,
  },
});
