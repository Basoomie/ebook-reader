/**
 * The series recap, "story so far", on the server (book summaries session 5; book-summaries.md
 * "Series recap"): which volumes it covers, when it is (re)built, the jobs along the summaries'
 * route of setups (each setup's writer writes, its reading models check each point), its
 * translations, and the "series-recap" record that tells every device about it.
 *
 * - Covers the series' volumes up to the last one completed at least once (a finished
 *   read-through or the status Completed now; a Start over never takes a volume out).
 * - Made only when at least two covered volumes have a summary (user, 2026-11-23).
 * - Automatic (the global "Update the story so far automatically", on by default): a volume
 *   summary added, replaced, edited, deleted or restored, a volume with a summary completed for
 *   the first time, the series' volumes changing; after a quiet wait (`recapDelayMinutes`).
 *   The panel's Regenerate makes one at once, also while automatic updates are off.
 * - Same failure handling as book summaries: the next setup on a refusal, an unusable answer or
 *   a long non-limit wait; every setup failed → a note and one alert; the limit only queues.
 */
import type Database from 'better-sqlite3';
import type { AiRunner } from '../ai/runner';
import { waitText } from '../ai/waits';
import { SQL_BOOK_FROM } from '../catalog/queries';
import { globalBoolean } from '../sync/global-setting';
import { ask, askedMetrics, Refused, Unusable, type Asked, type EngineDeps } from './engine';
import {
  checkEvidence,
  coveredBooks,
  digestOf,
  draftRecap,
  inputsDigest,
  recapInput,
  staleness,
  summaryDigest,
  volumeLabel,
  type CoveredVolume,
  type RecapDraft,
  type SeriesBook,
  type StaleWhy,
  type VolumeSummary,
} from './recap';
import { RECAP_CHECK_SPEC, RECAP_SPEC, type RecapAnswer, type RecapVerdict } from './recap-specs';
import { RecapStore, type RecapView } from './recap-store';
import type { RunHandle } from './run-handle';
import { setupLabel, type RouteSetup, type SummarySettings } from './settings';
import { modelOfRole, TRANSLATE_SPEC } from './specs';
import { EditError, type SummaryStore } from './store';
import { SUMMARY_FAILED_EVENT } from './summary-event';
import type { SummaryNotifier } from './service';
import { EVERY_SETUP_FAILED, failureLines, plainFailure, type PlainFailure } from './plain-words';

export const SERIES_RECAP_KIND = 'series-recap';
/** The global setting "Update the story so far automatically" (web `summaryRecapAuto$`). */
export const RECAP_AUTO_KEY = 'summaryRecapAuto';
/** `cli summaries recaps --apply` asks the running server to make these series' recaps. */
export const RECAPS_REQUESTED = 'recaps_requested';
/** A recap needs at least this many covered volumes with a summary (user, 2026-11-23). */
export const RECAP_MIN_VOLUMES = 2;

export interface RecapHost {
  db: Database.Database;
  main: Database.Database;
  runner: AiRunner;
  store: SummaryStore;
  now(): number;
  log?(m: string): void;
  notifications?: SummaryNotifier | null;
  settings(): SummarySettings;
  openRun(runId: string): RunHandle;
  closeRun(h: RunHandle): void;
  stopping(): boolean;
  /** Writes a server record for every user (only when it changed). */
  writeRecord(kind: string, id: string, data: Record<string, unknown>): void;
  /** The open book-summary jobs (queued or running) by book. */
  openBookJobs(): Set<string>;
}

type RecapJobKind = 'auto' | 'manual' | 'translate';
type RecapJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

interface RecapJobRow {
  id: number;
  series: string;
  kind: RecapJobKind;
  lang: string | null;
  recap_id: number | null;
  state: RecapJobState;
  reason: string | null;
  due_at: number;
  route_json: string | null;
  step: number;
  attempts_json: string;
  generation: number;
  inputs_digest: string | null;
  error: string | null;
  cost_usd: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export type RecapPhase = 'writing' | 'checking' | 'translating';

/** A covered volume as the panel shows it now. */
export interface CoverageVolume {
  bookId: string;
  label: string | null;
  title: string;
  hasSummary: boolean;
}

export interface RecapCoverage {
  /** The covered volumes now, in order (none: nothing completed yet). */
  volumes: CoverageVolume[];
  /** How many of them have a summary. */
  withSummary: number;
  /** Enough for a recap (two or more with a summary). */
  enough: boolean;
  /** What the recap doesn't have yet (only when there is a recap). */
  stale: { bookId: string; label: string | null; title: string; why: StaleWhy }[];
  orderChanged: boolean;
}

export interface RecapResponse {
  series: string;
  recap: RecapView | null;
  coverage: RecapCoverage;
  state: Record<string, unknown>;
  /** "Update the story so far automatically" as the server reads it. */
  auto: boolean;
}

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

export class RecapService {
  readonly store: RecapStore;
  private readonly active = new Map<number, Promise<void>>();
  private readonly phases = new Map<number, RecapPhase>();
  private readonly asked = new Map<number, Asked[]>();

