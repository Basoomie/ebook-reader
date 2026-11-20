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
    this.save(ai);
  }

  private time(ai: Stage4AiProgress, phase: string, ms: number, items: number): void {
    const t = (ai.times[phase] ??= { ms: 0, items: 0 });
    t.ms += ms;
    t.items += items;
  }

  private unpause(): void {
    if (getStage(this.db, STAGE).pauseReason === 'ai') resumeStage(this.db, STAGE);
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
    return this.db
      .prepare(
        `SELECT calibre_uuid, calibre_id, labeled FROM stage4_books
         WHERE analysis_id = ? AND state = 'proposed' AND calibre_id > ? ORDER BY calibre_id LIMIT ?`,
      )
      .all(p.analysisId, after, limit) as {
      calibre_uuid: string;
      calibre_id: number;
      labeled: number;
    }[];
  }

  private async evidenceStep(
    p: Stage4Progress,
    ai: Stage4AiProgress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    let n = 0;
    for (let round = 0; round < 10 && !shouldStop(); round++) {
      const rows = this.books(p, ai.cursor, SLICE);
      if (!rows.length) {
        const keys = new Set(
          (
            this.db
              .prepare(
                `SELECT calibre_uuid FROM stage4_books WHERE analysis_id = ? AND state = 'proposed'`,
              )
              .all(p.analysisId) as { calibre_uuid: string }[]
          ).map((r) => this.itemKey(p.libraryId, r.calibre_uuid)),
        );
        dropOtherItems(this.db, 'calibre4', keys);
        return { finished: true, items: n };
      }
      const items = [];
      for (const r of rows) {
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
    for (const r of rows) {
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
    ai.cost = runSpend(this.db, 'calibre4', ai.analysisId) as Stage4AiProgress['cost'];
  }
}
