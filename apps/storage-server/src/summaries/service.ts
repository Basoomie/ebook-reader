/**
 * Book summaries on the server (book summaries session 3; book-summaries.md "When a summary is
 * made", "Summaries on the server"): the jobs that make and translate summaries with session 2's
 * engine through the shared AI layer, the first-completion trigger, the user's actions (replace,
 * write my own, edit, delete, versions, restore), and the record that tells every device about a
 * book's current summary (kind "book-summary"; the summary itself is fetched over REST and kept
 * on the device for offline use: a summary is larger than a sync record may be).
 *
 * - Automatic only on a book's first completion, and only when it has no summary; a reread never
 *   makes one again and a later completion never retries a failed one (summary_books).
 * - The route of setups (settings.ts) is tried in order: a refusal or an unusable answer, or a
 *   wait other than the spending limit lasting `fallbackAfterMinutes`, moves to the next setup.
 *   When every setup failed: no summary, a note on the book and one alert.
 * - A series' volumes are made in order (a volume's background is the earlier volumes'
 *   summaries, without their chapter-by-chapter section).
 * - Every question is stored and never asked twice: a restart resumes a job from its answers.
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import type { AiCore } from '../ai/core';
import type { AiRunner } from '../ai/runner';
import type { AiStageSpec } from '../ai/types';
import { waitText, type AiWait } from '../ai/waits';
import type { BookScript } from '../audio/book-script';
import { LINKS } from '../notifications/messages';
import type { SyncChange, SyncStore } from '../sync/store';
import {
  ask,
  askedMetrics,
  backgroundText,
  Refused,
  runSetup,
  Unusable,
  type Asked,
  type BookInput,
  type EngineDeps,
} from './engine';
import {
  readSummarySettings,
  setupLabel,
  updateSummarySettings,
  modelsInUse,
  type RouteSetup,
  type SummarySettings,
} from './settings';
import {
  EXTRACT_CHAPTER_SPEC,
  EXTRACT_SPEC,
  LABEL_SPEC,
  MATCH_SPEC,
  modelOfRole,
  SUPPORT_CHAPTER_SPEC,
  SUPPORT_SPEC,
  TRANSLATE_SPEC,
  WRITE_SPEC,
  type ModelRole,
} from './specs';
import {
  EditError,
  itemDigest,
  SummaryStore,
  userSummary,
  type ItemInput,
  type SectionKey,
  type StoredSummary,
} from './store';
import { SUMMARY_FAILED_EVENT } from './summary-event';
import type { Summary } from './types';

/** The steps a summary's jobs ask (the test's claims and groups are not part of it). */
export const JOB_SPECS = [
  EXTRACT_SPEC,
  LABEL_SPEC,
  EXTRACT_CHAPTER_SPEC,
  MATCH_SPEC,
  SUPPORT_SPEC,
  SUPPORT_CHAPTER_SPEC,
  WRITE_SPEC,
  TRANSLATE_SPEC,
  LABEL_SPEC,
] as AiStageSpec<unknown, ModelRole>[];

/**
 * `cli summaries label --apply` sets this in summary_state; the running server then labels the
 * relationships of the current summaries written before labels existed (session 4), once.
 */
export const LABELS_REQUESTED = 'labels_requested';

/** The relationships a summary still needs labels for, and a rough cost (dry run). */
export function labelPlan(
  store: SummaryStore,
  price: { inputPerMTok: number; outputPerMTok: number } | null,
): {
  summaries: { summaryId: number; bookId: string; title: string; items: number }[];
  usd: number | null;
} {
  let input = 0;
  let output = 0;
  const out: { summaryId: number; bookId: string; title: string; items: number }[] = [];
  for (const u of store.unlabelled()) {
    const items = store
      .items(u.summaryId)
      .filter((i) => i.section === 'relationships' && !i.label && i.between);
    if (!items.length) continue;
    const m = store.metaById(u.summaryId);
    out.push({ ...u, title: m?.bookTitle ?? u.bookId, items: items.length });
    // The framework's estimate: 1.2 tokens per character, plus the instructions; ~20 out each.
    input += 400 + items.reduce((n, i) => n + (i.text.length + 40) * 1.2, 0);
    output += 20 * items.length;
  }
  return {
    summaries: out,
    usd: price ? (input * price.inputPerMTok + output * price.outputPerMTok) / 1e6 : null,
  };
}

export const BOOK_SUMMARY_KIND = 'book-summary';
export const SUMMARY_SKIP_KIND = 'summary-skip';
/** The pseudo-device that writes the "book-summary" records (user_seeds). */
export const SUMMARIES_DEVICE_SEED = 'summaries-device';

/** The book has no text to summarize (an image-only book). */
export class NoTextError extends Error {}

export interface SummaryNotifier {
  observe(
    key: string,
    event: string,
    o: { waitMs: number; summary: string; detail?: string },
  ): boolean;
  notify(m: { event: string; lines: string[]; link: string | null }): void;
  clear(key: string): void;
  poke(): void;
}

export interface SummaryServiceDeps {
  /** summaries.db. */
  db: Database.Database;
  /** ttsu.db (books, sync records, users). */
  main: Database.Database;
  core: AiCore;
  runner: AiRunner;
  /** The book's text as the reader counts it (throws NoTextError for a book without text). */
  readScript(bookId: string): Promise<BookScript>;
  notifications?: SummaryNotifier | null;
  now?: () => number;
  log?: (m: string) => void;
  /** Pump interval (ms). */
  intervalMs?: number;
}

type JobKind = 'auto' | 'regenerate' | 'translate';
type JobState = 'queued' | 'running' | 'done' | 'failed' | 'no_text' | 'cancelled';

