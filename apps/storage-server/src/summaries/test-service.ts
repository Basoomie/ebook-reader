/**
 * Book summaries session 2: the accuracy test. Its books, its runs (each setup on each book,
 * with or without earlier volumes as background), the judging data (single claims grouped
 * across setups; the user's marks and missing items) and each setup's scores.
 *
 * Only on the PC's test copy of the app (SUMMARIES_TEST=1); the answers live in summaries.db and
 * every model request goes through the shared AI layer (its spending against the test copy's
 * own monthly limit, set to the test's $30).
 */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { AiRunner } from '../ai/runner';
import type { BookScript } from '../audio/book-script';
import {
  ask,
  askedMetrics,
  backgroundText,
  prepared,
  Pump,
  Refused,
  runCloudSetup,
  SETUPS,
  translate,
  type Asked,
  type CloudSetup,
  type EngineDeps,
} from './engine';
import { summaryItems } from './pipeline';
import { ALL_SPECS, CLAIMS_SPEC, GROUP_SPEC } from './specs';
import type { Summary } from './types';
import type { LocalEngine } from './local-llm';

export type SetupId = CloudSetup | 'local';
export type ItemMark = 'right' | 'mistake' | 'not_needed' | 'unsure';
export const SETUP_LABELS: Record<SetupId, string> = {
  two: SETUPS.two.label,
  opus: SETUPS.opus.label,
  mixed: SETUPS.mixed.label,
  local: 'gemma-4-26B-A4B on the PC',
};
/** The order setups are listed in. */
const SETUP_ORDER: SetupId[] = ['two', 'mixed', 'opus', 'local'];
/** Rounds whose runs are judged on their own: round1, v2, v3, … (others: every run of the book). */
const isRound = (scope: string) => /^(round1|v\d+)$/.test(scope);
/** Spot checks per summary: items Claude found right that the user marks too. */
export const SPOT_CHECKS = 10;
export type TabGrade = 'best' | 'good' | 'weak';

export interface TestBook {
  key: string;
  title: string;
  file: string;
  series: string | null;
  volume: number | null;
  characters: number;
  readerId: string | null;
}

export interface RunRow {
  id: string;
  bookKey: string;
  setup: SetupId;
  background: boolean;
  round: string;
  state: 'running' | 'done' | 'refused' | 'failed';
  phase: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  metrics: RunMetrics | null;
}

export interface RunMetrics {
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock seconds from start to the finished summary. */
  seconds: number;
  /** Seconds the models worked (direct calls; batches have no per-request time). */
  modelSeconds: number;
  byStage: Record<string, { costUsd: number; requests: number; seconds: number }>;
  extracted: Record<
    string,
    {
      extracted: number;
      quoteNotFound: number;
      kept: number;
      emptyChapters: number;
      notStory: number;
    }
  >;
  confirmed: number;
  crossChecked: number;
  supported: number;
  partly: number;
  notSupported: number;
  writtenDropped: number;
  refusals: { stage: string; model: string }[];
  /** The quotes the check dropped (for the report). */
  droppedQuotes: { model: string; chapter: number; text: string; quote: string }[];
  droppedItems: { section: string; text: string; why: string }[];
  /** The local model: GPU and time notes. */
  local?: Record<string, unknown>;
}

export interface SummaryTestDeps {
  db: Database.Database;
  runner: AiRunner;
  /** The book's script from the reader's own import (the test copy's book id). */
  scriptOf: (readerId: string) => Promise<BookScript>;
  /** The test copy's book with this exact title (its id, counted characters, file). */
  findBook?: (title: string) => { id: string; characters: number; file: string } | null;
  local?: LocalEngine | null;
  now?: () => number;
  log?: (m: string) => void;
}

export const RUN_ID = 'summaries-test';

/** Progress share of each phase (the Runs panel's bar). */
const PHASES = ['extract', 'check', 'write', 'done'] as const;
const PHASE_AT: Record<string, number> = { extract: 0, check: 0.65, write: 0.8, done: 1 };

/** A run's id; runs of a later round (the fixed engine, "v2") keep the round in it. */
export function runIdOf(
  bookKey: string,
  setup: SetupId,
  background: boolean,
  round = 'round1',
): string {
  const base = `${bookKey}|${setup}|${background ? 'bg1' : 'bg0'}`;
  return round === 'round1' ? base : `${base}|${round}`;
}

export class SummaryTestService {
  readonly pump: Pump;
  private readonly db: Database.Database;
  private readonly running = new Map<string, Promise<void>>();
  private readonly asked = new Map<string, Asked[]>();

