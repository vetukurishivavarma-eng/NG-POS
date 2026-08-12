import { defineConfig } from 'vitest/config';

/**
 * The pure-logic tests, run without a database.
 *
 * The main suite deliberately talks to a real Postgres, which means it needs
 * Docker up before it will start. Parsing a spreadsheet and working out a
 * product code need none of that, and the feedback loop on them should be a
 * second rather than a minute — so they get their own config with no global
 * setup. They are also picked up by the main suite's `test/**` glob, so nothing
 * here is excluded from a full run or from coverage.
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