interface JobRow {
  id: number;
  book_id: string;
  kind: JobKind;
  lang: string | null;
  summary_id: number | null;
  state: JobState;
  route_json: string | null;
  step: number;
  attempts_json: string;
  generation: number;
  wait_text: string | null;
  error: string | null;
  cost_usd: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

/** A running job's step, as the book page shows it (session 4). */
export type JobPhase = 'reading' | 'checking' | 'writing' | 'translating';
const PHASE_ORDER: JobPhase[] = ['reading', 'checking', 'writing', 'translating'];

/** The step a question's stage belongs to (null: not one of the job's steps). */
export function phaseOfStage(stage: string): JobPhase | null {
  if (stage === 'sum.extract' || stage === 'sum.extract-chapter') return 'reading';
  if (stage === 'sum.match' || stage === 'sum.support' || stage === 'sum.support-chapter')
    return 'checking';
  if (stage === 'sum.write') return 'writing';
  if (stage === 'sum.translate') return 'translating';
  return null;
}

export interface JobView {
  id: number;
  bookId: string;
  kind: JobKind;
  lang: string | null;
  state: JobState;
  /** The setup being tried (making a summary). */
  setup: string | null;
  /** A running job's step. */
  phase: JobPhase | null;
  attempts: { setup: string; reason: string; at: number }[];
  waiting: string | null;
  /** Waiting for an earlier volume of its series. */
  afterVolume: boolean;
  error: string | null;
  costUsd: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

interface BookRow {
  id: string;
  title: string;
  series_id: number | null;
  series_index: number | null;
  char_count: number | null;
  language: string | null;
  languages: string | null;
}

/** One running set of questions (a job's setup, or a translation). */
class RunHandle {
  stopped = false;
  abandoned = false;
  waitSince: number | null = null;
  wait: AiWait | null = null;
  private wakers: (() => void)[] = [];
  constructor(readonly runId: string) {}
  get isStopped(): boolean {
    return this.stopped;
  }
  tick(): Promise<void> {
    return new Promise((r) => this.wakers.push(r));
  }
  wake(): void {
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }
}

/** Waits that never count toward trying the next setup: the spending limit only queues. */
function countsAsFailing(w: AiWait | null): boolean {
  return !!w && !['limit_reached', 'no_limit', 'batch_queue_full'].includes(w.kind);
}

const ISO_LANG: Record<string, string> = { jpn: 'ja', eng: 'en', ja: 'ja', en: 'en' };

function digest(v: unknown): string {
  return createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

export class SummaryService {
  readonly store: SummaryStore;
  private readonly db: Database.Database;
  private readonly main: Database.Database;
  private readonly now: () => number;
  private sync: SyncStore | null = null;
  private readonly runs = new Map<string, RunHandle>();
  private readonly active = new Map<number, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private pumping = false;
  private readonly asked = new Map<number, Asked[]>();
  /** Each running job's step (session 4's progress): from the stage of its last question. */
  private readonly phases = new Map<number, JobPhase>();
  /** The jobs a pass found waiting for an earlier volume. */
  private afterVolume = new Set<number>();

  constructor(private readonly deps: SummaryServiceDeps) {
    this.db = deps.db;
    this.main = deps.main;
    this.now = deps.now ?? Date.now;
    this.store = new SummaryStore(deps.db, this.now);
  }

  settings(): SummarySettings {
    return readSummarySettings(this.db);
  }

  updateSettings(changes: unknown): SummarySettings {
    const known = new Set(this.deps.core.settings().models);
    return updateSummarySettings(this.db, changes, (m) => known.has(m), this.now());
  }

  /** Starts the jobs (and the one-time baseline of books completed before summaries existed). */
  start(): void {
    this.deps.core.registerFeature('summaries', 'Book summaries');
    this.deps.core.registerModelUse((model) => {
      const s = this.settings();
      const out: string[] = [];
      s.route.forEach((r, i) => {
        if (r.finders.includes(model) || r.writer === model)
          out.push(`Book summaries, setup ${i + 1}`);
      });
      if (s.translator === model) out.push('Book summaries, translations');
      return out;
    });
    this.baseline();
    // A restart: jobs that were running go on from their stored answers.
    this.db.prepare(`UPDATE summary_jobs SET state = 'queued' WHERE state = 'running'`).run();
    this.timer = setInterval(() => void this.pass(), this.deps.intervalMs ?? 2000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const h of this.runs.values()) {
      h.stopped = true;
      h.wake();
    }
    await Promise.allSettled([...this.active.values()]);
  }

  /** The sync store the "book-summary" records are written through (built by the API router). */
  attachSync(sync: SyncStore): void {
    this.sync = sync;
    this.publishStale();
  }

  private lastSweep = 0;

  /**
   * Every book with a summary or a note gets its record as it is now (written only when it
   * changed): summaries stored outside the server (the one-time import's CLI) reach the devices.
   */
  publishStale(): void {
    this.lastSweep = this.now();
    if (!this.sync) return;
    try {
      const ids = this.db
        .prepare(
          `SELECT book_id FROM summaries UNION SELECT book_id FROM summary_books WHERE outcome IS NOT NULL`,
        )
        .all() as { book_id: string }[];
      for (const { book_id } of ids) this.publish(book_id);
    } catch (err) {
      this.deps.log?.(`Summaries: the records: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // the books

  private book(bookId: string): BookRow | null {
    return (
      (this.main
        .prepare(
          `SELECT b.id, b.title, b.series_id, b.series_index, b.char_count, l.language, b.languages
           FROM books b LEFT JOIN libraries l ON l.id = b.library_id WHERE b.id = ?`,
        )
        .get(bookId) as BookRow | undefined) ?? null
    );
  }

  /** The book's language: its library's, else Calibre's first, else Japanese. */
  bookLang(b: BookRow): string {
    if (b.language) return b.language;
    try {
      const first = (JSON.parse(b.languages ?? '[]') as string[])[0];
      if (first && ISO_LANG[first]) return ISO_LANG[first];
    } catch {
      /* not a list */
    }
    return 'ja';
  }

  private users(): string[] {
    return (
      this.main.prepare('SELECT id FROM users ORDER BY created_at').all() as { id: string }[]
    ).map((r) => r.id);
  }

  /** The earlier volumes' current summaries as background (without their chapters). */
  private backgroundFor(b: BookRow, lang: string): string | null {
    if (b.series_id === null || b.series_index === null) return null;
    const earlier = this.main
      .prepare(
        `SELECT id, title FROM books WHERE series_id = ? AND series_index < ? AND id <> ?
         ORDER BY series_index, title`,
      )
      .all(b.series_id, b.series_index, b.id) as { id: string; title: string }[];
    const vols: { title: string; summary: Summary }[] = [];
    for (const e of earlier) {
      const m = this.store.currentMeta(e.id);
      if (!m || m.lang !== lang) continue;
      const s = this.store.asSummary(m.id);
      if (s) vols.push({ title: e.title, summary: s });
    }
    return backgroundText(vols);
  }

  /** An earlier volume of the same series with a summary job still open. */
  private earlierVolumeOpen(job: JobRow): boolean {
    const b = this.book(job.book_id);
    if (!b || b.series_id === null || b.series_index === null) return false;
    const open = this.db
      .prepare(
        `SELECT book_id FROM summary_jobs WHERE state IN ('queued', 'running')
           AND kind IN ('auto', 'regenerate') AND id <> ?`,
      )
      .all(job.id) as { book_id: string }[];
    if (!open.length) return false;
    const same = this.main.prepare(
      'SELECT 1 FROM books WHERE id = ? AND series_id = ? AND series_index < ?',
    );
    return open.some((o) => !!same.get(o.book_id, b.series_id, b.series_index));
  }

  // ------------------------------------------------------------------------------------------
  // the first completion

  /**
   * Once: every book already completed (a finished read-through or the Completed status) gets
   * the marker "baseline", so only completions from now on make a summary automatically.
   */
  private baseline(): void {
    const done = this.db.prepare(`SELECT 1 FROM summary_state WHERE key = 'baseline'`).get();
    if (done) return;
    const books = this.main
      .prepare(
        `SELECT DISTINCT book_id FROM sync_records
         WHERE book_id IS NOT NULL AND deleted_at IS NULL AND (
           (kind = 'read-through' AND json_extract(data, '$.finished') = 1) OR
           (kind = 'book-status' AND json_extract(data, '$.status') = 'completed'))`,
      )
      .all() as { book_id: string }[];
    const now = this.now();
    this.db.transaction(() => {
      const ins = this.db.prepare(
        `INSERT INTO summary_books (book_id, first_completion, completed_at) VALUES (?, 'baseline', ?)
         ON CONFLICT(book_id) DO UPDATE SET first_completion = COALESCE(first_completion, 'baseline')`,
      );
      for (const b of books) ins.run(b.book_id, now);
      this.db
        .prepare(`INSERT INTO summary_state (key, value) VALUES ('baseline', ?)`)
        .run(String(now));
    })();
    this.deps.log?.(
      `Summaries: ${books.length} books completed before summaries existed (no automatic summary)`,
    );
  }

  private completedNow(userId: string, bookId: string): boolean {
    return !!this.main
      .prepare(
        `SELECT 1 FROM sync_records WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL AND (
           (kind = 'read-through' AND json_extract(data, '$.finished') = 1) OR
           (kind = 'book-status' AND json_extract(data, '$.status') = 'completed')) LIMIT 1`,
      )
      .get(userId, bookId);
  }

  /**
   * After a device's push (sync/routes.ts): a book completed for the first time gets its
   * automatic summary, unless the bulk "Mark completed" was told not to (a "summary-skip"
   * record), it has a summary already, or it has no text.
   */
  onSyncApplied(userId: string, changes: { kind: string; id: string }[]): void {
    const books = new Set<string>();
    for (const c of changes) {
      if (c.kind === 'book-status') books.add(c.id);
      else if (c.kind === 'read-through') books.add(c.id.split(':')[0]);
    }
    for (const bookId of books) {
      try {
        this.firstCompletion(userId, bookId);
      } catch (err) {
        this.deps.log?.(`Summaries: the completion of ${bookId}: ${(err as Error).message}`);
      }
    }
  }

  private firstCompletion(userId: string, bookId: string): void {
    const marker = this.db
      .prepare('SELECT first_completion FROM summary_books WHERE book_id = ?')
      .get(bookId) as { first_completion: string | null } | undefined;
    if (marker?.first_completion) return;
    if (!this.completedNow(userId, bookId)) return;
    const skip = this.main
      .prepare(
        `SELECT 1 FROM sync_records WHERE user_id = ? AND kind = ? AND id = ? AND deleted_at IS NULL`,
      )
      .get(userId, SUMMARY_SKIP_KIND, bookId);
    const b = this.book(bookId);
    const has = this.store.currentMeta(bookId);
    const noText = b?.char_count === 0;
    const what = skip ? 'skipped' : has ? 'had_summary' : noText ? 'no_text' : 'auto';
    this.db
      .prepare(
        `INSERT INTO summary_books (book_id, first_completion, completed_at) VALUES (?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET first_completion = excluded.first_completion,
           completed_at = excluded.completed_at`,
      )
      .run(bookId, what, this.now());
    if (what === 'no_text') {
      this.setOutcome(bookId, 'no_text', 'No text to summarize');
      this.publish(bookId);
    }
    if (what === 'auto') this.enqueue(bookId, 'auto');
  }

  // ------------------------------------------------------------------------------------------
  // jobs

  private enqueue(bookId: string, kind: 'auto' | 'regenerate'): number {
    const open = this.db
      .prepare(
        `SELECT id FROM summary_jobs WHERE book_id = ? AND kind IN ('auto', 'regenerate')
           AND state IN ('queued', 'running')`,
      )
      .get(bookId) as { id: number } | undefined;
    if (open) return open.id;
    const s = this.settings();
    let generation = 0;
    if (kind === 'regenerate') {
      // A new generation: the stored answers of earlier ones would make the same summary again.
      this.db
        .prepare(
          `INSERT INTO summary_books (book_id, generation) VALUES (?, 1)
           ON CONFLICT(book_id) DO UPDATE SET generation = generation + 1`,
        )
        .run(bookId);
    }
    generation =
      (
        this.db.prepare('SELECT generation FROM summary_books WHERE book_id = ?').get(bookId) as
          | { generation: number }
          | undefined
      )?.generation ?? 0;
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO summary_jobs (book_id, kind, state, route_json, generation, created_at)
           VALUES (?, ?, 'queued', ?, ?, ?)`,
        )
        .run(bookId, kind, JSON.stringify(s.route), generation, this.now()).lastInsertRowid,
    );
    this.publish(bookId);
    return id;
  }

  private enqueueTranslate(bookId: string, summaryId: number, lang: string): void {
    const open = this.db
      .prepare(
        `SELECT 1 FROM summary_jobs WHERE kind = 'translate' AND summary_id = ? AND lang = ? AND state = 'queued'`,
      )
      .get(summaryId, lang);
    if (open) return;
    this.db
      .prepare(
        `INSERT INTO summary_jobs (book_id, kind, lang, summary_id, state, created_at)
         VALUES (?, 'translate', ?, ?, 'queued', ?)`,
      )
      .run(bookId, lang, summaryId, this.now());
  }

  /** Saved languages of a book's current summary that need items translated. */
  private translateSaved(bookId: string): void {
    const m = this.store.currentMeta(bookId);
    if (!m) return;
    for (const lang of this.store.languages(bookId, m.lang))
      if (lang !== m.lang) this.enqueueTranslate(bookId, m.id, lang);
  }

  private job(id: number): JobRow | null {
    return (this.db.prepare('SELECT * FROM summary_jobs WHERE id = ?').get(id) as JobRow) ?? null;
  }

  private setJob(id: number, fields: Partial<Omit<JobRow, 'id'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE summary_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), id);
  }

  private setOutcome(
    bookId: string,
    outcome: 'made' | 'failed' | 'no_text' | null,
    note: string | null,
  ) {
    this.db
      .prepare(
        `INSERT INTO summary_books (book_id, outcome, note, note_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET outcome = excluded.outcome, note = excluded.note,
           note_at = excluded.note_at`,
      )
      .run(bookId, outcome, note, note ? this.now() : null);
  }

  /** One pass: start what may start, step every open run's questions. */
  async pass(): Promise<void> {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      if (this.now() - this.lastSweep >= 10 * 60_000) this.publishStale();
      this.startJobs();
      this.startLabels();
      await this.pump();
    } catch (err) {
      this.deps.log?.(`Summaries: ${(err as Error).message}`);
    } finally {
      this.pumping = false;
    }
  }

