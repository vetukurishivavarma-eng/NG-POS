import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

/**
 * Fetching the new build and handing it to Android's installer, in-app.
 *
 * What this replaces: a link that threw the shop out into a browser, left an
 * APK sitting in Downloads forever, and relied on somebody finding it in a
 * file manager and tapping the right one. Half of the support calls about
 * "the update didn't work" were somebody installing last month's APK, because
 * three of them were still in the folder.
 *
 * What it cannot do is install silently. Android will always draw its own
 * confirmation over the top of this, and the first time it will also insist
 * the user allows installs from NG POS. A truly unattended install needs the
 * handset to be enrolled as a managed device; short of that, "auto" here means
 * the fetching, the housekeeping and the version bookkeeping are automatic and
 * exactly one deliberate tap is left to the person holding the phone.
 *
 * Two things Android does give us for free, and they are the reason this is
 * safe to do at all:
 *
 *  - **The install is an upgrade, not a second copy.** Same package name, so
 *    the old version is replaced in place and the SQLite till data, the queued
 *    offline sales and the SecureStore keys all survive.
 *  - **The signature has to match.** A tampered or substituted APK cannot
 *    install over ours, whatever the download served. That is a stronger
 *    guarantee than a checksum we would be verifying against a number fetched
 *    over the same connection.
 */

/** Everything staged for install lives here, and nothing else does. */
const STAGING = 'updates';

/** `FLAG_GRANT_READ_URI_PERMISSION` — lets the installer read our file. */
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;

const APK_MIME = 'application/vnd.android.package-archive';

/**
 * Refuse to start a download that obviously cannot finish.
 *
 * The 1.3.0 APK is 41 MB, and Android wants several times that again while it
 * copies and optimises the package during install. The floor is set well above
 * the sum so a till is told up front rather than filling its last free
 * megabytes and failing at the point of no return — but not so high that a
 * phone with room to spare is refused.
 */
const REQUIRED_FREE_BYTES = 250 * 1024 * 1024;

/**
 * How long to wait for the *first byte* before giving up and starting over.
 *
 * `downloadAsync()` has no timeout of its own, so a connection that is accepted
 * and then goes nowhere waits for ever — which on 1.5.0 showed as a progress
 * panel reading 0.0 MB for about a minute, indistinguishable from a hang.
 *
 * The classic cause of exactly that shape is a handset trying an AAAA record on
 * a network with no working IPv6 route: the attempt blackholes until something
 * gives up, then IPv4 succeeds and the transfer runs at full speed. Whatever the
 * cause, the cure is the same and it is not patience — a fresh connection
 * re-resolves and usually lands immediately.
 *
 * This measures time to first byte, not total time. A genuinely slow shop
 * connection is allowed to take as long as it needs once bytes are moving.
 */
const FIRST_BYTE_TIMEOUT_MS = 45_000;

/** One retry. If a second fresh connection also stalls, something is wrong. */
const MAX_ATTEMPTS = 2;