  constructor(private readonly h: RecapHost) {
    this.store = new RecapStore(h.db, () => h.now());
  }

  private get db() {
    return this.h.db;
  }
  private get main() {
    return this.h.main;
  }

  // ------------------------------------------------------------------------------------------
  // the series and its volumes

  /** The owner's choice (the first user: the app has one person; summaries are shared). */
  autoOn(): boolean {
    const owner = this.main.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as
      | { id: string }
      | undefined;
    return owner ? globalBoolean(this.main, owner.id, RECAP_AUTO_KEY, true) : true;
  }

  seriesOf(bookId: string): string | null {
    const r = this.main
      .prepare('SELECT s.name FROM books b JOIN series s ON s.id = b.series_id WHERE b.id = ?')
      .get(bookId) as { name: string } | undefined;
    return r?.name ?? null;
  }

  /** The series' books as the series page lists them, each with "completed at least once". */
  seriesBooks(series: string): SeriesBook[] {
    const rows = this.main
      .prepare(
        `SELECT b.id, b.title, b.series_index,
           EXISTS (SELECT 1 FROM sync_records r
             WHERE r.user_id IN (SELECT id FROM users) AND r.book_id = b.id
               AND r.kind IN ('read-through', 'book-status') AND r.deleted_at IS NULL AND (
                 (r.kind = 'read-through' AND json_extract(r.data, '$.finished') = 1) OR
                 (r.kind = 'book-status' AND json_extract(r.data, '$.status') = 'completed'))
           ) AS done
         ${SQL_BOOK_FROM}
         WHERE b.series_id = (SELECT id FROM series WHERE name = ?) AND s.missing_at IS NULL
         ORDER BY IFNULL(b.series_index, -1), b.added_at, b.id`,
      )
      .all(series) as { id: string; title: string; series_index: number | null; done: number }[];
    return rows.map((r) => ({
      bookId: r.id,
      title: r.title,
      seriesIndex: r.series_index,
      completed: r.done === 1,
    }));
  }

  /** Whether a book is completed at least once now (any user). */
  private completedEver(bookId: string): boolean {
    return !!this.main
      .prepare(
        `SELECT 1 FROM sync_records WHERE user_id IN (SELECT id FROM users) AND book_id = ?
           AND kind IN ('read-through', 'book-status') AND deleted_at IS NULL AND (
             (kind = 'read-through' AND json_extract(data, '$.finished') = 1) OR
             (kind = 'book-status' AND json_extract(data, '$.status') = 'completed')) LIMIT 1`,
      )
      .get(bookId);
  }

  /** The covered volumes now, each with its current summary (and its digest). */
  covered(series: string): { volumes: CoveredVolume[]; summaries: Map<string, VolumeSummary> } {
    const summaries = new Map<string, VolumeSummary>();
    const volumes = coveredBooks(this.seriesBooks(series)).map((b, i): CoveredVolume => {
      const m = this.h.store.currentMeta(b.bookId);
      const v: CoveredVolume = {
        n: i + 1,
        bookId: b.bookId,
        title: b.title,
        label: volumeLabel(b.seriesIndex),
        summaryId: m?.id ?? null,
        digest: null,
      };
      if (m) {
        const items = this.h.store.items(m.id);
        const also = this.h.store.alsoMentioned(m.id);
        v.digest = summaryDigest(m.id, items, also);
        summaries.set(b.bookId, { volume: v, items, alsoMentioned: also });
      }
      return v;
    });
    return { volumes, summaries };
  }

  coverage(series: string, cov = this.covered(series)): RecapCoverage {
    const vols = cov.volumes;
    const withSummary = vols.filter((v) => v.summaryId !== null).length;
    const recap = this.store.current(series);
    let stale: RecapCoverage['stale'] = [];
    let orderChanged = false;
    if (recap) {
      const s = staleness(
        recap.volumes.map((v) => ({ bookId: v.bookId, digest: v.digest })),
        vols.map((v) => ({ bookId: v.bookId, digest: v.digest })),
      );
      const info = new Map<string, { label: string | null; title: string }>();
      for (const v of recap.volumes) info.set(v.bookId, { label: v.label, title: v.title });
      for (const v of vols) info.set(v.bookId, { label: v.label, title: v.title });
      stale = s.volumes.map((x) => ({ ...x, ...info.get(x.bookId)! }));
      orderChanged = s.orderChanged;
    }
    return {
      volumes: vols.map((v) => ({
        bookId: v.bookId,
        label: v.label,
        title: v.title,
        hasSummary: v.summaryId !== null,
      })),
      withSummary,
      enough: withSummary >= RECAP_MIN_VOLUMES,
      stale,
      orderChanged,
    };
  }