  private startJobs(): void {
    const s = this.settings();
    const queued = this.db
      .prepare(`SELECT * FROM summary_jobs WHERE state = 'queued' ORDER BY id`)
      .all() as JobRow[];
    let making = [...this.active.keys()].filter((id) => this.job(id)?.kind !== 'translate').length;
    const after = new Set<number>();
    for (const j of queued) {
      if (this.active.has(j.id)) continue;
      if (j.kind === 'translate') {
        this.launch(j);
        continue;
      }
      if (making >= s.parallelBooks) continue;
      if (this.earlierVolumeOpen(j)) {
        after.add(j.id);
        continue;
      }
      making++;
      this.launch(j);
    }
    this.afterVolume = after;
  }

  private labelling: Promise<void> | null = null;

  /** Starts the one-time labelling when `cli summaries label --apply` asked for it. */
  private startLabels(): void {
    if (this.labelling) return;
    const req = this.db
      .prepare('SELECT value FROM summary_state WHERE key = ?')
      .get(LABELS_REQUESTED) as { value: string } | undefined;
    if (!req) return;
    this.labelling = this.runLabels()
      .catch((err) => this.deps.log?.(`Summaries: labels: ${(err as Error).message}`))
      .finally(() => {
        this.labelling = null;
      });
  }

