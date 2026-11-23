/**
 * Calibre stage 4's AI step (WP20e): setup E on the shared framework (src/cleanup/ai/), after
 * the rules' analysis is done. Phases, resumable, in slices (as audiobook stage 5):
 *
 *   evidence  every proposed book's evidence object stored with the runner (ai_items)
 *   models    both models asked about every book (labeled first; only them with labeledOnly)
 *   decide    setup E per field (ai-decide.ts) into ai_values 'calibre4', and the book proposed
 *             again with the decided values (a value the user set is never replaced)
 *   gate      the labeled books scored (ai-gate.ts); a field below its bar pauses as the rules'
 *             gate pauses it
 *
 * Its progress lives in the stage-4 progress (`ai`). A new stage-4 analysis starts it over; a
 * changed prompt or model asks again (answers already given are kept); a changed decision rule
 * decides again without asking. Nothing here writes to Calibre.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { AiRunner } from '../../ai/runner';
import { waitIsNote, waitNeedsUser, waitText } from '../../ai/waits';
import { runSpend } from '../../ai/spend';
import { dropOtherItems, itemDesigns, valueCounts, writeDecisions } from '../ai-decide/values';
import { getSettings, stage4Bar } from '../settings';
import { pauseField, resumeField } from '../stage2-gate';
import { getStage, pauseStage, resumeStage, updateStage } from '../stages';
import {
  STAGE4_AI_DECIDE_VERSION,
  decideStage4Ai,
  decideStage4AiUpgrade,
  decisionRows,
  storedAiValues,
} from './ai-decide';
import { scoreAiGate, type AiGate } from './ai-gate';
import {
  STAGE4_EVIDENCE_VERSION,
  STAGE4_PROMPT_VERSION,
  STAGE4_SPEC,
  stage4Evidence,
  stage4EvidenceText,
} from './ai-prompt';
import { oneTimePassesDone, type Stage4Analysis, type Stage4Progress } from './analysis';
import { SCORED_FIELDS, FIELD_NAMES } from './score';
import { STAGE4_RULES_VERSION } from './stage4-rules';
import { chooseSpellings, seriesKey } from './series-spelling';
import {
  addSeriesChecks,
  emptyChecks,
  orderSeries,
  type SeriesBook,
  type SeriesChecks,
  type SeriesChoice,
} from './series-order';
import { clearSeriesOrder, writeSeriesOrder, type SeriesOrderRow } from './series-order-store';

const STAGE = 4;
/** Labeled books the gate reads per step, and its counting steps after them (its bar). */
const GATE_CHUNK = 100;
const GATE_TAIL = 4;
const SLICE = 50;
/** The longest stretch the step keeps the server (lessons 3: a blocking step froze it). */
const YIELD_MS = 30;

/** Gives the server back whenever the step has run YIELD_MS since it last did. */
class Yielder {
  private last = performance.now();
  async maybe(): Promise<void> {
    if (performance.now() - this.last < YIELD_MS) return;
    await new Promise((r) => setImmediate(r));
    this.last = performance.now();
  }
}

export type Stage4AiPhase =
  | 'evidence'
  | 'models'
  | 'decide'
  | 'spelling'
  | 'series'
  | 'gate'
  | 'done';

/** The series step's progress (series-order.ts): facts, then the order, then proposals again. */
export interface SeriesOrderProgress {
  part: 'facts' | 'order' | 'propose';
  cursor: number;
  /** Books of a series (facts), series (order), books proposed again (propose). */
  total: number;
  /** Across the three parts, for the bar's time left. */
  done: number;
  books: number;
  series: number;
  choices: number;
  changed: number;
  guesses: number;
  reviews: number;
  /** The library-wide checks after the order (gate 2 of the plan). */
  checks?: SeriesChecks | null;
}

export interface Stage4AiProgress {
  /** The stage-4 analysis these decisions belong to (also the runner's run id). */
  analysisId: string;
  /** When the rules' analysis finished: a later finish (books reopened) starts the AI over. */
  rulesFinishedAt?: number | null;
  phase: Stage4AiPhase;
  startedAt: number;
  finishedAt: number | null;
  cursor: number;
  items: number;
  labeledItems: number;
  askKey: string | null;
  rulesKey: string | null;
  /** How the evidence was built (STAGE4_EVIDENCE_BUILD; absent = 1). */
  evidenceBuild?: number;
  decided: number;
  invented: number;
  ai: {
    queued: number;
    sent: number;
    answered: number;
    failed: number;
    blocked: number;
    invalid: number;
  } | null;
  wait: string | null;
  cost: { costUsd: number; [k: string]: unknown } | null;
  gate: (AiGate & { at: number; passed: boolean; below: string[] }) | null;
  counts: Record<string, Record<string, number>> | null;
  /** Automatic rules values both models agreed against (flagged), per field. */
  flaggedAgainstRules: Record<string, number> | null;
  /** Best guesses (flagged values of books both models answered), per field: written at On. */
  unconfirmed?: Record<string, number> | null;
  /** The phase's start, and how far it was then (evidence: books, decide: books decided). */
  phaseStartedAt?: number;
  phaseStartDone?: number;
  /** Books the evidence phase walks (the analysis' proposed books). */
  total?: number;
  /** When the asking started, and each model's answers then (its measured rate since). */
  modelsStart?: { at: number; done: Record<string, number> } | null;
  /**
   * One spelling per series (series-spelling.ts): the chosen spelling by series key, set after
   * deciding; the books whose series proposals it changes are proposed again.
   */
  seriesSpelling?: { at: number; names: Record<string, string> } | null;
  /** The spelling phase: series with more than one spelling, and books proposed again. */
  spelling?: { series: number; books: number; total: number } | null;
  /** The gate's labeled books (its bar: these, then GATE_TAIL counting steps; `cursor`). */
  gateTotal?: number;
  /** The series step (series-order follow-up). */
  seriesOrder?: SeriesOrderProgress | null;
  error: string | null;
  times: Record<string, { ms: number; items: number }>;
}

