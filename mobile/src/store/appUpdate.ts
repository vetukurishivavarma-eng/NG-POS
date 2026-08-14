import { create } from 'zustand';
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import type { File } from 'expo-file-system';

import { appUpdates } from '../api/endpoints';
import type { AppReleaseInfo } from '../api/types';
import {
  canInstallInApp,
  downloadApk,
  InstallError,
  launchInstaller,
  type DownloadHandle,
} from '../lib/apkInstaller';

/**
 * Keeping the shop on a current build.
 *
 * The rule, as asked for: when the app opens it asks the server what the
 * current build is. If there is a newer one it says so and offers "Later".
 * "Later" works twice. The third time the same update is offered there is no
 * "Later" — nobody gets past the prompt until the new APK is installed.
 *
 * Three deliberate decisions inside that:
 *
 *  - **The count is per build, not global.** Postponing 1.2.0 twice must not
 *    mean 1.3.0 is compulsory the first time it appears. A new build starts
 *    with a fresh two.
 *  - **A failed check never blocks.** A till on a dead connection, or a server
 *    asleep, must still sell — being unable to *ask* whether the app is current
 *    is not evidence that it is not. Blocking on it would mean one bad minute
 *    of network closes every shop at once.
 *  - **The count lives on the handset, the policy on the server.** The prompt
 *    has to work offline once it has been shown; but how many times "Later" is
 *    allowed comes down with the release, so a release that must not be
 *    postponed can say so without shipping an app to enforce it.
 */

/** Per-build tally of postponements, as `{"14":2}`. */
const SKIPS_KEY = 'ngpos.update.skips';

/**
 * How long a successful check stands before the app asks again.
 *
 * The check runs on cold start and whenever the app is brought back to the
 * foreground, which on a till is many times an hour. Half an hour is often
 * enough to catch an update on the day it is published and rare enough not to
 * be a background chatter.
 */
const RECHECK_AFTER_MS = 30 * 60_000;

/**
 * The installed build, as an integer.
 *
 * Android's `versionCode` is what the server compares. `expoConfig` is the app
 * config baked into the build, so this is the number in `app.json` at the
 * moment the APK was assembled.
 */
