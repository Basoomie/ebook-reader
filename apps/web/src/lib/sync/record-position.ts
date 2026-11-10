/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CalibreLink } from '$lib/library/library-db';
import { bookStateFrom, positionReadThroughId } from '$lib/sync/book-state';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * Shadow position records (WP4). After the reader saves its bookmark, the
 * place this device reached is also written as a `position` record, for books
 * with a server book id: opened from the Calibre library, or linked by the
 * WP5 migration.
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
  /** WP5: the migrated link of a title without a Calibre link. */
  legacyBookId?(title: string): Promise<string | null>;
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
 * The server book id of a local book, or null when it has none. A Calibre
 * link whose title no longer matches the local book's title is stale (WP6
 * rule) and ignored; several valid links are reported and ignored. Without a
 * Calibre link, the book's migrated link (WP5) is used when given.
 */
export async function resolveLinkedBookId(
  localId: number,
  title: string,
  linksForLocalId: (localId: number) => Promise<CalibreLink[]>,
  warn: (message: string) => void,
  legacyBookId?: (title: string) => Promise<string | null>
): Promise<string | null> {
  const links = (await linksForLocalId(localId)).filter((l) => l.title === title);
  if (links.length > 1) {
    warn(`Sync: book ${localId} has several Calibre links; skipped`);
    return null;
  }
  if (links.length === 1) return links[0].bookId;
  return legacyBookId ? legacyBookId(title) : null;
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
    const bookId = await resolveLinkedBookId(
      localId,
      title,
      deps.linksForLocalId,
      deps.warn,
      deps.legacyBookId
    );
    if (!bookId) return false;
    const engine = await deps.getEngine();
    return await engine.put(
      'position',
      positionRecordId(bookId, engine.deviceId),
      {
        charPos: Math.max(0, Math.round(bookmark.exploredCharCount ?? 0)),
        progress: toProgress(bookmark.progress),
        // WP8a: the book's current read-through (null while it has none = the first).
        readThroughId: positionReadThroughId(bookStateFrom(bookId, await engine.getForBook(bookId)))
      },
      { bookId }
    );
  } catch (error) {
    deps.warn(`Sync: could not record the position: ${(error as Error)?.message ?? error}`);
    return false;
  }
}
