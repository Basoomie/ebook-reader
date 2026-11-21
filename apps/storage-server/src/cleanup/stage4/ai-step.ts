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
import { waitNeedsUser, waitText, type AiRunner } from '../ai/runner';
import { runSpend } from '../ai/spend';
import { dropOtherItems, valueCounts, writeDecisions } from '../ai/values';
import { getSettings, stage4Bar } from '../settings';
import { pauseField, resumeField } from '../stage2-gate';
import { getStage, pauseStage, resumeStage, updateStage } from '../stages';
import {
  STAGE4_AI_DECIDE_VERSION,
  decideStage4Ai,
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
import type { Stage4Analysis, Stage4Progress } from './analysis';
import { SCORED_FIELDS, FIELD_NAMES } from './score';
import { STAGE4_RULES_VERSION } from './stage4-rules';

const STAGE = 4;
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

export type Stage4AiPhase = 'evidence' | 'models' | 'decide' | 'gate' | 'done';

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
  /** The analysis' proposed books in calibre_id order (see books()). */
  private list: {
    key: string;
    rows: { calibre_uuid: string; calibre_id: number; labeled: number }[];
  } | null = null;

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

  /** Whether the step has work: the rules are done and its decisions are not current. */
  needsWork(): boolean {
    const p = this.stage4();
    if (!p || p.phase !== 'done' || p.error || p.bookmeterEditions?.phase !== 'done') return false;
    const ai = this.progress();
    if (!ai) return true;
    if (ai.phase !== 'done') return true;
    return ai.askKey !== stage4AskKey(this.db) || ai.rulesKey !== stage4AiRulesKey();
  }

  /** Done for the current analysis, with the current prompt, models and rules. */
  isDone(): boolean {
    const p = this.stage4();
    return !!p && p.phase === 'done' && !p.error && !this.needsWork();
  }

  async step(shouldStop: () => boolean): Promise<Stage4AiStep> {
    const p = this.stage4();
    if (!p || p.phase !== 'done' || p.error || p.bookmeterEditions?.phase !== 'done') return 'done';
    let ai = this.progress();
    if (!ai) {
      ai = emptyStage4Ai(p.analysisId);
      ai.rulesFinishedAt = p.finishedAt;
      this.save(ai);
      this.deps.log?.('Stage 4: the AI check starts');
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
          this.next(ai, 'decide');
          return 'more';
        }
        this.save(ai);
        return r;
      }
      if (ai.phase === 'decide') {
        const r = await this.decideStep(p, ai, shouldStop);
        this.time(ai, 'decide', Date.now() - t0, r.items);
        if (r.finished) this.next(ai, 'gate');
        else this.save(ai);
        return 'more';
      }
      if (ai.phase === 'gate') {
        this.gateStep(p, ai);
        this.time(ai, 'gate', Date.now() - t0, ai.gate?.books ?? 0);
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
      return r.pending === 0 && !waitNeedsUser(r.wait) ? 'done' : 'wait';
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
        const out = decideStage4Ai(inp.decision, answers, stage4EvidenceText(ev.evidence));
        ai.invented += out.invented;
        writeDecisions(this.db, 'calibre4', decisionRows(key, out, ev.hash, asked), 'E', now);
        // Read back: a value the user set wins over the decision.
        await this.deps.analysis.proposeWithAi(p, r.calibre_uuid, storedAiValues(this.db, key));
      }
      ai.cursor = r.calibre_id;
      ai.decided++;
      n++;
    }
    return { finished: false, items: n };
  }

  private gateStep(p: Stage4Progress, ai: Stage4AiProgress): void {
    const settings = getSettings(this.db);
    const books = this.deps.analysis.labeledBooks(p).map((b) => ({
      gid: b.gid,
      gold: b.gold,
      ai: storedAiValues(this.db, this.itemKey(p.libraryId, b.uuid)),
    }));
    const g = scoreAiGate(books);
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
    const flagged: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT field, COUNT(*) AS n FROM ai_values WHERE stage = 'calibre4' AND flagged = 1 AND rules_auto = 1
         GROUP BY field`,
      )
      .all() as { field: string; n: number }[])
      flagged[r.field] = r.n;
    ai.flaggedAgainstRules = flagged;
    // The best guesses that are written at On: flagged values of books both models answered.
    const unconfirmed: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT v.field, COUNT(*) AS n FROM ai_values v
         JOIN ai_values a ON a.stage = v.stage AND a.item_key = v.item_key AND a.field = 'asked'
         WHERE v.stage = 'calibre4' AND v.flagged = 1 AND a.value_json = 'true' GROUP BY v.field`,
      )
      .all() as { field: string; n: number }[])
      unconfirmed[r.field] = r.n;
    ai.unconfirmed = unconfirmed;
    ai.cost = runSpend(this.db, 'calibre4', ai.analysisId) as Stage4AiProgress['cost'];
  }
}