export type Stage4AiStep = 'done' | 'more' | 'wait';

export interface Stage4AiDeps {
  db: Database.Database;
  runner: AiRunner;
  analysis: Stage4Analysis;
  log?: (m: string) => void;
}

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

/** What the answers depend on: asked again (answers kept) when it changes. */
export function stage4AskKey(db: Database.Database): string {
  const s = getSettings(db);
  return sha([
    STAGE4_PROMPT_VERSION,
    STAGE4_EVIDENCE_VERSION,
    s.models[STAGE4_SPEC.tasks.primary],
    s.models[STAGE4_SPEC.tasks.secondary],
    s.ai.labeledOnly,
  ]);
}
/**
 * How each book's evidence is built from its records. When it changes, the evidence is built
 * again (answers kept: a book whose evidence comes out as before keeps its answers) without
 * changing the evidence format (STAGE4_EVIDENCE_VERSION would change every book's hash).
 * 2: Calibre's title and authors as stage 4 found them, not its own writes read back (stop 2 of
 * the series-order follow-up: 11,991 books were asked again for nothing).
 * 3: the same evidence, built again so the questions build 2 never queued are asked (its
 * restart kept the ask key: 503 books' new evidence went unasked).
 */
export const STAGE4_EVIDENCE_BUILD = 3;
const evidenceBuildOf = (ai: Stage4AiProgress) => ai.evidenceBuild ?? 1;

/** What the decisions depend on besides the answers: decided again when it changes. */
export function stage4AiRulesKey(): string {
  return sha([STAGE4_AI_DECIDE_VERSION, STAGE4_RULES_VERSION]);
}

export function emptyStage4Ai(analysisId: string, now = Date.now()): Stage4AiProgress {
  return {
    analysisId,
    phase: 'evidence',
    startedAt: now,
    finishedAt: null,
    cursor: 0,
    items: 0,
    labeledItems: 0,
    askKey: null,
    rulesKey: null,
    evidenceBuild: STAGE4_EVIDENCE_BUILD,
    decided: 0,
    invented: 0,
    ai: null,
    wait: null,
    cost: null,
    gate: null,
    counts: null,
    flaggedAgainstRules: null,
    error: null,
    times: {},
  };
}

export class Stage4Ai {
  /** The gate's labeled books and their values, gathered over its steps (one run). */
  private gateBooks: {
    run: string;
    labeled: ReturnType<Stage4Analysis['labeledBooks']>;
    books: Parameters<typeof scoreAiGate>[0];
  } | null = null;
  /** The analysis' proposed books in calibre_id order (see books()). */
  private list: {
    key: string;
    rows: { calibre_uuid: string; calibre_id: number; labeled: number }[];
  } | null = null;

  /**
   * The series step's work in memory (facts of every book of a series, the series, the books to
   * propose again). After a restart the step starts over from the facts (about a minute).
   */
  private seriesRun: {
    key: string;
    uuids: string[];
    after: Map<
      string,
      {
        name: string | null;
        index: number | null;
        title: string;
        proposed: boolean;
        proposedSeries?: boolean;
      }
    >;
    facts: SeriesBook[];
    groups: SeriesBook[][];
    changed: string[];
    checks: SeriesChecks;
  } | null = null;

  /** The books the spelling phase proposes again, in uuid order (rebuilt after a restart). */
  private respell: { key: string; uuids: string[] } | null = null;

  /** WP20g: the design each item keeps (new arrivals decided with J), read once per decide. */
  private designs: Map<string, string> | null = null;

  constructor(private readonly deps: Stage4AiDeps) {}

  private get db(): Database.Database {
    return this.deps.db;
  }

  private stage4(): (Stage4Progress & { ai?: Stage4AiProgress }) | null {
    return this.deps.analysis.progress() as (Stage4Progress & { ai?: Stage4AiProgress }) | null;
  }

  /** The AI step's progress for the current stage-4 analysis (null before it starts). */
  progress(): Stage4AiProgress | null {
    const p = this.stage4();
    return p?.ai && p.ai.analysisId === p.analysisId && p.ai.rulesFinishedAt === p.finishedAt
      ? p.ai
      : null;
  }

  private save(ai: Stage4AiProgress): void {
    const p = this.stage4();
    if (!p || p.analysisId !== ai.analysisId || p.finishedAt !== ai.rulesFinishedAt) return;
    updateStage(this.db, STAGE, { progress: { ...p, ai } as unknown as Record<string, unknown> });
  }

