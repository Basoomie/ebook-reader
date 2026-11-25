/**
 * The Calibre library's new arrivals, stage 4's AI check (WP20g): the books of one run decided
 * with the arrivals' design (default J, plan section 6 and 10) by stage 4's own code, on the run's
 * view of the stage-4 progress (Stage4Analysis.arrivalView):
 *
 *   evidence  each new book's evidence (stage4Evidence, as the library's AI step builds it)
 *   cheap     Haiku and Luna (E) asked about every new book (the shared runner, run id = the view's
 *             analysis id)
 *   strong    for J (and F): Sonnet and Sol asked about the books where E left a field open or
 *             flagged (stage4NeedsUpgrade)
 *   decide    each book decided (combineE, or combineUpgrade for J/F) into ai_values 'calibre4'
 *             with its design kept in ai_item_designs (the library's own decide keeps it), then
 *             proposed again with the decided values (a value the user set wins)
 *   spelling  one spelling per series for the series the new books are in (chooseSpellings over
 *             every book of the library as stage 4 On would leave it, as the library's step does)
 *   series    the order of those series decided whole (orderSeries); the rows of every book of
 *             those series are written (the Best guesses list shows them), but only the new books
 *             are proposed (decided with the user 2026-11-22: a change to a book already in Calibre
 *             waits for stage 4's own On)
 *
 * The J gate (jGate): the labeled books decided with J in memory (never stored: the library's
 * labeled books keep their E values), scored against the bars. A field below its bar is decided
 * with E for the arrivals (E's gate is the library's, which passed).
 */
import type Database from 'better-sqlite3';
import type { AiRunner } from '../../ai/runner';
import { waitNeedsUser, waitText } from '../../ai/waits';
import { runSpend } from '../../ai/spend';
import type { UpgradeDesign } from '../ai-decide/combine';
import { addItemDesigns, writeDecisions } from '../ai-decide/values';
import { getSettings, stage4Bar } from '../settings';
import {
  AI_FIELD_KEYS,
  decideStage4Ai,
  decideStage4AiUpgrade,
  decisionRows,
  outcomeValues,
  stage4NeedsUpgrade,
  storedAiValues,
  type AiFieldKey,
  type Stage4AiOutcome,
} from '../stage4/ai-decide';
import { scoreAiGate } from '../stage4/ai-gate';
import {
  STAGE4_EVIDENCE_VERSION,
  STAGE4_SPEC,
  stage4Evidence,
  stage4EvidenceText,
} from '../stage4/ai-prompt';
import type { Stage4Analysis, Stage4Progress } from '../stage4/analysis';
import { FIELD_NAMES, SCORED_FIELDS } from '../stage4/score';
import { chooseSpellings, seriesKey } from '../stage4/series-spelling';
import { orderSeries, type SeriesBook } from '../stage4/series-order';
import { writeSeriesOrder, type SeriesOrderRow } from '../stage4/series-order-store';

export type ArrivalAiPhase =
  | 'evidence'
  | 'cheap'
  | 'strong'
  | 'decide'
  | 'spelling'
  | 'series'
  | 'done';

export interface ArrivalAiProgress {
  phase: ArrivalAiPhase;
  design: 'E' | 'F' | 'J';
  /** Item keys of the run's books with evidence. */
  keys: string[];
  /** Books the stronger pair is asked about. */
  strongKeys: string[];
  cursor: number;
  decided: number;
  /** Questions of this phase not answered yet (the run's bar while the models answer). */
  pending?: number;
  invented: number;
  /** Fields decided with E because J is below its bar on the labeled books. */
  eFields: string[];
  wait: string | null;
  cost: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  series: {
    series: number;
    newBooks: number;
    guesses: number;
    reviews: number;
    /** Books already in Calibre whose number the order would change (listed, not written). */
    existingChanged: number;
  } | null;
}

export function emptyArrivalAi(design: 'E' | 'F' | 'J', now = Date.now()): ArrivalAiProgress {
  return {
    phase: 'evidence',
    design,
    keys: [],
    strongKeys: [],
    cursor: 0,
    decided: 0,
    invented: 0,
    eFields: [],
    wait: null,
    cost: 0,
    phaseStartedAt: now,
    phaseStartDone: 0,
    series: null,
  };
}

/** The J gate: the labeled books decided with the stronger pair in memory. */
export interface JGate {
  at: number;
  design: UpgradeDesign;
  passed: boolean;
  /** Fields below their bar (decided with E for the arrivals). */
  below: string[];
  books: number;
  /** Per field: right when applied automatically (%), with how many. */
  fields: Record<string, { autoPercent: number | null; auto: number }>;
  /** Books with every field right, no review (%). */
  allRight: number | null;
}

export interface ArrivalAiDeps {
  db: Database.Database;
  runner: AiRunner;
  analysis: Stage4Analysis;
  log?: (m: string) => void;
}

