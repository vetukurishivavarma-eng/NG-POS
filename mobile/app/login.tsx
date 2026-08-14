import React, { useEffect, useState } from 'react';
import {
  Image,
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
import { router, useLocalSearchParams } from 'expo-router';

import { useAuth } from '../src/store/auth';
import {
  CONFIGURED_BASE_URL,
  apiBaseUrlHost,
  errorMessage,
  getApiBaseUrl,
  isDeviceConflict,
  isNetworkError,
  resetApiBaseUrl,
  setApiBaseUrl,
  takeSessionEndedReason,
} from '../src/api/client';
import { Button, Icon } from '../src/ui/components';
import { bevel, colors, font, radius, shadow, spacing } from '../src/theme';

export default function LoginScreen() {
  const signIn = useAuth((s) => s.signIn);
  // Carried back from a completed password reset, so the last thing someone does
  // isn't retyping the address they just used.
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState<'email' | 'password' | 'server' | null>(null);

  // The server address is editable here and nowhere else that matters: if it is
  // wrong, nobody can sign in, so a screen behind authentication would be the
  // one place you cannot reach.
  const [serverUrl, setServerUrl] = useState(getApiBaseUrl());
  const [serverOpen, setServerOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState(getApiBaseUrl());
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [deviceBlocked, setDeviceBlocked] = useState(false);

  // Landing here because the session ended mid-shift looks identical to landing
  // here on purpose. Say which it was — the server's reason is the only clue to
  // a removed device or a password changed on another handset.
  useEffect(() => {
    const reason = takeSessionEndedReason();
    if (reason) setError(reason);
  }, []);

  async function submit() {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    setUnreachable(false);
    setDeviceBlocked(false);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      // A dead link and a wrong password look identical to a tired cashier, so
      // say which one it is and point at the thing that fixes it.
      setUnreachable(isNetworkError(err));
      // Being refused because another handset holds the account is not a wrong
      // password, and treating it like one sends people round in circles
      // retyping something that was already correct.
      setDeviceBlocked(isDeviceConflict(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveServer() {
    setServerBusy(true);
    setServerError(null);
    try {
      const next = await setApiBaseUrl(serverDraft);
      setServerUrl(next);
      setServerDraft(next);
      setServerOpen(false);
      setError(null);
      setUnreachable(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not save that address.');
    } finally {
      setServerBusy(false);
    }
  }

  async function revertServer() {
    setServerBusy(true);
    setServerError(null);
    try {
      const next = await resetApiBaseUrl();
      setServerUrl(next);
      setServerDraft(next);
      setError(null);
      setUnreachable(false);
    } finally {
      setServerBusy(false);
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
              {/*
                The tile sits on the same card colour as the launcher icon, so
                the mark a cashier taps and the mark they then see are the same
                object. It must not be the gold accent: the logo's own lettering
                is gold and would vanish into it.
              */}
              <View style={styles.mark}>
                <Image
                  source={require('../assets/brand-mark.png')}
                  style={styles.markImage}
                  resizeMode="contain"
                  accessibilityRole="image"
                  accessibilityLabel="Mama Maxx Agrovet"
                />
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
                  <View style={styles.flex}>
                    <Text style={styles.errorText}>{error}</Text>
                    {unreachable ? (
                      <Pressable onPress={() => setServerOpen(true)} hitSlop={6}>
                        <Text style={styles.errorAction}>
                          Couldn&apos;t reach {apiBaseUrlHost(serverUrl)} — check the server address
                        </Text>
                      </Pressable>
                    ) : null}
                    {deviceBlocked ? (
                      // The password was right, so offer the two ways out
                      // rather than leaving them retyping it.
                      <Text style={styles.errorAction}>
                        Your password was correct. Ask your administrator to remove that device
                        under More → Devices, or use “Forgot password?” below — resetting it
                        releases every device.
                      </Text>
                    ) : null}
                  </View>
                </View>
              ) : null}

              <Button
                label="Sign In"
                size="lg"
                onPress={submit}
                loading={busy}
                style={{ marginTop: spacing.lg }}
              />

              <Pressable
                onPress={() => router.push({ pathname: '/forgot-password', params: { email: email.trim() } })}
                hitSlop={10}
                disabled={busy}
                style={styles.forgotLink}
              >
                <Text style={styles.forgotText}>Forgot password?</Text>
              </Pressable>
            </View>

            {serverOpen ? (
              <View style={styles.serverCard}>
                <View style={styles.serverHead}>
                  <Text style={styles.serverTitle}>Server address</Text>
                  <Pressable onPress={() => setServerOpen(false)} hitSlop={10}>
                    <Icon name="x" size={18} color={colors.textFaint} />
                  </Pressable>
                </View>
                <Text style={styles.serverHint}>
                  Where this till sends its sales. Saved on this device.
                </Text>

                <View style={[styles.field, focused === 'server' && styles.fieldFocused]}>
                  <Icon name="server" size={18} color={colors.textFaint} />
                  <TextInput
                    value={serverDraft}
                    onChangeText={setServerDraft}
                    onFocus={() => setFocused('server')}
                    onBlur={() => setFocused(null)}
                    placeholder="ngpos-api.onrender.com"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={styles.input}
                    editable={!serverBusy}
                    onSubmitEditing={saveServer}
                    returnKeyType="done"
                  />
                </View>

                {serverError ? (
                  <View style={styles.errorBox}>
                    <Icon name="alert-circle" size={15} color={colors.danger} />
                    <Text style={styles.errorText}>{serverError}</Text>
                  </View>
                ) : null}

                <Button
                  label="Use This Server"
                  onPress={saveServer}
                  loading={serverBusy}
                  style={{ marginTop: spacing.md }}
                />

                {serverUrl !== CONFIGURED_BASE_URL ? (
                  <Pressable onPress={revertServer} hitSlop={8} disabled={serverBusy}>
                    <Text style={styles.serverReset}>
                      Reset to {apiBaseUrlHost(CONFIGURED_BASE_URL)}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <Pressable
                onPress={() => {
                  setServerDraft(serverUrl);
                  setServerOpen(true);
                }}
                hitSlop={10}
                style={styles.serverToggle}
              >
                <Icon name="server" size={13} color={colors.onDarkMuted} />
                <Text style={styles.serverToggleText}>{apiBaseUrlHost(serverUrl)}</Text>
                <Icon name="chevron-down" size={13} color={colors.onDarkMuted} />
              </Pressable>
            )}

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
    width: 96,
    height: 96,
    borderRadius: radius.xl,
    backgroundColor: colors.brandCard,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.raised,
    ...bevel.light,
  },
  markImage: { width: 78, height: 78 },
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
    ...bevel.light,
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
  errorAction: {
    fontFamily: font.semibold,
    fontSize: 12,
    color: colors.danger,
    textDecorationLine: 'underline',
    marginTop: 4,
  },

  // Sits under the sign-in card on the dark wash, so it reads as an escape
  // hatch rather than a field anyone needs to touch on a normal morning.
  serverToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
  },
  serverToggleText: { fontFamily: font.medium, fontSize: 12, color: colors.onDarkMuted },

  serverCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.lg,
    ...shadow.raised,
  },
  serverHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  serverTitle: { fontFamily: font.bold, fontSize: 16, color: colors.text },
  serverHint: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
    marginBottom: spacing.md,
  },
  serverReset: {
    fontFamily: font.medium,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
  },

  forgotLink: { alignSelf: 'center', marginTop: spacing.md, paddingVertical: spacing.xs },
  forgotText: { fontFamily: font.medium, fontSize: 13, color: colors.primary },

  footnote: {
    fontFamily: font.medium,
    fontSize: 12,
    color: colors.onDarkMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
});