  constructor(private readonly deps: SummaryTestDeps) {
    this.db = deps.db;
    this.pump = new Pump(deps.runner, RUN_ID);
    // A run cut off by a restart starts again (its answers are stored: nothing is asked twice).
    this.db
      .prepare(
        `UPDATE test_runs SET state = 'failed', error = 'stopped by a restart' WHERE state = 'running'`,
      )
      .run();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private engine(runId: string): EngineDeps {
    const list = this.asked.get(runId) ?? [];
    this.asked.set(runId, list);
    return { runner: this.deps.runner, pump: this.pump, runId: RUN_ID, onAsk: (a) => list.push(a) };
  }

  // -------------------------------------------------------------------------------------------
  // books

  addBook(b: TestBook): void {
    this.db
      .prepare(
        `INSERT INTO test_books (key, title, file, series, volume, characters, reader_id, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET title = excluded.title, file = excluded.file,
           series = excluded.series, volume = excluded.volume, characters = excluded.characters,
           reader_id = excluded.reader_id`,
      )
      .run(b.key, b.title, b.file, b.series, b.volume, b.characters, b.readerId, this.now());
  }

  /** Adds a test book by its exact title in the test copy's library. */
  addByTitle(key: string, title: string, series: string | null, volume: number | null): TestBook {
    const f = this.deps.findBook?.(title);
    if (!f) throw new Error(`no book titled ${title} in the test copy's library`);
    const b: TestBook = {
      key,
      title,
      file: f.file,
      series,
      volume,
      characters: f.characters,
      readerId: f.id,
    };
    this.addBook(b);
    return b;
  }

  books(): TestBook[] {
    return (
      this.db.prepare('SELECT * FROM test_books ORDER BY series, volume, title').all() as {
        key: string;
        title: string;
        file: string;
        series: string | null;
        volume: number | null;
        characters: number;
        reader_id: string | null;
      }[]
    ).map((r) => ({
      key: r.key,
      title: r.title,
      file: r.file,
      series: r.series,
      volume: r.volume,
      characters: r.characters,
      readerId: r.reader_id,
    }));
  }

  book(key: string): TestBook | null {
    return this.books().find((b) => b.key === key) ?? null;
  }

  private async input(b: TestBook, background: boolean) {
    if (!b.readerId) throw new Error(`${b.title}: not in the test copy's library`);
    const script = await this.deps.scriptOf(b.readerId);
    let bg: string | null = null;
    if (background) {
      if (!b.series || b.volume === null) throw new Error(`${b.title}: no series volume`);
      const earlier = this.books().filter(
        (x) => x.series === b.series && x.volume !== null && x.volume < b.volume!,
      );
      const vols: { title: string; summary: Summary }[] = [];
      for (const e of earlier) {
        const s = this.bestSummary(e.key);
        if (!s) throw new Error(`${b.title}: no summary of the earlier volume ${e.title} yet`);
        vols.push({ title: e.title, summary: s });
      }
      bg = backgroundText(vols);
    }
    return { key: b.key, title: b.title, script, lang: 'ja', background: bg };
  }

  /** The background volumes' summary: the chosen setup's (the newest finished run). */
  private bestSummary(bookKey: string): Summary | null {
    const r = this.db
      .prepare(
        `SELECT s.summary_json FROM test_summaries s JOIN test_runs r ON r.id = s.run_id
         WHERE r.book_key = ? AND r.background = 0 AND r.state = 'done' AND s.lang = 'ja'
           AND r.setup = COALESCE((SELECT value FROM test_state WHERE key = 'backgroundSetup'), r.setup)
         ORDER BY r.ended_at DESC LIMIT 1`,
      )
      .get(bookKey) as { summary_json: string } | undefined;
    return r ? (JSON.parse(r.summary_json) as Summary) : null;
  }

  // -------------------------------------------------------------------------------------------
  // runs

  start(bookKey: string, setup: SetupId, background: boolean, round: string): RunRow {
    const b = this.book(bookKey);
    if (!b) throw new Error(`no test book ${bookKey}`);
    if (setup === 'local' && !this.deps.local) throw new Error('the local model is not set up');
    const id = runIdOf(bookKey, setup, background, round);
    const cur = this.run(id);
    if (cur?.state === 'running' && this.running.has(id)) return cur;
    this.db
      .prepare(
        `INSERT INTO test_runs (id, book_key, setup, background, round, state, phase, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', 'extract', ?)
         ON CONFLICT(id) DO UPDATE SET state = 'running', phase = 'extract', error = NULL,
           round = excluded.round, started_at = excluded.started_at, ended_at = NULL`,
      )
      .run(id, bookKey, setup, background ? 1 : 0, round, this.now());
    // Questions given up after their tries (network errors) are asked again when a run is
    // started again; answered, refused and unusable ones never are.
    for (const stage of new Set(ALL_SPECS.map((s) => s.stage)))
      this.deps.runner.askAgain(stage, RUN_ID);
    this.pump.start();
    this.asked.set(id, []);
    const p = this.execute(id, b, setup, background).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return this.run(id)!;
  }

  /** Waits for a run (tests, the CLI). */
  async settled(id: string): Promise<RunRow | null> {
    await this.running.get(id);
    return this.run(id);
  }

  private phase(id: string, phase: string) {
    this.db.prepare('UPDATE test_runs SET phase = ? WHERE id = ?').run(phase, id);
  }

  private async execute(id: string, b: TestBook, setup: SetupId, background: boolean) {
    const started = this.now();
    try {
      const inp = await this.input(b, background);
      let summary: Summary;
      let metrics: RunMetrics;
      if (setup === 'local') {
        const r = await this.deps.local!.run(inp, (ph) => this.phase(id, ph));
        summary = r.summary;
        metrics = r.metrics;
      } else {
        const d = this.engine(id);
        const watch = setInterval(() => this.phase(id, this.guessPhase(id)), 1000);
        let res;
        try {
          res = await runCloudSetup(d, inp, setup, () => this.now());
        } finally {
          clearInterval(watch);
        }
        const m = askedMetrics(this.db, this.asked.get(id) ?? []);
        const rep = res.report;
        metrics = {
          ...m,
          // The stored request times, so a run started again (answered from the store) or
          // resumed after a stop keeps its time.
          seconds: m.busySeconds || m.spanSeconds || (this.now() - started) / 1000,
          extracted: Object.fromEntries(
            Object.entries(rep.extracted).map(([role, e]) => [
              role,
              {
                extracted: e.extracted,
                quoteNotFound: e.quoteNotFound,
                kept: e.items.length,
                emptyChapters: e.emptyChapters.length,
                notStory: e.notStory.length,
              },
            ]),
          ),
          confirmed: rep.cross.confirmed,
          crossChecked: rep.cross.checked,
          supported: rep.cross.supported,
          partly: rep.cross.partly,
          notSupported: rep.cross.notSupported + rep.cross.noVerdict,
          writtenDropped: rep.writtenDropped,
          refusals: rep.refusals,
          droppedQuotes: Object.entries(rep.extracted).flatMap(([role, e]) =>
            e.droppedQuotes.map((q) => ({ model: role, ...q })),
          ),
          droppedItems: rep.droppedItems,
        };
        summary = res.summary;
      }
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO test_summaries (run_id, lang, summary_json, made_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(run_id, lang) DO UPDATE SET summary_json = excluded.summary_json, made_at = excluded.made_at`,
          )
          .run(id, summary.lang, JSON.stringify(summary), this.now());
        this.db
          .prepare(
            `UPDATE test_runs SET state = 'done', phase = 'done', ended_at = ?, metrics_json = ? WHERE id = ?`,
          )
          .run(this.now(), JSON.stringify(metrics), id);
      })();
    } catch (e) {
      const refused = e instanceof Refused;
      const m = askedMetrics(this.db, this.asked.get(id) ?? []);
      this.db
        .prepare(
          `UPDATE test_runs SET state = ?, error = ?, ended_at = ?, metrics_json = ? WHERE id = ?`,
        )
        .run(
          refused ? 'refused' : 'failed',
          String((e as Error).message ?? e).slice(0, 500),
          this.now(),
          JSON.stringify({
            ...m,
            seconds: (this.now() - started) / 1000,
            refusals: refused ? [{ stage: (e as Refused).stage, model: (e as Refused).model }] : [],
          }),
          id,
        );
      this.deps.log?.(
        `Summaries test: ${id} ${refused ? 'refused' : 'failed'}: ${(e as Error).message}`,
      );
    }
  }

  /** The phase from the questions asked so far (extraction, checks, writing). */
  private guessPhase(id: string): string {
    const stages = new Set((this.asked.get(id) ?? []).map((a) => a.stage));
    if (stages.has('sum.write')) return 'write';
    if (stages.has('sum.match') || stages.has('sum.support')) return 'check';
    return 'extract';
  }

  run(id: string): RunRow | null {
    const r = this.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as
      | RunDbRow
      | undefined;
    return r ? runRow(r) : null;
  }

  runs(): RunRow[] {
    return (this.db.prepare('SELECT * FROM test_runs ORDER BY started_at').all() as RunDbRow[]).map(
      runRow,
    );
  }

  /** Progress (0-1) and seconds left, from earlier finished runs of the same setup. */
  progress(r: RunRow): { done: number; secondsLeft: number | null } {
    if (r.state !== 'running') return { done: r.state === 'done' ? 1 : 0, secondsLeft: null };
    const b = this.book(r.bookKey);
    const done = PHASE_AT[r.phase ?? 'extract'] ?? 0;
    const like = this.runs().filter(
      (x) => x.setup === r.setup && x.state === 'done' && x.metrics && x.id !== r.id,
    );
    if (!like.length || !b) return { done, secondsLeft: null };
    // Seconds per 1,000 characters of the finished runs of this setup.
    const per =
      like.reduce(
        (a, x) => a + x.metrics!.seconds / Math.max(1, this.book(x.bookKey)?.characters ?? 1),
        0,
      ) / like.length;
    const total = per * b.characters;
    const elapsed = (this.now() - r.startedAt) / 1000;
    return {
      done: Math.max(done, Math.min(0.95, elapsed / total)),
      secondsLeft: Math.max(0, total - elapsed),
    };
  }

  /** The book's chapters with their reader positions (quote places on the summary page). */
  async chapters(
    bookKey: string,
  ): Promise<{ chapters: { index: number; title: string; start: number }[]; characters: number }> {
    const b = this.book(bookKey);
    if (!b?.readerId) return { chapters: [], characters: 0 };
    const s = await this.deps.scriptOf(b.readerId);
    return {
      chapters: s.chapters.map((c, i) => ({ index: i, title: c.title, start: c.startCharacter })),
      characters: s.characters,
    };
  }

  summary(runId: string, lang = 'ja'): Summary | null {
    const r = this.db
      .prepare('SELECT summary_json FROM test_summaries WHERE run_id = ? AND lang = ?')
      .get(runId, lang) as { summary_json: string } | undefined;
    return r ? (JSON.parse(r.summary_json) as Summary) : null;
  }

  languages(runId: string): string[] {
    return (
      this.db
        .prepare('SELECT lang FROM test_summaries WHERE run_id = ? ORDER BY made_at')
        .all(runId) as {
        lang: string;
      }[]
    ).map((x) => x.lang);
  }

  async translateRun(runId: string, to: string): Promise<Summary> {
    const s = this.summary(runId);
    if (!s) throw new Error(`no summary for ${runId}`);
    this.pump.start();
    const t = await translate(this.engine(runId), runId, s, to);
    this.db
      .prepare(
        `INSERT INTO test_summaries (run_id, lang, summary_json, made_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id, lang) DO UPDATE SET summary_json = excluded.summary_json, made_at = excluded.made_at`,
      )
      .run(runId, to, JSON.stringify(t.summary), this.now());
    return t.summary;
  }

  // -------------------------------------------------------------------------------------------
  // judging

  /**
   * The judging data of a book's runs in a scope ("round1": the setups; "bg": with and without
   * background): each run's single claims, then the same claim across runs grouped. Asked once;
   * groups the user changed are kept.
   */
  async prepareJudging(bookKey: string, scope: string, runIds: string[]): Promise<void> {
    const b = this.book(bookKey);
    if (!b) throw new Error(`no test book ${bookKey}`);
    this.pump.start();
    const d = this.engine(`judge|${bookKey}|${scope}`);
    for (const runId of runIds) {
      const s = this.summary(runId);
      if (!s) throw new Error(`no summary for ${runId}`);
      const items = summaryItems(s).map(({ section, item }) => ({
        ref: item.ref,
        section,
        text: [item.heading, item.between?.join(' / '), item.text].filter(Boolean).join(': '),
      }));
      const a = await ask(d, CLAIMS_SPEC, 'sonnet', runId, { title: b.title, items });
      if (a.state !== 'answered' || !a.answer) throw new Error(`claims of ${runId}: ${a.state}`);
      const byRef = new Map(summaryItems(s).map((x) => [x.item.ref, x]));
      const ins = this.db.prepare(
        `INSERT INTO test_claims (run_id, ref, text, section, quote, position) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, ref) DO NOTHING`,
      );
      this.db.transaction(() => {
        for (const it of (a.answer as { items: { ref: string; claims: string[] }[] }).items) {
          const src = byRef.get(it.ref);
          if (!src) continue;
          it.claims.forEach((c, k) =>
            ins.run(runId, `${it.ref}#${k}`, c, src.section, src.item.quote, src.item.position),
          );
        }
      })();
    }
    const claims = this.db
      .prepare(
        `SELECT id, run_id, ref, text, group_id FROM test_claims WHERE run_id IN (${runIds.map(() => '?').join(',')})
         ORDER BY run_id, id`,
      )
      .all(...runIds) as {
      id: number;
      run_id: string;
      ref: string;
      text: string;
      group_id: number | null;
    }[];
    if (claims.every((c) => c.group_id !== null)) return;
    // A run added before anything is judged: group every claim again, so the new run's claims
    // join the same claims of the others. Once a mark or a user's group exists, the groups stay
    // (the new claims get groups of their own, to merge on the page).
    const judged = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM test_marks m JOIN test_groups g ON g.id = m.group_id WHERE g.book_key = ? AND g.scope = ?)
              + (SELECT COUNT(*) FROM test_groups WHERE book_key = ? AND scope = ? AND made_by = 'user')
              + (SELECT COUNT(*) FROM test_claims c JOIN test_groups g ON g.id = c.group_id
                 WHERE g.book_key = ? AND g.scope = ? AND c.mark IS NOT NULL) AS n`,
      )
      .get(bookKey, scope, bookKey, scope, bookKey, scope) as { n: number };
    if (judged.n === 0) {
      this.db.transaction(() => {
        const ids = (
          this.db
            .prepare('SELECT id FROM test_groups WHERE book_key = ? AND scope = ?')
            .all(bookKey, scope) as { id: number }[]
        ).map((g) => g.id);
        for (const id of ids) {
          this.db.prepare('UPDATE test_claims SET group_id = NULL WHERE group_id = ?').run(id);
          this.db.prepare('DELETE FROM test_groups WHERE id = ?').run(id);
        }
      })();
      for (const c of claims) c.group_id = null;
    }
    // The ids the model sees: stable (run index and ref), never database row ids.
    const label = (c: (typeof claims)[number]) => `${runIds.indexOf(c.run_id)}.${c.ref}`;
    const g = await ask(d, GROUP_SPEC, 'sonnet', `${bookKey}|${scope}`, {
      title: b.title,
      claims: claims.map((c) => ({ id: label(c), text: c.text })),
    });
    if (g.state !== 'answered' || !g.answer) throw new Error(`groups of ${bookKey}: ${g.state}`);
    const byLabel = new Map(claims.map((c) => [label(c), c]));
    const newGroup = this.db.prepare(
      `INSERT INTO test_groups (book_key, scope, text, made_by) VALUES (?, ?, ?, 'model')`,
    );
    const setGroup = this.db.prepare(
      'UPDATE test_claims SET group_id = ? WHERE id = ? AND group_id IS NULL',
    );
    this.db.transaction(() => {
      const placed = new Set<number>();
      for (const grp of (g.answer as { groups: { text: string; ids: string[] }[] }).groups) {
        const members = grp.ids
          .map((i) => byLabel.get(i))
          .filter((c): c is (typeof claims)[number] => !!c && !placed.has(c.id));
        if (!members.length) continue;
        const gid = Number(newGroup.run(bookKey, scope, grp.text).lastInsertRowid);
        for (const c of members) {
          setGroup.run(gid, c.id);
          placed.add(c.id);
        }
      }
      // A claim the model left out is a group of its own.
      for (const c of claims)
        if (!placed.has(c.id) && c.group_id === null) {
          const gid = Number(newGroup.run(bookKey, scope, c.text).lastInsertRowid);
          setGroup.run(gid, c.id);
        }
    })();
  }

  /** The judging view of a book and scope. */
  judging(bookKey: string, scope: string) {
    const groups = this.db
      .prepare(
        `SELECT g.id, g.text, g.made_by, m.mark, m.note FROM test_groups g
         LEFT JOIN test_marks m ON m.group_id = g.id WHERE g.book_key = ? AND g.scope = ? ORDER BY g.id`,
      )
      .all(bookKey, scope) as {
      id: number;
      text: string;
      made_by: string;
      mark: string | null;
      note: string | null;
    }[];
    const claims = this.db
      .prepare(
        `SELECT c.id, c.run_id, c.ref, c.text, c.section, c.quote, c.position, c.group_id, c.mark FROM test_claims c
         JOIN test_groups g ON g.id = c.group_id WHERE g.book_key = ? AND g.scope = ? ORDER BY c.id`,
      )
      .all(bookKey, scope) as {
      id: number;
      run_id: string;
      ref: string;
      text: string;
      section: string;
      quote: string | null;
      position: number | null;
      group_id: number;
      mark: string | null;
    }[];
    const missing = this.db
      .prepare(
        'SELECT id, text, added_at FROM test_missing WHERE book_key = ? AND scope = ? ORDER BY id',
      )
      .all(bookKey, scope) as { id: number; text: string; added_at: number }[];
    const byGroup = new Map<number, typeof claims>();
    for (const c of claims) byGroup.set(c.group_id, [...(byGroup.get(c.group_id) ?? []), c]);
    return {
      groups: groups
        .map((g) => ({ ...g, claims: byGroup.get(g.id) ?? [] }))
        .filter((g) => g.claims.length > 0),
      missing,
    };
  }

  mark(groupId: number, mark: 'right' | 'wrong' | 'unsure' | null, note: string | null): void {
    if (mark === null) this.db.prepare('DELETE FROM test_marks WHERE group_id = ?').run(groupId);
    else
      this.db
        .prepare(
          `INSERT INTO test_marks (group_id, mark, note, marked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(group_id) DO UPDATE SET mark = excluded.mark, note = excluded.note, marked_at = excluded.marked_at`,
        )
        .run(groupId, mark, note, this.now());
  }

  /**
   * Marks one setup's version of a claim (when the setups said it differently): it overrides
   * the group's mark for that version; null goes back to the group's mark.
   */
  markClaim(claimId: number, mark: 'right' | 'wrong' | 'unsure' | null): void {
    const r = this.db.prepare('UPDATE test_claims SET mark = ? WHERE id = ?').run(mark, claimId);
    if (r.changes === 0) throw new Error('no such claim');
  }

  /** Moves a claim to another group of the same book and scope, or to a new group of its own. */
  moveClaim(claimId: number, toGroup: number | 'new'): number {
    const c = this.db
      .prepare(
        `SELECT c.id, c.text, c.group_id, g.book_key, g.scope FROM test_claims c JOIN test_groups g ON g.id = c.group_id WHERE c.id = ?`,
      )
      .get(claimId) as
      | { id: number; text: string; group_id: number; book_key: string; scope: string }
      | undefined;
    if (!c) throw new Error('no such claim');
    let target: number;
    if (toGroup === 'new') {
      target = Number(
        this.db
          .prepare(
            `INSERT INTO test_groups (book_key, scope, text, made_by) VALUES (?, ?, ?, 'user')`,
          )
          .run(c.book_key, c.scope, c.text).lastInsertRowid,
      );
    } else {
      const g = this.db
        .prepare('SELECT book_key, scope FROM test_groups WHERE id = ?')
        .get(toGroup) as { book_key: string; scope: string } | undefined;
      if (!g || g.book_key !== c.book_key || g.scope !== c.scope)
        throw new Error('not a group of this book');
      target = toGroup;
    }
    this.db.prepare('UPDATE test_claims SET group_id = ? WHERE id = ?').run(target, claimId);
    return target;
  }

  /** Merges group `from` into `into` (its claims move; its mark goes). */
  mergeGroups(from: number, into: number): void {
    if (from === into) return;
    const a = this.db.prepare('SELECT book_key, scope FROM test_groups WHERE id = ?');
    const x = a.get(from) as { book_key: string; scope: string } | undefined;
    const y = a.get(into) as { book_key: string; scope: string } | undefined;
    if (!x || !y || x.book_key !== y.book_key || x.scope !== y.scope)
      throw new Error('not groups of one book');
    this.db.transaction(() => {
      this.db.prepare('UPDATE test_claims SET group_id = ? WHERE group_id = ?').run(into, from);
      this.db.prepare('DELETE FROM test_marks WHERE group_id = ?').run(from);
    })();
  }

  /** A note on a book (runId null) or on one setup's summary of it. */
  addMissing(
    bookKey: string,
    scope: string,
    text: string,
    runId: string | null = null,
    section: string | null = null,
  ): number {
    return Number(
      this.db
        .prepare(
          'INSERT INTO test_missing (book_key, scope, text, added_at, run_id, section) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(bookKey, scope, text.trim(), this.now(), runId, section).lastInsertRowid,
    );
  }

  /** A note's new text (kept as written, line breaks and all), and optionally its summary. */
  updateMissing(id: number, text: string, runId?: string | null, section?: string | null): void {
    if (section !== undefined)
      this.db.prepare('UPDATE test_missing SET section = ? WHERE id = ?').run(section, id);
    const r =
      runId === undefined
        ? this.db
            .prepare('UPDATE test_missing SET text = ?, edited_at = ? WHERE id = ?')
            .run(text.trim(), this.now(), id)
        : this.db
            .prepare('UPDATE test_missing SET text = ?, run_id = ?, edited_at = ? WHERE id = ?')
            .run(text.trim(), runId, this.now(), id);
    if (r.changes === 0) throw new Error('no such note');
  }

  removeMissing(id: number): void {
    this.db.prepare('DELETE FROM test_missing WHERE id = ?').run(id);
  }

  /**
   * Each run's scores from the marks: groups it made that are right, wrong, unsure or not yet
   * marked, and what it missed (right groups only other runs made, plus what the user added).
   */
  scores(bookKey: string, scope: string) {
    const j = this.judging(bookKey, scope);
    const runIds = [...new Set(j.groups.flatMap((g) => g.claims.map((c) => c.run_id)))].sort();
    // A setup's mark on a group: its versions' own marks where you marked them (the worst one
    // counts: wrong, then unsure, then right), else the group's mark. Not marked when any of
    // its versions has no mark at all.
    const rank: Record<string, number> = { wrong: 3, unsure: 2, right: 1 };
    const markOf = (g: (typeof j.groups)[number], runId: string): string | null => {
      let worst: string | null = null;
      for (const c of g.claims) {
        if (c.run_id !== runId) continue;
        const m = c.mark ?? g.mark;
        if (!m) return null;
        if (!worst || rank[m] > rank[worst]) worst = m;
      }
      return worst;
    };
    const anyRight = (g: (typeof j.groups)[number]) =>
      g.mark === 'right' || g.claims.some((c) => c.mark === 'right');
    return runIds.map((runId) => {
      const run = this.run(runId);
      const mine = j.groups.filter((g) => g.claims.some((c) => c.run_id === runId));
      const count = (m: string | null) => mine.filter((g) => markOf(g, runId) === m).length;
      const missedOthers = j.groups.filter(
        (g) => anyRight(g) && !g.claims.some((c) => c.run_id === runId),
      ).length;
      return {
        runId,
        setup: run?.setup ?? null,
        background: run?.background ?? false,
        label: run
          ? `${SETUP_LABELS[run.setup]}${run.background ? ' · with earlier volumes' : ''}`
          : runId,
        claims: mine.length,
        right: count('right'),
        wrong: count('wrong'),
        unsure: count('unsure'),
        unmarked: count(null),
        missed: missedOthers + j.missing.length,
        missedFoundByOthers: missedOthers,
        missedByAll: j.missing.length,
        metrics: run?.metrics ?? null,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // judging whole items (the page since 2026-11-22)

  /** Marks one item of a run's summary; null clears it. */
  markItem(runId: string, ref: string, mark: ItemMark | null): void {
    const s = this.summary(runId);
    if (!s || !summaryItems(s).some((x) => x.item.ref === ref)) throw new Error('no such item');
    this.db.prepare('DELETE FROM test_item_copies WHERE run_id = ? AND ref = ?').run(runId, ref);
    if (mark === null)
      this.db.prepare('DELETE FROM test_item_marks WHERE run_id = ? AND ref = ?').run(runId, ref);
    else
      this.db
        .prepare(
          `INSERT INTO test_item_marks (run_id, ref, mark, marked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id, ref) DO UPDATE SET mark = excluded.mark, marked_at = excluded.marked_at`,
        )
        .run(runId, ref, mark, this.now());
  }

  /**
   * Gives an item the user's mark on the same item in another summary of the same book. Only
   * items not marked yet; the source must be marked by the user themself (not copied).
   */
  copyMark(runId: string, ref: string, fromRun: string, fromRef: string): ItemMark {
    const run = this.runs().find((r) => r.id === runId);
    const from = this.runs().find((r) => r.id === fromRun);
    if (!run || !from || run.bookKey !== from.bookKey || runId === fromRun)
      throw new Error('the two summaries must be different summaries of one book');
    const s = this.summary(runId);
    if (!s || !summaryItems(s).some((x) => x.item.ref === ref)) throw new Error('no such item');
    const source = this.db
      .prepare('SELECT mark FROM test_item_marks WHERE run_id = ? AND ref = ?')
      .get(fromRun, fromRef) as { mark: ItemMark } | undefined;
    if (!source) throw new Error(`${fromRun} ${fromRef} is not marked`);
    if (
      this.db
        .prepare('SELECT 1 FROM test_item_copies WHERE run_id = ? AND ref = ?')
        .get(fromRun, fromRef)
    )
      throw new Error(`${fromRun} ${fromRef} has a copied mark`);
    if (
      this.db.prepare('SELECT 1 FROM test_item_marks WHERE run_id = ? AND ref = ?').get(runId, ref)
    )
      throw new Error(`${runId} ${ref} is already marked`);
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO test_item_marks (run_id, ref, mark, marked_at) VALUES (?, ?, ?, ?)')
        .run(runId, ref, source.mark, now);
      this.db
        .prepare(
          'INSERT INTO test_item_copies (run_id, ref, from_run, from_ref, copied_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(runId, ref, fromRun, fromRef, now);
    })();
    return source.mark;
  }

  /** A book's finished runs with their summaries and item marks, the missing notes and scores. */
  itemJudging(bookKey: string, scope = 'round1') {
    const runs = this.runs().filter(
      (r) =>
        r.bookKey === bookKey && r.state === 'done' && (isRound(scope) ? r.round === scope : true),
    );
    const marksOf = this.db.prepare('SELECT ref, mark FROM test_item_marks WHERE run_id = ?');
    const copiesOf = this.db.prepare('SELECT ref, from_run FROM test_item_copies WHERE run_id = ?');
    const checksOf = this.db.prepare(
      'SELECT ref, verdict, reason, spot FROM test_item_checks WHERE run_id = ?',
    );
    const gradesOf = this.db.prepare('SELECT section, grade FROM test_tab_grades WHERE run_id = ?');
    const labelOf = (id: string) => {
      const r = this.runs().find((x) => x.id === id);
      return r ? `${SETUP_LABELS[r.setup]}${r.background ? ' · with earlier volumes' : ''}` : id;
    };
    const missing = this.db
      .prepare(
        'SELECT id, text, added_at, run_id, section FROM test_missing WHERE book_key = ? AND scope = ? ORDER BY id',
      )
      .all(bookKey, scope) as {
      id: number;
      text: string;
      added_at: number;
      run_id: string | null;
      section: string | null;
    }[];
    const out = runs
      .map((r) => {
        const summary = this.summary(r.id);
        if (!summary) return null;
        const marks = Object.fromEntries(
          (marksOf.all(r.id) as { ref: string; mark: ItemMark }[]).map((m) => [m.ref, m.mark]),
        ) as Record<string, ItemMark>;
        const copied = Object.fromEntries(
          (copiesOf.all(r.id) as { ref: string; from_run: string }[])
            .filter((c) => marks[c.ref])
            .map((c) => [c.ref, labelOf(c.from_run)]),
        ) as Record<string, string>;
        const checks = Object.fromEntries(
          (
            checksOf.all(r.id) as {
              ref: string;
              verdict: ItemMark;
              reason: string | null;
              spot: number;
            }[]
          ).map((c) => [c.ref, { verdict: c.verdict, reason: c.reason, spot: c.spot === 1 }]),
        ) as Record<string, { verdict: ItemMark; reason: string | null; spot: boolean }>;
        const grades = Object.fromEntries(
          (gradesOf.all(r.id) as { section: string; grade: TabGrade }[]).map((g) => [
            g.section,
            g.grade,
          ]),
        ) as Record<string, TabGrade>;
        const refs = summaryItems(summary).map((x) => x.item.ref);
        // An item's mark: yours, else Claude's check of it (a spot check waits for yours).
        const marked = (ref: string): ItemMark | undefined =>
          marks[ref] ?? (checks[ref] && !checks[ref].spot ? checks[ref].verdict : undefined);
        const count = (m: ItemMark) => refs.filter((ref) => marked(ref) === m).length;
        const spots = refs.filter((ref) => checks[ref]?.spot);
        const needsYou = (ref: string) =>
          !marks[ref] && (!checks[ref] || checks[ref].verdict !== 'right' || checks[ref].spot);
        return {
          id: r.id,
          setup: r.setup,
          background: r.background,
          label: `${SETUP_LABELS[r.setup]}${r.background ? ' · with earlier volumes' : ''}`,
          summary,
          marks,
          copied,
          score: {
            items: refs.length,
            right: count('right'),
            mistake: count('mistake'),
            notNeeded: count('not_needed'),
            unsure: count('unsure'),
            unmarked: refs.filter((ref) => !marked(ref)).length,
            notes: missing.filter((m) => m.run_id === r.id).length,
            copied: refs.filter((ref) => copied[ref]).length,
            // Claude's check: items it found right, items it flagged.
            claudeRight: refs.filter((ref) => checks[ref]?.verdict === 'right').length,
            claudeFlagged: refs.filter((ref) => checks[ref] && checks[ref].verdict !== 'right')
              .length,
            // What waits for you: no mark of yours, and Claude flagged it, didn't check it, or
            // it is a spot check.
            needsYou: refs.filter(needsYou).length,
            spotChecks: spots.length,
            spotMarked: spots.filter((ref) => marks[ref]).length,
            spotAgreed: spots.filter((ref) => marks[ref] === 'right').length,
          },
          needsYou: refs.filter(needsYou),
          checks,
          grades,
          notes: missing.filter((m) => m.run_id === r.id),
          metrics: r.metrics,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    out.sort(
      (a, b) =>
        SETUP_ORDER.indexOf(a.setup) - SETUP_ORDER.indexOf(b.setup) ||
        Number(a.background) - Number(b.background),
    );
    return {
      book: this.book(bookKey),
      runs: out,
      missing: missing.filter((m) => m.run_id === null),
    };
  }

  /**
   * Claude's check of a summary's items against the book (replaces earlier checks of the same
   * items). Of the items found right, SPOT_CHECKS chosen by a hash of their ref (the same every
   * time) are spot checks: they wait for the user's own mark.
   */
  setChecks(
    runId: string,
    checks: { ref: string; verdict: ItemMark; reason?: string | null }[],
  ): { saved: number; spot: number } {
    const s = this.summary(runId);
    if (!s) throw new Error(`no summary for ${runId}`);
    const refs = new Set(summaryItems(s).map((x) => x.item.ref));
    for (const c of checks) {
      if (!refs.has(c.ref)) throw new Error(`${runId} has no item ${c.ref}`);
      if (!['right', 'mistake', 'not_needed', 'unsure'].includes(c.verdict))
        throw new Error(`${c.ref}: verdict must be right, mistake, not_needed or unsure`);
    }
    const now = this.now();
    const put = this.db.prepare(
      `INSERT INTO test_item_checks (run_id, ref, verdict, reason, spot, checked_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(run_id, ref) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, spot = 0, checked_at = excluded.checked_at`,
    );
    const hash = (ref: string) => createHash('sha1').update(`${runId}|${ref}`).digest('hex');
    let spot = 0;
    this.db.transaction(() => {
      for (const c of checks) put.run(runId, c.ref, c.verdict, c.reason ?? null, now);
      const right = (
        this.db
          .prepare(`SELECT ref FROM test_item_checks WHERE run_id = ? AND verdict = 'right'`)
          .all(runId) as { ref: string }[]
      )
        .map((r) => r.ref)
        .sort((a, b) => (hash(a) < hash(b) ? -1 : 1));
      this.db.prepare('UPDATE test_item_checks SET spot = 0 WHERE run_id = ?').run(runId);
      const mark = this.db.prepare(
        'UPDATE test_item_checks SET spot = 1 WHERE run_id = ? AND ref = ?',
      );
      for (const ref of right.slice(0, SPOT_CHECKS)) {
        mark.run(runId, ref);
        spot++;
      }
    })();
    return { saved: checks.length, spot };
  }

  /** The user's grade of one tab of a summary (against the other setups' same tab); null clears. */
  gradeTab(runId: string, section: string, grade: TabGrade | null): void {
    if (!this.run(runId)) throw new Error(`no run ${runId}`);
    if (grade === null)
      this.db
        .prepare('DELETE FROM test_tab_grades WHERE run_id = ? AND section = ?')
        .run(runId, section);
    else
      this.db
        .prepare(
          `INSERT INTO test_tab_grades (run_id, section, grade, graded_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id, section) DO UPDATE SET grade = excluded.grade, graded_at = excluded.graded_at`,
        )
        .run(runId, section, grade, this.now());
  }

  // -------------------------------------------------------------------------------------------
  // state

  setState(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM test_state WHERE key = ?').run(key);
    else
      this.db
        .prepare(
          'INSERT INTO test_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
  }

  stop(): void {
    this.pump.stop();
  }
}

interface RunDbRow {
  id: string;
  book_key: string;
  setup: string;
  background: number;
  round: string;
  state: string;
  phase: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  metrics_json: string | null;
}

function runRow(r: RunDbRow): RunRow {
  return {
    id: r.id,
    bookKey: r.book_key,
    setup: r.setup as SetupId,
    background: r.background === 1,
    round: r.round,
    state: r.state as RunRow['state'],
    phase: r.phase,
    error: r.error,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    metrics: r.metrics_json ? (JSON.parse(r.metrics_json) as RunMetrics) : null,
  };
}

export { PHASES, prepared };