export class InstallError extends Error {
  constructor(
    message: string,
    /** Whether offering the browser download instead is worth the user's time. */
    readonly fallbackWorthwhile = true
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

export const canInstallInApp = Platform.OS === 'android';

function staging(): Directory {
  const dir = new Directory(Paths.cache, STAGING);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Throws away every staged APK.
 *
 * Called on launch, which is the moment it is unambiguously safe: if the app
 * is running then whatever was staged has either been installed — in which
 * case it is this very build and keeping it is pointless — or was abandoned.
 * This is the half of "don't keep the old version around" that the browser
 * download could never do, because a file in Downloads belongs to the user and
 * an app has no business deleting it.
 */
export function sweepStagedApks(): void {
  if (!canInstallInApp) return;
  try {
    for (const entry of staging().list()) {
      try {
        entry.delete();
      } catch {
        // A file the installer still has open. The next sweep gets it.
      }
    }
  } catch {
    // No cache directory yet, or no permission to read it. Nothing staged
    // either way, so there is nothing this needs to report.
  }
}

/**
 * True if the file starts with a local zip header.
 *
 * An APK is a zip. This catches the failure that a plain size check does not:
 * a share link that answers 200 with an HTML interstitial, or a captive portal
 * login page, both of which download perfectly and then hand the installer
 * something it will reject with a message about a corrupt package. Only four
 * bytes are read — the file is far too big to pull into memory.
 */
function looksLikeAnApk(file: File): boolean {
  let handle;
  try {
    handle = file.open(FileMode.ReadOnly);
    const magic = handle.readBytes(4);
    return magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;
  } catch {
    return false;
  } finally {
    handle?.close();
  }
}

export interface DownloadHandle {
  /** Abandons the transfer. The partial file is left for the next sweep. */
  cancel: () => void;
}

/**
 * Downloads the APK for `build` into the staging directory.
 *
 * `onHandle` receives a cancel hook as soon as the transfer is live, so the
 * caller can tear it down without this function having to return first.
 */
export async function downloadApk(
  url: string,
  build: number,
  onProgress: (received: number, total: number) => void,
  onHandle?: (handle: DownloadHandle) => void,
  /** Called before each attempt, so the caller can reset its progress display. */
  onAttempt?: (attempt: number) => void
): Promise<File> {
  if (!canInstallInApp) {
    throw new InstallError('In-app installing is only available on Android.');
  }

  // Whatever is here is for a build nobody is being offered any more.
  sweepStagedApks();

  if (Paths.availableDiskSpace < REQUIRED_FREE_BYTES) {
    throw new InstallError(
      'There is not enough free space on this device to download the update. Free up some space and try again.',
      false
    );
  }

  // Held across attempts: a cancellation must stop the retry loop too, or
  // tapping Cancel during a stall would quietly start a second transfer.
  let cancelledByUser = false;
  let live: AbortController | null = null;
  onHandle?.({
    cancel: () => {
      cancelledByUser = true;
      live?.abort();
    },
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onAttempt?.(attempt);

    const controller = new AbortController();
    live = controller;

    let sawBytes = false;
    const stall = setTimeout(() => {
      if (!sawBytes) controller.abort();
    }, FIRST_BYTE_TIMEOUT_MS);

    // `createDownloadTask` has no overwrite option and rejects onto an existing
    // file, so the destination is cleared rather than assumed absent — the
    // sweep above handles the first attempt, this handles a retry after one
    // that wrote something before dying.
    const destination = new File(staging(), `ngpos-${build}.apk`);
    if (destination.exists) {
      try {
        destination.delete();
      } catch {
        /* Nothing better to do; the download below will report the real fault. */
      }
    }

    try {
      const task = File.createDownloadTask(url, destination, {
        signal: controller.signal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          if (bytesWritten > 0) sawBytes = true;
          onProgress(bytesWritten, totalBytes);
        },
      });

      const file = await task.downloadAsync();
      clearTimeout(stall);

      // `null` means the task was paused. Nothing here pauses one, so treat it
      // the same as a transfer that never arrived rather than pressing on with
      // no file.
      if (!file) throw new InstallError('The download did not finish.');

      if (!looksLikeAnApk(file)) {
        try {
          file.delete();
        } catch {
          /* The sweep will deal with it. */
        }
        throw new InstallError(
          'What was downloaded is not an installable app. The download link for this release is probably wrong — check it on the releases screen.',
          false
        );
      }

      return file;
    } catch (error) {
      clearTimeout(stall);

      // The user's own doing. The caller has already put something on screen.
      if (cancelledByUser) throw error;

      // A diagnosed fault — wrong file, no space, a paused task. A second
      // attempt would fail the same way and only wastes the shop's data.
      if (error instanceof InstallError) throw error;

      // Anything else is the connection: a stall we aborted, a dropped socket,
      // a DNS failure. Worth exactly one fresh connection.
      if (attempt === MAX_ATTEMPTS) {
        throw new InstallError(
          'The update could not be downloaded — the connection did not get going, twice. Try again when the signal is better, or use the browser instead.'
        );
      }
    }
  }

  // Unreachable: the loop either returns a file or throws on its last attempt.
  throw new InstallError('The update could not be downloaded.');
}

/**
 * Hands the staged APK to Android's package installer.
 *
 * The result code is deliberately ignored. A successful install kills this
 * process to replace it, so the only paths that reach the end of this function
 * are a cancellation and an installer that closed without saying why — and
 * neither is distinguishable from the other through `startActivityForResult`.
 * The gate stays up either way, which is the correct outcome for both.
 */
export async function launchInstaller(file: File): Promise<void> {
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: file.contentUri,
    type: APK_MIME,
    // No `FLAG_ACTIVITY_NEW_TASK`: this goes out through
    // `startActivityForResult`, which a new task would break.
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  });
}

/**
 * Opens the "install unknown apps" screen for NG POS.
 *
 * Whether the permission is already granted cannot be read from JavaScript, so
 * this is not a gate in front of the install — it is offered *after* one that
 * did not take, which is the only moment the user has any reason to care.
 */
export async function openInstallPermissionSettings(): Promise<void> {
  await IntentLauncher.startActivityAsync(
    IntentLauncher.ActivityAction.MANAGE_UNKNOWN_APP_SOURCES,
    // Read rather than written out: the settings screen silently lands on the
    // full app list instead of ours if the package name drifts from the one in
    // app.json, and nothing would fail loudly enough to notice.
    { data: `package:${Constants.expoConfig?.android?.package ?? ''}` }
  );
}