  private next(ai: Stage4AiProgress, phase: Stage4AiPhase): void {
    ai.phase = phase;
    ai.cursor = 0;
    ai.phaseStartedAt = Date.now();
    ai.phaseStartDone = phase === 'decide' ? ai.decided : 0;
    ai.modelsStart =
      phase === 'models' ? { at: Date.now(), done: this.doneByModel(ai.analysisId) } : null;
    this.save(ai);
  }

  /** Each model's questions of this run: answered or final (done), and still to come (left). */
  private byModel(runId: string): Map<string, { done: number; left: number }> {
    const out = new Map<string, { done: number; left: number }>();
    for (const r of this.db
      .prepare(
        `SELECT model, state, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'calibre4'
         GROUP BY model, state`,
      )
      .all(runId) as { model: string; state: string; n: number }[]) {
      const m = out.get(r.model) ?? { done: 0, left: 0 };
      if (r.state === 'queued' || r.state === 'sent') m.left += r.n;
      else m.done += r.n;
      out.set(r.model, m);
    }
    return out;
  }

  private doneByModel(runId: string): Record<string, number> {
    return Object.fromEntries([...this.byModel(runId)].map(([m, c]) => [m, c.done]));
  }

  /**
   * The page's progress bar (WP20e follow-up): how far the running phase is, and the time left
   * from what was measured in it: asking, each model's own answers per minute since the asking
   * started (batches go out side by side and the calls run directWorkers at a time, so the rate
   * measures both), the step as long as its slowest model; evidence and deciding, the books per
   * minute since the phase started. null seconds = too little measured yet.
   */
  bar(
    now = Date.now(),
  ): { phase: Stage4AiPhase; done: number; total: number; secondsLeft: number | null } | null {
    const ai = this.progress();
    if (!ai || ai.phase === 'done') return null;
    const since = (done: number, total: number) => {
      const elapsed = now - (ai.phaseStartedAt ?? now);
      const n = done - (ai.phaseStartDone ?? 0);
      return n > 0 && elapsed > 0 ? Math.round(((total - done) * elapsed) / n / 1000) : null;
    };
    if (ai.phase === 'evidence') {
      const total = ai.total ?? 0;
      return {
        phase: ai.phase,
        done: ai.items,
        total,
        secondsLeft: total ? since(ai.items, total) : null,
      };
    }
    if (ai.phase === 'decide') {
      const total = ai.items;
      return { phase: ai.phase, done: ai.decided, total, secondsLeft: since(ai.decided, total) };
    }
    if (ai.phase === 'spelling') {
      const total = ai.spelling?.total ?? 0;
      return { phase: ai.phase, done: ai.cursor, total, secondsLeft: since(ai.cursor, total) };
    }
    if (ai.phase === 'series') {
      const so = ai.seriesOrder;
      // Facts, order and proposals counted together: the proposals are about as many as the
      // books with a choice until the order says how many.
      const books = so?.books || so?.total || 0;
      const total = so
        ? books + (so.series || books / 3) + (so.part === 'propose' ? so.total : books)
        : 0;
      const done = so?.done ?? 0;
      return { phase: ai.phase, done, total: Math.round(total), secondsLeft: since(done, total) };
    }
    if (ai.phase === 'gate') {
      // The labeled books in chunks, then the counting steps (2026-11-22: the gate was one
      // ~2 s step, the bar showed 0 of 0 and the server waited).
      const total = ai.gateTotal ? ai.gateTotal + GATE_TAIL : 0;
      return { phase: ai.phase, done: ai.cursor, total, secondsLeft: since(ai.cursor, total) };
    }
    if (ai.phase === 'models') {
      const models = this.byModel(ai.analysisId);
      let done = 0;
      let total = 0;
      let secs: number | null = 0;
      const start = ai.modelsStart;
      for (const [model, c] of models) {
        done += c.done;
        total += c.done + c.left;
        if (!c.left) continue;
        const elapsed = start ? now - start.at : 0;
        const n = c.done - (start?.done[model] ?? 0);
        if (n <= 0 || elapsed <= 0) secs = null;
        else if (secs !== null) secs = Math.max(secs, Math.round((c.left * elapsed) / n / 1000));
      }
      return { phase: ai.phase, done, total, secondsLeft: secs };
    }
    return { phase: ai.phase, done: 0, total: 0, secondsLeft: null };
  }

  private time(ai: Stage4AiProgress, phase: string, ms: number, items: number): void {
    const t = (ai.times[phase] ??= { ms: 0, items: 0 });
    t.ms += ms;
    t.items += items;
  }

  private unpause(): void {
    if (getStage(this.db, STAGE).pauseReason === 'ai') resumeStage(this.db, STAGE);
  }

  /**
   * The given-up questions asked again (the page's button): they go back to the queue, and the
   * step returns to asking, then decides every book again (the stored answers of the others give
   * the same values) and runs the gate. Returns how many questions were queued.
   */
  askAgain(): number {
    const ai = this.progress();
    if (!ai) return 0;
    const n = this.deps.runner.askAgain('calibre4', ai.analysisId);
    if (n > 0 && ai.phase !== 'evidence' && ai.phase !== 'models') {
      ai.decided = 0;
      ai.invented = 0;
      ai.finishedAt = null;
      ai.gate = null;
      this.next(ai, 'models');
    }
    if (n > 0) this.deps.log?.(`Stage 4: ${n} given-up AI questions asked again`);
    return n;
  }

