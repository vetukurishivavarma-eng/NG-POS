import cron from 'node-cron';

import { env } from '../env.js';
import { snapshotAllStores, todayKey, yesterdayKey } from '../services/dailyReport.js';

/**
 * Nightly Z-report snapshot.
 *
 * Two things run on a schedule:
 *
 *  - **Close-of-business** (`DAILY_REPORT_CRON`, default 21:05) takes an
 *    unsealed snapshot of the day that is ending. Shops close around 20:00, so
 *    by then the figures are what the cash drawer should hold, and a manager
 *    printing an End Session report gets the same numbers the server stored.
 *  - **After midnight** (`DAILY_REPORT_SEAL_CRON`, default 00:20) re-runs
 *    yesterday and seals it. The gap catches sales that landed late — an
 *    offline device syncing on its way home is the normal case — and once the
 *    row is sealed it is never recomputed.
 *
 * Both run in `REPORT_TIMEZONE`, so a container in UTC still cuts the day at
 * midnight in Lusaka.
 */
export function startDailyReportJobs(): () => void {
  if (!env.CRON_ENABLED) {
    console.log('[daily-report] cron disabled (CRON_ENABLED=false)');
    return () => {};
  }

  const options = { timezone: env.REPORT_TIMEZONE } as const;

  const closing = cron.schedule(
    env.DAILY_REPORT_CRON,
    () => {
      void run('close-of-business', todayKey(), false);
    },
    options
  );

  const sealing = cron.schedule(
    env.DAILY_REPORT_SEAL_CRON,
    () => {
      void run('seal', yesterdayKey(), true);
    },
    options
  );

  console.log(
    `[daily-report] scheduled: snapshot "${env.DAILY_REPORT_CRON}", seal "${env.DAILY_REPORT_SEAL_CRON}" (${env.REPORT_TIMEZONE})`
  );

  return () => {
    void closing.stop();
    void sealing.stop();
  };
}

/**
 * A restart at the wrong moment shouldn't cost a day. On boot, seal yesterday
 * if the job never got to it — `snapshotStoreDay` leaves already-sealed rows
 * alone, so this is safe to run every time the process starts.
 */
export async function catchUpOnBoot(): Promise<void> {
  if (!env.CRON_ENABLED) return;
  await run('boot catch-up', yesterdayKey(), true);
}

async function run(label: string, date: string, finalize: boolean): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await snapshotAllStores(date, { finalize });
    console.log(
      `[daily-report] ${label} ${date}: ${result.stores} store(s)${
        result.failed ? `, ${result.failed} failed` : ''
      }${finalize ? ', sealed' : ''} in ${Date.now() - startedAt}ms`
    );
  } catch (err) {
    // A scheduled job must never take the API process down with it.
    console.error(`[daily-report] ${label} ${date} failed:`, err);
  }
}
