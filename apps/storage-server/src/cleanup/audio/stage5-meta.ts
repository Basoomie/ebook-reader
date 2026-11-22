/**
 * Audiobook stage 5: metadata decisions (WP21d, plan section 7). Analysis only (Preview):
 * values and their sources go into cleanup.db (ai_values, stage "audio5"); nothing is written to
 * the audiobook folders or to Audiobookshelf, nothing is fetched, no file is read.
 *
 * Phases (resumable; each saves before the next starts):
 *   evidence  one evidence record per recording (stage 4's units), from cleanup.db only
 *   models    setup E: Claude Haiku 5.5 and GPT-6 Luna read every recording (the shared AI
 *             framework: batches or direct calls, within the spending limit; answers kept, so
 *             unchanged evidence is never asked twice). Waits on the page for a spending limit,
 *             a key, a model id; pauses when the limit is reached.
 *   decide    the rules and both answers per field (meta-decide.ts)
 *   gate      the labeled books, every field (meta-gate.ts)
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { AiRunner, modeOf, type AiCounts } from '../../ai/runner';
import { waitIsNote, waitNeedsUser, waitText } from '../../ai/waits';
import { runSpend } from '../../ai/spend';
import {
  dropOtherItems,
  itemDesigns,
  setItemDesigns,
  setUserValue,
  valueCounts,
  valuesOf,
  writeDecisions,
  type DecisionRow,
  type StoredValue,
} from '../ai-decide/values';
import { getSettings } from '../settings';
import { getAudioStage, pauseAudioStage, resumeAudioStage, updateAudioStage } from './audio-stages';
import {
  decideUnit,
  META_VALUE_FIELDS,
  needsUpgrade,
  sameBookSeries,
  sharedPositions,
  type SameBookUnit,
} from './meta-decide';
import { VOLUME_NO_SERIES } from './meta-rules';
import { CORRECTIONS } from './meta-corrections';
import { nameGroups, respellAll, type NameUnit } from './meta-names';
import { EvidenceBuilder, META_EVIDENCE_VERSION, type MetaEvidence } from './meta-evidence';
import { scoreMetaGate, type GateValue, type MetaGateResult, type MetaLabel } from './meta-gate';
import { META_PROMPT_VERSION, META_SPEC, metaEvidenceText } from './meta-prompt';
import type { UnitInputs } from './stage4-online';

const STAGE5 = 5;
/** Raised when a code change can change the decisions (decided again, nobody asked again). */
export const META_RULES_VERSION = 8;
/** Units per synchronous slice (measured on the live copy: 200 held the event loop 112 ms). */
const SLICE = 50;

export type Stage5Phase = 'evidence' | 'models' | 'decide' | 'gate' | 'done';

export interface Stage5PhaseTime {
  ms: number;
  items: number;
}

export interface AudioStage5Progress {
  analysisId: string;
  phase: Stage5Phase;
  startedAt: number;
  finishedAt: number | null;
  /** The stage-4 analysis the units come from (a new one starts stage 5 over). */
  stage4Id: string | null;
  /** The rules' settings the decisions were made with (a change decides again). */
  rulesKey: string | null;
  /** The models, prompt and scope the questions were queued with (a change asks again). */
  askKey: string | null;
  units: number;
  labeledUnits: number;
  /** Units decided in the decide phase. */
  decided: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  phaseTimes: Record<string, Stage5PhaseTime>;
  /** WP21f-1: recordings per design (E, F, J) in this analysis. */
  designs?: Record<'E' | 'F' | 'J', number>;
  /** WP21f-1: F/J recordings asked of the stronger pair. */
  upgradeAsked?: number;
  ai: AiCounts | null;
  /** What the models step waits for (shown on the card). */
  wait: string | null;
  invented: number;
  counts: Record<string, Record<string, number>> | null;
  /**
   * The answers the decisions use (this run's and earlier runs' with the same evidence, prompt
   * and models), with their cost: a run again asks only what is missing, so its own counts
   * alone read as "0 in, $0.00".
   */
  inUse?: { answered: number; failed: number; blocked: number; invalid: number; costUsd: number };
  cost: {
    costUsd: number;
    items: number;
    perItemUsd: number | null;
    byModel: Record<string, number>;
  } | null;
  gate: MetaGateResult | null;
  gateLabelsKey: string | null;
  error: string | null;
}

export function emptyStage5(now = Date.now()): AudioStage5Progress {
  return {
    analysisId: randomUUID(),
    phase: 'evidence',
    startedAt: now,
    finishedAt: null,
    stage4Id: null,
    rulesKey: null,
    askKey: null,
    units: 0,
    labeledUnits: 0,
    decided: 0,
    phaseStartedAt: now,
    phaseStartDone: 0,
    phaseTimes: {},
    ai: null,
    wait: null,
    invented: 0,
    counts: null,
    cost: null,
    gate: null,
    gateLabelsKey: null,
    error: null,
  };
}

