import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { canInstallInApp, openInstallPermissionSettings } from '../lib/apkInstaller';
import { installedVersion, shouldAutoDownload, useAppUpdate } from '../store/appUpdate';
import { colors, font, radius, shadow, spacing } from '../theme';
import { Icon } from './components';

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const install = useAppUpdate((s) => s.install);
  const metered = useAppUpdate((s) => s.metered);
  const installUpdate = useAppUpdate((s) => s.installUpdate);
  const cancelInstall = useAppUpdate((s) => s.cancelInstall);
  const autoStart = useAppUpdate(shouldAutoDownload);

  const [browserOpening, setBrowserOpening] = useState(false);
  const [browserFailed, setBrowserFailed] = useState(false);

  /**
   * Start fetching as soon as the gate appears, on a connection where that is
   * free. By the time the release notes have been read the APK is usually
   * down, and the only thing left is Android's own confirmation — which is the
   * whole of what "automatic" can mean without enrolling the handset.
   */
  useEffect(() => {
    if (autoStart) void installUpdate();
  }, [autoStart, installUpdate]);

  if (!release) return null;

  const required = status === 'required';
  const remaining = Math.max(0, graceCount - skipsUsed);
  const busy = install.kind === 'downloading' || install.kind === 'handedOff';

  const openInBrowser = async () => {
    setBrowserOpening(true);
    setBrowserFailed(false);
    try {
      await Linking.openURL(release.download_url);
    } catch {
      // No browser, or a link that cannot be handled. Show the address so the
      // shop can type it on another device rather than being left at a dead end.
      setBrowserFailed(true);
    } finally {
      setBrowserOpening(false);
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

          {install.kind === 'downloading' ? (
            <Downloading
              received={install.received}
              total={install.total}
              onCancel={cancelInstall}
            />
          ) : install.kind === 'handedOff' ? (
            <View style={styles.waiting}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.waitingLabel}>
                Downloaded. Confirm the install when Android asks.
              </Text>
            </View>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
              onPress={canInstallInApp ? () => void installUpdate() : openInBrowser}
              disabled={browserOpening}
            >
              <Icon
                name={install.kind === 'staged' ? 'check-circle' : 'download'}
                size={18}
                color="#fff"
              />
              <Text style={styles.primaryLabel}>
                {browserOpening
                  ? 'Opening…'
                  : install.kind === 'staged'
                    ? 'Install now'
                    : install.kind === 'failed'
                      ? 'Try again'
                      : 'Update now'}
              </Text>
            </Pressable>
          )}

          {/* Said only when it is about to cost them something. On wi-fi the
              download has already started and there is nothing to warn about. */}
          {canInstallInApp && metered && install.kind === 'idle' ? (
            <Text style={styles.note}>
              You are on mobile data, so this was not downloaded automatically. Tap to download it
              now, or wait until you are on wi-fi.
            </Text>
          ) : null}

          {/* Backing out of Android's dialog and being blocked by it look
              identical from here, and the second is the likelier of the two the
              first time an update is installed this way. So the permission is
              offered on both, worded as the possibility it is. */}
          {install.kind === 'staged' ? (
            <View style={styles.pending}>
              <Text style={styles.pendingText}>
                The update is downloaded but not installed yet.
              </Text>
              <Pressable onPress={() => void openInstallPermissionSettings()}>
                <Text style={styles.link}>
                  If Android would not let it install, allow installs from NG POS
                </Text>
              </Pressable>
            </View>
          ) : null}

          {install.kind === 'failed' ? (
            <View style={styles.problem}>
              <Text style={styles.problemText}>{install.reason}</Text>
              <Pressable onPress={() => void openInstallPermissionSettings()}>
                <Text style={styles.link}>
                  If Android blocked the install, allow installs from NG POS
                </Text>
              </Pressable>
              {install.offerBrowser ? (
                <Pressable onPress={openInBrowser}>
                  <Text style={styles.link}>Download it in the browser instead</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {browserFailed ? (
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
          ) : busy ? null : (
            // Hidden while the APK is coming down, because "Later" there would
            // dismiss the screen and leave the transfer running out of sight —
            // spending both a postponement and the shop's data for nothing.
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

/**
 * The transfer, with a way out of it.
 *
 * `total` is `-1` when the server sent no `Content-Length`, which some file
 * hosts do not. There is no percentage to show then, so it shows what has
 * arrived instead of a bar that would have to invent its own position.
 */
function Downloading({
  received,
  total,
  onCancel,
}: {
  received: number;
  total: number;
  onCancel: () => void;
}) {
  const known = total > 0;
  const fraction = known ? Math.min(1, received / total) : 0;

  return (
    <View>
      <View style={styles.progressHead}>
        <Text style={styles.progressLabel}>Downloading the update</Text>
        <Text style={styles.progressValue}>
          {known ? `${Math.round(fraction * 100)}%` : megabytes(received)}
        </Text>
      </View>

      <View style={styles.track}>
        {known ? (
          <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
        ) : (
          <View style={styles.fillUnknown} />
        )}
      </View>

      <Text style={styles.progressSub}>
        {known ? `${megabytes(received)} of ${megabytes(total)}` : 'Keep the app open.'}
      </Text>

      <Pressable
        style={({ pressed }) => [styles.later, pressed && styles.laterPressed]}
        onPress={onCancel}
      >
        <Text style={styles.laterLabel}>Cancel</Text>
      </Pressable>
    </View>
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
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  waitingLabel: {
    flex: 1,
    fontFamily: font.semibold,
    fontSize: 14,
    lineHeight: 20,
    color: colors.primaryDeep,
  },
  progressHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  progressLabel: { fontFamily: font.semibold, fontSize: 15, color: colors.ink },
  progressValue: { fontFamily: font.bold, fontSize: 15, color: colors.primaryBright },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceSunken,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 4, backgroundColor: colors.primary },
  /** No `Content-Length`: a stub that shows life without claiming a position. */
  fillUnknown: { height: '100%', width: '35%', borderRadius: 4, backgroundColor: colors.primarySoft },
  progressSub: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textFaint,
    marginTop: spacing.sm,
  },
  note: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  /** Nothing has gone wrong here — only something is still outstanding. */
  pending: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  pendingText: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.warning,
  },
  problem: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  problemText: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.danger,
  },
  link: {
    fontFamily: font.semibold,
    fontSize: 13,
    lineHeight: 19,
    color: colors.primaryDeep,
    textDecorationLine: 'underline',
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
