/**
 * The Google run's workflow marks, recorded before stage 5 removes them from Calibre (WP20f,
 * decided with the user 2026-11-21). Stage 2's and stage 4's rules read the tag
 * metadata-processed ("Calibre's record came from the Google Books run"): with the tag gone, a
 * later analysis reads the record instead and decides exactly as before. Recorded once per book
 * and tag, never cleared.
 */
import type Database from 'better-sqlite3';
import type { Stage2Book } from './stage2-snapshot';
import { RECORDED_MARKS } from './stage5/vocab';

const MARKS = new Set<string>(RECORDED_MARKS);

/** Records every book's marks found in the snapshot now. Returns how many rows were added. */
export function recordMarks(
  db: Database.Database,
  libraryId: string,
  books: Iterable<Pick<Stage2Book, 'uuid' | 'tags'>>,
  now = Date.now(),
): number {
  const put = db.prepare(
    `INSERT OR IGNORE INTO calibre_marks (library_id, calibre_uuid, tag, recorded_at) VALUES (?, ?, ?, ?)`,
  );
  let n = 0;
  db.transaction(() => {
    for (const b of books)
      for (const t of b.tags) {
        const tag = t.trim().toLowerCase();
        if (MARKS.has(tag)) n += put.run(libraryId, b.uuid, tag, now).changes;
      }
  })();
  return n;
}

/** The recorded marks by book (one read; 26,000+ rows: a few ms). */
export function recordedMarks(db: Database.Database, libraryId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db
    .prepare('SELECT calibre_uuid, tag FROM calibre_marks WHERE library_id = ?')
    .all(libraryId) as { calibre_uuid: string; tag: string }[]) {
    const l = out.get(r.calibre_uuid);
    if (l) l.push(r.tag);
    else out.set(r.calibre_uuid, [r.tag]);
  }
  return out;
}

/** Gives each snapshot book its recorded marks (`marks`; its Calibre tags stay as they are). */
export function attachMarks(
  db: Database.Database,
  libraryId: string,
  books: Iterable<Stage2Book>,
): void {
  const marks = recordedMarks(db, libraryId);
  for (const b of books) b.marks = marks.get(b.uuid) ?? [];
}
