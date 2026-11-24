/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { SyncEngine } from '$lib/sync/sync-engine';
import { SUMMARY_SKIP_KIND } from './summary-cache';

/**
 * "Make a summary when a book is first completed" (session 4b). While it is off, every
 * completion on this device (the reader's Complete Book, the Book status dialog, the bulk
 * "Mark completed") first writes a "summary-skip" record for the book, in the same push as the
 * completion and offline too. The server marks a book with that record "skipped" the first time
 * it sees it completed, so a completion made while the switch was off never makes a summary
 * later: not after switching it on again, a restart, or a push that comes in late.
 *
 * Never throws: completing a book must not fail because of summaries.
 */
export async function skipWhenAutoOff(
  engine: Pick<SyncEngine, 'put'>,
  bookIds: readonly string[],
  autoOn: boolean,
  warn: (message: string) => void = () => {}
): Promise<void> {
  if (autoOn) return;
  for (const id of bookIds) {
    try {
      await engine.put(SUMMARY_SKIP_KIND, id, {}, { bookId: id });
    } catch (error) {
      warn(`Summaries: could not note "no summary" for ${id}: ${(error as Error)?.message}`);
    }
  }
}
