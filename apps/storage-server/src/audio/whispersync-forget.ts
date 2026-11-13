/**
 * When a book's audiobook or subtitle link changes, whispersync's saved match and saved
 * subtitles of that book were made with the old files and no longer fit (decided with the
 * user, 2026-11-13). They are removed on every device, the same way whispersync's own
 * reset removes them: the server marks the book's "book-attachment" records
 * (`<bookId>:whispersync-match`, `<bookId>:whispersync-subtitles`) deleted. A device that
 * syncs then puts the book's original text back and drops its saved subtitles, unless its
 * own copy was saved after the change (whispersync-sync.ts in the web app). The playback
 * position is kept. The stored files stay until a device uploads new ones, as with a
 * device's reset.
 *
 * Only writes sync records; never touches the audiobooks folder or the attachment files.
 */
import type Database from 'better-sqlite3';
import { SyncStore } from '../sync/store';
import { BOOK_ATTACHMENT_KIND, BOOK_ATTACHMENT_NAMES, attachmentRecordId } from '../sync/kinds';

/** The device id of these server-made deletions (records need one; no device has it). */
export const SERVER_DEVICE_ID = 'server';

/** Marks the book's saved whispersync match and subtitles removed. Returns how many. */
export function forgetWhispersync(
  db: Database.Database,
  userId: string,
  bookId: string,
  now: number,
): number {
  const sync = new SyncStore(db);
  let removed = 0;
  for (const name of BOOK_ATTACHMENT_NAMES) {
    const id = attachmentRecordId(bookId, name);
    const current = sync.getRecord(userId, BOOK_ATTACHMENT_KIND, id);
    if (!current || current.deletedAt !== null) continue;
    // Newer than the record in any case, so the deletion is never refused as stale.
    const at = Math.max(now, current.updatedAt + 1);
    const result = sync.writeAs(
      userId,
      SERVER_DEVICE_ID,
      { kind: BOOK_ATTACHMENT_KIND, id, updatedAt: at, deletedAt: at, data: {} },
      at,
    );
    if (result.status !== 'applied') {
      throw new Error(`removing ${id}: ${result.status}`);
    }
    removed += 1;
  }
  return removed;
}