  /**
   * Labels every current summary's relationships that have none: one small question per summary
   * (the translator's model), stored as the summary's own (not the user's); then the saved
   * languages translate those items again and the devices get the change.
   */
  private async runLabels(): Promise<void> {
    const s = this.settings();
    let done = 0;
    let failed = 0;
    for (const u of this.store.unlabelled()) {
      if (this.stopping) return;
      const items = this.store
        .items(u.summaryId)
        .filter((i) => i.section === 'relationships' && !i.label && i.between);
      const m = this.store.metaById(u.summaryId);
      if (!items.length || !m) continue;
      const runId = `sumlabel:${u.summaryId}`;
      this.deps.runner.askAgain(LABEL_SPEC.stage, runId);
      const h = this.openRun(runId);
      try {
        const key = `labels:${u.summaryId}|${digest(items.map((i) => itemDigest(i)))}`;
        const a = await ask(
          { runner: this.deps.runner, pump: h, runId },
          LABEL_SPEC,
          s.translator,
          key,
          {
            title: m.bookTitle,
            lang: m.lang,
            items: items.map((i) => ({ ref: i.ref, between: i.between!, text: i.text })),
          },
        );
        if (a.state !== 'answered' || !a.answer)
          throw new Unusable(LABEL_SPEC.stage, a.model, a.state);
        const got = (a.answer as { items: { ref: string; label: string }[] }).items;
        const n = this.store.setLabels(u.summaryId, new Map(got.map((x) => [x.ref, x.label])));
        if (n) {
          done++;
          this.translateSaved(u.bookId);
          this.publish(u.bookId);
        }
      } catch (err) {
        if (this.stopping && !h.abandoned) return;
        failed++;
        this.deps.log?.(`Summaries: labels of ${u.bookId}: ${(err as Error).message}`);
        if (h.abandoned) this.deps.runner.withdraw(runId);
      } finally {
        this.closeRun(h);
      }
    }
    this.db.prepare('DELETE FROM summary_state WHERE key = ?').run(LABELS_REQUESTED);
    this.deps.log?.(`Summaries: labels: ${done} summaries labelled, ${failed} failed`);
  }