const SLICE = 50;

export function itemKeyOf(libraryId: string, uuid: string): string {
  return `${libraryId}:${uuid}`;
}

export class ArrivalStage4Ai {
  constructor(private readonly deps: ArrivalAiDeps) {}

  private get db(): Database.Database {
    return this.deps.db;
  }

  private next(ai: ArrivalAiProgress, phase: ArrivalAiPhase, done = 0): void {
    ai.phase = phase;
    ai.cursor = 0;
    ai.pending = undefined;
    ai.phaseStartedAt = Date.now();
    ai.phaseStartDone = done;
  }

  /** The E outcome of a book from its stored answers (null without evidence). */
  private cheapOutcome(
    view: Stage4Progress,
    uuid: string,
  ): { out: Stage4AiOutcome; asked: boolean; hash: string } | null {
    const key = itemKeyOf(view.libraryId, uuid);
    const inp = this.deps.analysis.aiInputs(view, uuid);
    const ev = this.deps.runner.evidenceOf(STAGE4_SPEC, key);
    if (!inp || !ev) return null;
    const a = this.deps.runner.answerOf(STAGE4_SPEC, 'primary', key);
    const b = this.deps.runner.answerOf(STAGE4_SPEC, 'secondary', key);
    const answers = {
      primary: a?.state === 'answered' ? a.answer : null,
      secondary: b?.state === 'answered' ? b.answer : null,
    };
    return {
      out: decideStage4Ai(inp.decision, answers, stage4EvidenceText(ev.evidence)),
      asked: !!answers.primary && !!answers.secondary,
      hash: ev.hash,
    };
  }

  /**
   * One step of the run's AI check. `uuids`: the run's books stage 4 proposed (the view's
   * stage4_books in state proposed). Returns more (work done), wait (waiting for answers) or done.
   */
  async step(
    view: Stage4Progress,
    ai: ArrivalAiProgress,
    uuids: string[],
    jGate: JGate | null,
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait' | 'done'> {
    const runner = this.deps.runner;
    const runId = view.analysisId;
    if (ai.phase === 'evidence') {
      const items = [];
      for (const uuid of uuids) {
        const inp = this.deps.analysis.aiInputs(view, uuid);
        if (!inp) continue;
        items.push({
          key: itemKeyOf(view.libraryId, uuid),
          evidence: stage4Evidence(inp.base),
          labeled: false,
        });
      }
      runner.putItems(STAGE4_SPEC, items, STAGE4_EVIDENCE_VERSION);
      ai.keys = items.map((i) => i.key);
      for (let at = 0; at < ai.keys.length; at += 500) {
        const chunk = ai.keys.slice(at, at + 500);
        runner.enqueue(STAGE4_SPEC, 'primary', chunk, runId);
        runner.enqueue(STAGE4_SPEC, 'secondary', chunk, runId);
      }
      this.next(ai, 'cheap');
      return 'more';
    }
    if (ai.phase === 'cheap' || ai.phase === 'strong') {
      const r = await runner.step(STAGE4_SPEC, runId, shouldStop);
      ai.cost = (runSpend(this.db, 'calibre4', runId) as { costUsd: number }).costUsd ?? 0;
      ai.pending = r.pending;
      if (r.wait) {
        ai.wait = waitText(r.wait);
        if (waitNeedsUser(r.wait)) return 'wait';
      } else ai.wait = null;
      if (r.pending > 0) return r.sent > 0 || r.answered > 0 ? 'more' : 'wait';
      if (ai.phase === 'cheap' && ai.design !== 'E') {
        const design = ai.design as UpgradeDesign;
        ai.strongKeys = [];
        for (const key of ai.keys) {
          const uuid = key.slice(view.libraryId.length + 1);
          const c = this.cheapOutcome(view, uuid);
          if (c && stage4NeedsUpgrade(c.out, design)) ai.strongKeys.push(key);
        }
        for (let at = 0; at < ai.strongKeys.length; at += 500) {
          const chunk = ai.strongKeys.slice(at, at + 500);
          runner.enqueue(STAGE4_SPEC, 'upgradePrimary', chunk, runId);
          runner.enqueue(STAGE4_SPEC, 'upgradeSecondary', chunk, runId);
        }
        this.next(ai, 'strong');
        return 'more';
      }
      ai.eFields = jGate && ai.design !== 'E' ? jGate.below : [];
      this.next(ai, 'decide');
      return 'more';
    }
    if (ai.phase === 'decide') {
      const strong = new Set(ai.strongKeys);
      const now = Date.now();
      const designs = new Map<string, string>();
      let n = 0;
      while (ai.cursor < ai.keys.length && n < SLICE) {
        if (shouldStop()) break;
        const key = ai.keys[ai.cursor];
        const uuid = key.slice(view.libraryId.length + 1);
        const c = this.cheapOutcome(view, uuid);
        if (c) {
          let out = c.out;
          let design = 'E';
          if (ai.design !== 'E' && strong.has(key)) {
            const sa = runner.answerOf(STAGE4_SPEC, 'upgradePrimary', key);
            const sb = runner.answerOf(STAGE4_SPEC, 'upgradeSecondary', key);
            const inp = this.deps.analysis.aiInputs(view, uuid)!;
            const ev = runner.evidenceOf(STAGE4_SPEC, key)!;
            const a = runner.answerOf(STAGE4_SPEC, 'primary', key);
            const b = runner.answerOf(STAGE4_SPEC, 'secondary', key);
            const up = decideStage4AiUpgrade(
              ai.design as UpgradeDesign,
              inp.decision,
              {
                primary: a?.state === 'answered' ? a.answer : null,
                secondary: b?.state === 'answered' ? b.answer : null,
              },
              {
                primary: sa?.state === 'answered' ? sa.answer : null,
                secondary: sb?.state === 'answered' ? sb.answer : null,
              },
              stage4EvidenceText(ev.evidence),
            );
            out = withEFields(up, c.out, ai.eFields);
            design = ai.design;
          }
          ai.invented += out.invented;
          writeDecisions(this.db, 'calibre4', decisionRows(key, out, c.hash, c.asked), design, now);
          designs.set(key, ai.design);
          await this.deps.analysis.proposeWithAi(view, uuid, storedAiValues(this.db, key));
          ai.decided++;
        }
        ai.cursor++;
        n++;
      }
      // The run's books keep the run's design when the library is decided again.
      if (designs.size) addItemDesigns(this.db, 'calibre4', designs, now);
      if (ai.cursor >= ai.keys.length) this.next(ai, 'spelling');
      return 'more';
    }
    if (ai.phase === 'spelling') {
      this.spelling(view, uuids);
      for (const uuid of uuids) {
        await this.deps.analysis.proposeWithAi(
          view,
          uuid,
          storedAiValues(this.db, itemKeyOf(view.libraryId, uuid)),
        );
      }
      this.next(ai, 'series');
      return 'more';
    }
    if (ai.phase === 'series') {
      ai.series = this.series(view, uuids);
      for (const uuid of uuids) {
        await this.deps.analysis.proposeWithAi(
          view,
          uuid,
          storedAiValues(this.db, itemKeyOf(view.libraryId, uuid)),
        );
      }
      this.next(ai, 'done');
      return 'done';
    }
    return 'done';
  }

