import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Legacy tests spawn the real server as a child process; give startup some room.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