  private launch(j: JobRow): void {
    this.setJob(j.id, { state: 'running', started_at: j.started_at ?? this.now() });
    if (j.kind !== 'translate') this.publish(j.book_id);
    const p = (j.kind === 'translate' ? this.runTranslate(j) : this.runMake(j))
      .catch((err) => {
        this.deps.log?.(`Summaries: job ${j.id}: ${(err as Error).message}`);
        if (!this.stopping)
          this.setJob(j.id, {
            state: 'failed',
            error: String((err as Error).message).slice(0, 500),
            ended_at: this.now(),
          });
      })
      .finally(() => this.active.delete(j.id));
    this.active.set(j.id, p);
  }

  /** Steps every open run's questions; a run that can't send for too long is abandoned. */
  private async pump(): Promise<void> {
    const s = this.settings();
    const limitMs = s.fallbackAfterMinutes * 60_000;
    const handles = [...this.runs.values()].filter((h) => !h.stopped);
    const waits = new Map<RunHandle, { wait: AiWait | null; sent: number }>();
    for (const spec of JOB_SPECS) {
      for (const h of handles) {
        if (h.stopped || this.stopping) continue;
        if (this.deps.runner.pending(spec.stage, h.runId) === 0) continue;
        const r = await this.deps.runner.step(spec, h.runId, () => h.stopped || this.stopping);
        const w = waits.get(h) ?? { wait: null, sent: 0 };
        w.wait ??= r.wait;
        w.sent += r.sent;
        waits.set(h, w);
      }
    }
    const now = this.now();
    for (const h of handles) {
      const w = waits.get(h);
      h.wait = w?.wait ?? null;
      if (!w || w.sent > 0 || !countsAsFailing(w.wait)) h.waitSince = null;
      else {
        h.waitSince ??= now;
        if (now - h.waitSince >= limitMs) {
          h.abandoned = true;
          h.stopped = true;
        }
      }
      h.wake();
    }
  }

  private openRun(runId: string): RunHandle {
    const h = new RunHandle(runId);
    this.runs.set(runId, h);
    return h;
  }

  private closeRun(h: RunHandle): void {
    h.stopped = true;
    h.wake();
    this.runs.delete(h.runId);
  }

  private engineDeps(j: JobRow, h: RunHandle): EngineDeps {
    const list = this.asked.get(j.id) ?? [];
    this.asked.set(j.id, list);
    return {
      runner: this.deps.runner,
      pump: h,
      runId: h.runId,
      onAsk: (a) => {
        list.push(a);
        const phase = phaseOfStage(a.stage);
        const was = this.phases.get(j.id);
        // Only forward: a late follow-up of the reading step (an empty chapter asked again
        // while items are checked) doesn't take the bar back. A new setup (the route's next)
        // starts again from its own first question (runMake clears the step).
        if (phase && (!was || PHASE_ORDER.indexOf(phase) > PHASE_ORDER.indexOf(was))) {
          this.phases.set(j.id, phase);
          // The devices' record shows the step (only making jobs are in it).
          if (j.kind !== 'translate') this.publish(j.book_id);
        }
      },
    };
  }

  /** Makes a summary along the route (an automatic or a Regenerate job). */
  private async runMake(j: JobRow): Promise<void> {
    const b = this.book(j.book_id);
    if (!b) {
      this.finishFailed(j, [], 'The book is no longer in the library');
      return;
    }
    const lang = this.bookLang(b);
    let script: BookScript;
    try {
      script = await this.deps.readScript(b.id);
    } catch (err) {
      if (err instanceof NoTextError) return this.finishNoText(j);
      this.finishFailed(j, [], `The book could not be read: ${(err as Error).message}`);
      return;
    }
    if (!script.chapters.length || script.characters === 0) return this.finishNoText(j);
    const background = this.backgroundFor(b, lang);
    const input: BookInput = {
      key: `book:${b.id}|g${j.generation}`,
      title: b.title,
      script,
      lang,
      background,
    };
    const route = JSON.parse(j.route_json ?? '[]') as RouteSetup[];
    const attempts = JSON.parse(j.attempts_json) as JobView['attempts'];
    for (let step = j.step; step < route.length; step++) {
      this.phases.delete(j.id);
      if (this.stopping) return;
      const r = route[step];
      const label = setupLabel(r);
      this.setJob(j.id, { step });
      const runId = `sum:${j.id}:${step}`;
      // Questions given up after their tries in an earlier process are asked again.
      for (const spec of JOB_SPECS) this.deps.runner.askAgain(spec.stage, runId);
      const h = this.openRun(runId);
      try {
        const res = await runSetup(
          this.engineDeps(j, h),
          input,
          {
            extract: r.finders,
            writer: r.writer,
            matcher: r.finders.length === 2 ? r.finders[0] : null,
          },
          label,
          this.now,
        );
        this.finishMade(j, b, res.summary, label, background !== null, attempts);
        return;
      } catch (err) {
        if (this.stopping && !h.abandoned) return;
        const reason = h.abandoned
          ? `nothing could be sent for ${this.settings().fallbackAfterMinutes} min: ${h.wait ? waitText(h.wait) : 'waiting'}`
          : err instanceof Refused
            ? `${err.model} refused (${err.stage})`
            : err instanceof Unusable
              ? err.message
              : `error: ${(err as Error).message}`;
        if (h.abandoned) this.deps.runner.withdraw(runId);
        attempts.push({ setup: label, reason: reason.slice(0, 400), at: this.now() });
        this.setJob(j.id, { attempts_json: JSON.stringify(attempts) });
        this.deps.log?.(`Summaries: ${b.title}: setup ${label} failed: ${reason}`);
      } finally {
        this.closeRun(h);
      }
    }
    this.finishFailed(j, attempts, null);
  }

