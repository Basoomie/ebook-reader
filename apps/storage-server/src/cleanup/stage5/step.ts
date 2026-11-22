/**
 * Stage 5 (WP20f): genres and tags, after stage 4's AI check. Phases, resumable, in slices:
 *
 *   marks     the Google run's workflow marks recorded (calibre_marks) before anything else, so
 *             stage 2's and stage 4's rules still see them once stage 5 removed the tags
 *   evidence  every stage-4 book's evidence stored with the runner (ai_items 'calibre5')
 *   models    Haiku and Luna asked about every book (labeled first; only them with labeledOnly)
 *   decide    each book's own terms: both models per id, RanobeDB, the store rules (decide.ts),
 *             into ai_values 'calibre5'
 *   gate      each book's terms (per book, decided 2026-11-21), the labeled books scored (gate.ts); a set below its
 *             bar is held back (nothing of it is applied)
 *   propose   one change per Calibre book (stage 5, field 'tags'): the labels to add with the
 *             format tag, the approved removals; books stage 4 never read get the removals only
 *
 * Nothing here writes to Calibre: On writes the proposals through stage 2's field-write path.
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import type { AiRunner } from '../../ai/runner';
import { waitIsNote, waitNeedsUser, waitText } from '../../ai/waits';
import { runSpend } from '../../ai/spend';
import { writeDecisions } from '../ai-decide/values';
import { recordMarks } from '../marks';
import { getSettings } from '../settings';
import { mapLabeledIds, pauseField, resumeField } from '../stage2-gate';
import type { Stage2Book } from '../stage2-snapshot';
import { getStage, pauseStage, resumeStage, updateStage } from '../stages';
import { storedAiValues } from '../stage4/ai-decide';
import type { Stage4Ai } from '../stage4/ai-step';
import type { Stage4Analysis, Stage4Progress } from '../stage4/analysis';
import type { Format } from '../stage4/rules-v3';
import {
  STAGE5_RULES_VERSION,
  byKind,
  ownTerms,
  seriesUnion,
  tagChange,
  type OwnTerms,
  type UnionTerm,
} from './decide';
import { adaptationText, stage5Evidence, type Stage5Item } from './evidence';
import {
  TEST_SCORES,
  belowBars,
  loadGenreLabels,
  scoreSet,
  type GenreLabels,
  type SetScore,
} from './gate';
import {
  STAGE5_EVIDENCE_VERSION,
  STAGE5_PROMPT_VERSION,
  STAGE5_SPEC,
  type Stage5Answer,
} from './prompt';
import { BY_ID, FORMAT_TAGS, GENRE_IDS, SUBJECT_IDS, TAG_IDS } from './vocab';

const STAGE = 5;
const SLICE = 50;
/** The longest stretch the step keeps the server (lessons 3). */
const YIELD_MS = 30;
const OWN_FIELD = 'own';
export const GENRE_LABELS_FILENAME = 'genre-labels.json';

class Yielder {
  private last = performance.now();
  async maybe(): Promise<void> {
    if (performance.now() - this.last < YIELD_MS) return;
    await new Promise((r) => setImmediate(r));
    this.last = performance.now();
  }
}

export type Stage5Phase = 'marks' | 'evidence' | 'models' | 'decide' | 'gate' | 'propose' | 'done';

/** Scores of one view of the labeled books (genres with subjects, and tags). */
export interface GateView {
  genres: SetScore;
  tags: SetScore;
}

export interface Stage5Gate {
  at: number;
  /** Labeled books in the library now (genre labels, tag labels). */
  books: { genres: number; tags: number };
  /** Both models, per book (comparable with the genre test). */
  models: GateView;
  /** Every source per book (as written: per book, decided 2026-11-21). */
  own: GateView;
  /** Per book without RanobeDB (its effect). */
  noRanobedb: GateView;
  /** As it would be written: every source, per book. */
  final: GateView;
  test: typeof TEST_SCORES;
  /** Sets below their bars (held back). */
  below: string[];
  held: { genres: boolean; tags: boolean };
  passed: boolean;
  /** Labeled books not asked (labeledOnly left the models out, or no answer). */
  notAsked: number;
}

export interface Stage5Counts {
  /** Books that get each term, and each format tag. */
  terms: Record<string, number>;
  formats: Record<string, number>;
  /** Stage-4 books with no genre and no subject. */
  noGenre: number;
  /** Books per removed tag. */
  removals: Record<string, number>;
  /** Books with a change, labels added, tags removed. */
  books: number;
  added: number;
  removed: number;
  /** Books stage 4 never read (removals only), and those of them with a change. */
  outside: number;
  outsideChanged: number;
  /** Books left alone because a stage-5 change of theirs is in a batch now. */
  inBatch: number;
}

