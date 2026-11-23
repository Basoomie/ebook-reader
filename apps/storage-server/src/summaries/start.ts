/**
 * Book summaries on the server (session 3): starts the feature. summaries.db beside ttsu.db
 * (created on first use), a runner of the shared AI layer for the feature "summaries", and the
 * book's text read as the reader counts it (the counter bundle, as the audiobook jobs read it,
 * but without needing the audiobooks to be on).
 *
 * Off while the accuracy test runs on the PC's test copy (SUMMARIES_TEST=1): both would use
 * summaries.db's one queue.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import type { AiCore } from '../ai/core';
import { AiRunner } from '../ai/runner';
import { readBookScript, type BookScript, type ScriptReader } from '../audio/book-script';
import { resolveInside } from '../calibre/source-fs';
import { getBookFileFor } from '../catalog/queries';
import type { UploadStore } from '../uploads/upload-store';
import { NoTextError, SummaryService, type SummaryNotifier } from './service';
import { modelForTask } from './specs';
import { openSummariesDb, summariesDbPath } from './summaries-db';

export interface SummariesStartOptions {
  db: Database.Database;
  dbDir: string;
  core: AiCore;
  calibreDir: string | null;
  uploads: UploadStore | null;
  importOptions: unknown;
  /** The reader's sentence length (the audiobooks' setting; positions don't depend on it). */
  maxSentence: number;
  scriptTimeoutSeconds: number;
  notifications?: SummaryNotifier | null;
  readScript?: ScriptReader;
}

/** The book's EPUB on disk (read-only), or null. */
export function bookEpub(
  db: Database.Database,
  o: { calibreDir: string | null; uploads: UploadStore | null },
  bookId: string,
): string | null {
  const owner = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as
    | { id: string }
    | undefined;
  const loc = getBookFileFor(db, { id: owner?.id ?? '' }, bookId);
  if (!loc || loc.missing) return null;
  try {
    if (loc.kind === 'upload') return o.uploads ? o.uploads.resolve(loc.filePath) : null;
    if (!o.calibreDir) return null;
    return resolveInside(path.join(o.calibreDir, loc.libraryFolder), loc.filePath);
  } catch {
    return null;
  }
}

export function startSummaries(o: SummariesStartOptions): SummaryService | null {
  if (process.env.SUMMARIES_TEST === '1') {
    console.log('Book summaries: off while the accuracy test runs (SUMMARIES_TEST=1)');
    return null;
  }
  try {
    const db = openSummariesDb(summariesDbPath(o.dbDir));
    const runner = new AiRunner({
      db,
      core: o.core,
      source: 'summaries',
      featureOf: () => 'summaries',
      modelFor: modelForTask,
      log: (m) => console.log(`Summaries: ${m}`),
    });
    const read = o.readScript ?? readBookScript;
    const svc = new SummaryService({
      db,
      main: o.db,
      core: o.core,
      runner,
      notifications: o.notifications ?? null,
      log: (m) => console.log(m),
      readScript: async (bookId): Promise<BookScript> => {
        const file = bookEpub(o.db, o, bookId);
        if (!file) throw new Error("the book's EPUB is not available on the server");
        const script = await read(file, {
          importOptions: o.importOptions,
          maxSentence: o.maxSentence,
          timeoutMs: o.scriptTimeoutSeconds * 1000,
        });
        if (!script.chapters.length || script.characters === 0)
          throw new NoTextError('This book has no text');
        return script;
      },
    });
    svc.start();
    console.log('Book summaries: on (summaries.db)');
    return svc;
  } catch (err) {
    console.error('Error: book summaries are off:', err);
    return null;
  }
}
