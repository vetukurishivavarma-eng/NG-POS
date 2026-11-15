import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';

import { appUpdates } from '../api/endpoints';
import { restoreApiBaseUrl } from '../api/client';
import { installedBuild, installedVersion, notifyUpdateOnce } from '../store/appUpdate';

const TASK = 'ngpos-update-check';

/**
 * Runs about every 15 minutes even when the app is closed (Android WorkManager):
 * asks the server whether a newer build exists and, if so, raises the
 * "update available" notification. Tapping it opens the app, whose normal
 * check then shows the "Update now" prompt.
 * ponytail: the OS decides the exact timing (battery saver and Doze can delay
 * it, and a force-stopped app does not run it). Real push needs Firebase.
 */
TaskManager.defineTask(TASK, async () => {
  try {
    await restoreApiBaseUrl();
    const r = await appUpdates.check(installedBuild(), installedVersion());
    if (r.update_available && r.latest) await notifyUpdateOnce(r.latest.build, r.latest.version);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerUpdateTask(): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
  } catch {
    // Unsupported or restricted on this device: the in-app check still works.
  }
}
