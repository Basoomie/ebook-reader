/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Entry point of the storage server's copy of the stats code
 * (`apps/storage-server/vendor/stats.cjs`, built by `pnpm build:server-stats`).
 * Notifications N2: the server's daily, weekly and monthly stats messages use exactly
 * these functions, so their totals are the Stats page's. Re-exports only.
 */

export { statEntriesFromRecords, readingSpeed } from '$lib/stats/aggregate';
export { bookStatesFrom } from '$lib/sync/book-state';
export { buildStatsView } from '$lib/stats/stats-view';
export {
  addDays,
  isDayKey,
  normalizeWeekStart,
  periodContaining,
  periodLabel,
  periodToParam,
  stepPeriod
} from '$lib/stats/periods';
export { changeLine } from '$lib/stats/period-compare';
export { formatDuration, formatNumber } from '$lib/stats/stats-format';
