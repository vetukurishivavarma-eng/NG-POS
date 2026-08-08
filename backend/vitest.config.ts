import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite talks to a real Postgres. Mocking Prisma would test the mock:
    // every bug these tests exist for was in how the database was actually
    // queried or constrained, not in application logic a fake would exercise.
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // Sales share receipt counters and stock rows; parallel files would fight
    // over them and fail for reasons that have nothing to do with the code.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      // LCOV is what SonarCloud reads; text keeps a summary in the CI log.
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // Entry point, generated Prisma client and type-only modules have nothing
      // a unit test would meaningfully cover.
      exclude: ['src/index.ts', 'src/prisma.ts', '**/*.d.ts'],
    },
  },
});
