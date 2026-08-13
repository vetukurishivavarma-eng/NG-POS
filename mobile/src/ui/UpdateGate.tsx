import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { installedVersion, useAppUpdate } from '../store/appUpdate';
import { colors, font, radius, shadow, spacing } from '../theme';
import { Icon } from './components';

/**
 * The update prompt, and — when the postponements are spent — the wall.
 *
 * Like `LockScreen`, this is not a route. It is rendered over the navigator by
 * the root layout, so a back gesture has no navigation state to unwind to reach
 * the app underneath. When the update is compulsory there is no dismissal on
 * screen at all: the only way past it is to install the build.
 *
 * The two states are drawn as one screen with a different tone rather than two
 * components, because they are the same fact told twice — the second time
 * without a choice.
 */
export function UpdateGate() {
  const status = useAppUpdate((s) => s.status);
  const release = useAppUpdate((s) => s.release);
  const skipsUsed = useAppUpdate((s) => s.skipsUsed);
  const graceCount = useAppUpdate((s) => s.graceCount);
  const postpone = useAppUpdate((s) => s.postpone);

  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!release) return null;

  const required = status === 'required';
  const remaining = Math.max(0, graceCount - skipsUsed);

  const download = async () => {
    setOpening(true);
    setFailed(false);
    try {
      await Linking.openURL(release.download_url);
    } catch {
      // No browser, or a link that cannot be handled. Show the address so the
      // shop can type it on another device rather than being left at a dead end.
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };

  return (
    <SafeAreaView style={styles.backdrop}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.card}>
          <View style={[styles.crest, required && styles.crestRequired]}>
            <Icon
              name={required ? 'alert-triangle' : 'download-cloud'}
              size={26}
              color={required ? colors.danger : colors.primary}
            />
          </View>

          <Text style={styles.title}>
            {required ? 'Update required' : 'A new version is ready'}
          </Text>

          <Text style={styles.lead}>
            {required
              ? 'This version of NG POS is out of date and can no longer be used. Install the update to carry on.'
              : `NG POS ${release.version} is available. Installing it now takes a minute.`}
          </Text>

          <View style={styles.versions}>
            <View style={styles.versionSide}>
              <Text style={styles.versionLabel}>Installed</Text>
              <Text style={styles.versionValue}>{installedVersion() || '—'}</Text>
            </View>
            <Icon name="arrow-right" size={16} color={colors.textFaint} />
            <View style={styles.versionSide}>
              <Text style={styles.versionLabel}>Available</Text>
              <Text style={[styles.versionValue, styles.versionNew]}>{release.version}</Text>
            </View>
          </View>

          {release.notes ? (
            <View style={styles.notes}>
              <Text style={styles.notesLabel}>What's new</Text>
              <Text style={styles.notesBody}>{release.notes}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
            onPress={download}
            disabled={opening}
          >
            <Icon name="download" size={18} color="#fff" />
            <Text style={styles.primaryLabel}>{opening ? 'Opening…' : 'Update now'}</Text>
          </Pressable>

          {failed ? (
            <Text style={styles.fallback} selectable>
              Could not open the link. Download it from:{'\n'}
              {release.download_url}
            </Text>
          ) : null}

          {required ? (
            <Text style={styles.locked}>
              <Icon name="lock" size={12} color={colors.textMuted} />{' '}
              {skipsUsed > 0
                ? 'This update has already been postponed as many times as allowed.'
                : 'This update cannot be postponed.'}
            </Text>
          ) : (
            <>
              <Pressable
                style={({ pressed }) => [styles.later, pressed && styles.laterPressed]}
                onPress={() => void postpone()}
              >
                <Text style={styles.laterLabel}>Later</Text>
              </Pressable>
              {/* Said plainly, and before the last one is spent. Somebody who
                  finds out the app has locked at the start of a shift, with no
                  warning that it would, is right to be angry about it. */}
              <Text style={styles.remaining}>
                {remaining === 1
                  ? 'You can postpone once more. After that the update is required.'
                  : `You can postpone ${remaining} more times.`}
              </Text>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  /**
   * Positioned absolutely rather than `flex: 1`.
   *
   * This is rendered as a sibling of the navigator, so a flexed child would be
   * given half the column and leave the app it is supposed to be covering
   * visible — and usable — underneath. `elevation` is what puts it on top on
   * Android, where z-order follows elevation rather than paint order.
   */
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.canvas,
    justifyContent: 'center',
    zIndex: 100,
    elevation: 100,
  },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    ...shadow.tile,
  },
  crest: {
    width: 54,
    height: 54,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  crestRequired: { backgroundColor: colors.dangerSoft },
  title: { fontFamily: font.extrabold, fontSize: 22, color: colors.ink, marginBottom: spacing.sm },
  lead: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  versions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  versionSide: { flex: 1 },
  versionLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textFaint,
    marginBottom: 2,
  },
  versionValue: { fontFamily: font.bold, fontSize: 16, color: colors.text },
  versionNew: { color: colors.primaryBright, textAlign: 'right' },
  notes: { marginBottom: spacing.lg },
  notesLabel: {
    fontFamily: font.semibold,
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textFaint,
    marginBottom: spacing.xs,
  },
  notesBody: { fontFamily: font.regular, fontSize: 14, lineHeight: 21, color: colors.text },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
  },
  primaryPressed: { backgroundColor: colors.primaryDeep },
  primaryLabel: { fontFamily: font.bold, fontSize: 16, color: '#fff' },
  fallback: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.danger,
    marginTop: spacing.md,
    lineHeight: 19,
  },
  later: { alignItems: 'center', paddingVertical: spacing.lg, marginTop: spacing.xs },
  laterPressed: { opacity: 0.6 },
  laterLabel: { fontFamily: font.semibold, fontSize: 15, color: colors.textMuted },
  remaining: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textFaint,
    textAlign: 'center',
    lineHeight: 18,
  },
  locked: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.lg,
    lineHeight: 18,
  },
});