  /**
   * One spelling per series for the series the run's books are in: chosen from every book of the
   * library as stage 4 On would leave it (the library's own step's input), set on the view so the
   * new books' proposals take it. The library's chosen spellings of other series are kept.
   */
  private spelling(view: Stage4Progress, uuids: string[]): void {
    const books = this.deps.analysis.seriesAfterOn(view);
    const mine = new Set(uuids);
    const keys = new Set<string>();
    for (const b of books) {
      if (!mine.has(b.uuid)) continue;
      for (const n of [b.after, b.now]) if (n) keys.add(seriesKey(n));
    }
    keys.delete('');
    const map = chooseSpellings(
      books.filter(
        (b) =>
          (b.after !== null && keys.has(seriesKey(b.after))) ||
          (b.now !== null && keys.has(seriesKey(b.now))),
      ),
    );
    const v = view as Stage4Progress & {
      ai?: { seriesSpelling?: { at: number; names: Record<string, string> } | null };
    };
    const names = { ...(v.ai?.seriesSpelling?.names ?? {}) };
    for (const [k, name] of map) names[k] = name;
    v.ai = { ...(v.ai ?? {}), seriesSpelling: { at: Date.now(), names } };
  }

  /**
   * The order of each series a run's book is in (series-order.ts), decided whole from every book
   * of the series as stage 4 On would leave it. Every book's row is written (for the Best guesses
   * list); the caller proposes only the run's books.
   */
  private series(view: Stage4Progress, uuids: string[]): NonNullable<ArrivalAiProgress['series']> {
    const after = this.deps.analysis.seriesStateAfterOn(view);
    const mine = new Set(uuids);
    const keys = new Set<string>();
    for (const u of uuids) {
      const a = after.get(u);
      if (a?.name) keys.add(seriesKey(a.name));
    }
    keys.delete('');
    const by = new Map<string, SeriesBook[]>();
    for (const [uuid, a] of after) {
      if (!a.name) continue;
      const k = seriesKey(a.name);
      if (!keys.has(k)) continue;
      const b = this.deps.analysis.seriesBook(view, uuid, a);
      if (b) by.set(k, [...(by.get(k) ?? []), b]);
    }
    const out = { series: by.size, newBooks: 0, guesses: 0, reviews: 0, existingChanged: 0 };
    const rows: SeriesOrderRow[] = [];
    for (const [key, g] of by) {
      const choices = new Map(orderSeries(g).map((c) => [c.uuid, c]));
      for (const b of g) {
        const c = choices.get(b.uuid);
        const a = after.get(b.uuid)!;
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
        if (mine.has(b.uuid)) {
          out.newBooks++;
          if (c?.guess) out.guesses++;
          if (c?.review) out.reviews++;
        } else if (c && (c.index !== b.index || c.review !== undefined)) out.existingChanged++;
      }
    }
    if (rows.length) writeSeriesOrder(this.db, view.libraryId, rows);
    return out;
  }

