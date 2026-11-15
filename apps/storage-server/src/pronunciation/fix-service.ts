/**
 * Season 2 Phase 12: the per-book and global pronunciation fix lists (ttsu.db
 * `pronunciation_fixes`, migration 20), and applying them to a book's sentences through the
 * time-limited worker (fix-runner.ts). Jobs apply the lists when they are queued, so a job
 * keeps the fixes it started with; editing the lists changes only audio made afterwards.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import {
  checkEntry,
  FIX_LIMITS,
  FixRuleError,
  type FixEntry,
  type FixSentence,
  type SentenceResult,
} from './fix-rules';
import { type FixRunner, FixTimeoutError } from './fix-runner';

export class FixRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  id: number;
  user_id: string;
  book_id: string | null;
  kind: 'word' | 'pattern';
  match: string;
  reading: string;
  created_at: number;
  updated_at: number;
}

export interface FixView extends FixEntry {
  updatedAt: number;
}

/** What a job records about the fixes it used (`params.fixes`). */
export interface FixSummary {
  /** Entries of the book's list and of the global list that matched at least once. */
  book: number;
  global: number;
  /** Places read differently. */
  places: number;
  /** sha256 of the entries that matched (list, kind, match, reading); '' = none. */
  digest: string;
}

export const NO_FIXES: FixSummary = { book: 0, global: 0, places: 0, digest: '' };

export interface FixCheck {
  id: number;
  places: number;
  /** Places skipped because the book's own furigana reads them. */
  skipped: number;
  /** Up to 3 sentences where it matched, with the reading the PC is given. */
  examples: { text: string; reading: string }[];
}