export interface Stage5Progress {
  libraryId: string;
  /** This run (the proposals' analysis_id and the runner's run id). */
  analysisId: string;
  /** The stage-4 analysis and AI check it builds on (a newer one starts stage 5 over). */
  stage4AnalysisId: string;
  stage4AiFinishedAt: number | null;
  phase: Stage5Phase;
  startedAt: number;
  finishedAt: number | null;
  cursor: number;
  total: number;
  items: number;
  labeledItems: number;
  askKey: string | null;
  rulesKey: string | null;
  decided: number;
  /** Books both models answered, and terms only one gave (dropped by the AND). */
  asked: number;
  oneModel: number;
  /** Answer terms not on the lists (dropped). */
  droppedTerms: number;
  marks: number | null;
  ai: Record<string, number> | null;
  wait: string | null;
  cost: { costUsd: number; [k: string]: unknown } | null;
  gate: Stage5Gate | null;
  counts: Stage5Counts | null;
  phaseStartedAt?: number;
  phaseStartDone?: number;
  modelsStart?: { at: number; done: Record<string, number> } | null;
  error: string | null;
  times: Record<string, { ms: number; items: number }>;
}

export type Stage5StepResult = 'done' | 'more' | 'wait';

export interface Stage5Deps {
  db: Database.Database;
  runner: AiRunner;
  analysis: Stage4Analysis;
  stage4Ai: Stage4Ai;
  dbDir?: string | null;
  log?: (m: string) => void;
}

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

export function stage5AskKey(db: Database.Database): string {
  const s = getSettings(db);
  return sha([
    STAGE5_PROMPT_VERSION,
    STAGE5_EVIDENCE_VERSION,
    s.models[STAGE5_SPEC.tasks.primary],
    s.models[STAGE5_SPEC.tasks.secondary],
    s.ai.labeledOnly,
  ]);
}

/** What the decisions and proposals depend on besides the answers: done again when it changes. */
export function stage5RulesKey(db: Database.Database, stage4AiFinishedAt: number | null): string {
  const s = getSettings(db);
  return sha([STAGE5_RULES_VERSION, stage4AiFinishedAt, s.gate.stage5, s.customTags]);
}

function emptyCounts(): Stage5Counts {
  return {
    terms: {},
    formats: {},
    noGenre: 0,
    removals: {},
    books: 0,
    added: 0,
    removed: 0,
    outside: 0,
    outsideChanged: 0,
    inBatch: 0,
  };
}

const FORMATS = new Set(Object.keys(FORMAT_TAGS));

export class Stage5 {
  /** Stage 4's proposed books in calibre_id order (read once per stage-4 analysis). */
  private list: {
    key: string;
    rows: { calibre_uuid: string; calibre_id: number; labeled: number }[];
  } | null = null;
  /** Stage 4's decided format per book (its format proposals). */
  private formats: { key: string; map: Map<string, Format> } | null = null;
  /** Each book's terms (built in the gate phase, kept for proposing). */
  private union: { key: string; map: Map<number, Record<string, UnionTerm>> } | null = null;
  private all: { snap: object; rows: { calibre_id: number; book: Stage2Book }[] } | null = null;
  /** The labeled books: asked first, and alone with labeledOnly. */
  private labeled: { key: string; ids: Set<number>; gids: Map<string, number> } | null = null;

  constructor(private readonly deps: Stage5Deps) {}

  private get db(): Database.Database {
    return this.deps.db;
  }

  progress(): Stage5Progress | null {
    const p = getStage(this.db, STAGE).progress as unknown as Stage5Progress;
    return p && typeof p.analysisId === 'string' && typeof p.stage4AnalysisId === 'string'
      ? p
      : null;
  }