  /**
   * The J gate (once per design and settings, before the first arrival is decided with it): the
   * labeled books' stronger-pair answers asked under their own run id, then decided in memory and
   * scored. Returns null while answers are still coming.
   */
  async jGate(
    library: Stage4Progress,
    design: UpgradeDesign,
    shouldStop: () => boolean,
  ): Promise<{ gate: JGate | null; wait: string | null }> {
    const runner = this.deps.runner;
    const runId = `arrivals-gate-${design}`;
    const labeled = this.deps.analysis.labeledBooks(library);
    const keys: string[] = [];
    const cheap = new Map<string, { out: Stage4AiOutcome; asked: boolean }>();
    for (const b of labeled) {
      const c = this.cheapOutcome(library, b.uuid);
      if (!c) continue;
      cheap.set(b.uuid, c);
      if (stage4NeedsUpgrade(c.out, design)) keys.push(itemKeyOf(library.libraryId, b.uuid));
    }
    runner.enqueue(STAGE4_SPEC, 'upgradePrimary', keys, runId);
    runner.enqueue(STAGE4_SPEC, 'upgradeSecondary', keys, runId);
    const r = await runner.step(STAGE4_SPEC, runId, shouldStop);
    if (r.pending > 0) return { gate: null, wait: r.wait ? waitText(r.wait) : null };
    const need = new Set(keys);
    const settings = getSettings(this.db);
    const books = labeled.map((b) => {
      const c = cheap.get(b.uuid);
      const key = itemKeyOf(library.libraryId, b.uuid);
      if (!c) return { gid: b.gid, gold: b.gold, ai: null };
      if (!need.has(key)) return { gid: b.gid, gold: b.gold, ai: outcomeValues(c.out, c.asked) };
      const inp = this.deps.analysis.aiInputs(library, b.uuid)!;
      const ev = runner.evidenceOf(STAGE4_SPEC, key)!;
      const ans = (role: 'primary' | 'secondary' | 'upgradePrimary' | 'upgradeSecondary') => {
        const x = runner.answerOf(STAGE4_SPEC, role, key);
        return x?.state === 'answered' ? x.answer : null;
      };
      const up = decideStage4AiUpgrade(
        design,
        inp.decision,
        { primary: ans('primary'), secondary: ans('secondary') },
        { primary: ans('upgradePrimary'), secondary: ans('upgradeSecondary') },
        stage4EvidenceText(ev.evidence),
      );
      return { gid: b.gid, gold: b.gold, ai: outcomeValues(up, c.asked) };
    });
    const g = scoreAiGate(books);
    const below: string[] = [];
    const fields: JGate['fields'] = {};
    for (const f of SCORED_FIELDS) {
      const name = FIELD_NAMES[f];
      const s = g.all.fields[f];
      fields[name] = { autoPercent: s.autoPercent, auto: s.auto };
      const bar = stage4Bar(settings, name);
      if (s.autoPercent !== null && s.auto >= settings.gate.minBooks && s.autoPercent < bar)
        below.push(name);
    }
    return {
      gate: {
        at: Date.now(),
        design,
        passed: g.books > 0 && below.length === 0,
        below,
        books: g.books,
        fields,
        allRight: g.all.everyFieldPercent,
      },
      wait: null,
    };
  }
}

/** The gate's field names → the AI's field keys. */
const FIELD_KEY: Record<string, AiFieldKey> = {
  title: 't',
  authors: 'au',
  illustrators: 'il',
  series: 'se',
  number: 'ix',
  format: 'fmt',
};

/** An upgraded outcome with E's decision kept for the fields J is below its bar on. */
function withEFields(up: Stage4AiOutcome, e: Stage4AiOutcome, eFields: string[]): Stage4AiOutcome {
  if (!eFields.length) return up;
  const out = { ...up } as Stage4AiOutcome;
  for (const name of eFields) {
    const k = FIELD_KEY[name];
    if (k && (AI_FIELD_KEYS as readonly string[]).includes(k))
      (out as unknown as Record<string, unknown>)[k] = (e as unknown as Record<string, unknown>)[k];
  }
  return out;
}
