/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    // Tests install their own DOM through $lib/server/epub/node-dom, so they run the
    // exact Node code path a server-side job would use.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // One temp folder per run, deleted at the end (the tests' temp folders used to pile up).
    globalSetup: ['../../tools/vitest-temp-dir.mjs'],
    testTimeout: 60_000
  }
});
