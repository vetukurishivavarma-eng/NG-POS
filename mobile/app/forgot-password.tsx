import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';

import { auth as authApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { Button, Icon } from '../src/ui/components';
import { colors, font, radius, shadow, spacing } from '../src/theme';

/**
 * Recovery for a shop, not a consumer web app.
 *
 * Staff accounts use internal addresses that no mailbox answers, so there is
 * nowhere to send a reset link. The request goes to the organisation's
 * administrator instead; they read the one-time code back to the person in
 * front of them, which is a check no emailed link can make.
 */
export default function ForgotPasswordScreen() {
  const params = useLocalSearchParams<{ email?: string }>();

  const [stage, setStage] = useState<'request' | 'code'>('request');
  const [email, setEmail] = useState(params.email ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode() {
    if (!email.trim()) {
      setError('Enter the email address for the account.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.forgotPassword(email.trim());
      setNotice(res.detail);
      setStage('code');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset() {
    if (!code.trim()) {
      setError('Enter the code your administrator gave you.');
      return;
    }
    if (password.length < 8) {
      setError('Your new password must be at least 8 characters.');
      return;
    }
    // Caught here rather than by the server: there is one code, and burning it
    // on a typo means going back to the administrator for another.
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await authApi.resetPassword(email.trim(), code.trim(), password);
      router.replace({ pathname: '/login', params: { email: email.trim() } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.flex}>
        {/* `padding` on Android too — see the note in `login.tsx`. */}
        <KeyboardAvoidingView behavior="padding" style={styles.flex}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Pressable onPress={() => router.back()} hitSlop={10} style={styles.back}>
              <Icon name="chevron-left" size={18} color={colors.onDarkMuted} />
              <Text style={styles.backText}>Back to sign in</Text>
            </Pressable>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                {stage === 'request' ? 'Forgot password' : 'Enter your code'}
              </Text>
              <Text style={styles.cardHint}>
                {stage === 'request'
                  ? 'Your administrator will be sent a one-time code for this account.'
                  : 'Ask your administrator for the code, then set a new password.'}
              </Text>

              <Text style={styles.label}>Email</Text>
              <View style={styles.field}>
                <Icon name="mail" size={18} color={colors.textFaint} />
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  style={styles.input}
                  editable={!busy && stage === 'request'}
                  onSubmitEditing={stage === 'request' ? requestCode : undefined}
                  returnKeyType="go"
                />
              </View>

              {stage === 'code' ? (
                <>
                  <Text style={styles.label}>One-time code</Text>
                  <View style={styles.field}>
                    <Icon name="key" size={18} color={colors.textFaint} />
                    <TextInput
                      value={code}
                      onChangeText={setCode}
                      placeholder="8 characters"
                      placeholderTextColor={colors.textFaint}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      maxLength={12}
                      style={[styles.input, styles.codeInput]}
                      editable={!busy}
                    />
                  </View>

                  <Text style={styles.label}>New password</Text>
                  <View style={styles.field}>
                    <Icon name="lock" size={18} color={colors.textFaint} />
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      placeholder="At least 8 characters"
                      placeholderTextColor={colors.textFaint}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      style={styles.input}
                      editable={!busy}
                    />
                    <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={10}>
                      <Icon
                        name={showPassword ? 'eye-off' : 'eye'}
                        size={18}
                        color={colors.textFaint}
                      />
                    </Pressable>
                  </View>

                  <Text style={styles.label}>Confirm new password</Text>
                  <View style={styles.field}>
                    <Icon name="lock" size={18} color={colors.textFaint} />
                    <TextInput
                      value={confirm}
                      onChangeText={setConfirm}
                      placeholder="Type it again"
                      placeholderTextColor={colors.textFaint}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      style={styles.input}
                      editable={!busy}
                      onSubmitEditing={submitReset}
                      returnKeyType="go"
                    />
                  </View>
                </>
              ) : null}

              {notice && !error ? (
                <View style={styles.noticeBox}>
                  <Icon name="mail" size={15} color={colors.primary} />
                  <Text style={styles.noticeText}>{notice}</Text>
                </View>
              ) : null}

              {error ? (
                <View style={styles.errorBox}>
                  <Icon name="alert-circle" size={15} color={colors.danger} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <Button
                label={stage === 'request' ? 'Request Code' : 'Set New Password'}
                size="lg"
                onPress={stage === 'request' ? requestCode : submitReset}
                loading={busy}
                style={{ marginTop: spacing.lg }}
              />

              {stage === 'code' ? (
                <Pressable
                  onPress={() => {
                    setStage('request');
                    setError(null);
                    setNotice(null);
                    setCode('');
                  }}
                  hitSlop={10}
                  disabled={busy}
                  style={styles.secondaryLink}
                >
                  <Text style={styles.secondaryText}>Request a new code</Text>
                </Pressable>
              ) : null}
            </View>

            <Text style={styles.footnote}>
              Codes expire quickly and work once. If you did not ask for one, tell your
              administrator.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.primaryDeep },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },

  back: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.lg },
  backText: { fontFamily: font.medium, fontSize: 13, color: colors.onDarkMuted },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadow.card,
  },
  cardTitle: { fontFamily: font.bold, fontSize: 20, color: colors.text },
  cardHint: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 4,
    marginBottom: spacing.lg,
  },

  label: {
    fontFamily: font.semibold,
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 50,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  input: { flex: 1, fontFamily: font.medium, fontSize: 15, color: colors.text },
  // A code that is read aloud is easier to check back if it is not proportional.
  codeInput: { fontFamily: font.bold, fontSize: 18, letterSpacing: 3 },

  noticeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  noticeText: { flex: 1, fontFamily: font.medium, fontSize: 13, color: colors.text },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  errorText: { flex: 1, fontFamily: font.medium, fontSize: 13, color: colors.danger },

  secondaryLink: { alignSelf: 'center', marginTop: spacing.md, paddingVertical: spacing.xs },
  secondaryText: { fontFamily: font.medium, fontSize: 13, color: colors.textMuted },

  footnote: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.onDarkMuted,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