  /**
   * Books whose stage-4 changes were all undone (the test batches before the run, WP20e: written,
   * checked against Calibre and undone; deciding again never proposes them by itself because
   * their rows stay 'undone'). WP20f: they are written with the rest before stage 5.
   */
  undoneBooks(): string[] {
    const p = this.stage4();
    if (!p) return [];
    // Per field (stop 3 of the series order, 2026-11-22): a test batch's book whose other
    // fields the first On wrote, or that has a review item, still has an undone field to write
    // (11 of the 20 test books were left out when any other row counted). A field is left out
    // only when a newer row handles it: proposed or queued, or applied after it was undone; or
    // when the book was decided again after the undo and gave that field no change (2096, 2107:
    // Calibre's description holds the same text; the card said "2 books were left out").
    const undone = this.db
      .prepare(
        `SELECT calibre_uuid, field, created_at FROM proposed_changes INDEXED BY proposed_changes_counts
         WHERE stage = 4 AND library_id = ? AND state = 'undone' AND analysis_id = ?
           AND field NOT IN ('format', 'kind')`,
      )
      .all(p.libraryId, p.analysisId) as {
      calibre_uuid: string;
      field: string;
      created_at: number;
    }[];
    const handled = this.db.prepare(
      `SELECT 1 FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND analysis_id = ? AND field = ?
         AND (state IN ('proposed', 'queued') OR (state = 'applied' AND created_at > ?)) LIMIT 1`,
    );
    const decidedAgain = this.db.prepare(
      `SELECT 1 FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND analysis_id = ?
         AND state <> 'undone' AND created_at > ? LIMIT 1`,
    );
    const books = new Set<string>();
    for (const r of undone)
      if (
        !books.has(r.calibre_uuid) &&
        !handled.get(p.libraryId, r.calibre_uuid, p.analysisId, r.field, r.created_at) &&
        !decidedAgain.get(p.libraryId, r.calibre_uuid, p.analysisId, r.created_at)
      )
        books.add(r.calibre_uuid);
    return [...books].sort();
  }

  /** Proposes those books again from their stored decisions (no AI call). Returns how many. */
  async reproposeUndone(): Promise<number> {
    const p = this.stage4();
    if (!p || !this.isDone()) return 0;
    let n = 0;
    for (const uuid of this.undoneBooks()) {
      if (
        await this.deps.analysis.proposeWithAi(
          p,
          uuid,
          storedAiValues(this.db, this.itemKey(p.libraryId, uuid)),
        )
      )
        n++;
    }
    if (n) this.deps.log?.(`Stage 4: ${n} books whose changes were undone proposed again`);
    return n;
  }

  /** Whether the step has work: the rules are done and its decisions are not current. */
  needsWork(): boolean {
    const p = this.stage4();
    if (!p || p.phase !== 'done' || p.error || !oneTimePassesDone(p)) return false;
    const ai = this.progress();
    if (!ai) return true;
    if (ai.phase !== 'done') return true;
    return (
      evidenceBuildOf(ai) !== STAGE4_EVIDENCE_BUILD ||
      ai.askKey !== stage4AskKey(this.db) ||
      ai.rulesKey !== stage4AiRulesKey()
    );
  }

  /** Done for the current analysis, with the current prompt, models and rules. */
  isDone(): boolean {
    const p = this.stage4();
    return !!p && p.phase === 'done' && !p.error && !this.needsWork();
  }

