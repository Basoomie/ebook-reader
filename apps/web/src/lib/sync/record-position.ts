/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CalibreLink } from '$lib/library/library-db';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * Shadow position records (WP4). After the reader saves its bookmark, the
 * place this device reached is also written as a `position` record, but only
 * for books opened from the Calibre library (they have a server book id).
 * WP9's "Continue from...?" prompt reads them; the legacy sync still carries
 * the real position. Never throws and never delays the bookmark save.
 */

export interface BookmarkLike {
  exploredCharCount?: number;
  progress: number | string | undefined;
}

export interface RecordPositionDeps {
  getEngine(): Promise<SyncEngine>;
  linksForLocalId(localId: number): Promise<CalibreLink[]>;
  warn(message: string): void;
}

export function positionRecordId(bookId: string, deviceId: string): string {
  return `${bookId}:${deviceId}`;
}

function toProgress(value: number | string | undefined): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * The server book id of a local book, or null when it has no single valid
 * Calibre link. A link whose title no longer matches the local book's title is
 * stale (WP6 rule) and ignored; several valid links are reported and ignored.
 */
export async function resolveLinkedBookId(
  localId: number,
  title: string,
  linksForLocalId: (localId: number) => Promise<CalibreLink[]>,
  warn: (message: string) => void
): Promise<string | null> {
  const links = (await linksForLocalId(localId)).filter((l) => l.title === title);
  if (links.length > 1) warn(`Sync: book ${localId} has several Calibre links; skipped`);
  return links.length === 1 ? links[0].bookId : null;
}

/**
 * Returns whether a record was queued. `title` is the local book's title: a
 * link whose title no longer matches is stale (WP6 rule) and is ignored.
 */
export async function recordPosition(
  localId: number,
  title: string,
  bookmark: BookmarkLike,
  deps: RecordPositionDeps
): Promise<boolean> {
  try {
    const bookId = await resolveLinkedBookId(localId, title, deps.linksForLocalId, deps.warn);
    if (!bookId) return false;
    const engine = await deps.getEngine();
    return await engine.put(
      'position',
      positionRecordId(bookId, engine.deviceId),
      {
        charPos: Math.max(0, Math.round(bookmark.exploredCharCount ?? 0)),
        progress: toProgress(bookmark.progress),
        readThroughId: null
      },
      { bookId }
    );
  } catch (error) {
    deps.warn(`Sync: could not record the position: ${(error as Error)?.message ?? error}`);
    return false;
  }
}
