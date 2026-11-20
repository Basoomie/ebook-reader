/**
 * The reader's audiobook hold (WP21e-2, ttsu.db migration 27). The audiobook cleanup's
 * switch renames the library's audio folder and rewrites the reader's links; while it does,
 * nothing on the reader's side may read the folders' layout or write into them.
 *
 * - `switch`: held by the switch (renames, link remap, rescan; Undo; deleting
 *   japanese-old). While it is held: the scanner's passes scan nothing (the switch runs its
 *   own scan), merges wait, the PC worker gets no job, the link routes refuse a change and
 *   AudioWriter refuses every write.
 * - `merge_wait`: from the deploy of WP21e-2 until the switch is done, merging into one
 *   file is refused (decided with the user 2026-11-20): a merged file goes to
 *   `<audio folder>-merged/<book path>/`, and before the switch that path is the old one.
 *
 * Stored in ttsu.db, so a restart in the middle of the switch keeps it (read on every
 * check; a primary-key lookup).
 */
import type Database from 'better-sqlite3';
import { ApiError } from '../api/errors';

export type AudioHoldKind = 'switch' | 'merge_wait';

export interface AudioHold {
  kind: AudioHoldKind;
  reason: string;
  since: number;
}

export const HOLD_TEXT: Record<AudioHoldKind, string> = {
  switch: 'The audiobooks are being moved to their new folders. Try again when that has finished.',
  merge_wait:
    'Merging waits until the audiobooks have moved to their new folders (the audiobook cleanup’s switch).',
};

/** An ApiError (409 audio_hold), so a route that meets it answers with the plain text. */
export class AudioHoldError extends ApiError {
  constructor(readonly kind: AudioHoldKind) {
    super(409, 'audio_hold', HOLD_TEXT[kind]);
  }
}

export function getHold(db: Database.Database, kind: AudioHoldKind): AudioHold | null {
  const row = db.prepare('SELECT kind, reason, since FROM audio_hold WHERE kind = ?').get(kind) as
    | AudioHold
    | undefined;
  return row ?? null;
}

export function isHeld(db: Database.Database, kind: AudioHoldKind): boolean {
  return getHold(db, kind) !== null;
}

/** Throws AudioHoldError when `kind` is held. */
export function assertNotHeld(db: Database.Database, kind: AudioHoldKind = 'switch'): void {
  if (isHeld(db, kind)) throw new AudioHoldError(kind);
}

/** Takes the hold (keeps the first `since` when it is already held). */
export function setHold(
  db: Database.Database,
  kind: AudioHoldKind,
  reason: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO audio_hold (kind, reason, since) VALUES (?, ?, ?)
     ON CONFLICT (kind) DO UPDATE SET reason = excluded.reason`,
  ).run(kind, reason, now);
}

export function clearHold(db: Database.Database, kind: AudioHoldKind): boolean {
  return db.prepare('DELETE FROM audio_hold WHERE kind = ?').run(kind).changes > 0;
}

export function listHolds(db: Database.Database): AudioHold[] {
  return db
    .prepare('SELECT kind, reason, since FROM audio_hold ORDER BY kind')
    .all() as AudioHold[];
}
