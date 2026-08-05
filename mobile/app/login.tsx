import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '../src/store/auth';
import { errorMessage } from '../src/api/client';
import { Button, Icon } from '../src/ui/components';
import { colors, font, radius, shadow, spacing } from '../src/theme';

export default function LoginScreen() {
  const signIn = useAuth((s) => s.signIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState<'email' | 'password' | null>(null);

  async function submit() {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      {/* Layered wash: keeps the deep green from reading as a flat block. */}
      <View style={styles.washTop} />
      <View style={styles.washGlow} />

      <SafeAreaView style={styles.flex}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <View style={styles.brand}>
              <View style={styles.mark}>
                <Text style={styles.markText}>NG</Text>
              </View>
              <Text style={styles.wordmark}>NG POS</Text>
              <Text style={styles.tagline}>Inventory &amp; Sales</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Welcome back</Text>
              <Text style={styles.cardHint}>Sign in to open your till</Text>

              <Text style={styles.label}>Email</Text>
              <View style={[styles.field, focused === 'email' && styles.fieldFocused]}>
                <Icon name="mail" size={18} color={colors.textFaint} />
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  onFocus={() => setFocused('email')}
                  onBlur={() => setFocused(null)}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  style={styles.input}
                  editable={!busy}
                />
              </View>

              <Text style={styles.label}>Password</Text>
              <View style={[styles.field, focused === 'password' && styles.fieldFocused]}>
                <Icon name="lock" size={18} color={colors.textFaint} />
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                  placeholder="Your password"
                  placeholderTextColor={colors.textFaint}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  style={styles.input}
                  editable={!busy}
                  onSubmitEditing={submit}
                  returnKeyType="go"
                />
                <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={10}>
                  <Icon name={showPassword ? 'eye-off' : 'eye'} size={18} color={colors.textFaint} />
                </Pressable>
              </View>

              {error ? (
                <View style={styles.errorBox}>
                  <Icon name="alert-circle" size={15} color={colors.danger} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <Button
                label="Sign In"
                size="lg"
                onPress={submit}
                loading={busy}
                style={{ marginTop: spacing.lg }}
              />
            </View>

            <Text style={styles.footnote}>Mama Maxx Agrovet</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.primaryDeep },
  flex: { flex: 1 },
  washTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '58%',
    backgroundColor: colors.primaryDeep,
  },
  washGlow: {
    position: 'absolute',
    top: -140,
    right: -110,
    width: 380,
    height: 380,
    borderRadius: 190,
    backgroundColor: colors.primaryBright,
    opacity: 0.35,
  },

  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },

  brand: { alignItems: 'center', marginBottom: spacing.xl },
  mark: {
    width: 66,
    height: 66,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.raised,
  },
  markText: { fontFamily: font.extrabold, fontSize: 24, color: colors.primaryDeep },
  wordmark: {
    fontFamily: font.extrabold,
    fontSize: 30,
    color: colors.onDark,
    marginTop: spacing.md,
    letterSpacing: -0.6,
  },
  tagline: {
    fontFamily: font.medium,
    fontSize: 13,
    color: colors.onDarkMuted,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    marginTop: 4,
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    ...shadow.raised,
  },
  cardTitle: { fontFamily: font.bold, fontSize: 21, color: colors.text, letterSpacing: -0.3 },
  cardHint: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted, marginBottom: spacing.lg },

  label: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 52,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  fieldFocused: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  input: { flex: 1, fontFamily: font.medium, fontSize: 15, color: colors.text },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.lg,
  },
  errorText: { flex: 1, fontFamily: font.medium, fontSize: 13, color: colors.danger },

  footnote: {
    fontFamily: font.medium,
    fontSize: 12,
    color: colors.onDarkMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
});