export interface Stage5Deps {
  db: Database.Database;
  runner: AiRunner;
  /** labels.json as text, or why it can't be read. */
  readLabels?: () => { text: string | null; error: string | null };
  /**
   * WP21f-1: the design each recording is decided with (stage 7: the new arrivals get the
   * arrivals' setup, default J). Missing = E for every recording.
   */
  designs?: (stage4Id: string) => Map<string, 'E' | 'F' | 'J'>;
  log?: (m: string) => void;
}

export function stage5RulesKey(db: Database.Database): string {
  const s = getSettings(db);
  return createHash('sha1')
    .update(JSON.stringify([META_RULES_VERSION, s.audiobooks.multiNarratorMin]))
    .digest('hex')
    .slice(0, 16);
}

export function stage5AskKey(db: Database.Database): string {
  const s = getSettings(db);
  return createHash('sha1')
    .update(
      JSON.stringify([
        META_PROMPT_VERSION,
        s.models[META_SPEC.tasks.primary],
        s.models[META_SPEC.tasks.secondary],
        s.ai.labeledOnly,
        // WP21f-1: the stronger pair of the upgrades (asked only about F and J items).
        s.models[META_SPEC.tasks.upgradePrimary],
        s.models[META_SPEC.tasks.upgradeSecondary],
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

/** One step's outcome: done, more work now, or waiting (sleep before the next step). */
export type Stage5Step = 'done' | 'more' | 'wait';

export class AudioStage5 {
  private labelsCache: {
    at: number;
    books: MetaLabel[] | null;
    error: string | null;
    key: string | null;
  } | null = null;

  constructor(private readonly deps: Stage5Deps) {}

  private get db(): Database.Database {
    return this.deps.db;
  }

  progress(): AudioStage5Progress | null {
    const p = getAudioStage(this.db, STAGE5).progress as unknown as AudioStage5Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: AudioStage5Progress, state?: string): void {
    updateAudioStage(this.db, STAGE5, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(): AudioStage5Progress {
    const p = emptyStage5();
    this.save(p, 'analysing');
    this.unpause();
    return p;
  }

  private nextPhase(p: AudioStage5Progress, phase: Stage5Phase): void {
    p.phase = phase;
    p.phaseStartedAt = Date.now();
    p.phaseStartDone = phase === 'decide' ? p.decided : 0;
    this.save(p, phase === 'done' ? 'ready' : 'analysing');
  }

  private addTime(p: AudioStage5Progress, phase: string, ms: number, items: number): void {
    const t = (p.phaseTimes[phase] ??= { ms: 0, items: 0 });
    t.ms += ms;
    t.items += items;
  }

  private unpause(): void {
    const st = getAudioStage(this.db, STAGE5);
    if (st.pauseReason === 'ai') resumeAudioStage(this.db, STAGE5);
  }

  /** Decide again from the stored answers (the rules' settings changed). */
  redecide(): void {
    const p = this.progress();
    if (!p || p.phase === 'evidence' || p.phase === 'models') return;
    this.db
      .prepare(`UPDATE audio_meta_units SET state = 'asking' WHERE analysis_id = ?`)
      .run(p.analysisId);
    p.decided = 0;
    // Counted while deciding: a new pass counts from zero (it doubled on each pass, 2026-11-20).
    p.invented = 0;
    p.rulesKey = stage5RulesKey(this.db);
    p.finishedAt = null;
    p.gate = null;
    this.nextPhase(p, 'decide');
  }

  /** Ask again (the models, the prompt or the scope changed): answers already given are kept. */
  reask(): void {
    const p = this.progress();
    if (!p || p.phase === 'evidence') return;
    p.askKey = null;
    p.decided = 0;
    p.invented = 0;
    p.finishedAt = null;
    p.gate = null;
    this.nextPhase(p, 'models');
  }

  async step(shouldStop: () => boolean, stage4Id: string): Promise<Stage5Step> {
    const p = this.progress();
    if (!p || p.phase === 'done') return 'done';
    const t0 = Date.now();
    try {
      if (p.phase === 'evidence') {
        const n = await this.evidenceStep(p, stage4Id);
        this.addTime(p, 'evidence', Date.now() - t0, n);
        this.nextPhase(p, 'models');
        return 'more';
      }
      if (p.phase === 'models') {
        const r = await this.modelsStep(p, shouldStop);
        this.addTime(p, 'models', Date.now() - t0, 0);
        if (r === 'done') {
          this.nextPhase(p, 'decide');
          return 'more';
        }
        this.save(p, 'analysing');
        return r;
      }
      if (p.phase === 'decide') {
        const r = await this.decideStep(p, shouldStop);
        this.addTime(p, 'decide', Date.now() - t0, r.items);
        if (r.finished) {
          await this.sameBookStep(p);
          await this.positionsStep(p);
          this.correctionsStep(p);
          await this.namesStep(p);
          this.nextPhase(p, 'gate');
        } else this.save(p, 'analysing');
        return 'more';
      }
      if (p.phase === 'gate') {
        p.gate = this.evaluateGate(p);
        p.counts = valueCounts(this.db, 'audio5', this.unitKeys(p));
        const cost = runSpend(this.db, 'audio5', p.analysisId);
        p.cost = cost;
        p.inUse = this.answersInUse();
        p.finishedAt = Date.now();
        this.addTime(p, 'gate', Date.now() - t0, p.gate.books);
        this.nextPhase(p, 'done');
        this.deps.log?.(
          `Audiobooks stage 5: done (gate ${p.gate.passed ? 'passed' : 'not passed'}, cost $${cost.costUsd.toFixed(4)})`,
        );
        return 'done';
      }
      return 'done';
    } catch (err) {
      p.error = (err as Error).message.slice(0, 500);
      p.finishedAt = Date.now();
      this.nextPhase(p, 'done');
      throw err;
    }
  }

  /** The answers the current decisions read, whatever run asked them, with their cost. */
  private answersInUse(): NonNullable<AudioStage5Progress['inUse']> {
    const s = getSettings(this.db);
    const models = [
      s.models[META_SPEC.tasks.primary],
      s.models[META_SPEC.tasks.secondary],
      s.models[META_SPEC.tasks.upgradePrimary],
      s.models[META_SPEC.tasks.upgradeSecondary],
    ];
    const out = { answered: 0, failed: 0, blocked: 0, invalid: 0, costUsd: 0 };
    for (const r of this.db
      .prepare(
        `SELECT r.state, COUNT(*) AS n, COALESCE(SUM(r.cost_usd), 0) AS c
         FROM ai_items i JOIN ai_requests r ON r.stage = i.stage AND r.item_key = i.item_key
           AND r.evidence_hash = i.evidence_hash AND r.prompt_version = ? AND r.model IN (?, ?, ?, ?)
         WHERE i.stage = 'audio5' GROUP BY r.state`,
      )
      .all(META_SPEC.promptVersion, ...models) as {
      state: string;
      n: number;
      c: number;
    }[]) {
      if (r.state in out) (out as Record<string, number>)[r.state] = r.n;
      out.costUsd += r.c;
    }
    return out;
  }

  /** Every recording as the series rules after the decisions see it (cleanup.db only, in slices). */
  private async seriesUnits(p: AudioStage5Progress): Promise<SameBookUnit[]> {
    const runner = this.deps.runner;
    const keys = this.unitKeys(p);
    const units: SameBookUnit[] = [];
    for (let at = 0; at < keys.length; at += SLICE) {
      for (const key of keys.slice(at, at + SLICE)) {
        const ev = runner.evidenceOf(META_SPEC, key);
        const v = Object.fromEntries(valuesOf(this.db, 'audio5', key).map((x) => [x.field, x]));
        const rec = ev?.evidence.record;
        const audibleRecord = rec?.source === 'audible' && rec.series.length > 0;
        const series = v.series;
        units.push({
          key,
          name: ev?.evidence.name ?? key,
          audibleRecord,
          audibleSeries:
            audibleRecord && !!series && !series.flagged && series.source !== 'unknown',
          title: (v.title?.value as string | null) ?? null,
          authors: (v.authors?.value as string[] | null) ?? [],
          series: (series?.value as SameBookUnit['series']) ?? null,
          user: series?.source === 'user',
          volumeGuess: series?.reason === VOLUME_NO_SERIES && series.source !== 'unknown',
        });
      }
      await new Promise((r) => setImmediate(r));
    }
    return units;
  }

  /** A recording's count of unconfirmed fields follows its values. */
  private refreshFlagged(p: AudioStage5Progress, itemKeys: string[]): void {
    const count = this.db.prepare(
      `SELECT COUNT(*) AS n FROM ai_values WHERE stage = 'audio5' AND item_key = ? AND flagged = 1
       AND field IN (${META_VALUE_FIELDS.map(() => '?').join(', ')})`,
    );
    const upd = this.db.prepare(
      'UPDATE audio_meta_units SET flagged = ? WHERE analysis_id = ? AND unit_key = ?',
    );
    this.db.transaction(() => {
      for (const k of itemKeys)
        upd.run((count.get(k, ...META_VALUE_FIELDS) as { n: number }).n, p.analysisId, k);
    })();
  }

  /**
   * After every recording is decided: a position two recordings of one Audible series share is
   * dropped (see `sharedPositions`; user, 2026-11-20). Runs before the same-book step so a
   * recording taking its twin's series takes it without the dropped number.
   */
  private async positionsStep(p: AudioStage5Progress): Promise<void> {
    const runner = this.deps.runner;
    const found = sharedPositions(await this.seriesUnits(p));
    if (!found.size) return;
    const now = Date.now();
    const rows: DecisionRow[] = [];
    for (const [key, series] of found) {
      const cur = valuesOf(this.db, 'audio5', key).find((x) => x.field === 'series');
      if (!cur || cur.source === 'user') continue;
      rows.push({
        itemKey: key,
        field: 'series',
        decision: {
          value: series,
          source: cur.source,
          flagged: cur.flagged,
          reason: 'Audible gives the same position to another recording of the series: no number',
        },
        rules: { value: cur.rules, auto: cur.rulesAuto ?? false },
        primary: cur.primary,
        secondary: cur.secondary,
        evidenceHash: runner.evidenceOf(META_SPEC, key)?.hash ?? null,
        design: cur.design,
      });
    }
    writeDecisions(this.db, 'audio5', rows, 'E', now);
    this.refreshFlagged(
      p,
      rows.map((r) => r.itemKey),
    );
    this.deps.log?.(
      `Audiobooks stage 5: ${rows.length} recordings share a position with another recording: no number`,
    );
  }

  /**
   * The one-off corrections of store errors (`meta-corrections.ts`): written as the user's own
   * values, only where the user has no value yet, so no later pass overwrites them.
   */
  private correctionsStep(p: AudioStage5Progress): void {
    if (!CORRECTIONS.length) return;
    const now = Date.now();
    const find = this.db.prepare(
      'SELECT unit_key FROM audio_meta_units WHERE analysis_id = ? AND record = ?',
    );
    const touched = new Set<string>();
    for (const c of CORRECTIONS) {
      for (const { unit_key } of find.all(p.analysisId, c.record) as { unit_key: string }[]) {
        const cur = valuesOf(this.db, 'audio5', unit_key).find((x) => x.field === c.field);
        if (cur?.source === 'user') continue;
        setUserValue(this.db, 'audio5', unit_key, c.field, c.value, now);
        touched.add(unit_key);
      }
    }
    this.refreshFlagged(p, [...touched]);
    if (touched.size)
      this.deps.log?.(`Audiobooks stage 5: ${touched.size} recordings with a correction`);
  }

  /**
   * After the corrections: one person, one spelling (see `meta-names.ts`; user, 2026-11-20).
   * Authors and narrators of every recording that is not the user's own value take the
   * spelling most recordings have; 複数ナレーター follows a narrators list that changed size.
   */
  private async namesStep(p: AudioStage5Progress): Promise<void> {
    const runner = this.deps.runner;
    const units: NameUnit[] = [];
    const keys = this.unitKeys(p);
    const cur = new Map<string, Record<string, StoredValue>>();
    for (let at = 0; at < keys.length; at += SLICE) {
      for (const key of keys.slice(at, at + SLICE)) {
        const v = Object.fromEntries(valuesOf(this.db, 'audio5', key).map((x) => [x.field, x]));
        cur.set(key, v);
        units.push({
          key,
          authors: (v.authors?.value as string[] | null) ?? null,
          narrators: (v.narrators?.value as string[] | null) ?? null,
          userAuthors: v.authors?.source === 'user',
          userNarrators: v.narrators?.source === 'user',
        });
      }
      await new Promise((r) => setImmediate(r));
    }
    const found = respellAll(units, nameGroups(units));
    if (!found.size) return;
    const min = getSettings(this.db).audiobooks.multiNarratorMin;
    const rows: DecisionRow[] = [];
    const reason = 'Spelled as most recordings spell this person';
    for (const [key, f] of found) {
      const v = cur.get(key)!;
      const hash = runner.evidenceOf(META_SPEC, key)?.hash ?? null;
      for (const field of ['authors', 'narrators'] as const) {
        const list = f[field];
        const c = v[field];
        if (!list || !c) continue;
        rows.push({
          itemKey: key,
          field,
          decision: {
            value: list,
            source: c.source,
            flagged: c.flagged,
            reason: c.reason ?? reason,
          },
          rules: { value: c.rules, auto: c.rulesAuto ?? false },
          primary: c.primary,
          secondary: c.secondary,
          evidenceHash: hash,
          design: c.design,
        });
        const m = v.multi_narr;
        if (field === 'narrators' && m && m.source !== 'user')
          rows.push({
            itemKey: key,
            field: 'multi_narr',
            decision: {
              value: list.length >= min,
              source: m.source,
              flagged: m.flagged,
              reason: m.reason,
            },
            rules: null,
            primary: null,
            secondary: null,
            evidenceHash: hash,
            design: m.design,
          });
      }
    }
    writeDecisions(this.db, 'audio5', rows, 'E', Date.now());
    this.refreshFlagged(p, [...found.keys()]);
    this.deps.log?.(`Audiobooks stage 5: ${found.size} recordings with a name respelled`);
  }

  /**
   * After every recording is decided: the same book's series in Audible's name (see
   * `sameBookSeries`). Reads cleanup.db only, in slices; a user value is never replaced.
   */
  private async sameBookStep(p: AudioStage5Progress): Promise<void> {
    const runner = this.deps.runner;
    const found = sameBookSeries(await this.seriesUnits(p));
    if (!found.size) return;
    const now = Date.now();
    const rows: DecisionRow[] = [];
    for (const [key, f] of found) {
      const cur = valuesOf(this.db, 'audio5', key).find((x) => x.field === 'series');
      if (cur?.source === 'user') continue;
      rows.push({
        itemKey: key,
        field: 'series',
        decision: {
          value: f.series,
          source: 'rules',
          flagged: false,
          reason: `The Audible edition of the same book (${f.from})`,
        },
        rules: cur ? { value: cur.rules, auto: cur.rulesAuto ?? false } : null,
        primary: cur?.primary ?? null,
        secondary: cur?.secondary ?? null,
        evidenceHash: runner.evidenceOf(META_SPEC, key)?.hash ?? null,
        ...(cur ? { design: cur.design } : {}),
      });
    }
    writeDecisions(this.db, 'audio5', rows, 'E', now);
    this.refreshFlagged(
      p,
      rows.map((r) => r.itemKey),
    );
    this.deps.log?.(
      `Audiobooks stage 5: ${rows.length} series from the Audible edition of the same book`,
    );
  }

  private unitKeys(p: AudioStage5Progress): string[] {
    return (
      this.db
        .prepare('SELECT unit_key FROM audio_meta_units WHERE analysis_id = ?')
        .all(p.analysisId) as { unit_key: string }[]
    ).map((r) => r.unit_key);
  }

  // -------------------------------------------------------------------------------------------
  // evidence

  private async evidenceStep(p: AudioStage5Progress, stage4Id: string): Promise<number> {
    const db = this.db;
    p.stage4Id = stage4Id;
    p.rulesKey = stage5RulesKey(db);
    const units = EvidenceBuilder.units(db, stage4Id);
    const builder = new EvidenceBuilder(db);
    const now = Date.now();
    // Earlier analyses' rows go (their values stay until replaced; evidence records stay).
    db.prepare('DELETE FROM audio_meta_units WHERE analysis_id <> ?').run(p.analysisId);
    const put = db.prepare(
      `INSERT INTO audio_meta_units (analysis_id, unit_key, name, labeled, kind, stage4_class, record, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence', ?)
       ON CONFLICT(analysis_id, unit_key) DO NOTHING`,
    );
    for (let at = 0; at < units.length; at += SLICE) {
      const chunk = units.slice(at, at + SLICE);
      const items: { key: string; evidence: MetaEvidence; labeled: boolean }[] = [];
      for (const u of chunk)
        items.push({ key: u.unit_key, evidence: builder.build(u), labeled: u.labeled === 1 });
      this.deps.runner.putItems(META_SPEC, items, META_EVIDENCE_VERSION);
      db.transaction(() => {
        for (const it of items)
          put.run(
            p.analysisId,
            it.key,
            it.evidence.name,
            it.labeled ? 1 : 0,
            it.evidence.kind,
            it.evidence.stage4.class,
            it.evidence.record?.id ?? null,
            now,
          );
      })();
      await new Promise((r) => setImmediate(r));
    }
    dropOtherItems(db, 'audio5', new Set(units.map((u) => u.unit_key)));
    // WP21f-1: which recordings are decided with a stronger design (the new arrivals).
    const designs = this.deps.designs?.(stage4Id) ?? new Map<string, 'E' | 'F' | 'J'>();
    setItemDesigns(db, 'audio5', designs, now);
    p.designs = { E: 0, F: 0, J: 0 };
    for (const u of units) p.designs[designs.get(u.unit_key) ?? 'E']++;
    p.units = units.length;
    p.labeledUnits = units.filter((u) => u.labeled === 1).length;
    return units.length;
  }

  // -------------------------------------------------------------------------------------------
  // models

  private async modelsStep(p: AudioStage5Progress, shouldStop: () => boolean): Promise<Stage5Step> {
    const runner = this.deps.runner;
    const s = getSettings(this.db);
    const key = stage5AskKey(this.db);
    if (p.askKey !== key) {
      // Queue every recording's questions (the labeled first; only them when labeledOnly).
      const rows = this.db
        .prepare(
          `SELECT unit_key FROM audio_meta_units WHERE analysis_id = ? ${s.ai.labeledOnly ? 'AND labeled = 1' : ''}
           ORDER BY labeled DESC, unit_key`,
        )
        .all(p.analysisId) as { unit_key: string }[];
      const keys = rows.map((r) => r.unit_key);
      for (let at = 0; at < keys.length; at += 500) {
        const chunk = keys.slice(at, at + 500);
        runner.enqueue(META_SPEC, 'primary', chunk, p.analysisId);
        runner.enqueue(META_SPEC, 'secondary', chunk, p.analysisId);
        await new Promise((r) => setImmediate(r));
      }
      this.db
        .prepare(`UPDATE audio_meta_units SET state = 'asking' WHERE analysis_id = ?`)
        .run(p.analysisId);
      p.askKey = key;
    }
    const r = await runner.step(META_SPEC, p.analysisId, shouldStop);
    p.ai = runner.counts('audio5', p.analysisId);
    p.cost = runSpend(this.db, 'audio5', p.analysisId);
    if (r.wait) {
      p.wait = waitText(r.wait);
      const st = getAudioStage(this.db, STAGE5);
      if (waitNeedsUser(r.wait) && (st.pauseReason !== 'ai' || st.pauseDetail !== p.wait)) {
        pauseAudioStage(this.db, STAGE5, 'ai', p.wait);
        this.deps.log?.(`Audiobooks stage 5: ${p.wait}`);
      }
      if (r.pending === 0 && !waitNeedsUser(r.wait)) return 'done';
      // A note on one model's batches: the rest goes on at its own pace.
      return waitIsNote(r.wait) && (r.sent > 0 || r.answered > 0) ? 'more' : 'wait';
    }
    p.wait = null;
    this.unpause();
    if (r.pending === 0) {
      // WP21f-1: E's answers are in; the F and J items now get the stronger pair's questions
      // (only those with a field E decided or guessed).
      if (this.queueUpgrades(p) > 0) return 'more';
      return 'done';
    }
    return r.sent > 0 || r.answered > 0 ? 'more' : 'wait';
  }

  /**
   * WP21f-1: the stronger pair's questions for the items decided with F or J: an item is asked
   * when E would leave one of its fields for the upgrade (F: a flagged field; J: also an open
   * field both cheap models agreed on). Returns how many questions were added.
   */
  private queueUpgrades(p: AudioStage5Progress): number {
    const designs = itemDesigns(this.db, 'audio5');
    if (!designs.size) return 0;
    const runner = this.deps.runner;
    const s = getSettings(this.db);
    const opts = { multiNarratorMin: s.audiobooks.multiNarratorMin };
    const live = new Set(this.unitKeys(p));
    const keys: string[] = [];
    for (const [key, design] of designs) {
      if ((design !== 'F' && design !== 'J') || !live.has(key)) continue;
      const ev = runner.evidenceOf(META_SPEC, key);
      if (!ev) continue;
      const a = runner.answerOf(META_SPEC, 'primary', key);
      const b = runner.answerOf(META_SPEC, 'secondary', key);
      const out = decideUnit(
        ev.evidence,
        {
          primary: a?.state === 'answered' ? a.answer : null,
          secondary: b?.state === 'answered' ? b.answer : null,
        },
        metaEvidenceText(ev.evidence),
        opts,
      );
      if (needsUpgrade(out, design)) keys.push(key);
    }
    p.upgradeAsked = keys.length;
    if (!keys.length) return 0;
    return (
      runner.enqueue(META_SPEC, 'upgradePrimary', keys, p.analysisId) +
      runner.enqueue(META_SPEC, 'upgradeSecondary', keys, p.analysisId)
    );
  }

  // -------------------------------------------------------------------------------------------
  // decide

  private async decideStep(
    p: AudioStage5Progress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; items: number }> {
    const db = this.db;
    const runner = this.deps.runner;
    const opts = { multiNarratorMin: getSettings(db).audiobooks.multiNarratorMin };
    const rows = db
      .prepare(
        `SELECT unit_key FROM audio_meta_units WHERE analysis_id = ? AND state IN ('evidence', 'asking')
         ORDER BY labeled DESC, unit_key LIMIT ?`,
      )
      .all(p.analysisId, SLICE) as { unit_key: string }[];
    if (!rows.length) return { finished: true, items: 0 };
    const now = Date.now();
    const decisions: DecisionRow[] = [];
    const done: { key: string; flagged: number; record: string | null; error: string | null }[] =
      [];
    const designs = itemDesigns(db, 'audio5');
    for (const { unit_key } of rows) {
      if (shouldStop()) break;
      const ev = runner.evidenceOf(META_SPEC, unit_key);
      if (!ev) {
        done.push({ key: unit_key, flagged: 0, record: null, error: 'no evidence record' });
        continue;
      }
      const a = runner.answerOf(META_SPEC, 'primary', unit_key);
      const b = runner.answerOf(META_SPEC, 'secondary', unit_key);
      const design = designs.get(unit_key) ?? 'E';
      let upgrade: Parameters<typeof decideUnit>[4];
      if (design === 'F' || design === 'J') {
        const sa = runner.answerOf(META_SPEC, 'upgradePrimary', unit_key);
        const sb = runner.answerOf(META_SPEC, 'upgradeSecondary', unit_key);
        upgrade = {
          design,
          primary: sa?.state === 'answered' ? sa.answer : null,
          secondary: sb?.state === 'answered' ? sb.answer : null,
        };
      }
      const out = decideUnit(
        ev.evidence,
        {
          primary: a?.state === 'answered' ? a.answer : null,
          secondary: b?.state === 'answered' ? b.answer : null,
        },
        metaEvidenceText(ev.evidence),
        opts,
        upgrade,
      );
      p.invented += out.invented;
      let flagged = 0;
      for (const f of META_VALUE_FIELDS) {
        const o = out.fields[f];
        if (!o) continue;
        if (o.decision.flagged) flagged++;
        decisions.push({
          itemKey: unit_key,
          field: f,
          decision: o.decision,
          rules: o.rules,
          primary: o.primary,
          secondary: o.secondary,
          evidenceHash: ev.hash,
          design,
        });
      }
      done.push({ key: unit_key, flagged, record: out.record?.id ?? null, error: null });
    }
    writeDecisions(db, 'audio5', decisions, 'E', now);
    const upd = db.prepare(
      `UPDATE audio_meta_units SET state = ?, flagged = ?, record = ?, error = ?, updated_at = ?
       WHERE analysis_id = ? AND unit_key = ?`,
    );
    db.transaction(() => {
      for (const d of done)
        upd.run(
          d.error ? 'error' : 'decided',
          d.flagged,
          d.record,
          d.error,
          now,
          p.analysisId,
          d.key,
        );
    })();
    p.decided += done.length;
    await new Promise((r) => setImmediate(r));
    return { finished: false, items: done.length };
  }

  // -------------------------------------------------------------------------------------------
  // gate

  labels(): { books: MetaLabel[] | null; error: string | null; key: string | null } {
    const now = Date.now();
    if (this.labelsCache && now - this.labelsCache.at < 60_000) return this.labelsCache;
    const r = this.deps.readLabels?.() ?? { text: null, error: 'The labeled books are not set up' };
    let books: MetaLabel[] | null = null;
    let error = r.error;
    const key = r.text ? createHash('sha1').update(r.text).digest('hex').slice(0, 16) : null;
    if (r.text) {
      try {
        const j = JSON.parse(r.text) as { books?: unknown };
        if (Array.isArray(j.books)) books = j.books as MetaLabel[];
        else error = 'The labels file has no "books"';
      } catch (err) {
        error = `The labels file can't be read: ${(err as Error).message}`;
      }
    } else error ??= "The labels file can't be read";
    this.labelsCache = { at: now, books, error: books ? null : error, key };
    return this.labelsCache;
  }

  /** The unit a label's torrent file or folder belongs to (as stage 4's gate finds it). */
  unitFinder(p: AudioStage5Progress) {
    const rows = this.db
      .prepare(
        `SELECT m.unit_key, m.name, m.record, o.inputs_json FROM audio_meta_units m
         JOIN audio_online_units o ON o.analysis_id = ? AND o.unit_key = m.unit_key
         WHERE m.analysis_id = ?`,
      )
      .all(p.stage4Id, p.analysisId) as {
      unit_key: string;
      name: string;
      record: string | null;
      inputs_json: string;
    }[];
    const byPath = new Map<string, { unitKey: string; name: string; record: string | null }>();
    for (const r of rows) {
      const inputs = JSON.parse(r.inputs_json) as UnitInputs;
      const o = { unitKey: r.unit_key, name: r.name, record: r.record };
      for (const f of inputs.opening) if (f.root === 'torrents') byPath.set(f.rel, o);
      for (const pth of inputs.paths) {
        const rel = pth.slice(pth.indexOf(':') + 1);
        if (pth.startsWith('torrents:') && !byPath.has(rel)) byPath.set(rel, o);
      }
    }
    return (torrent: string) => {
      const exact = byPath.get(torrent);
      if (exact) return exact;
      for (const [rel, o] of byPath) if (rel.startsWith(torrent + '/')) return o;
      return null;
    };
  }

  evaluateGate(p: AudioStage5Progress): MetaGateResult {
    const l = this.labels();
    p.gateLabelsKey = l.key;
    const s = getSettings(this.db);
    if (!l.books) {
      return {
        passed: false,
        books: 0,
        notFound: [],
        fields: {} as MetaGateResult['fields'],
        misses: [],
        flaggedWrong: [],
        error: l.error,
      };
    }
    return scoreMetaGate(
      l.books,
      this.unitFinder(p),
      (k) => {
        const out: Record<string, GateValue> = {};
        for (const v of valuesOf(this.db, 'audio5', k))
          out[v.field] = {
            value: v.value,
            source: v.source,
            flagged: v.flagged,
            rules: v.rules,
            primary: v.primary,
            secondary: v.secondary,
          };
        return out;
      },
      s.gate.audiobookMetaPercent,
      s.gate.minBooks,
    );
  }

  /** A corrected labels.json scores the gate again (nothing is asked or decided again). */
  refreshGate(): boolean {
    const p = this.progress();
    if (!p || p.phase !== 'done' || p.error) return false;
    const l = this.labels();
    if (!l.key || p.gateLabelsKey === l.key) return false;
    p.gate = this.evaluateGate(p);
    this.save(p);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // the page

  /** Seconds left (estimate), or null while it can't be told. */
  secondsLeft(p: AudioStage5Progress, now = Date.now()): number | null {
    if (p.phase === 'done') return 0;
    const rate = (done: number, total: number) => {
      const elapsed = now - p.phaseStartedAt;
      const n = done - p.phaseStartDone;
      if (n <= 0 || elapsed <= 0) return null;
      return ((total - done) * elapsed) / n / 1000;
    };
    if (p.phase === 'decide') return rate(p.decided, p.units);
    if (p.phase === 'models') {
      const s = this.deps.runner.settings();
      const counts = p.ai;
      if (!counts) return null;
      if (!counts.queued && !counts.sent) return 0;
      // Questions asked directly (a direct provider's, or given back by a stalled batch) and
      // questions for batches; the step's time is the longer of the two.
      const groups = this.db
        .prepare(
          `SELECT model, mode, state, COUNT(*) AS n FROM ai_requests
           WHERE run_id = ? AND stage = 'audio5' AND state IN ('queued', 'sent')
           GROUP BY model, mode, state`,
        )
        .all(p.analysisId) as { model: string; mode: string | null; state: string; n: number }[];
      const direct = new Map<string, number>();
      let batchQueued = 0;
      let batchOpen = 0;
      for (const g of groups) {
        if (modeOf(s, g.model) === 'direct' || g.mode === 'direct')
          direct.set(g.model, (direct.get(g.model) ?? 0) + g.n);
        else if (g.state === 'queued') batchQueued += g.n;
        else batchOpen += g.n;
      }
      let secs = 0;
      // One call each: per model, its own measured time per answer, directWorkers at a time;
      // the models run side by side, so the step takes as long as the slowest.
      for (const [model, n] of direct) {
        const r = this.db
          .prepare(
            `SELECT AVG(answered_at - sent_at) AS ms FROM ai_requests
             WHERE stage = 'audio5' AND model = ? AND mode = 'direct' AND state = 'answered'
             AND answered_at IS NOT NULL AND sent_at IS NOT NULL`,
          )
          .get(model) as { ms: number | null };
        if (!r.ms) return null;
        secs = Math.max(secs, (n * r.ms) / s.directWorkers / 1000);
      }
      if (batchQueued || batchOpen) {
        const b = this.deps.runner.batches('audio5');
        // Until this stage has a batch back, the setting's starting figure (stop 1 measured
        // 2.6 min for Claude Haiku's batch of 195).
        const turnaround = b.turnaroundMs.median ?? s.batchTurnaroundMinutes * 60_000;
        const oldest = this.db
          .prepare(
            `SELECT MIN(submitted_at) AS t FROM ai_batches WHERE stage = 'audio5' AND state = 'submitted'`,
          )
          .get() as { t: number | null };
        const batchesLeft = Math.ceil(batchQueued / Math.max(1, s.batchSize));
        const current = oldest.t ? Math.max(0, turnaround - (now - oldest.t)) : 0;
        secs = Math.max(secs, (current + batchesLeft * turnaround) / 1000);
      }
      return secs;
    }
    return null;
  }

  status(now = Date.now()) {
    const p = this.progress();
    const s = this.deps.runner.settings();
    // This month's spending of every AI feature, under the one monthly limit.
    const room = this.deps.runner.core.room();
    return {
      progress: p
        ? {
            ...p,
            gate: p.gate
              ? {
                  ...p.gate,
                  misses: p.gate.misses.slice(0, 50),
                  flaggedWrong: p.gate.flaggedWrong.length,
                }
              : null,
          }
        : null,
      secondsLeft: p ? this.secondsLeft(p, now) : null,
      spend: { spentUsd: room.spentUsd, reservedUsd: room.reservedUsd, limitUsd: room.limitUsd },
      batches: this.deps.runner.batches('audio5'),
      modes: {
        primary: modeOf(s, getSettings(this.db).models[META_SPEC.tasks.primary] ?? ''),
        secondary: modeOf(s, getSettings(this.db).models[META_SPEC.tasks.secondary] ?? ''),
      },
      models: {
        primary: getSettings(this.db).models[META_SPEC.tasks.primary] ?? '',
        secondary: getSettings(this.db).models[META_SPEC.tasks.secondary] ?? '',
      },
      batchStallMinutes: s.batchStallMinutes,
      labeledOnly: getSettings(this.db).ai.labeledOnly,
    };
  }
}