  private cost(jobId: number): number {
    return askedMetrics(this.db, this.asked.get(jobId) ?? []).costUsd;
  }

  private finishMade(
    j: JobRow,
    b: BookRow,
    summary: Summary,
    label: string,
    background: boolean,
    attempts: JobView['attempts'],
  ): void {
    const cost = this.cost(j.id);
    const current = this.store.currentMeta(b.id);
    // An automatic run never replaces a summary the user wrote or edited in the meantime (it is
    // kept as an earlier version); Regenerate is the user's own choice.
    const keepTheirs =
      j.kind === 'auto' && !!current && (current.origin === 'user' || current.editedAt !== null);
    const id = this.store.save(b.id, summary, {
      origin: 'ai',
      setup: label,
      background,
      current: !keepTheirs,
      jobId: j.id,
      report: { costUsd: cost, attempts, characters: b.char_count },
    });
    this.setJob(j.id, { state: 'done', ended_at: this.now(), cost_usd: cost, wait_text: null });
    this.setOutcome(b.id, 'made', null);
    this.deps.notifications?.clear(`${SUMMARY_FAILED_EVENT}:${b.id}`);
    this.asked.delete(j.id);
    this.phases.delete(j.id);
    if (!keepTheirs) this.translateSaved(b.id);
    this.publish(b.id);
    this.deps.log?.(`Summaries: ${b.title}: made by ${label} (summary ${id}, $${cost.toFixed(2)})`);
  }

  private finishNoText(j: JobRow): void {
    this.setJob(j.id, { state: 'no_text', ended_at: this.now() });
    this.setOutcome(j.book_id, 'no_text', 'No text to summarize');
    this.publish(j.book_id);
  }

  /** Every setup failed (or the book can't be read): the note on the book and one alert. */
  private finishFailed(j: JobRow, attempts: JobView['attempts'], why: string | null): void {
    const cost = this.cost(j.id);
    const note =
      why ??
      `No summary: every setup failed (${attempts.map((a) => `${a.setup}: ${a.reason}`).join('; ')})`;
    this.setJob(j.id, {
      state: 'failed',
      ended_at: this.now(),
      cost_usd: cost,
      error: note.slice(0, 1000),
    });
    this.setOutcome(j.book_id, 'failed', note.slice(0, 1000));
    this.asked.delete(j.id);
    this.phases.delete(j.id);
    this.publish(j.book_id);
    const n = this.deps.notifications;
    if (n) {
      try {
        const title = this.book(j.book_id)?.title ?? j.book_id;
        const summary = `The summary of "${title}" could not be made`;
        if (
          n.observe(`${SUMMARY_FAILED_EVENT}:${j.book_id}`, SUMMARY_FAILED_EVENT, {
            waitMs: 0,
            summary,
            detail: note.slice(0, 300),
          })
        ) {
          n.notify({
            event: SUMMARY_FAILED_EVENT,
            lines: [summary, note.slice(0, 200)],
            link: LINKS.book(j.book_id),
          });
          n.poke();
        }
      } catch (err) {
        this.deps.log?.(`Summaries: the alert: ${(err as Error).message}`);
      }
    }
  }