  private save(p: Stage5Progress, state?: string): void {
    updateStage(this.db, STAGE, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  private stage4(): Stage4Progress | null {
    return this.deps.analysis.progress();
  }

  /** Stage 4 is ready for stage 5: its analysis and its AI check are done. */
  stage4Ready(): boolean {
    return this.deps.stage4Ai.isDone();
  }

  private next(p: Stage5Progress, phase: Stage5Phase): void {
    p.phase = phase;
    p.cursor = 0;
    p.phaseStartedAt = Date.now();
    p.phaseStartDone = phase === 'decide' ? p.decided : 0;
    p.modelsStart =
      phase === 'models' ? { at: Date.now(), done: this.doneByModel(p.analysisId) } : null;
    this.save(p, phase === 'done' ? (p.error ? 'failed' : 'ready') : 'analysing');
  }

  private time(p: Stage5Progress, phase: string, ms: number, items: number): void {
    const t = (p.times[phase] ??= { ms: 0, items: 0 });
    t.ms += ms;
    t.items += items;
  }

  /** A new run on the current stage-4 analysis (answers already given are kept). */
  restart(libraryId: string): Stage5Progress | null {
    const p4 = this.stage4();
    if (!p4) return null;
    const ai4 = this.deps.stage4Ai.progress();
    const p: Stage5Progress = {
      libraryId,
      analysisId: randomUUID(),
      stage4AnalysisId: p4.analysisId,
      stage4AiFinishedAt: ai4?.finishedAt ?? null,
      phase: 'marks',
      startedAt: Date.now(),
      finishedAt: null,
      cursor: 0,
      total: 0,
      items: 0,
      labeledItems: 0,
      askKey: null,
      rulesKey: null,
      decided: 0,
      asked: 0,
      oneModel: 0,
      droppedTerms: 0,
      marks: null,
      ai: null,
      wait: null,
      cost: null,
      gate: null,
      counts: null,
      error: null,
      times: {},
    };
    this.union = null;
    this.save(p, 'analysing');
    this.deps.log?.('Stage 5: genres and tags start');
    return p;
  }

  /** Whether the step has work (stage 4 ready, and stage 5 not current). */
  needsWork(libraryId: string): boolean {
    if (!this.stage4Ready()) return false;
    const p = this.progress();
    const p4 = this.stage4();
    if (!p || !p4 || p.libraryId !== libraryId || p.stage4AnalysisId !== p4.analysisId) return true;
    if (p.phase !== 'done') return !p.error;
    if (p.error) return false;
    const ai4 = this.deps.stage4Ai.progress();
    return (
      p.askKey !== stage5AskKey(this.db) ||
      p.rulesKey !== stage5RulesKey(this.db, ai4?.finishedAt ?? null)
    );
  }

  /** Done for the current stage-4 analysis with the current prompt, models and rules. */
  isDone(libraryId: string): boolean {
    const p = this.progress();
    return !!p && p.phase === 'done' && !p.error && !this.needsWork(libraryId);
  }

  /** Each model's questions of this run: answered or final (done), and still to come (left). */
  private byModel(runId: string): Map<string, { done: number; left: number }> {
    const out = new Map<string, { done: number; left: number }>();
    for (const r of this.db
      .prepare(
        `SELECT model, state, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'calibre5'
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
   * The card's bar: how far the running phase is and the time left from what was measured in
   * it (lessons 4: from what is open). Asking: each model's answers since the asking started,
   * the slowest decides; the other phases: books per minute since the phase started.
   */
  bar(
    now = Date.now(),
  ): { phase: Stage5Phase; done: number; total: number; secondsLeft: number | null } | null {
    const p = this.progress();
    if (!p || p.phase === 'done') return null;
    const since = (done: number, total: number) => {
      const elapsed = now - (p.phaseStartedAt ?? now);
      const n = done - (p.phaseStartDone ?? 0);
      return n > 0 && elapsed > 0 ? Math.round(((total - done) * elapsed) / n / 1000) : null;
    };
    if (p.phase === 'models') {
      let done = 0;
      let total = 0;
      let secs: number | null = 0;
      const start = p.modelsStart;
      for (const [model, c] of this.byModel(p.analysisId)) {
        done += c.done;
        total += c.done + c.left;
        if (!c.left) continue;
        const elapsed = start ? now - start.at : 0;
        const n = c.done - (start?.done[model] ?? 0);
        if (n <= 0 || elapsed <= 0) secs = null;
        else if (secs !== null) secs = Math.max(secs, Math.round((c.left * elapsed) / n / 1000));
      }
      return { phase: p.phase, done, total, secondsLeft: secs };
    }
    if (p.phase === 'evidence')
      return {
        phase: p.phase,
        done: p.items,
        total: p.total,
        secondsLeft: since(p.items, p.total),
      };
    if (p.phase === 'decide')
      return {
        phase: p.phase,
        done: p.decided,
        total: p.items,
        secondsLeft: since(p.decided, p.items),
      };
    if (p.phase === 'propose')
      return {
        phase: p.phase,
        done: p.cursor,
        total: p.total,
        secondsLeft: since(p.cursor, p.total),
      };
    return { phase: p.phase, done: 0, total: 0, secondsLeft: null };
  }

  /** The given-up questions asked again (the card's button); then decided again. */
  askAgain(): number {
    const p = this.progress();
    if (!p) return 0;
    const n = this.deps.runner.askAgain('calibre5', p.analysisId);
    if (n > 0 && p.phase !== 'marks' && p.phase !== 'evidence' && p.phase !== 'models') {
      p.decided = 0;
      p.asked = 0;
      p.oneModel = 0;
      p.droppedTerms = 0;
      p.finishedAt = null;
      p.gate = null;
      p.counts = null;
      this.next(p, 'models');
    }
    if (n > 0) this.deps.log?.(`Stage 5: ${n} given-up AI questions asked again`);
    return n;
  }

  async step(libraryId: string, shouldStop: () => boolean): Promise<Stage5StepResult> {
    this.extrasNow = null;
    if (!this.stage4Ready()) return 'wait';
    const p4 = this.stage4();
    if (!p4) return 'wait';
    let p = this.progress();
    if (!p || p.libraryId !== libraryId || p.stage4AnalysisId !== p4.analysisId) {
      p = this.restart(libraryId);
      if (!p) return 'wait';
    } else if (p.phase === 'done') {
      if (p.error) return 'done';
      const ai4 = this.deps.stage4Ai.progress();
      if (p.askKey !== stage5AskKey(this.db)) {
        p.askKey = null;
        this.redo(p);
        this.next(p, 'models');
      } else if (p.rulesKey !== stage5RulesKey(this.db, ai4?.finishedAt ?? null)) {
        // Stage 4 decided again, or the bars or the custom tags changed: the evidence (Calibre's
        // title, the format, the description) is built again; the answers stay where it is the same.
        p.stage4AiFinishedAt = ai4?.finishedAt ?? null;
        p.items = 0;
        p.labeledItems = 0;
        this.redo(p);
        this.next(p, 'evidence');
      } else return 'done';
    }
    const t0 = Date.now();
    try {
      switch (p.phase) {
        case 'marks': {
          this.marksStep(p4, p);
          this.time(p, 'marks', Date.now() - t0, p.marks ?? 0);
          this.next(p, 'evidence');
          return 'more';
        }
        case 'evidence': {
          const r = await this.evidenceStep(p4, p, shouldStop);
          this.time(p, 'evidence', Date.now() - t0, r.items);
          if (r.finished) this.next(p, 'models');
          else this.save(p);
          return 'more';
        }
        case 'models': {
          const r = await this.modelsStep(p, shouldStop);
          this.time(p, 'models', Date.now() - t0, 0);
          if (r === 'done') {
            this.next(p, 'decide');
            return 'more';
          }
          this.save(p);
          return r;
        }
        case 'decide': {
          const r = await this.decideStep(p4, p, shouldStop);
          this.time(p, 'decide', Date.now() - t0, r.items);
          if (r.finished) this.next(p, 'gate');
          else this.save(p);
          return 'more';
        }
        case 'gate': {
          await this.gateStep(p4, p);
          this.time(p, 'gate', Date.now() - t0, p.decided);
          this.next(p, 'propose');
          return 'more';
        }
        case 'propose': {
          const r = await this.proposeStep(p4, p, shouldStop);
          this.time(p, 'propose', Date.now() - t0, r.items);
          if (r.finished) {
            p.rulesKey = stage5RulesKey(this.db, p.stage4AiFinishedAt);
            p.finishedAt = Date.now();
            this.next(p, 'done');
            this.deps.log?.(
              `Stage 5: done (${p.counts?.books ?? 0} books to change, gate ${p.gate?.passed ? 'passed' : 'not passed'}, cost $${(p.cost?.costUsd ?? 0).toFixed(4)})`,
            );
            return 'done';
          }
          this.save(p);
          return 'more';
        }
        default:
          return 'done';
      }
    } catch (err) {
      p.error = (err as Error).message.slice(0, 500);
      p.finishedAt = Date.now();
      this.next(p, 'done');
      throw err;
    }
  }

  private redo(p: Stage5Progress): void {
    p.decided = 0;
    p.asked = 0;
    p.oneModel = 0;
    p.droppedTerms = 0;
    p.finishedAt = null;
    p.gate = null;
    p.counts = null;
    this.union = null;
  }

  private itemKey(libraryId: string, uuid: string): string {
    return `${libraryId}:${uuid}`;
  }

  private books(
    p4: Stage4Progress,
  ): { calibre_uuid: string; calibre_id: number; labeled: number }[] {
    const key = `${p4.analysisId}|${p4.finishedAt}`;
    if (this.list?.key !== key) {
      const rows = this.db
        .prepare(
          `SELECT calibre_uuid, calibre_id, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'proposed'`,
        )
        .all(p4.analysisId) as { calibre_uuid: string; calibre_id: number; labeled: number }[];
      rows.sort((a, b) => a.calibre_id - b.calibre_id);
      this.list = { key, rows };
    }
    return this.list.rows;
  }

  private slice<T extends { calibre_id: number }>(rows: T[], after: number, limit: number): T[] {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].calibre_id <= after) lo = mid + 1;
      else hi = mid;
    }
    return rows.slice(lo, lo + limit);
  }

  /** Stage 4's decided format per book: its format proposals (the AI value where asked). */
  private formatOf(p4: Stage4Progress): Map<string, Format> {
    const key = `${p4.analysisId}|${p4.finishedAt}|${this.deps.stage4Ai.progress()?.finishedAt}`;
    if (this.formats?.key !== key) {
      const map = new Map<string, Format>();
      for (const r of this.db
        .prepare(
          // Format proposals are never written (stage 5 makes the format a tag): always proposed.
          `SELECT calibre_uuid, new_json FROM proposed_changes INDEXED BY proposed_changes_counts
           WHERE stage = 4 AND library_id = ? AND state = 'proposed' AND field = 'format' AND analysis_id = ?`,
        )
        .all(p4.libraryId, p4.analysisId) as { calibre_uuid: string; new_json: string }[]) {
        const v = JSON.parse(r.new_json) as unknown;
        if (typeof v === 'string' && FORMATS.has(v)) map.set(r.calibre_uuid, v as Format);
      }
      this.formats = { key, map };
    }
    return this.formats.map;
  }

  /** Calibre's series and description per book (the snapshot's extras, one map per snapshot). */
  private extras(p4: Stage4Progress) {
    // Once per step: loadSnapshot looks at the snapshot file on every call (52,000 looks held
    // the server about 6 s on the PC, measured at stop 1).
    return (this.extrasNow ??= this.deps.analysis.extrasAll(p4));
  }
  private extrasNow: ReadonlyMap<
    number,
    { series: string | null; comments: string | null }
  > | null = null;

  /** Every Calibre book of the snapshot in id order (stage 5 also removes tags of the others). */
  private allBooks(p4: Stage4Progress): { calibre_id: number; book: Stage2Book }[] {
    const snap = this.deps.analysis.loadSnapshot(p4.libraryId);
    if (this.all?.snap !== snap) {
      const rows = [...snap.books.values()]
        .sort((a, b) => a.calibreId - b.calibreId)
        .map((book) => ({ calibre_id: book.calibreId, book }));
      this.all = { snap, rows };
    }
    return this.all.rows;
  }

  /** The genre test's labels file (setting, else beside gold800.json). */
  labelsFile(): string | null {
    const s = getSettings(this.db).gate.genreLabelsFile;
    if (s) return s;
    return this.deps.dbDir
      ? path.join(this.deps.dbDir, 'cleanup', 'reference-sample', GENRE_LABELS_FILENAME)
      : null;
  }

  private labels(): GenreLabels | null {
    const f = this.labelsFile();
    return f ? loadGenreLabels(f) : null;
  }

  /** The labeled books (their Calibre ids now): asked first, and alone with labeledOnly. */
  private labeledSet(p4: Stage4Progress): { ids: Set<number>; gids: Map<string, number> } {
    const key = `${p4.analysisId}|${p4.finishedAt}`;
    if (this.labeled?.key === key) return this.labeled;
    const L = this.labels();
    const gids = L
      ? mapLabeledIds(this.db, p4.libraryId, [
          ...new Set([...Object.keys(L.genres), ...Object.keys(L.tags)]),
        ])
      : new Map<string, number>();
    const ids = new Set<number>(gids.values());
    this.labeled = { key, ids, gids };
    return this.labeled;
  }

  private marksStep(p4: Stage4Progress, p: Stage5Progress): void {
    const snap = this.deps.analysis.loadSnapshot(p4.libraryId);
    const n = recordMarks(this.db, p4.libraryId, snap.books.values());
    p.marks = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM calibre_marks WHERE library_id = ?')
        .get(p4.libraryId) as { n: number }
    ).n;
    this.deps.log?.(`Stage 5: the Google run's marks recorded (${n} new, ${p.marks} in all)`);
  }

  private async evidenceStep(
    p4: Stage4Progress,
    p: Stage5Progress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    const all = this.books(p4);
    p.total = all.length;
    const formats = this.formatOf(p4);
    const labeled = this.labeledSet(p4).ids;
    let n = 0;
    for (let round = 0; round < 10 && !shouldStop(); round++) {
      const rows = this.slice(all, p.cursor, SLICE);
      if (!rows.length) return { finished: true, items: n };
      const items: { key: string; evidence: Stage5Item; labeled: boolean }[] = [];
      const y = new Yielder();
      for (const r of rows) {
        await y.maybe();
        const inp = this.deps.analysis.aiInputs(p4, r.calibre_uuid);
        if (!inp) continue;
        const key = this.itemKey(p4.libraryId, r.calibre_uuid);
        const s4 = storedAiValues(this.db, key);
        const ex = this.extras(p4).get(r.calibre_id);
        items.push({
          key,
          evidence: stage5Evidence({
            book: inp.book,
            base: inp.base,
            record: inp.record,
            decision: inp.decision,
            comments: ex?.comments ?? null,
            format: formats.get(r.calibre_uuid) ?? null,
            modelsSayAmazon: !!s4?.asked && !!s4.amazonIsBook,
          }),
          labeled: labeled.has(r.calibre_id),
        });
      }
      this.deps.runner.putItems(STAGE5_SPEC, items, STAGE5_EVIDENCE_VERSION);
      p.items += items.length;
      p.labeledItems += items.filter((i) => i.labeled).length;
      p.cursor = rows[rows.length - 1].calibre_id;
      n += items.length;
      await new Promise((res) => setImmediate(res));
    }
    return { finished: false, items: n };
  }

  private async modelsStep(
    p: Stage5Progress,
    shouldStop: () => boolean,
  ): Promise<Stage5StepResult> {
    const runner = this.deps.runner;
    const s = getSettings(this.db);
    const key = stage5AskKey(this.db);
    if (p.askKey !== key) {
      const keys = (
        this.db
          .prepare(
            `SELECT item_key FROM ai_items WHERE stage = 'calibre5' ${s.ai.labeledOnly ? 'AND labeled = 1' : ''}
             ORDER BY labeled DESC, item_key`,
          )
          .all() as { item_key: string }[]
      ).map((r) => r.item_key);
      for (let at = 0; at < keys.length; at += 500) {
        const chunk = keys.slice(at, at + 500);
        runner.enqueue(STAGE5_SPEC, 'primary', chunk, p.analysisId);
        runner.enqueue(STAGE5_SPEC, 'secondary', chunk, p.analysisId);
        await new Promise((r) => setImmediate(r));
      }
      p.askKey = key;
    }
    p.modelsStart ??= { at: Date.now(), done: this.doneByModel(p.analysisId) };
    const r = await runner.step(STAGE5_SPEC, p.analysisId, shouldStop);
    p.ai = runner.counts('calibre5', p.analysisId) as unknown as Record<string, number>;
    p.cost = runSpend(this.db, 'calibre5', p.analysisId) as Stage5Progress['cost'];
    if (r.wait) {
      p.wait = waitText(r.wait);
      const st = getStage(this.db, STAGE);
      if (waitNeedsUser(r.wait) && (st.pauseReason !== 'ai' || st.pauseDetail !== p.wait)) {
        pauseStage(this.db, STAGE, 'ai', p.wait);
        this.deps.log?.(`Stage 5: ${p.wait}`);
      }
      if (r.pending === 0 && !waitNeedsUser(r.wait)) return 'done';
      // A note on one model's batches: the rest goes on at its own pace.
      return waitIsNote(r.wait) && (r.sent > 0 || r.answered > 0) ? 'more' : 'wait';
    }
    p.wait = null;
    if (getStage(this.db, STAGE).pauseReason === 'ai') resumeStage(this.db, STAGE);
    if (r.pending === 0) return 'done';
    return r.sent > 0 || r.answered > 0 ? 'more' : 'wait';
  }

  private async decideStep(
    p4: Stage4Progress,
    p: Stage5Progress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    const runner = this.deps.runner;
    const rows = this.slice(this.books(p4), p.cursor, SLICE);
    if (!rows.length) return { finished: true, items: 0 };
    const now = Date.now();
    const out = [];
    const y = new Yielder();
    for (const r of rows) {
      await y.maybe();
      if (shouldStop()) break;
      const key = this.itemKey(p4.libraryId, r.calibre_uuid);
      const ev = runner.evidenceOf<Stage5Item>(STAGE5_SPEC, key);
      if (ev) {
        const a = runner.answerOf(STAGE5_SPEC, 'primary', key);
        const b = runner.answerOf(STAGE5_SPEC, 'secondary', key);
        const pa = a?.state === 'answered' ? (a.answer as Stage5Answer) : null;
        const pb = b?.state === 'answered' ? (b.answer as Stage5Answer) : null;
        const own = ownTerms({
          primary: pa,
          secondary: pb,
          ranobedbTags: ev.evidence.ranobedb_tags,
          storeCategories: ev.evidence.amazon_categories,
          adaptationText: adaptationText(ev.evidence),
        });
        if (own.asked) p.asked += 1;
        p.oneModel += own.oneModel;
        p.droppedTerms += (pa?.dropped ?? 0) + (pb?.dropped ?? 0);
        out.push({
          itemKey: key,
          field: OWN_FIELD,
          decision: {
            value: own,
            source: own.asked ? ('both_models' as const) : ('rules' as const),
            flagged: false,
            reason: own.asked ? null : 'Not asked (or a model gave no answer): rules only',
          },
          rules: null,
          primary: pa,
          secondary: pb,
          evidenceHash: ev.hash,
        });
      }
      p.cursor = r.calibre_id;
      p.decided += 1;
    }
    writeDecisions(this.db, 'calibre5', out, 'E', now);
    return { finished: false, items: out.length };
  }

  /** Every stage-4 book's own terms (read once per gate; a user value wins as for any value). */
  private ownTermsAll(p4: Stage4Progress): Map<string, OwnTerms> {
    const prefix = `${p4.libraryId}:`;
    const out = new Map<string, OwnTerms>();
    for (const r of this.db
      .prepare(`SELECT item_key, value_json FROM ai_values WHERE stage = 'calibre5' AND field = ?`)
      .all(OWN_FIELD) as { item_key: string; value_json: string }[]) {
      if (!r.item_key.startsWith(prefix)) continue;
      out.set(r.item_key.slice(prefix.length), JSON.parse(r.value_json) as OwnTerms);
    }
    return out;
  }

  private unionNow(p4: Stage4Progress, p: Stage5Progress): Map<number, Record<string, UnionTerm>> {
    const key = `${p.analysisId}|${p.decided}|${p.stage4AiFinishedAt}`;
    if (this.union?.key === key) return this.union.map;
    const own = this.ownTermsAll(p4);
    const books = this.books(p4).flatMap((b) => {
      const o = own.get(b.calibre_uuid);
      return o
        ? [
            {
              calibreId: b.calibre_id,
              // Per book (decided with the user 2026-11-21): no union across a series.
              series: null,
              own: o,
            },
          ]
        : [];
    });
    const map = seriesUnion(books);
    this.union = { key, map };
    return map;
  }

  private async gateStep(p4: Stage4Progress, p: Stage5Progress): Promise<void> {
    const settings = getSettings(this.db);
    const union = this.unionNow(p4, p);
    await new Promise((r) => setImmediate(r));
    const own = this.ownTermsAll(p4);
    await new Promise((r) => setImmediate(r));
    const L = this.labels() ?? { genres: {}, tags: {} };
    const { gids } = this.labeledSet(p4);
    const snap = this.deps.analysis.loadSnapshot(p4.libraryId);
    const uuidOf = (gid: string) => {
      const id = gids.get(gid);
      return id === undefined ? null : (snap.books.get(id)?.uuid ?? null);
    };
    let notAsked = 0;
    const asked = new Set<string>();
    const view = (pick: (gid: string) => Set<string> | null): GateView => ({
      genres: scoreSet(L.genres, pick, (x) => GENRE_IDS.has(x) || SUBJECT_IDS.has(x)),
      tags: scoreSet(L.tags, pick, (x) => TAG_IDS.has(x)),
    });
    const ownOf = (gid: string, keep: (sources: string[]) => boolean) => {
      const u = uuidOf(gid);
      const o = u ? own.get(u) : undefined;
      if (!o) return null;
      return new Set(
        Object.entries(o.terms)
          .filter(([, s]) => keep(s))
          .map(([id]) => id),
      );
    };
    for (const gid of new Set([...Object.keys(L.genres), ...Object.keys(L.tags)])) {
      const u = uuidOf(gid);
      const o = u ? own.get(u) : undefined;
      if (o && !o.asked && !asked.has(gid)) notAsked += 1;
      asked.add(gid);
    }
    // Per book without RanobeDB's terms (its effect).
    const books4 = this.books(p4);
    const noRdb = seriesUnion(
      books4.flatMap((b) => {
        const o = own.get(b.calibre_uuid);
        if (!o) return [];
        const terms = Object.fromEntries(
          Object.entries(o.terms)
            .map(([id, s]) => [id, s.filter((x) => x !== 'ranobedb')] as const)
            .filter(([, s]) => s.length > 0),
        );
        return [
          {
            calibreId: b.calibre_id,
            series: null,
            own: { ...o, terms },
          },
        ];
      }),
    );
    await new Promise((r) => setImmediate(r));
    const unionOf = (m: Map<number, Record<string, UnionTerm>>) => (gid: string) => {
      const id = gids.get(gid);
      const u = id === undefined ? undefined : m.get(id);
      return u ? new Set(Object.keys(u)) : null;
    };
    const g = {
      models: view((gid) => ownOf(gid, (s) => s.includes('models'))),
      own: view((gid) => ownOf(gid, () => true)),
      noRanobedb: view(unionOf(noRdb)),
      final: view(unionOf(union)),
    };
    const below = belowBars(g.final, settings.gate.stage5);
    const held = {
      genres: below.some((b) => b.startsWith('genres')),
      tags: below.some((b) => b.startsWith('tags')),
    };
    for (const set of ['genres', 'tags'] as const) {
      if (held[set])
        pauseField(this.db, STAGE, set, 'gate', below.filter((b) => b.startsWith(set)).join('; '));
      else resumeField(this.db, STAGE, set);
    }
    p.gate = {
      at: Date.now(),
      books: { genres: g.final.genres.books, tags: g.final.tags.books },
      ...g,
      test: TEST_SCORES,
      below,
      held,
      passed: g.final.genres.books > 0 && g.final.tags.books > 0 && below.length === 0,
      notAsked,
    };
    p.cost = runSpend(this.db, 'calibre5', p.analysisId) as Stage5Progress['cost'];
  }

  private async proposeStep(
    p4: Stage4Progress,
    p: Stage5Progress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    const settings = getSettings(this.db);
    const all = this.allBooks(p4);
    p.total = all.length;
    p.counts ??= emptyCounts();
    const c = p.counts;
    const union = this.unionNow(p4, p);
    const formats = this.formatOf(p4);
    const in4 = new Set(this.books(p4).map((b) => b.calibre_uuid));
    const held = p.gate?.held ?? { genres: false, tags: false };
    const rows = this.slice(all, p.cursor, SLICE * 4).map((x) => x.book);
    if (!rows.length) return { finished: true, items: 0 };
    const now = Date.now();
    const uuids = rows.map((b) => b.uuid);
    const ph = uuids.map(() => '?').join(', ');
    const added = new Map<string, string[]>();
    for (const r of this.db
      .prepare(
        `SELECT calibre_uuid, value_json FROM applied_values
         WHERE library_id = ? AND field = 'tags' AND calibre_uuid IN (${ph})`,
      )
      .all(p4.libraryId, ...uuids) as { calibre_uuid: string; value_json: string }[]) {
      added.set(r.calibre_uuid, (JSON.parse(r.value_json) as { added?: string[] }).added ?? []);
    }
    const busy = new Set(
      (
        this.db
          .prepare(
            `SELECT calibre_uuid FROM proposed_changes INDEXED BY proposed_changes_book
             WHERE library_id = ? AND calibre_uuid IN (${ph}) AND field = 'tags' AND stage = 5 AND state = 'queued'`,
          )
          .all(p4.libraryId, ...uuids) as { calibre_uuid: string }[]
      ).map((r) => r.calibre_uuid),
    );
    const del = this.db.prepare(
      `DELETE FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND field = 'tags' AND stage = 5 AND state IN ('proposed', 'skipped')`,
    );
    const ins = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (5, ?, ?, ?, 'tags', ?, ?, ?, ?, 'auto', NULL, 'proposed', ?, ?, ?)`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const b of rows) {
        n += 1;
        if (busy.has(b.uuid)) {
          c.inBatch += 1;
          continue;
        }
        const inside = in4.has(b.uuid);
        const u = inside ? (union.get(b.calibreId) ?? {}) : null;
        const ids = u
          ? Object.keys(u).filter((id) => {
              const k = BY_ID.get(id)?.kind;
              if (held.genres && (k === 'genre' || k === 'subject')) return false;
              if (held.tags && k === 'tag') return false;
              return true;
            })
          : null;
        const format = inside ? (formats.get(b.uuid) ?? null) : null;
        const ch = tagChange(ids, format, b.tags, settings.customTags, added.get(b.uuid) ?? []);
        del.run(p4.libraryId, b.uuid);
        if (inside) {
          const k = byKind(ids ?? []);
          for (const id of ids ?? []) c.terms[id] = (c.terms[id] ?? 0) + 1;
          if (format) c.formats[format] = (c.formats[format] ?? 0) + 1;
          if (k.genres.length === 0 && k.subjects.length === 0) c.noGenre += 1;
        } else c.outside += 1;
        for (const t of ch.remove) c.removals[t] = (c.removals[t] ?? 0) + 1;
        if (!ch.add.length && !ch.remove.length) continue;
        c.books += 1;
        c.added += ch.add.length;
        c.removed += ch.remove.length;
        if (!inside) c.outsideChanged += 1;
        const sources: Record<string, unknown> = {};
        for (const id of ids ?? []) {
          const t = u![id];
          sources[id] = { from: t.sources, books: t.count, of: t.books };
        }
        ins.run(
          p4.libraryId,
          b.calibreId,
          b.uuid,
          JSON.stringify(b.tags),
          JSON.stringify(ch),
          inside ? 'stage5' : 'stage5-removals',
          JSON.stringify({
            title: b.title,
            lastModified: b.lastModified,
            ids: ids ? byKind(ids) : null,
            format,
            sources,
            series: inside ? (this.extras(p4).get(b.calibreId)?.series ?? null) : null,
            rules: STAGE5_RULES_VERSION,
          }),
          p.analysisId,
          now,
          now,
        );
      }
    })();
    p.cursor = rows[rows.length - 1].calibreId;
    if (shouldStop()) return { finished: false, items: n };
    await new Promise((r) => setImmediate(r));
    return { finished: false, items: n };
  }
}