const toView = (r: Row): FixView => ({
  id: r.id,
  bookId: r.book_id,
  kind: r.kind,
  match: r.match,
  reading: r.reading,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const EXAMPLES = 3;

export class FixService {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    private readonly runner: FixRunner,
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  get timeoutSeconds(): number {
    return this.runner.timeoutSeconds;
  }

  /** One list: the book's (bookId) or the global one (null), in the order it is applied. */
  list(userId: string, bookId: string | null): FixView[] {
    const rows = (
      bookId === null
        ? this.db
            .prepare(
              `SELECT * FROM pronunciation_fixes WHERE user_id = ? AND book_id IS NULL
                 ORDER BY created_at, id`,
            )
            .all(userId)
        : this.db
            .prepare(
              `SELECT * FROM pronunciation_fixes WHERE user_id = ? AND book_id = ?
                 ORDER BY created_at, id`,
            )
            .all(userId, bookId)
    ) as Row[];
    return rows.map(toView);
  }

  /** Both lists that apply to a book (the global one only when bookId is null). */
  entriesFor(userId: string, bookId: string | null): FixView[] {
    return [...(bookId ? this.list(userId, bookId) : []), ...this.list(userId, null)];
  }

  get(userId: string, id: number): FixView | null {
    const row = this.db
      .prepare('SELECT * FROM pronunciation_fixes WHERE id = ? AND user_id = ?')
      .get(id, userId) as Row | undefined;
    return row ? toView(row) : null;
  }

  /** Checks an entry (throws FixRequestError 400 with a plain message). */
  check(input: { kind: unknown; match: unknown; reading: unknown }) {
    try {
      return checkEntry(input);
    } catch (err) {
      if (err instanceof FixRuleError) throw new FixRequestError(400, err.code, err.message);
      throw err;
    }
  }

  private duplicate(
    userId: string,
    bookId: string | null,
    kind: string,
    match: string,
    except: number | null,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM pronunciation_fixes WHERE user_id = ? AND book_id IS ? AND kind = ?
           AND match = ? AND id IS NOT ?`,
      )
      .get(userId, bookId, kind, match, except) as { id: number } | undefined;
    return Boolean(row);
  }

  private duplicateError(kind: string): FixRequestError {
    return new FixRequestError(
      409,
      'duplicate',
      kind === 'word' ? 'This word is in the list already' : 'This pattern is in the list already',
    );
  }

  add(
    userId: string,
    bookId: string | null,
    input: { kind: unknown; match: unknown; reading: unknown },
  ): FixView {
    const entry = this.check(input);
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM pronunciation_fixes WHERE user_id = ? AND book_id IS ?')
        .get(userId, bookId) as { n: number }
    ).n;
    if (count >= FIX_LIMITS.entriesPerList) {
      throw new FixRequestError(
        409,
        'too_many',
        `A list can have at most ${FIX_LIMITS.entriesPerList} fixes`,
      );
    }
    if (this.duplicate(userId, bookId, entry.kind, entry.match, null))
      throw this.duplicateError(entry.kind);
    const now = this.now();
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO pronunciation_fixes (user_id, book_id, kind, match, reading, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, bookId, entry.kind, entry.match, entry.reading, now, now).lastInsertRowid,
    );
    return this.get(userId, id)!;
  }

  update(
    userId: string,
    id: number,
    input: { kind?: unknown; match?: unknown; reading?: unknown },
  ): FixView {
    const old = this.get(userId, id);
    if (!old) throw new FixRequestError(404, 'not_found', 'No such fix');
    const entry = this.check({
      kind: input.kind ?? old.kind,
      match: input.match ?? old.match,
      reading: input.reading ?? old.reading,
    });
    if (this.duplicate(userId, old.bookId, entry.kind, entry.match, id))
      throw this.duplicateError(entry.kind);
    this.db
      .prepare(
        `UPDATE pronunciation_fixes SET kind = ?, match = ?, reading = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
      )
      .run(entry.kind, entry.match, entry.reading, this.now(), id, userId);
    return this.get(userId, id)!;
  }

  remove(userId: string, id: number): void {
    const res = this.db
      .prepare('DELETE FROM pronunciation_fixes WHERE id = ? AND user_id = ?')
      .run(id, userId);
    if (!res.changes) throw new FixRequestError(404, 'not_found', 'No such fix');
  }

  /**
   * Applies entries to sentences in the worker. A run past the time limit is refused with
   * 422 `fix_timeout` naming the entry that was running.
   */
  async run(entries: FixEntry[], sentences: FixSentence[]): Promise<SentenceResult[]> {
    try {
      return await this.runner.apply(entries, sentences);
    } catch (err) {
      if (err instanceof FixTimeoutError) {
        const entry = entries.find((e) => e.id === err.entryId);
        const what = entry
          ? `The pronunciation fix ${entry.kind === 'pattern' ? 'pattern' : 'word'} "${entry.match}"`
          : 'The pronunciation fixes';
        throw new FixRequestError(
          422,
          'fix_timeout',
          `${what} took longer than ${err.seconds} s on this book; change or remove it`,
        );
      }
      throw err;
    }
  }

  /** Per entry: places, furigana skips and examples, for the text check. */
  static checks(
    entries: FixEntry[],
    sentences: FixSentence[],
    results: SentenceResult[],
  ): FixCheck[] {
    const by = new Map<number, FixCheck>(
      entries.map((e) => [e.id, { id: e.id, places: 0, skipped: 0, examples: [] }]),
    );
    results.forEach((r, i) => {
      const seen = new Set<number>();
      for (const h of r.hits) {
        const c = by.get(h.entryId);
        if (!c) continue;
        c.places += 1;
        if (!seen.has(h.entryId) && c.examples.length < EXAMPLES) {
          c.examples.push({ text: sentences[i].text, reading: r.reading ?? sentences[i].reading });
        }
        seen.add(h.entryId);
      }
      for (const id of r.skipped) {
        const c = by.get(id);
        if (c) c.skipped += 1;
      }
    });
    return entries.map((e) => by.get(e.id)!);
  }

  /** What a job records: the entries that matched, and their digest. */
  static summary(entries: FixEntry[], results: SentenceResult[]): FixSummary {
    const used = new Set<number>();
    let places = 0;
    for (const r of results) {
      for (const h of r.hits) {
        used.add(h.entryId);
        places += 1;
      }
    }
    const matched = entries.filter((e) => used.has(e.id));
    if (!matched.length) return { ...NO_FIXES };
    const key = matched
      .map((e) => [e.bookId === null ? 'global' : 'book', e.kind, e.match, e.reading])
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    return {
      book: matched.filter((e) => e.bookId !== null).length,
      global: matched.filter((e) => e.bookId === null).length,
      places,
      digest: createHash('sha256').update(JSON.stringify(key)).digest('hex'),
    };
  }

  close(): Promise<void> {
    return this.runner.close();
  }
}
