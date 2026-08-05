import { createApp } from './app.js';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { catchUpOnBoot, startDailyReportJobs } from './jobs/dailyReport.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`NG POS API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

const stopJobs = startDailyReportJobs();
// Deliberately not awaited: a slow catch-up shouldn't delay serving requests.
void catchUpOnBoot();

/** Finish in-flight requests before exiting, so a deploy can't tear a sale in half. */
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down.`);
  stopJobs();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
