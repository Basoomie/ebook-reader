import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // One temp folder per run, deleted at the end (the tests' temp folders used to pile up).
    globalSetup: ['../../tools/vitest-temp-dir.mjs'],
    // Legacy tests spawn the real server as a child process; give startup some room.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