  /** The recap's language: the last covered volume's summary's. */
  private langOf(cov: { volumes: CoveredVolume[]; summaries: Map<string, VolumeSummary> }): string {
    for (const v of [...cov.volumes].reverse()) {
      if (v.summaryId === null) continue;
      const m = this.h.store.metaById(v.summaryId);
      if (m) return m.lang;
    }
    return 'ja';
  }

  // ------------------------------------------------------------------------------------------
  // triggers

  /** Once: the books completed before recaps existed are known as completed (no recap made). */
  baseline(): void {
    const done = this.db.prepare(`SELECT 1 FROM summary_state WHERE key = 'recap_baseline'`).get();
    if (done) return;
    const books = this.main
      .prepare(
        `SELECT DISTINCT book_id FROM sync_records
         WHERE book_id IS NOT NULL AND deleted_at IS NULL AND (
           (kind = 'read-through' AND json_extract(data, '$.finished') = 1) OR
           (kind = 'book-status' AND json_extract(data, '$.status') = 'completed'))`,
      )
      .all() as { book_id: string }[];
    const now = this.h.now();
    this.db.transaction(() => {
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO series_recap_completed (book_id, at) VALUES (?, ?)',
      );
      for (const b of books) ins.run(b.book_id, now);
      this.db
        .prepare(`INSERT INTO summary_state (key, value) VALUES ('recap_baseline', ?)`)
        .run(String(now));
    })();
  }

  /** A restart: recap jobs that were running go on from their stored answers. */
  resume(): void {
    this.db.prepare(`UPDATE series_recap_jobs SET state = 'queued' WHERE state = 'running'`).run();
  }

  /**
   * A volume's summary changed (added, replaced, edited, deleted, restored): the recap of its
   * series, when that volume is one the recap covers.
   */
  noteSummaryChange(bookId: string, reason: string): void {
    try {
      const series = this.seriesOf(bookId);
      if (!series) return;
      const covered = coveredBooks(this.seriesBooks(series));
      if (!covered.some((b) => b.bookId === bookId)) return;
      this.schedule(series, reason);
    } catch (err) {
      this.h.log?.(`Summaries: the story so far for ${bookId}: ${(err as Error).message}`);
    }
  }

  /**
   * After a push: a book completed at least once for the first time joins its series' recap
   * when it has a summary (or a book whose completion was undone leaves it). A Start over adds
   * an open read-through and keeps the finished one: nothing changes.
   */
  onCompletions(bookIds: Iterable<string>): void {
    const marker = this.db.prepare('SELECT 1 FROM series_recap_completed WHERE book_id = ?');
    for (const bookId of bookIds) {
      try {
        const had = !!marker.get(bookId);
        const has = this.completedEver(bookId);
        if (had === has) continue;
        if (has) {
          this.db
            .prepare('INSERT OR IGNORE INTO series_recap_completed (book_id, at) VALUES (?, ?)')
            .run(bookId, this.h.now());
          if (this.h.store.currentMeta(bookId)) this.noteSummaryChange(bookId, 'completed');
        } else {
          this.db.prepare('DELETE FROM series_recap_completed WHERE book_id = ?').run(bookId);
          const series = this.seriesOf(bookId);
          // Its recap may have covered it: the inputs say whether anything changed.
          if (series && this.store.current(series)) this.schedule(series, 'completion undone');
        }
      } catch (err) {
        this.h.log?.(`Summaries: the story so far after ${bookId}: ${(err as Error).message}`);
      }
    }
  }