  async step(shouldStop: () => boolean): Promise<Stage4AiStep> {
    const p = this.stage4();
    if (!p || p.phase !== 'done' || p.error || !oneTimePassesDone(p)) return 'done';
    let ai = this.progress();
    if (!ai) {
      ai = emptyStage4Ai(p.analysisId);
      ai.rulesFinishedAt = p.finishedAt;
      this.save(ai);
      this.deps.log?.('Stage 4: the AI check starts');
    } else if (evidenceBuildOf(ai) !== STAGE4_EVIDENCE_BUILD) {
      // Built again in any phase (a run in its models phase would otherwise send the questions
      // the old evidence queued); questions never sent at an old evidence are dropped by
      // putItems, answers are kept.
      ai.evidenceBuild = STAGE4_EVIDENCE_BUILD;
      // The models phase queues questions only when its ask key changes: without this a book
      // whose evidence came out new was never asked (stop 2: 503 books, decided by the rules
      // alone, ~300 of them proposing to remove a series).
      ai.askKey = null;
      ai.items = 0;
      ai.labeledItems = 0;
      ai.decided = 0;
      ai.invented = 0;
      ai.finishedAt = null;
      clearSeriesOrder(this.db, p.libraryId);
      this.next(ai, 'evidence');
      this.deps.log?.("Stage 4: the AI check's evidence is built again (answers kept)");
    } else if (ai.phase === 'done') {
      if (ai.askKey !== stage4AskKey(this.db)) {
        // Asked again: answers already given are kept by the runner (same evidence and prompt).
        ai.askKey = null;
        ai.decided = 0;
        ai.invented = 0;
        ai.finishedAt = null;
        this.next(ai, 'models');
      } else if (ai.rulesKey !== stage4AiRulesKey()) {
        ai.decided = 0;
        ai.invented = 0;
        ai.finishedAt = null;
        clearSeriesOrder(this.db, p.libraryId);
        this.next(ai, 'decide');
      } else return 'done';
    }
    const t0 = Date.now();
    try {
      if (ai.phase === 'evidence') {
        const r = await this.evidenceStep(p, ai, shouldStop);
        this.time(ai, 'evidence', Date.now() - t0, r.items);
        if (r.finished) this.next(ai, 'models');
        else this.save(ai);
        return 'more';
      }
      if (ai.phase === 'models') {
        const r = await this.modelsStep(ai, shouldStop);
        this.time(ai, 'models', Date.now() - t0, 0);
        if (r === 'done') {
          clearSeriesOrder(this.db, p.libraryId);
          this.next(ai, 'decide');
          return 'more';
        }
        this.save(ai);
        return r;
      }
      if (ai.phase === 'decide') {
        const r = await this.decideStep(p, ai, shouldStop);
        this.time(ai, 'decide', Date.now() - t0, r.items);
        if (r.finished) this.next(ai, 'spelling');
        else this.save(ai);
        return 'more';
      }
      if (ai.phase === 'spelling') {
        const r = await this.spellingStep(p, ai, shouldStop);
        this.time(ai, 'spelling', Date.now() - t0, r.items);
        if (r.finished) {
          this.deps.log?.(
            `Stage 4: one spelling per series (${ai.spelling?.series ?? 0} series, ${ai.spelling?.books ?? 0} books proposed again)`,
          );
          ai.seriesOrder = null;
          this.next(ai, 'series');
        } else this.save(ai);
        return 'more';
      }
      if (ai.phase === 'series') {
        const r = await this.seriesStep(p, ai, shouldStop);
        this.time(ai, 'series', Date.now() - t0, r.items);
        if (r.finished) {
          const so = ai.seriesOrder;
          this.deps.log?.(
            `Stage 4: series order (${so?.series ?? 0} series, ${so?.changed ?? 0} books changed, ${so?.guesses ?? 0} best guesses, ${so?.reviews ?? 0} to review)`,
          );
          this.next(ai, 'gate');
        } else this.save(ai);
        return 'more';
      }
      if (ai.phase === 'gate') {
        const before = ai.cursor;
        const finished = this.gateStep(p, ai);
        this.time(ai, 'gate', Date.now() - t0, ai.cursor - before);
        if (!finished) {
          this.save(ai);
          return 'more';
        }
        ai.finishedAt = Date.now();
        this.next(ai, 'done');
        this.deps.log?.(
          `Stage 4: the AI check is done (gate ${ai.gate?.passed ? 'passed' : 'not passed'}, cost $${(ai.cost?.costUsd ?? 0).toFixed(4)})`,
        );
        return 'done';
      }
      return 'done';
    } catch (err) {
      ai.error = (err as Error).message.slice(0, 500);
      ai.finishedAt = Date.now();
      this.next(ai, 'done');
      throw err;
    }
  }

  private itemKey(libraryId: string, uuid: string): string {
    return `${libraryId}:${uuid}`;
  }

