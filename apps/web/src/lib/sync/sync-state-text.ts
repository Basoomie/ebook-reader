/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { RunnerStatus } from '$lib/sync/sync-runner';

/** The sync runner's state in words (Settings > Data and Settings > Diagnostics). */
export const SYNC_STATE_TEXT: Record<RunnerStatus['state'], string> = {
  idle: 'Up to date',
  syncing: 'Syncing…',
  off: 'Off on this device',
  disconnected: 'Not connected',
  error: 'Last sync failed'
};
