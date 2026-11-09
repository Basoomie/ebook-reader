/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP5 side-by-side writes for UI code (statistics page, reading goals). The
 * record sync is loaded on demand and any failure is swallowed, so these calls
 * can never break the screen that makes them.
 */

export function shadowStatistics(title: string, options: { pruneMissing?: boolean } = {}): void {
  import('$lib/sync/sync-service')
    .then(({ recordBookStatistics }) => recordBookStatistics(title, options))
    .catch(() => {});
}

export function shadowReadingGoals(): void {
  import('$lib/sync/sync-service')
    .then(({ recordReadingGoalEdits }) => recordReadingGoalEdits())
    .catch(() => {});
}
