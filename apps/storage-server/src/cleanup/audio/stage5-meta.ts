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
import { AiRunner, modeOf, waitNeedsUser, waitText, type AiCounts } from '../ai/runner';
import { runSpend, spendNow } from '../ai/spend';
import {
  dropOtherItems,
  valueCounts,
  valuesOf,
  writeDecisions,
  type DecisionRow,
} from '../ai/values';
import { getSettings } from '../settings';
import { getAudioStage, pauseAudioStage, resumeAudioStage, updateAudioStage } from './audio-stages';
import { decideUnit, META_VALUE_FIELDS } from './meta-decide';
import { EvidenceBuilder, META_EVIDENCE_VERSION, type MetaEvidence } from './meta-evidence';
import { scoreMetaGate, type GateValue, type MetaGateResult, type MetaLabel } from './meta-gate';
import { META_PROMPT_VERSION, META_SPEC, metaEvidenceText } from './meta-prompt';
import type { UnitInputs } from './stage4-online';

const STAGE5 = 5;
/** Raised when a code change can change the decisions (decided again, nobody asked again). */
export const META_RULES_VERSION = 2;
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
  ai: AiCounts | null;
  /** What the models step waits for (shown on the card). */
  wait: string | null;
  invented: number;
  counts: Record<string, Record<string, number>> | null;
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
        if (r.finished) this.nextPhase(p, 'gate');
        else this.save(p, 'analysing');
        return 'more';
      }
      if (p.phase === 'gate') {
        p.gate = this.evaluateGate(p);
        p.counts = valueCounts(this.db, 'audio5', this.unitKeys(p));
        const cost = runSpend(this.db, 'audio5', p.analysisId);
        p.cost = cost;
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
      return r.pending === 0 && !waitNeedsUser(r.wait) ? 'done' : 'wait';
    }
    p.wait = null;
    this.unpause();
    if (r.pending === 0) return 'done';
    return r.sent > 0 || r.answered > 0 ? 'more' : 'wait';
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
    for (const { unit_key } of rows) {
      if (shouldStop()) break;
      const ev = runner.evidenceOf(META_SPEC, unit_key);
      if (!ev) {
        done.push({ key: unit_key, flagged: 0, record: null, error: 'no evidence record' });
        continue;
      }
      const a = runner.answerOf(META_SPEC, 'primary', unit_key);
      const b = runner.answerOf(META_SPEC, 'secondary', unit_key);
      const out = decideUnit(
        ev.evidence,
        {
          primary: a?.state === 'answered' ? a.answer : null,
          secondary: b?.state === 'answered' ? b.answer : null,
        },
        metaEvidenceText(ev.evidence),
        opts,
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
  private unitFinder(p: AudioStage5Progress) {
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
      const s = getSettings(this.db).ai;
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
      let direct = 0;
      let batchQueued = 0;
      let batchOpen = 0;
      for (const g of groups) {
        if (modeOf(s, g.model) === 'direct' || g.mode === 'direct') direct += g.n;
        else if (g.state === 'queued') batchQueued += g.n;
        else batchOpen += g.n;
      }
      let secs = 0;
      if (direct) {
        const r = this.db
          .prepare(
            `SELECT AVG(answered_at - sent_at) AS ms FROM ai_requests
             WHERE stage = 'audio5' AND mode = 'direct' AND answered_at IS NOT NULL AND sent_at IS NOT NULL
             AND run_id = ?`,
          )
          .get(p.analysisId) as { ms: number | null };
        if (!r.ms) return null;
        // Each provider asks directWorkers questions at a time, the providers side by side.
        secs = (direct * r.ms) / s.directWorkers / 2 / 1000;
      }
      if (batchQueued || batchOpen) {
        const b = this.deps.runner.batches('audio5');
        if (b.turnaroundMs.median === null) return null;
        const oldest = this.db
          .prepare(
            `SELECT MIN(submitted_at) AS t FROM ai_batches WHERE stage = 'audio5' AND state = 'submitted'`,
          )
          .get() as { t: number | null };
        const batchesLeft = Math.ceil(batchQueued / Math.max(1, s.batchSize));
        const current = oldest.t ? Math.max(0, b.turnaroundMs.median - (now - oldest.t)) : 0;
        secs = Math.max(secs, (current + batchesLeft * b.turnaroundMs.median) / 1000);
      }
      return secs;
    }
    return null;
  }

  status(now = Date.now()) {
    const p = this.progress();
    const s = getSettings(this.db).ai;
    const spend = spendNow(this.db);
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
      spend: { ...spend, limitUsd: s.spendLimitUsd },
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
      labeledOnly: s.labeledOnly,
    };
  }
}