export function installedBuild(): number | null {
  const android = Constants.expoConfig?.android?.versionCode;
  if (typeof android === 'number') return android;
  const ios = Constants.expoConfig?.ios?.buildNumber;
  const parsed = ios ? Number.parseInt(ios, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function installedVersion(): string {
  return Constants.expoConfig?.version ?? '';
}

async function readSkips(): Promise<Record<string, number>> {
  try {
    const raw = await SecureStore.getItemAsync(SKIPS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

async function writeSkips(skips: Record<string, number>): Promise<void> {
  try {
    await SecureStore.setItemAsync(SKIPS_KEY, JSON.stringify(skips));
  } catch {
    // A handset that cannot record the count will keep offering "Later"
    // indefinitely. That is the safe direction to fail: a till that still
    // works, against one locked shut by its own bookkeeping.
  }
}

/**
 * Where the install has got to.
 *
 * Kept apart from `UpdateStatus` on purpose: that answers "should the gate be
 * up", which the server decides, and this answers "what is happening on this
 * handset right now", which nothing outside this run of the app cares about.
 */
export type InstallPhase =
  | { kind: 'idle' }
  /**
   * `received === 0` means the connection has not delivered anything yet, which
   * the gate shows as "Connecting" rather than as a download stuck at zero —
   * the two are the same picture and only one of them is honest. `attempt`
   * carries whether this is the retry, so the gate can say so.
   */
  | { kind: 'downloading'; received: number; total: number; attempt: number }
  /**
   * Downloaded, verified, and sitting on disk with nothing running.
   *
   * Reached by backing out of Android's installer. It is distinct from `idle`
   * for two reasons that both matter: the APK is already here, so offering
   * "Install" must not fetch it again, and `idle` is what the automatic
   * download watches for — returning there would restart an 80 MB transfer
   * every time somebody dismissed the system dialog.
   */
  | { kind: 'staged' }
  /** Android's installer is on screen. */
  | { kind: 'handedOff' }
  | { kind: 'failed'; reason: string; offerBrowser: boolean };

export type UpdateStatus =
  /** Nothing to say: current, or we could not ask. */
  | 'none'
  /** A newer build exists and "Later" is still available. */
  | 'optional'
  /** Update or stop: the grace is spent, or the release was never optional. */
  | 'required';

interface AppUpdateState {
  status: UpdateStatus;
  release: AppReleaseInfo | null;
  /** How many times this build has been postponed already. */
  skipsUsed: number;
  /** How many are allowed in total, from the server. */
  graceCount: number;
  /** Dismissed for this run of the app, having spent one of the skips. */
  postponed: boolean;
  checking: boolean;
  lastCheckedAt: number | null;

  install: InstallPhase;
  /**
   * Whether the connection is one it would be rude to pull 80 MB down.
   *
   * `null` until it has been established — which is not the same as "not
   * metered", and is why the automatic download waits for an answer rather
   * than assuming a good one.
   */
  metered: boolean | null;

  check: (options?: { force?: boolean }) => Promise<void>;
  postpone: () => Promise<void>;
  /** Fetch the APK and hand it to Android. */
  installUpdate: () => Promise<void>;
  cancelInstall: () => void;
  /** Only for the release screen: forget the tally after a manual install. */
  reset: () => Promise<void>;
}

/**
 * The live download, held outside the store.
 *
 * It is a native handle, not state — putting it in the store would mean every
 * subscriber re-rendered when it was swapped, for a value none of them read.
 */
let inFlight: DownloadHandle | null = null;

/** The APK on disk, if one has been fetched and checked this run. */
/** Ceiling on how often a download redraws the gate. ~4 updates a second. */
const PROGRESS_INTERVAL_MS = 250;

let staged: { build: number; file: File } | null = null;

/**
 * Whether the automatic download has had its turn for this build.
 *
 * Set the first time a download starts and never cleared except by a new
 * release, so cancelling is a decision that sticks. Without it, cancelling on
 * wi-fi would only mean the transfer restarted a frame later.
 */
let autoStarted = 0;

export const useAppUpdate = create<AppUpdateState>((set, get) => ({
  status: 'none',
  release: null,
  skipsUsed: 0,
  graceCount: 2,
  postponed: false,
  checking: false,
  lastCheckedAt: null,
  install: { kind: 'idle' },
  metered: null,

  check: async ({ force = false } = {}) => {
    const { checking, lastCheckedAt } = get();
    if (checking) return;
    if (!force && lastCheckedAt && Date.now() - lastCheckedAt < RECHECK_AFTER_MS) return;

    set({ checking: true });
    try {
      const build = installedBuild();
      const result = await appUpdates.check(build, installedVersion());

      if (!result.update_available || !result.latest) {
        set({
          status: 'none',
          release: null,
          postponed: false,
          install: { kind: 'idle' },
          lastCheckedAt: Date.now(),
        });
        return;
      }

      const skips = await readSkips();
      const used = skips[String(result.latest.build)] ?? 0;
      // `grace_count` comes back as 0 when the server has already decided the
      // update is compulsory — a mandatory release, or a build under the floor.
      const blocked = result.mandatory || used >= result.grace_count;

      // A different build than the one being shown is a new offer, and a build
      // that has just become compulsory must reappear whatever was tapped last
      // time. Only "same build, still optional" keeps its dismissal.
      const sameBuild = get().release?.build === result.latest.build;

      set({
        status: blocked ? 'required' : 'optional',
        release: result.latest,
        skipsUsed: used,
        graceCount: result.grace_count,
        postponed: !blocked && sameBuild && get().postponed,
        // A different build means anything downloaded or failed was about a
        // release nobody is being offered any more, and a stale "not enough
        // space" would otherwise sit on screen against the wrong version.
        install: sameBuild ? get().install : { kind: 'idle' },
        lastCheckedAt: Date.now(),
      });
    } catch {
      // Offline, or the server is asleep. Say nothing and let the till work —
      // see the note at the top about why this must not block.
      set({ status: 'none', lastCheckedAt: null });
    } finally {
      set({ checking: false });
    }
  },

  postpone: async () => {
    const { release, skipsUsed } = get();
    if (!release) return;

    // Only this build's tally is kept. Anything older is a build nobody is
    // being offered any more, and its count would never be read again.
    await writeSkips({ [String(release.build)]: skipsUsed + 1 });

    // The status deliberately does *not* harden here. "Later" was tapped, so
    // this time it works — that is what the word means. Spending the second one
    // is what makes the *third* prompt the wall, and the third prompt is the
    // next check: `used >= graceCount` there resolves to `required`.
    set({ skipsUsed: skipsUsed + 1, postponed: true });
  },

  installUpdate: async () => {
    const { release, install } = get();
    if (!release) return;
    // Re-entrant by design: the gate autostarts this and the button offers it,
    // and on a slow connection both can happen within the same second.
    if (install.kind === 'downloading' || install.kind === 'handedOff') return;

    autoStarted = release.build;

    // Already downloaded and checked, and the installer was backed out of.
    // `exists` is asked rather than assumed because the cache directory can be
    // emptied by Android at any moment when the device runs short of space.
    let file = staged?.build === release.build && staged.file.exists ? staged.file : null;

    if (!file) {
      staged = null;
      set({ install: { kind: 'downloading', received: 0, total: -1, attempt: 1 } });

      // Progress arrives per chunk — hundreds of events a second on a decent
      // link — and each one would otherwise be a store write and a re-render,
      // on the same thread that has to draw them. The eye cannot read more than
      // a few updates a second anyway.
      let lastEmit = 0;
      let attempt = 1;

      try {
        file = await downloadApk(
          release.download_url,
          release.build,
          (received, total) => {
            // A cancelled transfer can emit one last progress event on its way
            // down. Without this guard it would resurrect the progress bar over
            // whatever the cancellation just put on screen.
            if (get().install.kind !== 'downloading') return;

            const now = Date.now();
            // Never throttle away the first byte or the last: the first is what
            // turns "Connecting" into a real transfer, and the last is what
            // leaves the bar full instead of stopping at 97%.
            const isEdge = received === 0 || (total > 0 && received >= total);
            if (!isEdge && now - lastEmit < PROGRESS_INTERVAL_MS) return;
            lastEmit = now;

            set({ install: { kind: 'downloading', received, total, attempt } });
          },
          (handle) => {
            inFlight = handle;
          },
          (nextAttempt) => {
            // A retry starts from nothing, so the bar must go back to
            // "Connecting" rather than sit at whatever the dead attempt reached.
            attempt = nextAttempt;
            lastEmit = 0;
            if (get().install.kind !== 'downloading') return;
            set({ install: { kind: 'downloading', received: 0, total: -1, attempt } });
          }
        );
      } catch (error) {
        inFlight = null;
        // A cancellation is the user's own doing and has already been reflected
        // on screen by `cancelInstall`. Reporting it back as a failure would
        // replace "tap to download" with an error about something they chose.
        if (get().install.kind !== 'downloading') return;

        const known = error instanceof InstallError;
        set({
          install: {
            kind: 'failed',
            reason: known
              ? (error as InstallError).message
              : 'The update could not be downloaded. Check the connection and try again.',
            offerBrowser: known ? (error as InstallError).fallbackWorthwhile : true,
          },
        });
        return;
      }

      inFlight = null;
      staged = { build: release.build, file };
    }

    set({ install: { kind: 'handedOff' } });

    try {
      await launchInstaller(file);
    } catch {
      // The installer would not open at all — an OEM ROM with it disabled, or
      // no activity able to handle an APK. The file is downloaded and sound,
      // so the browser is genuinely worth offering here.
      set({
        install: {
          kind: 'failed',
          reason: 'This device would not open the installer.',
          offerBrowser: true,
        },
      });
      return;
    }

    // Reaching here means the installer closed without replacing us: cancelled,
    // or blocked because installs from NG POS are not permitted yet. The APK
    // is still on disk and still good, so this settles on `staged` — the next
    // tap opens the installer again without a second download.
    set({ install: { kind: 'staged' } });
  },

  cancelInstall: () => {
    inFlight?.cancel();
    inFlight = null;
    // `staged` when there is something to install, so cancelling the *dialog*
    // does not throw away a finished download.
    // `build != null` first, or a missing release and a missing `staged` would
    // compare `undefined === undefined` and take the branch that dereferences
    // the null.
    const build = get().release?.build;
    const ready = build != null && staged?.build === build && staged.file.exists;
    set({ install: ready ? { kind: 'staged' } : { kind: 'idle' } });
  },

  reset: async () => {
    await writeSkips({});
    staged = null;
    autoStarted = 0;
    set({
      skipsUsed: 0,
      postponed: false,
      status: 'none',
      release: null,
      install: { kind: 'idle' },
      lastCheckedAt: null,
    });
  },
}));

/**
 * Keeps `metered` current.
 *
 * Started once, at module load, because the answer is needed the moment the
 * gate appears — a subscription set up inside the gate would not have heard
 * from NetInfo yet, and the automatic download would either stall waiting or
 * start on somebody's mobile data.
 */
NetInfo.addEventListener((state) => {
  useAppUpdate.setState({
    metered: state.type === 'cellular' || state.details?.isConnectionExpensive === true,
  });
});

/**
 * Whether the APK should start downloading on its own.
 *
 * Only on a connection that is not going to cost the shop anything. On mobile
 * data the size is put in front of them and they choose — which is the one
 * place in this flow where making it automatic would be taking a decision that
 * is not ours to take.
 */
export function shouldAutoDownload(state: AppUpdateState): boolean {
  return (
    canInstallInApp &&
    state.install.kind === 'idle' &&
    state.release !== null &&
    state.release.build !== autoStarted &&
    state.metered === false
  );
}

/**
 * Whether the update prompt should be covering the app right now.
 *
 * `required` ignores `postponed` entirely — that is the whole point of it.
 */
export function updateGateVisible(state: AppUpdateState): boolean {
  if (state.status === 'required') return true;
  return state.status === 'optional' && !state.postponed;
}
