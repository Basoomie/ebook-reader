/**
 * Duplicate check for an upload (WP7b, decided 2026-11-10). In order:
 *
 * 1. same-file: an uploaded book with the same SHA-256.
 * 2. fingerprint: the WP3a/WP5 fingerprint (EPUB dc:title, image CRC32s, spine ids)
 *    verifies the upload against a catalog book's EPUB. It works although Calibre may
 *    rewrite EPUBs (whole-file hashes differ). Candidates by title, tier by tier, as in
 *    the migration (candidateTiers, imported unchanged); each EPUB is read once.
 * 3. title-author: the same title key and at least one author in common.
 *
 * Only reports matches. Nothing is ever merged automatically; the user decides.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { openSourceFile, resolveInside } from '../calibre/source-fs';
import {
  type BookFingerprint,
  candidateTiers,
  compareFingerprints,
  fingerprintEpub,
  looseTitleKey,
  MAX_CANDIDATES_PER_TIER,
  titleKey,
} from '../migration/fingerprint';
import type { UploadStore } from './upload-store';

export type DuplicateMatch = 'same-file' | 'fingerprint' | 'title-author';

export interface DuplicateHit {
  bookId: string;
  match: DuplicateMatch;
}

export interface UploadIdentity {
  /** The staged file. */
  file: string;
  sha256: string;
  /** Title and authors as the upload will be listed. */
  title: string;
  authors: string[];
}

interface CatalogEntry {
  id: string;
  title: string;
  kind: 'calibre' | 'upload';
  filePath: string | null;
  folder: string;
  key: string;
  looseKey: string;
}

/** Author key: NFKC, lower case, no whitespace. */
export function authorKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '');
}

export interface DuplicateDeps {
  db: Database.Database;
  store: UploadStore;
  /** Root of the Calibre libraries (read-only); null = Calibre books aren't fingerprinted. */
  calibreDir: string | null;
  logError?: (message: string, err: unknown) => void;
}

export async function findDuplicates(
  upload: UploadIdentity,
  deps: DuplicateDeps,
): Promise<DuplicateHit[]> {
  const { db, store } = deps;
  const hits: DuplicateHit[] = [];
  const seen = new Set<string>();
  const add = (bookId: string, match: DuplicateMatch) => {
    if (seen.has(bookId)) return;
    seen.add(bookId);
    hits.push({ bookId, match });
  };

  // Visible books only: present, in an enabled library.
  const visible = `FROM books b
    JOIN book_sources s ON s.book_id = b.id AND s.missing_at IS NULL
    JOIN libraries l ON l.id = b.library_id AND l.enabled = 1`;

  for (const row of db
    .prepare(`SELECT b.id ${visible} WHERE s.kind = 'upload' AND s.content_hash = ?`)
    .all(upload.sha256) as { id: string }[]) {
    add(row.id, 'same-file');
  }

  const entries: CatalogEntry[] = (
    db.prepare(`SELECT b.id, b.title, s.kind, s.file_path, l.folder ${visible}`).all() as {
      id: string;
      title: string;
      kind: 'calibre' | 'upload';
      file_path: string | null;
      folder: string;
    }[]
  ).map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    filePath: r.file_path,
    folder: r.folder,
    key: titleKey(r.title),
    looseKey: looseTitleKey(r.title),
  }));

  // 2. Fingerprint.
  let mine: BookFingerprint | null = null;
  try {
    mine = await fingerprintEpub(upload.file, store.openFile);
  } catch (err) {
    deps.logError?.('Uploads: could not fingerprint the upload', err);
  }
  if (mine) {
    const stored = { ...mine, sectionIds: [...(mine.spineIds ?? [])] };
    const cache = new Map<string, BookFingerprint | null>();
    const fingerprintOf = async (e: CatalogEntry): Promise<BookFingerprint | null> => {
      if (cache.has(e.id)) return cache.get(e.id)!;
      let fp: BookFingerprint | null = null;
      try {
        if (e.filePath) {
          if (e.kind === 'upload') {
            fp = await fingerprintEpub(store.resolve(e.filePath), store.openFile);
          } else if (deps.calibreDir) {
            const file = resolveInside(path.join(deps.calibreDir, e.folder), e.filePath);
            fp = await fingerprintEpub(file, openSourceFile);
          }
        }
      } catch {
        fp = null; // An unreadable candidate is simply not a match.
      }
      cache.set(e.id, fp);
      return fp;
    };
    for (const tier of candidateTiers(mine.title || upload.title, entries)) {
      let found = false;
      for (const e of tier.slice(0, MAX_CANDIDATES_PER_TIER)) {
        if (seen.has(e.id)) {
          found = true;
          continue;
        }
        const fp = await fingerprintOf(e);
        if (fp && compareFingerprints(stored, fp).verified) {
          add(e.id, 'fingerprint');
          found = true;
        }
      }
      if (found) break;
    }
  }

  // 3. Title and author.
  const key = titleKey(upload.title);
  const mineAuthors = new Set(upload.authors.map(authorKey).filter((a) => a !== ''));
  const sameTitle = entries.filter((e) => e.key === key && !seen.has(e.id));
  if (sameTitle.length && mineAuthors.size) {
    const authorsOf = db.prepare(
      `SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ?`,
    );
    for (const e of sameTitle) {
      const names = (authorsOf.all(e.id) as { name: string }[]).map((r) => authorKey(r.name));
      if (names.some((n) => mineAuthors.has(n))) add(e.id, 'title-author');
    }
  }
  return hits;
}
