import { create } from 'zustand';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import { appUpdates } from '../api/endpoints';
import type { AppReleaseInfo } from '../api/types';

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

  check: (options?: { force?: boolean }) => Promise<void>;
  postpone: () => Promise<void>;
  /** Only for the release screen: forget the tally after a manual install. */
  reset: () => Promise<void>;
}

export const useAppUpdate = create<AppUpdateState>((set, get) => ({
  status: 'none',
  release: null,
  skipsUsed: 0,
  graceCount: 2,
  postponed: false,
  checking: false,
  lastCheckedAt: null,

  check: async ({ force = false } = {}) => {
    const { checking, lastCheckedAt } = get();
    if (checking) return;
    if (!force && lastCheckedAt && Date.now() - lastCheckedAt < RECHECK_AFTER_MS) return;

    set({ checking: true });
    try {
      const build = installedBuild();
      const result = await appUpdates.check(build, installedVersion());

      if (!result.update_available || !result.latest) {
        set({ status: 'none', release: null, postponed: false, lastCheckedAt: Date.now() });
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

  reset: async () => {
    await writeSkips({});
    set({ skipsUsed: 0, postponed: false, status: 'none', release: null, lastCheckedAt: null });
  },
}));

/**
 * Whether the update prompt should be covering the app right now.
 *
 * `required` ignores `postponed` entirely — that is the whole point of it.
 */
export function updateGateVisible(state: AppUpdateState): boolean {
  if (state.status === 'required') return true;
  return state.status === 'optional' && !state.postponed;
}