  private books(
    p: Stage4Progress,
    after: number,
    limit: number,
  ): { calibre_uuid: string; calibre_id: number; labeled: number }[] {
    // Read once per analysis and finish, sorted here: the ordered query per slice sorted all
    // 52,000 books each time (345 ms on a copy of the live cleanup.db; once: 62 ms).
    const key = `${p.analysisId}|${p.finishedAt}`;
    if (this.list?.key !== key) {
      const rows = this.db
        .prepare(
          `SELECT calibre_uuid, calibre_id, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'proposed'`,
        )
        .all(p.analysisId) as { calibre_uuid: string; calibre_id: number; labeled: number }[];
      rows.sort((a, b) => a.calibre_id - b.calibre_id);
      this.list = { key, rows };
    }
    const rows = this.list.rows;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].calibre_id <= after) lo = mid + 1;
      else hi = mid;
    }
    return rows.slice(lo, lo + limit);
  }

  private async evidenceStep(
    p: Stage4Progress,
    ai: Stage4AiProgress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    let n = 0;
    for (let round = 0; round < 10 && !shouldStop(); round++) {
      const rows = this.books(p, ai.cursor, SLICE);
      ai.total = this.list?.rows.length ?? ai.total;
      if (!rows.length) {
        const keys = new Set(
          (this.list?.rows ?? []).map((r) => this.itemKey(p.libraryId, r.calibre_uuid)),
        );
        dropOtherItems(this.db, 'calibre4', keys);
        return { finished: true, items: n };
      }
      const items = [];
      const y = new Yielder();
      for (const r of rows) {
        await y.maybe();
        const inp = this.deps.analysis.aiInputs(p, r.calibre_uuid);
        if (!inp) continue;
        items.push({
          key: this.itemKey(p.libraryId, r.calibre_uuid),
          evidence: stage4Evidence(inp.base),
          labeled: r.labeled === 1,
        });
      }
      this.deps.runner.putItems(STAGE4_SPEC, items, STAGE4_EVIDENCE_VERSION);
      ai.items += items.length;
      ai.labeledItems += items.filter((i) => i.labeled).length;
      ai.cursor = rows[rows.length - 1].calibre_id;
      n += items.length;
      await new Promise((res) => setImmediate(res));
    }
    return { finished: false, items: n };
  }

  private async modelsStep(ai: Stage4AiProgress, shouldStop: () => boolean): Promise<Stage4AiStep> {
    const runner = this.deps.runner;
    const s = getSettings(this.db);
    const key = stage4AskKey(this.db);
    if (ai.askKey !== key) {
      const keys = (
        this.db
          .prepare(
            `SELECT item_key FROM ai_items WHERE stage = 'calibre4' ${s.ai.labeledOnly ? 'AND labeled = 1' : ''}
             ORDER BY labeled DESC, item_key`,
          )
          .all() as { item_key: string }[]
      ).map((r) => r.item_key);
      for (let at = 0; at < keys.length; at += 500) {
        const chunk = keys.slice(at, at + 500);
        runner.enqueue(STAGE4_SPEC, 'primary', chunk, ai.analysisId);
        runner.enqueue(STAGE4_SPEC, 'secondary', chunk, ai.analysisId);
        await new Promise((r) => setImmediate(r));
      }
      ai.askKey = key;
    }
    // A run that was asking before the bar existed measures its rates from now.
    ai.modelsStart ??= { at: Date.now(), done: this.doneByModel(ai.analysisId) };
    const r = await runner.step(STAGE4_SPEC, ai.analysisId, shouldStop);
    ai.ai = runner.counts('calibre4', ai.analysisId) as Stage4AiProgress['ai'];
    ai.cost = runSpend(this.db, 'calibre4', ai.analysisId) as Stage4AiProgress['cost'];
    if (r.wait) {
      ai.wait = waitText(r.wait);
      const st = getStage(this.db, STAGE);
      if (waitNeedsUser(r.wait) && (st.pauseReason !== 'ai' || st.pauseDetail !== ai.wait)) {
        pauseStage(this.db, STAGE, 'ai', ai.wait);
        this.deps.log?.(`Stage 4: ${ai.wait}`);
      }
      if (r.pending === 0 && !waitNeedsUser(r.wait)) return 'done';
      // A note on one model's batches: the rest goes on at its own pace.
      return waitIsNote(r.wait) && (r.sent > 0 || r.answered > 0) ? 'more' : 'wait';
    }
    ai.wait = null;
    this.unpause();
    if (r.pending === 0) return 'done';
    return r.sent > 0 || r.answered > 0 ? 'more' : 'wait';
  }

  private async decideStep(
    p: Stage4Progress,
    ai: Stage4AiProgress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    const runner = this.deps.runner;
    const rows = this.books(p, ai.cursor, SLICE);
    if (!rows.length) {
      ai.rulesKey = stage4AiRulesKey();
      return { finished: true, items: 0 };
    }
    const now = Date.now();
    // WP20g: a book decided with J (or F) as a new arrival keeps that design: decided again with
    // its stronger pair's stored answers (a book without them is decided with E as before).
    if (ai.cursor === 0 || !this.designs) this.designs = itemDesigns(this.db, 'calibre4');
    let n = 0;
    const y = new Yielder();
    for (const r of rows) {
      await y.maybe();
      if (shouldStop()) return { finished: false, items: n };
      const key = this.itemKey(p.libraryId, r.calibre_uuid);
      const inp = this.deps.analysis.aiInputs(p, r.calibre_uuid);
      const ev = runner.evidenceOf(STAGE4_SPEC, key);
      if (inp && ev) {
        const a = runner.answerOf(STAGE4_SPEC, 'primary', key);
        const b = runner.answerOf(STAGE4_SPEC, 'secondary', key);
        const answers = {
          primary: a?.state === 'answered' ? a.answer : null,
          secondary: b?.state === 'answered' ? b.answer : null,
        };
        const asked = !!answers.primary && !!answers.secondary;
        let out = decideStage4Ai(inp.decision, answers, stage4EvidenceText(ev.evidence));
        let design = 'E';
        const kept = this.designs.get(key);
        if (kept === 'J' || kept === 'F') {
          const sa = runner.answerOf(STAGE4_SPEC, 'upgradePrimary', key);
          const sb = runner.answerOf(STAGE4_SPEC, 'upgradeSecondary', key);
          if (sa?.state === 'answered' || sb?.state === 'answered') {
            out = decideStage4AiUpgrade(
              kept,
              inp.decision,
              answers,
              {
                primary: sa?.state === 'answered' ? sa.answer : null,
                secondary: sb?.state === 'answered' ? sb.answer : null,
              },
              stage4EvidenceText(ev.evidence),
            );
            design = kept;
          }
        }
        ai.invented += out.invented;
        writeDecisions(this.db, 'calibre4', decisionRows(key, out, ev.hash, asked), design, now);
        // Read back: a value the user set wins over the decision.
        await this.deps.analysis.proposeWithAi(p, r.calibre_uuid, storedAiValues(this.db, key));
      }
      ai.cursor = r.calibre_id;
      ai.decided++;
      n++;
    }
    return { finished: false, items: n };
  }

  /**
   * One spelling per series (decided with the user 2026-11-21): after every book is decided,
   * the spelling of each series with more than one is chosen from the names the books would
   * have after On, and the books of those series (and of the last choice's) are proposed again
   * with it. Resumable: the books are walked in uuid order by position.
   */
  private async spellingStep(
    p: Stage4Progress,
    ai: Stage4AiProgress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    const runKey = `${ai.analysisId}|${ai.phaseStartedAt ?? 0}`;
    if (ai.cursor === 0 || this.respell?.key !== runKey) {
      const books = this.deps.analysis.seriesAfterOn(p);
      const map = chooseSpellings(books);
      const keys = new Set([...map.keys(), ...Object.keys(ai.seriesSpelling?.names ?? {})]);
      const uuids = books
        .filter(
          (b) =>
            (b.after !== null && keys.has(seriesKey(b.after))) ||
            (b.now !== null && keys.has(seriesKey(b.now))),
        )
        .map((b) => b.uuid)
        .sort();
      this.respell = { key: runKey, uuids };
      if (ai.cursor === 0) {
        ai.seriesSpelling = { at: Date.now(), names: Object.fromEntries(map) };
        ai.spelling = { series: map.size, books: 0, total: uuids.length };
        this.save(ai);
      }
    }
    const fresh = this.stage4() ?? p;
    const uuids = this.respell.uuids;
    let n = 0;
    const y = new Yielder();
    while (ai.cursor < uuids.length && n < SLICE) {
      await y.maybe();
      if (shouldStop()) return { finished: false, items: n };
      const uuid = uuids[ai.cursor];
      if (
        await this.deps.analysis.proposeWithAi(
          fresh,
          uuid,
          storedAiValues(this.db, this.itemKey(p.libraryId, uuid)),
        )
      )
        if (ai.spelling) ai.spelling.books++;
      ai.cursor++;
      n++;
    }
    return { finished: ai.cursor >= uuids.length, items: n };
  }

  /**
   * The order of each series (series-order.ts; plan approved 2026-11-22), after the one spelling
   * is chosen: the facts of every book of a series, then each series ordered and its choices
   * written (stage4_series_order), then the books whose number, title, best guess or review the
   * order changes are proposed again. Sliced like the other phases (lessons 3).
   */
  private async seriesStep(
    p: Stage4Progress,
    ai: Stage4AiProgress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    const runKey = `${ai.analysisId}|${ai.phaseStartedAt ?? 0}`;
    if (!ai.seriesOrder || this.seriesRun?.key !== runKey) {
      const after = this.deps.analysis.seriesStateAfterOn(p);
      const uuids = [...after]
        .filter(([, a]) => a.name)
        .map(([u]) => u)
        .sort();
      this.seriesRun = {
        key: runKey,
        uuids,
        after,
        facts: [],
        groups: [],
        changed: [],
        checks: emptyChecks(),
      };
      ai.seriesOrder = {
        part: 'facts',
        cursor: 0,
        total: uuids.length,
        done: 0,
        books: uuids.length,
        series: 0,
        choices: 0,
        changed: 0,
        guesses: 0,
        reviews: 0,
        checks: null,
      };
      // The run key holds the phase's start: a restart (facts in memory only) starts over.
      this.save(ai);
    }
    const so = ai.seriesOrder;
    const run = this.seriesRun;
    const y = new Yielder();
    let n = 0;
    if (so.part === 'facts') {
      while (so.cursor < run.uuids.length && n < SLICE * 20) {
        await y.maybe();
        if (shouldStop()) return { finished: false, items: n };
        const uuid = run.uuids[so.cursor];
        const b = this.deps.analysis.seriesBook(p, uuid, run.after.get(uuid)!);
        if (b) run.facts.push(b);
        so.cursor++;
        so.done++;
        n++;
      }
      if (so.cursor >= run.uuids.length) {
        const by = new Map<string, SeriesBook[]>();
        for (const b of run.facts) {
          const k = seriesKey(b.name);
          if (k) by.set(k, [...(by.get(k) ?? []), b]);
        }
        run.groups = [...by.values()];
        clearSeriesOrder(this.db, p.libraryId);
        so.part = 'order';
        so.cursor = 0;
        so.total = run.groups.length;
        so.series = run.groups.length;
      }
      return { finished: false, items: n };
    }
    if (so.part === 'order') {
      const rows: SeriesOrderRow[] = [];
      while (so.cursor < run.groups.length && n < SLICE * 4) {
        await y.maybe();
        if (shouldStop()) break;
        const g = run.groups[so.cursor];
        const choices = orderSeries(g);
        addSeriesChecks(run.checks, g, choices);
        const by = new Map<string, SeriesChoice>(choices.map((c) => [c.uuid, c]));
        const key = seriesKey(g[0].name);
        for (const b of g) {
          const c = by.get(b.uuid);
          const a = run.after.get(b.uuid)!;
          rows.push({
            calibreUuid: b.uuid,
            calibreId: b.calibreId,
            series: b.name,
            seriesKey: key,
            index: c ? c.index : b.index,
            src: c ? c.from : 'calibre',
            guess: !!c?.guess,
            reason: c?.reason ?? null,
            title: c?.title ?? a.title,
            titleSrc: c?.title !== undefined ? (c.titleFrom ?? null) : null,
            review: c?.review ?? null,
          });
          if (!c) continue;
          so.choices++;
          if (
            c.index !== b.index ||
            c.title !== undefined ||
            c.review !== undefined ||
            (c.guess && a.proposed)
          )
            run.changed.push(b.uuid);
        }
        so.cursor++;
        so.done++;
        n++;
      }
      if (rows.length) writeSeriesOrder(this.db, p.libraryId, rows);
      if (so.cursor >= run.groups.length) {
        so.checks = run.checks;
        so.guesses = run.checks.guesses;
        so.reviews = run.checks.reviews;
        so.changed = run.changed.length;
        run.changed.sort();
        so.part = 'propose';
        so.cursor = 0;
        so.total = run.changed.length;
      }
      return { finished: false, items: n };
    }
    const fresh = this.stage4() ?? p;
    while (so.cursor < run.changed.length && n < SLICE) {
      await y.maybe();
      if (shouldStop()) return { finished: false, items: n };
      const uuid = run.changed[so.cursor];
      await this.deps.analysis.proposeWithAi(
        fresh,
        uuid,
        storedAiValues(this.db, this.itemKey(p.libraryId, uuid)),
      );
      so.cursor++;
      so.done++;
      n++;
    }
    return { finished: so.cursor >= run.changed.length, items: n };
  }

  /**
   * The gate in steps (its bar): the labeled books' stored values in chunks of GATE_CHUNK, then
   * the score with the fields' pauses and the value counts, the best guesses, the cost. True when
   * done. The books gathered are kept in memory; after a restart the gate starts over.
   */
  private gateStep(p: Stage4Progress, ai: Stage4AiProgress): boolean {
    const run = `${ai.analysisId}:${ai.rulesFinishedAt}`;
    if (ai.cursor === 0 || this.gateBooks?.run !== run) {
      ai.cursor = 0;
      this.gateBooks = { run, labeled: this.deps.analysis.labeledBooks(p), books: [] };
      ai.gateTotal = this.gateBooks.labeled.length;
    }
    const g0 = this.gateBooks;
    const total = g0.labeled.length;
    if (ai.cursor < total) {
      for (const b of g0.labeled.slice(ai.cursor, ai.cursor + GATE_CHUNK))
        g0.books.push({
          gid: b.gid,
          gold: b.gold,
          ai: storedAiValues(this.db, this.itemKey(p.libraryId, b.uuid)),
        });
      ai.cursor = Math.min(total, ai.cursor + GATE_CHUNK);
      return false;
    }
    const tail = ai.cursor - total;
    if (tail === 0) {
      const settings = getSettings(this.db);
      const g = scoreAiGate(g0.books);
      const below: string[] = [];
      if (g.books > 0) {
        for (const f of SCORED_FIELDS) {
          const name = FIELD_NAMES[f];
          const s = g.all.fields[f];
          const bar = stage4Bar(settings, name);
          if (s.autoPercent !== null && s.auto >= settings.gate.minBooks && s.autoPercent < bar) {
            below.push(name);
            pauseField(
              this.db,
              STAGE,
              name,
              'gate',
              `${s.autoPercent.toFixed(1)} % right on the labeled books after the AI check (bar ${bar} %)`,
            );
          } else resumeField(this.db, STAGE, name);
        }
      }
      ai.gate = { ...g, at: Date.now(), passed: g.books > 0 && below.length === 0, below };
      ai.counts = valueCounts(this.db, 'calibre4');
      ai.cursor++;
      return false;
    }
    if (tail === 1) {
      const flagged: Record<string, number> = {};
      for (const r of this.db
        .prepare(
          `SELECT field, COUNT(*) AS n FROM ai_values WHERE stage = 'calibre4' AND flagged = 1 AND rules_auto = 1
           GROUP BY field`,
        )
        .all() as { field: string; n: number }[])
        flagged[r.field] = r.n;
      ai.flaggedAgainstRules = flagged;
      ai.cursor++;
      return false;
    }
    if (tail === 2) {
      // The best guesses: flagged values of books both models answered.
      const unconfirmed: Record<string, number> = {};
      for (const r of this.db
        .prepare(
          `SELECT v.field, COUNT(*) AS n FROM ai_values v
           JOIN ai_values a ON a.stage = v.stage AND a.item_key = v.item_key AND a.field = 'asked'
           WHERE v.stage = 'calibre4' AND v.flagged = 1 AND a.value_json = 'true' GROUP BY v.field`,
        )
        .all() as { field: string; n: number }[])
        unconfirmed[r.field] = r.n;
      // The series numbers' best guesses are the series step's (it decides every number again).
      if (ai.seriesOrder) unconfirmed.ix = ai.seriesOrder.guesses;
      ai.unconfirmed = unconfirmed;
      ai.cursor++;
      return false;
    }
    ai.cost = runSpend(this.db, 'calibre4', ai.analysisId) as Stage4AiProgress['cost'];
    ai.cursor++;
    this.gateBooks = null;
    return true;
  }
}