  /** Translates the items a saved language still needs (only changed items after an edit). */
  private async runTranslate(j: JobRow): Promise<void> {
    const m = j.summary_id !== null ? this.store.metaById(j.summary_id) : null;
    if (!m || !j.lang) {
      this.setJob(j.id, { state: 'cancelled', ended_at: this.now() });
      return;
    }
    const needs = this.store.translationNeeds(m.id, j.lang);
    if (!needs.length) {
      this.setJob(j.id, { state: 'done', ended_at: this.now() });
      this.publish(m.bookId);
      return;
    }
    const s = this.settings();
    const runId = `sumtr:${j.id}`;
    this.deps.runner.askAgain(TRANSLATE_SPEC.stage, runId);
    const h = this.openRun(runId);
    try {
      const key = `summary:${m.id}|${j.lang}|${digest(needs.map((x) => x.digest))}`;
      const a = await ask(this.engineDeps(j, h), TRANSLATE_SPEC, s.translator, key, {
        from: m.lang,
        to: j.lang,
        title: m.bookTitle,
        items: needs.map((x) => ({
          ref: x.ref,
          heading: x.heading,
          label: x.label,
          text: x.text,
        })),
      });
      if (a.state !== 'answered' || !a.answer)
        throw new Unusable(TRANSLATE_SPEC.stage, a.model, a.state);
      const got = new Map(
        (
          a.answer as { items: { ref: string; heading: string; label?: string; text: string }[] }
        ).items.map((x) => [x.ref, x]),
      );
      const made = needs.flatMap((x) => {
        const t = got.get(x.ref);
        return t
          ? [{ ref: x.ref, heading: t.heading, label: t.label, text: t.text, digest: x.digest }]
          : [];
      });
      this.store.saveTranslations(m.id, j.lang, modelOfRole(s.translator), made);
      this.setJob(j.id, {
        state: 'done',
        ended_at: this.now(),
        cost_usd: this.cost(j.id),
        error:
          made.length < needs.length ? `${needs.length - made.length} items not translated` : null,
      });
      this.publish(m.bookId);
    } catch (err) {
      if (this.stopping && !h.abandoned) return;
      this.setJob(j.id, {
        state: 'failed',
        ended_at: this.now(),
        cost_usd: this.cost(j.id),
        error: (h.abandoned
          ? `nothing could be sent for ${s.fallbackAfterMinutes} min: ${h.wait ? waitText(h.wait) : 'waiting'}`
          : (err as Error).message
        ).slice(0, 500),
      });
      if (h.abandoned) this.deps.runner.withdraw(runId);
    } finally {
      this.closeRun(h);
      this.asked.delete(j.id);
      this.phases.delete(j.id);
    }
  }

  // ------------------------------------------------------------------------------------------
  // the record on every device

  private serverDevice(userId: string): string {
    const row = this.main
      .prepare('SELECT device_id FROM user_seeds WHERE user_id = ? AND name = ?')
      .get(userId, SUMMARIES_DEVICE_SEED) as { device_id: string | null } | undefined;
    if (row?.device_id) return row.device_id;
    const id = randomUUID();
    const now = this.now();
    this.main.transaction(() => {
      this.main
        .prepare('INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, ?)')
        .run(id, userId, now);
      const change: SyncChange = {
        kind: 'device',
        id,
        updatedAt: now,
        data: { name: 'Server (summaries)' },
      };
      this.sync!.writeAs(userId, id, change, now);
      this.main
        .prepare('INSERT INTO user_seeds (user_id, name, device_id, done_at) VALUES (?, ?, ?, ?)')
        .run(userId, SUMMARIES_DEVICE_SEED, id, now);
    })();
    return id;
  }

  /** What every device knows of a book's summary (the summary itself comes over REST). */
  recordData(bookId: string): Record<string, unknown> {
    const m = this.store.currentMeta(bookId);
    const st = this.db
      .prepare('SELECT outcome, note FROM summary_books WHERE book_id = ?')
      .get(bookId) as { outcome: string | null; note: string | null } | undefined;
    const job = this.db
      .prepare(
        `SELECT id, state, started_at FROM summary_jobs WHERE book_id = ? AND kind IN ('auto', 'regenerate')
           AND state IN ('queued', 'running') ORDER BY id DESC LIMIT 1`,
      )
      .get(bookId) as
      | { id: number; state: 'queued' | 'running'; started_at: number | null }
      | undefined;
    let summary: Record<string, unknown> | null = null;
    if (m) {
      const langs: Record<string, string> = {};
      for (const lang of this.store.languages(bookId, m.lang)) {
        const v = this.store.view(m.id, lang);
        if (v) langs[lang] = digest(v);
      }
      summary = {
        id: m.id,
        origin: m.origin,
        setup: m.setup,
        models: m.models,
        lang: m.lang,
        madeAt: m.madeAt,
        editedAt: m.editedAt,
        background: m.background,
        langs,
      };
    }
    return {
      summary,
      making: job?.state ?? null,
      // Session 4's progress: the running job's step and when it started.
      phase: job?.state === 'running' ? (this.phases.get(job.id) ?? 'reading') : null,
      since: job?.state === 'running' ? (job.started_at ?? null) : null,
      outcome: st?.outcome ?? null,
      note: st?.outcome === 'made' ? null : (st?.note ?? null),
    };
  }