  private openJob(series: string): RecapJobRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM series_recap_jobs WHERE series = ? AND kind IN ('auto', 'manual')
             AND state = 'queued' ORDER BY id DESC LIMIT 1`,
        )
        .get(series) as RecapJobRow | undefined) ?? null
    );
  }

  private generation(series: string): number {
    return (
      (
        this.db
          .prepare('SELECT generation FROM series_recap_state WHERE series = ?')
          .get(series) as { generation: number } | undefined
      )?.generation ?? 0
    );
  }

  /**
   * An automatic rebuild after the quiet wait (a newer change moves it later). Nothing while
   * automatic updates are off; nothing for a series that has no recap and too few summaries.
   */
  schedule(series: string, reason: string): void {
    if (!this.autoOn()) return;
    const recap = this.store.current(series);
    if (!recap && !this.coverage(series).enough) return;
    const due = this.h.now() + this.h.settings().recapDelayMinutes * 60_000;
    const open = this.openJob(series);
    if (open) {
      if (open.kind === 'auto')
        this.db
          .prepare('UPDATE series_recap_jobs SET due_at = ?, reason = ? WHERE id = ?')
          .run(due, reason, open.id);
    } else this.insertJob(series, 'auto', due, reason);
    this.publish(series);
  }

  private insertJob(series: string, kind: 'auto' | 'manual', due: number, reason: string): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO series_recap_jobs (series, kind, state, reason, due_at, route_json, generation, created_at)
           VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          series,
          kind,
          reason,
          due,
          JSON.stringify(this.h.settings().route),
          this.generation(series),
          this.h.now(),
        ).lastInsertRowid,
    );
  }

  /** The panel's Regenerate (or "Make the story so far"): at once, asked again. */
  regenerate(series: string): number {
    if (!this.seriesBooks(series).length)
      throw new EditError(404, 'unknown_series', 'No such series');
    if (!this.coverage(series).enough)
      throw new EditError(
        409,
        'too_few',
        'The story so far needs at least two completed volumes with a summary',
      );
    this.db
      .prepare(
        `INSERT INTO series_recap_state (series, generation) VALUES (?, 1)
         ON CONFLICT(series) DO UPDATE SET generation = generation + 1`,
      )
      .run(series);
    const gen = this.generation(series);
    const open = this.openJob(series);
    let id: number;
    if (open) {
      this.db
        .prepare(
          `UPDATE series_recap_jobs SET kind = 'manual', due_at = ?, reason = 'regenerate',
             generation = ?, route_json = ? WHERE id = ?`,
        )
        .run(this.h.now(), gen, JSON.stringify(this.h.settings().route), open.id);
      id = open.id;
    } else id = this.insertJob(series, 'manual', this.h.now(), 'regenerate');
    this.publish(series);
    return id;
  }

  /** `cli summaries recaps --apply`: the listed series (or every one with enough) made once. */
  private requested(): void {
    const r = this.db
      .prepare('SELECT value FROM summary_state WHERE key = ?')
      .get(RECAPS_REQUESTED) as { value: string } | undefined;
    if (!r) return;
    this.db.prepare('DELETE FROM summary_state WHERE key = ?').run(RECAPS_REQUESTED);
    let list: string[] = [];
    try {
      list = JSON.parse(r.value) as string[];
    } catch {
      return;
    }
    for (const s of list) {
      try {
        if (!this.store.current(s) && !this.openJob(s)) {
          if (this.coverage(s).enough) this.insertJob(s, 'manual', this.h.now(), 'requested');
          this.publish(s);
        }
      } catch (err) {
        this.h.log?.(`Summaries: the story so far of ${s}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The server's 10-minute check: a series whose recap no longer matches its volumes (one
   * joined or left the series, the order changed, a change was missed) is rebuilt, while
   * automatic updates are on; every recap's record is written as it is now.
   */
  sweep(): void {
    try {
      const auto = this.autoOn();
      for (const series of this.store.allSeries()) {
        const recap = this.store.current(series);
        if (auto && recap && !this.openJob(series) && !this.running(series)) {
          const cov = this.covered(series);
          if (inputsDigest(series, cov.volumes) !== recap.inputsDigest)
            this.schedule(series, 'series changed');
        }
        this.publish(series);
      }
      const others = this.db
        .prepare(
          `SELECT series FROM series_recap_state WHERE outcome IS NOT NULL
           UNION SELECT series FROM series_recap_jobs WHERE state IN ('queued', 'running')`,
        )
        .all() as { series: string }[];
      for (const { series } of others) this.publish(series);
    } catch (err) {
      this.h.log?.(`Summaries: the story so far check: ${(err as Error).message}`);
    }
  }

  private running(series: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM series_recap_jobs WHERE series = ? AND state = 'running'`)
      .get(series);
  }

  // ------------------------------------------------------------------------------------------
  // jobs

  /** One pass: start what may start (one recap made at a time; translations beside it). */
  startJobs(): void {
    this.requested();
    const now = this.h.now();
    const queued = this.db
      .prepare(
        `SELECT * FROM series_recap_jobs WHERE state = 'queued' AND due_at <= ? ORDER BY due_at, id`,
      )
      .all(now) as RecapJobRow[];
    let making = [...this.active.keys()].filter((id) => this.job(id)?.kind !== 'translate').length;
    let openBooks: Set<string> | null = null;
    for (const j of queued) {
      if (this.active.has(j.id)) continue;
      if (j.kind === 'translate') {
        this.launch(j);
        continue;
      }
      if (making >= 1 || this.running(j.series)) continue;
      // A volume of the series whose summary is being made: the recap waits for it.
      openBooks ??= this.h.openBookJobs();
      if (openBooks.size && this.seriesBooks(j.series).some((b) => openBooks!.has(b.bookId)))
        continue;
      making++;
      this.launch(j);
    }
  }

  private job(id: number): RecapJobRow | null {
    return (
      (this.db.prepare('SELECT * FROM series_recap_jobs WHERE id = ?').get(id) as RecapJobRow) ??
      null
    );
  }

  private setJob(id: number, fields: Partial<Omit<RecapJobRow, 'id'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .prepare(
        `UPDATE series_recap_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      )
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), id);
  }

  private launch(j: RecapJobRow): void {
    this.setJob(j.id, { state: 'running', started_at: j.started_at ?? this.h.now() });
    if (j.kind !== 'translate') this.publish(j.series);
    const p = (j.kind === 'translate' ? this.runTranslate(j) : this.runMake(j))
      .catch((err) => {
        this.h.log?.(`Summaries: story so far job ${j.id}: ${(err as Error).message}`);
        if (!this.h.stopping())
          this.setJob(j.id, {
            state: 'failed',
            error: String((err as Error).message).slice(0, 500),
            ended_at: this.h.now(),
          });
      })
      .finally(() => {
        this.active.delete(j.id);
        this.phases.delete(j.id);
        this.asked.delete(j.id);
      });
    this.active.set(j.id, p);
  }

  /** Waits for the running jobs (the server stopping). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }

  private deps(j: RecapJobRow, h: RunHandle): EngineDeps {
    const list = this.asked.get(j.id) ?? [];
    this.asked.set(j.id, list);
    return { runner: this.h.runner, pump: h, runId: h.runId, onAsk: (a) => list.push(a) };
  }

  private setPhase(j: RecapJobRow, phase: RecapPhase): void {
    if (this.phases.get(j.id) === phase) return;
    this.phases.set(j.id, phase);
    if (j.kind !== 'translate') this.publish(j.series);
  }

  private cost(jobId: number): number {
    return askedMetrics(this.db, this.asked.get(jobId) ?? []).costUsd;
  }

  private setOutcome(series: string, outcome: 'made' | 'failed' | null, note: string | null) {
    this.db
      .prepare(
        `INSERT INTO series_recap_state (series, outcome, note, note_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(series) DO UPDATE SET outcome = excluded.outcome, note = excluded.note,
           note_at = excluded.note_at`,
      )
      .run(series, outcome, note, note ? this.h.now() : null);
  }

  /** Makes the recap along the route (an automatic or a manual job). */
  private async runMake(j: RecapJobRow): Promise<void> {
    const series = j.series;
    const cov = this.covered(series);
    const withSummary = cov.volumes.filter((v) => v.summaryId !== null).length;
    if (withSummary < RECAP_MIN_VOLUMES) {
      // Fewer than two volumes with a summary (one was deleted): no recap.
      if (this.store.remove(series)) this.h.log?.(`Summaries: ${series}: the story so far removed`);
      this.setJob(j.id, {
        state: 'cancelled',
        ended_at: this.h.now(),
        error: 'fewer than two covered volumes have a summary',
      });
      this.publish(series);
      return;
    }
    const digest = inputsDigest(series, cov.volumes);
    const recap = this.store.current(series);
    if (recap && recap.inputsDigest === digest && recap.generation === j.generation) {
      // Nothing changed since the recap was made: nothing is asked.
      this.setJob(j.id, { state: 'done', ended_at: this.h.now(), inputs_digest: digest });
      this.publish(series);
      return;
    }
    this.setJob(j.id, { inputs_digest: digest });
    const lang = this.langOf(cov);
    const input = recapInput(series, lang, cov.volumes, cov.summaries);
    const route = JSON.parse(j.route_json ?? '[]') as RouteSetup[];
    const attempts = JSON.parse(j.attempts_json) as {
      setup: string;
      reason: string;
      at: number;
      fail?: PlainFailure;
    }[];
    const tried = new Set<string>();
    for (let step = j.step; step < route.length; step++) {
      if (this.h.stopping()) return;
      const r = route[step];
      const label = setupLabel(r);
      const key = `${r.writer}>${[...new Set(r.finders)].join('+')}`;
      // The same writer and checkers again (a later setup): asked nothing new, same failure.
      if (tried.has(key)) continue;
      tried.add(key);
      this.setJob(j.id, { step });
      const runId = `recap:${j.id}:${step}`;
      for (const spec of [RECAP_SPEC, RECAP_CHECK_SPEC, TRANSLATE_SPEC])
        this.h.runner.askAgain(spec.stage, runId);
      const h = this.h.openRun(runId);
      try {
        const made = await this.writeAndCheck(j, h, r, input, cov.volumes, digest);
        const cost = this.cost(j.id);
        const models = [...new Set([...r.finders, r.writer].map((m) => modelOfRole(m)))];
        this.store.save(series, {
          lang,
          volumes: cov.volumes,
          draft: made.draft,
          sources: input.sources,
          setup: label,
          models,
          inputsDigest: digest,
          generation: j.generation,
          jobId: j.id,
          report: { costUsd: cost, attempts, dropped: made.dropped, checked: made.checked },
        });
        this.setJob(j.id, { state: 'done', ended_at: this.h.now(), cost_usd: cost });
        this.setOutcome(series, 'made', null);
        this.h.notifications?.clear(`${SUMMARY_FAILED_EVENT}:recap:${series}`);
        this.translateSaved(series);
        this.publish(series);
        this.h.log?.(
          `Summaries: ${series}: the story so far made by ${label} (${made.draft.items.length} points, ${made.dropped.length} left out, $${cost.toFixed(2)})`,
        );
        return;
      } catch (err) {
        if (this.h.stopping() && !h.abandoned) return;
        const reason = h.abandoned
          ? `nothing could be sent for ${this.h.settings().fallbackAfterMinutes} min: ${h.wait ? waitText(h.wait) : 'waiting'}`
          : err instanceof Refused
            ? `${err.model} refused (${err.stage})`
            : err instanceof Unusable
              ? err.message
              : `error: ${(err as Error).message}`;
        if (h.abandoned) this.h.runner.withdraw(runId);
        attempts.push({
          setup: label,
          reason: reason.slice(0, 400),
          at: this.h.now(),
          fail: plainFailure(err, h, this.h.settings().fallbackAfterMinutes),
        });
        this.setJob(j.id, { attempts_json: JSON.stringify(attempts) });
        this.h.log?.(`Summaries: ${series}: the story so far by ${label} failed: ${reason}`);
      } finally {
        this.h.closeRun(h);
      }
    }
    this.finishFailed(j, attempts);
  }

  /** The writer writes; each of the setup's reading models checks every point. */
  private async writeAndCheck(
    j: RecapJobRow,
    h: RunHandle,
    r: RouteSetup,
    input: ReturnType<typeof recapInput>,
    volumes: CoveredVolume[],
    digest: string,
  ): Promise<{ draft: RecapDraft; dropped: RecapDraft['dropped']; checked: number }> {
    const d = this.deps(j, h);
    const base = `recap:${j.series}|${digest}|g${j.generation}|w:${r.writer}`;
    this.setPhase(j, 'writing');
    const w = await ask(d, RECAP_SPEC, r.writer, base, input.evidence);
    if (w.state === 'blocked') throw new Refused(RECAP_SPEC.stage, w.model);
    if (w.state !== 'answered' || !w.answer) throw new Unusable(RECAP_SPEC.stage, w.model, w.state);
    const draft = draftRecap(w.answer as unknown as RecapAnswer, input, volumes);
    if (!draft.items.length) throw new Unusable(RECAP_SPEC.stage, w.model, 'no usable point');

    this.setPhase(j, 'checking');
    const rejected = new Map<string, string>();
    const checkers = [...new Set(r.finders)];
    for (const checker of checkers) {
      const parts = checkEvidence(j.series, draft, input.sources, volumes);
      const seen = new Set<string>();
      const verdicts = new Map<string, RecapVerdict>();
      const askPart = async (key: string, ev: (typeof parts)[number]['evidence']) => {
        const a = await ask(d, RECAP_CHECK_SPEC, checker, key, ev);
        if (a.state === 'blocked') throw new Refused(RECAP_CHECK_SPEC.stage, a.model);
        if (a.state !== 'answered' || !a.answer)
          throw new Unusable(RECAP_CHECK_SPEC.stage, a.model, a.state);
        for (const v of (a.answer as { verdicts: { id: string; verdict: RecapVerdict }[] })
          .verdicts) {
          verdicts.set(v.id, v.verdict);
          seen.add(v.id);
        }
      };
      await Promise.all(parts.map((p) => askPart(`${base}|k:${checker}|${p.key}`, p.evidence)));
      // Points the answer left out are asked once more on their own.
      const missing = draft.items.filter((it) => !seen.has(it.ref)).map((it) => it.ref);
      if (missing.length) {
        const sub = { ...draft, items: draft.items.filter((it) => missing.includes(it.ref)) };
        const again = checkEvidence(j.series, sub, input.sources, volumes);
        await Promise.all(
          again.map((p) => askPart(`${base}|k:${checker}|again|${p.key}`, p.evidence)),
        );
      }
      for (const it of draft.items) {
        const v = verdicts.get(it.ref);
        if (v !== 'supported')
          rejected.set(
            it.ref,
            v === 'not_supported'
              ? `${modelOfRole(checker)}: not supported`
              : `${modelOfRole(checker)}: not checked`,
          );
      }
    }
    const dropped = [
      ...draft.dropped,
      ...draft.items
        .filter((it) => rejected.has(it.ref))
        .map((it) => ({ section: it.section, text: it.text, why: rejected.get(it.ref)! })),
    ];
    const kept = draft.items.filter((it) => !rejected.has(it.ref));
    if (!kept.length)
      throw new Unusable(RECAP_CHECK_SPEC.stage, checkers.join('+'), 'no point passed the check');
    return { draft: { ...draft, items: kept }, dropped, checked: draft.items.length };
  }

  /** Every setup failed: the note in the panel and one alert. */
  private finishFailed(
    j: RecapJobRow,
    attempts: { setup: string; reason: string; fail?: PlainFailure }[],
  ): void {
    const cost = this.cost(j.id);
    // In plain words, each failure once with its models (as a book summary's; 2026-11-24).
    const note = [
      EVERY_SETUP_FAILED,
      ...failureLines(
        attempts.map((a) => a.fail ?? { what: `${a.setup}: ${a.reason}.`, models: [] }),
      ),
    ].join('\n');
    this.setJob(j.id, {
      state: 'failed',
      ended_at: this.h.now(),
      cost_usd: cost,
      error: note.slice(0, 1000),
    });
    this.setOutcome(j.series, 'failed', note.slice(0, 1000));
    this.publish(j.series);
    const n = this.h.notifications;
    if (!n) return;
    try {
      const summary = `The story so far of "${j.series}" could not be made`;
      if (
        n.observe(`${SUMMARY_FAILED_EVENT}:recap:${j.series}`, SUMMARY_FAILED_EVENT, {
          waitMs: 0,
          summary,
          detail: note.slice(0, 300),
        })
      ) {
        n.notify({
          event: SUMMARY_FAILED_EVENT,
          lines: [
            summary,
            ...note
              .split('\n')
              .slice(0, 7)
              .map((l) => l.slice(0, 200)),
          ],
          link: `/library?tab=series&group=${encodeURIComponent(j.series)}`,
        });
        n.poke();
      }
    } catch (err) {
      this.h.log?.(`Summaries: the alert: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // translations

  private translateSaved(series: string): void {
    const m = this.store.current(series);
    if (!m) return;
    for (const lang of this.store.languages(series, m.lang))
      if (lang !== m.lang) this.enqueueTranslate(series, m.id, lang);
  }

  private enqueueTranslate(series: string, recapId: number, lang: string): void {
    const open = this.db
      .prepare(
        `SELECT 1 FROM series_recap_jobs WHERE kind = 'translate' AND recap_id = ? AND lang = ? AND state = 'queued'`,
      )
      .get(recapId, lang);
    if (open) return;
    this.db
      .prepare(
        `INSERT INTO series_recap_jobs (series, kind, lang, recap_id, state, due_at, created_at)
         VALUES (?, 'translate', ?, ?, 'queued', ?, ?)`,
      )
      .run(series, lang, recapId, this.h.now(), this.h.now());
  }

  /** A language chosen for the recap: saved, and translated point by point. */
  translate(series: string, lang: unknown): void {
    if (typeof lang !== 'string' || !LANG_RE.test(lang))
      throw new EditError(400, 'invalid', 'lang must be a language code like en or ja');
    const m = this.store.current(series);
    if (!m) throw new EditError(404, 'no_recap', 'This series has no story so far');
    if (lang === m.lang) return;
    this.store.addLanguage(series, lang);
    this.enqueueTranslate(series, m.id, lang);
    this.publish(series);
  }

  private async runTranslate(j: RecapJobRow): Promise<void> {
    const m = j.recap_id !== null ? this.store.byId(j.recap_id) : null;
    if (!m || !j.lang) {
      this.setJob(j.id, { state: 'cancelled', ended_at: this.h.now() });
      return;
    }
    const needs = this.store.translationNeeds(m.id, j.lang);
    if (!needs.length) {
      this.setJob(j.id, { state: 'done', ended_at: this.h.now() });
      this.publish(m.series);
      return;
    }
    const s = this.h.settings();
    const runId = `recaptr:${j.id}`;
    this.h.runner.askAgain(TRANSLATE_SPEC.stage, runId);
    const h = this.h.openRun(runId);
    try {
      // By the points' text: a rebuild that says the same asks nothing again.
      const key = `recap:${m.series}|${j.lang}|${digestOf(needs.map((x) => x.digest))}`;
      const a = await ask(this.deps(j, h), TRANSLATE_SPEC, s.translator, key, {
        from: m.lang,
        to: j.lang,
        title: m.series,
        items: needs.map((x) => ({ ref: x.ref, heading: x.heading, label: x.label, text: x.text })),
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
        ended_at: this.h.now(),
        cost_usd: this.cost(j.id),
        error:
          made.length < needs.length ? `${needs.length - made.length} points not translated` : null,
      });
      this.publish(m.series);
    } catch (err) {
      if (this.h.stopping() && !h.abandoned) return;
      this.setJob(j.id, {
        state: 'failed',
        ended_at: this.h.now(),
        cost_usd: this.cost(j.id),
        error: (h.abandoned
          ? `nothing could be sent for ${s.fallbackAfterMinutes} min: ${h.wait ? waitText(h.wait) : 'waiting'}`
          : (err as Error).message
        ).slice(0, 500),
      });
      if (h.abandoned) this.h.runner.withdraw(runId);
    } finally {
      this.h.closeRun(h);
    }
  }

  // ------------------------------------------------------------------------------------------
  // the record, the view

  private titles(volumes: { bookId: string }[]): Map<string, string> {
    const out = new Map<string, string>();
    const get = this.main.prepare('SELECT title FROM books WHERE id = ?');
    for (const v of volumes) {
      const r = get.get(v.bookId) as { title: string } | undefined;
      if (r) out.set(v.bookId, r.title);
    }
    return out;
  }

  /** What every device knows of a series' recap (the recap itself comes over REST). */
  recordData(series: string): Record<string, unknown> {
    const m = this.store.current(series);
    const st = this.db
      .prepare('SELECT outcome, note FROM series_recap_state WHERE series = ?')
      .get(series) as { outcome: string | null; note: string | null } | undefined;
    const job = this.db
      .prepare(
        `SELECT id, state, due_at, started_at FROM series_recap_jobs WHERE series = ?
           AND kind IN ('auto', 'manual') AND state IN ('queued', 'running')
         ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, id LIMIT 1`,
      )
      .get(series) as
      | { id: number; state: 'queued' | 'running'; due_at: number; started_at: number | null }
      | undefined;
    let recap: Record<string, unknown> | null = null;
    if (m) {
      const langs: Record<string, string> = {};
      const titles = this.titles(m.volumes);
      for (const lang of this.store.languages(series, m.lang)) {
        const v = this.store.view(m.id, lang, titles);
        if (v) langs[lang] = digestOf(v);
      }
      recap = {
        id: m.id,
        lang: m.lang,
        madeAt: m.madeAt,
        volumes: m.volumes.map((v) => v.bookId),
        langs,
      };
    }
    return {
      series,
      recap,
      making: job?.state ?? null,
      phase: job?.state === 'running' ? (this.phases.get(job.id) ?? 'writing') : null,
      since: job?.state === 'running' ? (job.started_at ?? null) : null,
      due: job?.state === 'queued' ? job.due_at : null,
      outcome: st?.outcome ?? null,
      note: st?.outcome === 'failed' ? (st?.note ?? null) : null,
    };
  }

  publish(series: string): void {
    try {
      this.h.writeRecord(SERIES_RECAP_KIND, series, this.recordData(series));
    } catch (err) {
      this.h.log?.(
        `Summaries: the record of the story so far of ${series}: ${(err as Error).message}`,
      );
    }
  }

  /** The recap of a series in a language, what it covers now, and its state. */
  get(series: string, lang?: string): RecapResponse {
    const cov = this.covered(series);
    const m = this.store.current(series);
    const recap = m ? this.store.view(m.id, lang, this.titles(m.volumes)) : null;
    return {
      series,
      recap,
      coverage: this.coverage(series, cov),
      state: this.recordData(series),
      auto: this.autoOn(),
    };
  }

  /** The series a recap could be made for now and their evidence size (the CLI's dry run). */
  plan(series?: string): { series: string; volumes: number; characters: number; has: boolean }[] {
    const names = series
      ? [series]
      : (
          this.main
            .prepare(
              `SELECT DISTINCT se.name FROM series se JOIN books b ON b.series_id = se.id ORDER BY se.name`,
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
    const out: { series: string; volumes: number; characters: number; has: boolean }[] = [];
    for (const name of names) {
      const cov = this.covered(name);
      const n = cov.volumes.filter((v) => v.summaryId !== null).length;
      if (n < RECAP_MIN_VOLUMES) continue;
      const input = recapInput(name, this.langOf(cov), cov.volumes, cov.summaries);
      const chars = input.evidence.volumes.reduce(
        (a, v) =>
          a + v.items.reduce((b, i) => b + i.text.length + (i.heading?.length ?? 0) + 20, 0),
        0,
      );
      out.push({ series: name, volumes: n, characters: chars, has: !!this.store.current(name) });
    }
    return out;
  }
}