  /** Writes the book's "book-summary" record for every user (devices pull it). */
  publish(bookId: string): void {
    if (!this.sync) return;
    try {
      const data = this.recordData(bookId);
      for (const userId of this.users()) {
        const device = this.serverDevice(userId);
        const prev = this.sync.getRecord(userId, BOOK_SUMMARY_KIND, bookId);
        if (prev && JSON.stringify(prev.data) === JSON.stringify(data) && prev.deletedAt === null)
          continue;
        const at = Math.max(this.now(), (prev?.updatedAt ?? 0) + 1);
        const change: SyncChange = { kind: BOOK_SUMMARY_KIND, id: bookId, updatedAt: at, data };
        const r = this.sync.writeAs(userId, device, change, at);
        if (r.status !== 'applied' && r.status !== 'duplicate')
          this.deps.log?.(`Summaries: the record of ${bookId}: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      this.deps.log?.(`Summaries: the record of ${bookId}: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // the user's actions (routes.ts)

  /** The current summary in a language (the book's when not given) and the book's state. */
  get(
    bookId: string,
    lang?: string,
  ): { summary: StoredSummary | null; state: Record<string, unknown> } {
    const m = this.store.currentMeta(bookId);
    return { summary: m ? this.store.view(m.id, lang) : null, state: this.recordData(bookId) };
  }

  regenerate(bookId: string): number {
    if (!this.book(bookId)) throw new EditError(404, 'unknown_book', 'No such book');
    return this.enqueue(bookId, 'regenerate');
  }

  writeOwn(bookId: string, body: unknown): StoredSummary {
    const b = this.book(bookId);
    if (!b) throw new EditError(404, 'unknown_book', 'No such book');
    const s = userSummary(body, { lang: this.bookLang(b), bookTitle: b.title, now: this.now() });
    const id = this.store.save(bookId, s, {
      origin: 'user',
      setup: null,
      background: false,
      current: true,
      byUser: true,
    });
    this.setOutcome(bookId, 'made', null);
    this.translateSaved(bookId);
    this.publish(bookId);
    return this.store.view(id)!;
  }

  private edited(bookId: string): void {
    this.translateSaved(bookId);
    this.publish(bookId);
  }

  editItem(bookId: string, itemId: number, input: Partial<ItemInput>) {
    const it = this.store.editItem(bookId, itemId, input);
    this.edited(bookId);
    return it;
  }

  editOverview(bookId: string, text: unknown) {
    if (typeof text !== 'string') throw new EditError(400, 'invalid', 'text must be text');
    const it = this.store.editOverview(bookId, text);
    this.edited(bookId);
    return it;
  }

  addItem(bookId: string, section: SectionKey, input: ItemInput) {
    const it = this.store.addItem(bookId, section, input);
    this.edited(bookId);
    return it;
  }

  deleteItem(bookId: string, itemId: number): void {
    this.store.deleteItem(bookId, itemId);
    this.edited(bookId);
  }

  /** Delete: the current summary becomes an earlier version (restorable). */
  deleteCurrent(bookId: string): void {
    this.store.retireCurrent(bookId);
    this.publish(bookId);
  }

  restore(bookId: string, summaryId: number): void {
    this.store.restore(bookId, summaryId);
    this.setOutcome(bookId, 'made', null);
    this.translateSaved(bookId);
    this.publish(bookId);
  }

  deleteVersion(bookId: string, summaryId: number): void {
    this.store.deleteVersion(bookId, summaryId);
  }

  /** A language chosen for the book's summary: saved, and translated item by item. */
  translate(bookId: string, lang: unknown): void {
    if (typeof lang !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang))
      throw new EditError(400, 'invalid', 'lang must be a language code like en or ja');
    const m = this.store.currentMeta(bookId);
    if (!m) throw new EditError(404, 'no_summary', 'This book has no summary');
    if (lang === m.lang) return;
    this.store.addLanguage(bookId, lang);
    this.enqueueTranslate(bookId, m.id, lang);
    this.publish(bookId);
  }

  /**
   * The bulk "Mark completed" estimate: the books that would get an automatic summary (never
   * completed before as the summaries saw it, no summary, text to read) and about what it costs.
   */
  estimate(bookIds: unknown): {
    books: string[];
    characters: number;
    usd: number;
    per100k: number;
  } {
    if (
      !Array.isArray(bookIds) ||
      bookIds.length > 5000 ||
      bookIds.some((x) => typeof x !== 'string')
    )
      throw new EditError(400, 'invalid', 'bookIds must be a list of book ids');
    const per100k = this.costPer100k();
    const books: string[] = [];
    let characters = 0;
    const marker = this.db.prepare('SELECT first_completion FROM summary_books WHERE book_id = ?');
    for (const id of bookIds as string[]) {
      const b = this.book(id);
      if (!b || !b.char_count) continue;
      const mk = marker.get(id) as { first_completion: string | null } | undefined;
      if (mk?.first_completion) continue;
      if (this.store.currentMeta(id)) continue;
      books.push(id);
      characters += b.char_count;
    }
    return { books, characters, usd: (characters / 100_000) * per100k, per100k };
  }

  /** The measured cost per 100,000 characters of the app's own summaries (3 or more). */
  costPer100k(): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(json_extract(report_json, '$.costUsd')) AS usd,
           SUM(json_extract(report_json, '$.characters')) AS chars
         FROM summaries WHERE origin = 'ai' AND report_json IS NOT NULL
           AND json_extract(report_json, '$.characters') > 0`,
      )
      .get() as { n: number; usd: number | null; chars: number | null };
    if (r.n >= 3 && r.usd && r.chars) return (r.usd / r.chars) * 100_000;
    return this.settings().costPer100kChars;
  }

  jobs(bookId?: string): JobView[] {
    const rows = (
      bookId
        ? this.db
            .prepare('SELECT * FROM summary_jobs WHERE book_id = ? ORDER BY id DESC LIMIT 50')
            .all(bookId)
        : this.db
            .prepare(
              `SELECT * FROM summary_jobs WHERE state IN ('queued', 'running')
               UNION ALL SELECT * FROM (SELECT * FROM summary_jobs WHERE state NOT IN ('queued', 'running') ORDER BY id DESC LIMIT 50)`,
            )
            .all()
    ) as JobRow[];
    return rows.map((j) => {
      const route = JSON.parse(j.route_json ?? '[]') as RouteSetup[];
      const h = this.runs.get(`sum:${j.id}:${j.step}`) ?? this.runs.get(`sumtr:${j.id}`);
      return {
        id: j.id,
        bookId: j.book_id,
        kind: j.kind,
        lang: j.lang,
        state: j.state,
        setup: route[j.step] ? setupLabel(route[j.step]) : null,
        phase:
          j.state === 'running'
            ? (this.phases.get(j.id) ?? (j.kind === 'translate' ? 'translating' : 'reading'))
            : null,
        attempts: JSON.parse(j.attempts_json) as JobView['attempts'],
        waiting: h?.wait ? waitText(h.wait) : null,
        afterVolume: this.afterVolume.has(j.id),
        error: j.error,
        costUsd: j.cost_usd,
        createdAt: j.created_at,
        startedAt: j.started_at,
        endedAt: j.ended_at,
      };
    });
  }

  /** Every model the summaries use (for Settings > AI). */
  modelsInUse(): string[] {
    return modelsInUse(this.settings());
  }
}
