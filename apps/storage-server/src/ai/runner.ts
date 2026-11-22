/**
 * Asks the models (WP21d; shared since book summaries session 1): a resumable queue of questions
 * in the feature's own database, sent in batches (the providers' Batch APIs, half price) or one
 * by one, within the one monthly spending limit (AiCore).
 *
 * - Each item's evidence record is kept (`ai_items`, gzip JSON with a hash).
 * - A question is one row per item, model, prompt version and evidence hash (`ai_requests`):
 *   a restart, a rules change or a new analysis with the same evidence never asks again.
 *   A failed question is asked again only in a later run; a blocked one never (final).
 * - Batches survive restarts (their ids are stored and checked every `batchPollSeconds`); once
 *   collected, what the provider keeps of them is deleted.
 * - Every paid answer is also a row in the shared ledger (ttsu.db), with the feature it is for.
 * - Nothing is sent while: the spending limit is not set or would be passed, a key is missing
 *   or refused, a model id is not in its provider's list, a model has no price.
 *
 * The queue's tables (ai_items, ai_requests, ai_batches) live in the feature's database; the
 * cleanup's are in cleanup.db (migrations 13, 16, 21).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import type { AiCore } from './core';
import { dropHold, putHold, recordedRefs, recordSpendMany, resetHolds } from './ledger';
import {
  FinalError,
  providerOf,
  RetryableError,
  type CallInput,
  type CallResult,
  type ProviderClient,
} from './providers';
import type { AiSettings } from './settings';
import { costOf, expectedListCost, priceOf } from './spend';
import type { AiStageSpec, Provider, StoredAnswer } from './types';
import { waitText, type AiWait } from './waits';

export type { AiWait } from './waits';

/** How a model is asked (settings ai.modes; a model not listed: batch). */
export function modeOf(s: AiSettings, model: string): 'batch' | 'direct' {
  return s.modes[model] ?? 'batch';
}

export interface AiRunnerDeps {
  /** The feature's database with the queue's tables. */
  db: Database.Database;
  core: AiCore;
  /** The queue's name in the ledger ("cleanup"): a request is (source, its id). */
  source: string;
  /** The feature a stage's spending counts for ("calibre-cleanup", "audiobook-cleanup", ...). */
  featureOf(stage: string): string;
  /** The model the feature chose for a task (its own setting; '' = none). */
  modelFor(task: string): string;
  /** Ask only about labeled items (the cleanup's "labeled only"); default off. */
  onlyLabeled?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

export interface AiItem<E> {
  key: string;
  evidence: E;
  labeled: boolean;
}

export interface AiStepResult {
  /** Questions of this run still open (queued or at a provider). */
  pending: number;
  /** Why nothing can be sent now (null = nothing in the way). */
  wait: AiWait | null;
  sent: number;
  answered: number;
}

export interface AiCounts {
  queued: number;
  sent: number;
  answered: number;
  blocked: number;
  invalid: number;
  failed: number;
}

interface ReqRow {
  id: number;
  item_key: string;
  role: string;
  provider: Provider;
  model: string;
  attempts: number;
  labeled: number;
}

const BUSY_WAIT_MS = 60_000;

function gz(v: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(v), 'utf8'));
}

export function ungz<T>(b: Buffer): T {
  return JSON.parse(gunzipSync(b).toString('utf8')) as T;
}

export function evidenceHash(version: number, evidence: unknown): string {
  return createHash('sha1')
    .update(`${version}\n${JSON.stringify(evidence)}`)
    .digest('hex')
    .slice(0, 20);
}

export class AiRunner {
  /** When this runner (the server process) started: calls sent before it were cut off. */
  private readonly startedAt: number;
  /**
   * The stages whose cut-off calls were asked again in this process. Per stage (WP20e): one
   * runner serves every stage, and a single flag left the second stage's calls "sent" for good.
   */
  private orphansRequeued = new Set<string>();
  /**
   * Calls asked one at a time that are in flight, by question id (a pool per model, as wide as
   * ai.directWorkers). A call that ends gives its slot to the next question at once, instead of
   * a group of calls waiting for its slowest one (stop 2, 2026-11-20: 8 calls a group gave
   * gpt-6-luna about 50 answers a minute; each group took as long as its slowest call).
   */
  private inFlight = new Map<number, { model: string; stage: string; estimate: number }>();
  /** Answers recorded by calls that ended since each stage's last step. */
  private endedSince = new Map<string, number>();
  /** What a call that ended found in the way (a refused key), for its stage's next step. */
  private callWaits = new Map<string, AiWait>();
  private waiters = new Set<() => void>();
  /** The last sweep of collected batches' provider data. */
  private lastSweep = 0;

  constructor(private readonly deps: AiRunnerDeps) {
    this.startedAt = this.now();
    this.repairLedger();
    this.rebuildHolds();
  }

  get core(): AiCore {
    return this.deps.core;
  }

  /**
   * The ledger gets a paid answer right after the feature's database: a process stopped in
   * between left the answer without its ledger row. Found here by id and added (cheap when the
   * counts agree).
   */
  private repairLedger(): void {
    const src = this.deps.source;
    const mine = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ai_requests WHERE cost_usd IS NOT NULL`)
      .get() as { n: number };
    const led = this.core.db
      .prepare(`SELECT COUNT(*) AS n FROM ai_spend WHERE source = ?`)
      .get(src) as { n: number };
    if (led.n >= mine.n) return;
    const have = recordedRefs(this.core.db, src);
    const rows = (
      this.db
        .prepare(
          `SELECT id, stage, provider, model, mode, cost_usd, answered_at, created_at FROM ai_requests
           WHERE cost_usd IS NOT NULL`,
        )
        .all() as {
        id: number;
        stage: string;
        provider: string;
        model: string;
        mode: string | null;
        cost_usd: number;
        answered_at: number | null;
        created_at: number;
      }[]
    ).filter((r) => !have.has(r.id));
    const n = recordSpendMany(
      this.core.db,
      rows.map((r) => ({
        source: src,
        ref: r.id,
        feature: this.deps.featureOf(r.stage),
        stage: r.stage,
        provider: r.provider,
        model: r.model,
        mode: r.mode,
        costUsd: r.cost_usd,
        at: r.answered_at ?? r.created_at,
      })),
    );
    if (n) {
      this.core.invalidateSpend();
      this.deps.log?.(`AI: ${n} paid answers added to the spending record`);
    }
  }

  /** The holds of this queue's batches still at a provider. */
  private rebuildHolds(): void {
    const open = this.db
      .prepare(
        `SELECT id, stage, estimate_usd, submitted_at FROM ai_batches WHERE state = 'submitted'`,
      )
      .all() as { id: string; stage: string; estimate_usd: number; submitted_at: number }[];
    resetHolds(
      this.core.db,
      this.deps.source,
      open.map((b) => ({
        batchId: b.id,
        feature: this.deps.featureOf(b.stage),
        estimateUsd: b.estimate_usd,
        since: b.submitted_at,
      })),
    );
  }

  /**
   * A call asked one at a time that was in flight when the server stopped (the nightly backup
   * stops ttsu-storage: stop 2, 2026-11-20 1:00 am, left 3 questions "sent" for good) is asked
   * again: queued with the tries it had. Batches are not touched (they survive by their id).
   */
  private requeueOrphans(stage: string): void {
    if (this.orphansRequeued.has(stage)) return;
    this.orphansRequeued.add(stage);
    const n = this.db
      .prepare(
        `UPDATE ai_requests SET state = 'queued', sent_at = NULL
         WHERE stage = ? AND state = 'sent' AND batch_id IS NULL AND (sent_at IS NULL OR sent_at < ?)`,
      )
      .run(stage, this.startedAt).changes;
    if (n) this.deps.log?.(`AI: ${n} questions cut off by a restart are asked again`);
  }

  private get db(): Database.Database {
    return this.deps.db;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms));
  }

  /** The provider settings (shared). */
  settings(): AiSettings {
    return this.core.settings();
  }

  private labeledOnly(): boolean {
    return this.deps.onlyLabeled?.() ?? false;
  }

  /** The model a role of a stage uses now (the feature's choice). */
  modelOf<R extends string>(spec: AiStageSpec<unknown, R>, role: R): string {
    return this.deps.modelFor(spec.tasks[role]) ?? '';
  }

  private client(provider: Provider): ProviderClient | null {
    return this.core.client(provider);
  }

  // -------------------------------------------------------------------------------------------
  // evidence records

  /** Stores the items' evidence; returns how many changed. */
  putItems<E>(spec: AiStageSpec<E>, items: AiItem<E>[], version: number): number {
    const now = this.now();
    const get = this.db.prepare(
      'SELECT evidence_hash, labeled FROM ai_items WHERE stage = ? AND item_key = ?',
    );
    const put = this.db.prepare(
      `INSERT INTO ai_items (stage, item_key, evidence, evidence_version, evidence_hash, labeled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stage, item_key) DO UPDATE SET evidence = excluded.evidence,
         evidence_version = excluded.evidence_version, evidence_hash = excluded.evidence_hash,
         labeled = excluded.labeled, updated_at = excluded.updated_at`,
    );
    // A question queued for evidence the item no longer has is never sent: it cost nothing yet,
    // and its answer would belong to evidence nobody reads (series-order follow-up, stop 2: a
    // run's questions at the old evidence were still sent after the evidence was built again).
    // A question already at the provider stays (it is collected and paid as it is).
    const stale = this.db.prepare(
      `DELETE FROM ai_requests WHERE stage = ? AND item_key = ? AND state = 'queued'
         AND evidence_hash <> ?`,
    );
    let changed = 0;
    this.db.transaction(() => {
      for (const it of items) {
        const hash = evidenceHash(version, it.evidence);
        const cur = get.get(spec.stage, it.key) as
          | { evidence_hash: string; labeled: number }
          | undefined;
        if (cur && cur.evidence_hash === hash && cur.labeled === (it.labeled ? 1 : 0)) continue;
        put.run(spec.stage, it.key, gz(it.evidence), version, hash, it.labeled ? 1 : 0, now);
        if (cur && cur.evidence_hash !== hash) stale.run(spec.stage, it.key, hash);
        changed++;
      }
    })();
    return changed;
  }

  evidenceOf<E>(spec: AiStageSpec<E>, key: string): { evidence: E; hash: string } | null {
    const r = this.db
      .prepare('SELECT evidence, evidence_hash FROM ai_items WHERE stage = ? AND item_key = ?')
      .get(spec.stage, key) as { evidence: Buffer; evidence_hash: string } | undefined;
    return r ? { evidence: ungz<E>(r.evidence), hash: r.evidence_hash } : null;
  }

  // -------------------------------------------------------------------------------------------
  // questions

  /**
   * Queues the questions a role still needs for these items (one per item at its current
   * evidence). Failed questions of earlier runs are asked again; answered and blocked ones never.
   */
  enqueue<R extends string>(
    spec: AiStageSpec<unknown, R>,
    role: R,
    keys: string[],
    runId: string,
  ): number {
    const model = this.modelOf(spec, role);
    if (!model) return 0;
    const provider = providerOf(model);
    const now = this.now();
    const item = this.db.prepare(
      'SELECT evidence_hash, labeled FROM ai_items WHERE stage = ? AND item_key = ?',
    );
    const ins = this.db.prepare(
      `INSERT INTO ai_requests (stage, item_key, role, provider, model, prompt_version, evidence_hash,
         state, run_id, labeled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
       ON CONFLICT(stage, item_key, model, prompt_version, evidence_hash) DO NOTHING`,
    );
    const again = this.db.prepare(
      `UPDATE ai_requests SET state = 'queued', attempts = 0, error = NULL, run_id = ?, labeled = ?
       WHERE stage = ? AND item_key = ? AND model = ? AND prompt_version = ? AND evidence_hash = ?
         AND ((state = 'failed' AND COALESCE(run_id, '') <> ?) OR state = 'queued')`,
    );
    // A question already sent (in a batch at the provider, or a call in flight) joins the new
    // run as it is: queued again it was asked and paid twice, and its batch was left open
    // (WP20e, found in the stop-1 smoke test). A restart's cut-off calls: requeueOrphans.
    const join = this.db.prepare(
      `UPDATE ai_requests SET run_id = ?, labeled = ?
       WHERE stage = ? AND item_key = ? AND model = ? AND prompt_version = ? AND evidence_hash = ?
         AND state = 'sent'`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const key of keys) {
        const it = item.get(spec.stage, key) as
          | { evidence_hash: string; labeled: number }
          | undefined;
        if (!it) continue;
        n += ins.run(
          spec.stage,
          key,
          role,
          provider,
          model,
          spec.promptVersion,
          it.evidence_hash,
          runId,
          it.labeled,
          now,
        ).changes;
        again.run(
          runId,
          it.labeled,
          spec.stage,
          key,
          model,
          spec.promptVersion,
          it.evidence_hash,
          runId,
        );
        join.run(runId, it.labeled, spec.stage, key, model, spec.promptVersion, it.evidence_hash);
      }
    })();
    return n;
  }

  /** A role's stored answer for an item at its current evidence (null = not asked yet). */
  answerOf<R extends string>(
    spec: AiStageSpec<unknown, R>,
    role: R,
    key: string,
  ): StoredAnswer | null {
    const model = this.modelOf(spec, role);
    const it = this.db
      .prepare('SELECT evidence_hash FROM ai_items WHERE stage = ? AND item_key = ?')
      .get(spec.stage, key) as { evidence_hash: string } | undefined;
    if (!model || !it) return null;
    const r = this.db
      .prepare(
        `SELECT state, answer_json FROM ai_requests WHERE stage = ? AND item_key = ? AND model = ?
         AND prompt_version = ? AND evidence_hash = ?`,
      )
      .get(spec.stage, key, model, spec.promptVersion, it.evidence_hash) as
      | { state: string; answer_json: string | null }
      | undefined;
    if (!r || r.state === 'queued' || r.state === 'sent') return null;
    return {
      model,
      state: r.state as StoredAnswer['state'],
      answer: r.answer_json ? (JSON.parse(r.answer_json) as Record<string, unknown>) : null,
    };
  }

  /**
   * The run's questions by state. With `labeledOnly` on, queued questions of unlabeled items
   * are not counted: they are never sent while it is on (a question already at the provider
   * still counts).
   */
  counts(stage: string, runId: string): AiCounts {
    const out: AiCounts = { queued: 0, sent: 0, answered: 0, blocked: 0, invalid: 0, failed: 0 };
    for (const r of this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = ?
           ${this.labeledOnly() ? "AND (labeled = 1 OR state <> 'queued')" : ''} GROUP BY state`,
      )
      .all(runId, stage) as { state: keyof AiCounts; n: number }[])
      out[r.state] = r.n;
    return out;
  }

  /** Questions still to be answered (as `counts`: with `labeledOnly`, only those it sends). */
  pending(stage: string, runId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = ? AND
             (state = 'sent' OR (state = 'queued' ${this.labeledOnly() ? 'AND labeled = 1' : ''}))`,
        )
        .get(runId, stage) as { n: number }
    ).n;
  }

  // -------------------------------------------------------------------------------------------
  // one step

  /**
   * Checks the batches at the providers, then sends what the limit allows. `labeledOnly`: only
   * labeled items' questions are sent.
   */
  async step<E>(
    spec: AiStageSpec<E>,
    runId: string,
    shouldStop: () => boolean,
  ): Promise<AiStepResult> {
    this.requeueOrphans(spec.stage);
    let answered = await this.collect(spec);
    let sent = 0;
    let wait: AiWait | null = null;
    const s = this.settings();
    if (s.spendLimitUsd === null) wait = { kind: 'no_limit' };
    else {
      const models = this.db
        .prepare(
          `SELECT model, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = ? AND state = 'queued'
           ${this.labeledOnly() ? 'AND labeled = 1' : ''} GROUP BY model`,
        )
        .all(runId, spec.stage) as { model: string; n: number }[];
      for (const m of models) {
        if (shouldStop()) break;
        const why = await this.core.usable(m.model);
        if (why) {
          wait ??= why;
          continue;
        }
        const batchMode = modeOf(s, m.model) === 'batch';
        // Questions a stalled batch gave back are always asked directly.
        const d = await this.sendDirect(
          spec,
          runId,
          m.model,
          s,
          shouldStop,
          batchMode ? 'returned' : 'all',
        );
        sent += d.sent;
        answered += d.answered;
        if (d.wait) wait ??= d.wait;
        if (batchMode && !d.wait) {
          const r = await this.sendBatch(spec, runId, m.model, s);
          sent += r.sent;
          answered += r.answered;
          if (r.wait) wait ??= r.wait;
        }
      }
    }
    // Calls one at a time run on after the step: it waits until one of this stage's ends (its
    // slot is filled again by the next step) or the batches' check is due, and gives the
    // server back meanwhile.
    if (!wait && this.inFlightOf(spec.stage) > 0)
      await this.nextEnd(spec.stage, s.batchPollSeconds * 1000, shouldStop);
    answered += this.endedSince.get(spec.stage) ?? 0;
    this.endedSince.delete(spec.stage);
    const cw = this.callWaits.get(spec.stage);
    if (cw) {
      this.callWaits.delete(spec.stage);
      wait ??= cw;
    }
    // A feature that waits in its queue for room under the limit: one alert while it waits
    // (the notification watcher reads it), gone once anything is sent again.
    if (spec.onLimit === 'queue') {
      const feature = this.deps.featureOf(spec.stage);
      if (wait?.kind === 'limit_reached') this.core.setWaiting(feature, waitText(wait));
      else if (sent > 0 || !wait) this.core.clearWaiting(feature);
    }
    return { pending: this.pending(spec.stage, runId), wait, sent, answered };
  }

  /** The source-wide key of a call in flight (the core holds every feature's). */
  private flightKey(id: number): string {
    return `${this.deps.source}:${id}`;
  }

  /** The limit's wait from the room now. */
  private limitWait(nextUsd: number, extraReserved = 0): AiWait {
    const r = this.core.room();
    return {
      kind: 'limit_reached',
      spentUsd: r.spentUsd,
      reservedUsd: r.reservedUsd + extraReserved,
      limitUsd: r.limitUsd ?? 0,
      nextUsd,
      resumesAt: r.resumesAt,
      resumesOn: r.resumesOn,
    };
  }

  private inFlightOf(stage: string): number {
    let n = 0;
    for (const c of this.inFlight.values()) if (c.stage === stage) n++;
    return n;
  }

  /** Until a call of the stage ends, at most `ms` (checked each second for a stop). */
  private async nextEnd(stage: string, ms: number, shouldStop: () => boolean): Promise<void> {
    const until = Date.now() + ms;
    const start = this.endedSince.get(stage) ?? 0;
    while (Date.now() < until && !shouldStop() && this.inFlightOf(stage) > 0) {
      if ((this.endedSince.get(stage) ?? 0) > start) return;
      await new Promise<void>((res) => {
        const done = () => {
          clearTimeout(t);
          this.waiters.delete(done);
          res();
        };
        const t = setTimeout(done, Math.min(1000, Math.max(1, until - Date.now())));
        this.waiters.add(done);
      });
    }
  }

  /** Until every call in flight has ended (tests; a stage's own waits go through `step`). */
  async settle(): Promise<void> {
    while (this.inFlight.size)
      await new Promise<void>((res) => {
        const done = () => {
          this.waiters.delete(done);
          res();
        };
        this.waiters.add(done);
      });
  }

  private queuedRows(
    spec: AiStageSpec<unknown>,
    runId: string,
    model: string,
    limit: number,
    labeledOnly: boolean,
    which: 'all' | 'batchable' | 'returned' = 'all',
  ): ReqRow[] {
    // returned = given back by a stalled batch (mode 'direct' while queued).
    const only =
      which === 'returned'
        ? `AND mode = 'direct'`
        : which === 'batchable'
          ? `AND COALESCE(mode, '') <> 'direct'`
          : '';
    // Labeled first, each in id order: one query per value reads the index in its order (with
    // "ORDER BY labeled DESC, id" SQLite sorted every queued question: 94 ms for Luna's 49,500,
    // on every step). "state = 'queued' AND mode = 'direct'" as written is what lets the
    // returned questions use their own index (cleanup.db v16).
    const st = this.db.prepare(
      `SELECT id, item_key, role, provider, model, attempts, labeled FROM ai_requests
       WHERE run_id = ? AND stage = ? AND state = 'queued' AND model = ? AND labeled = ? ${only}
       ORDER BY id LIMIT ?`,
    );
    const out: ReqRow[] = [];
    for (const labeled of labeledOnly ? [1] : [1, 0]) {
      if (out.length >= limit) break;
      out.push(...(st.all(runId, spec.stage, model, labeled, limit - out.length) as ReqRow[]));
    }
    return out;
  }

  private callInput<E>(spec: AiStageSpec<E>, row: ReqRow, s: AiSettings): CallInput | null {
    const ev = this.evidenceOf(spec, row.item_key);
    if (!ev) return null;
    return {
      model: row.model,
      system: spec.system,
      user: spec.userText(ev.evidence),
      schema: s.structuredOutputs ? { name: spec.schemaName, schema: spec.schema } : null,
      maxTokens: s.maxTokens,
    };
  }

  /** How many of `n` requests fit under the limit, and what one is expected to cost. */
  private fits(model: string, n: number, promptChars: number, batch: boolean, s: AiSettings) {
    const one = expectedListCost(this.db, s, model, promptChars) * (batch ? s.batchPriceFactor : 1);
    // This month's spending of every feature, their batches' holds and calls in flight.
    const r = this.core.room();
    const room = (s.spendLimitUsd ?? 0) - r.spentUsd - r.reservedUsd;
    const fit = one > 0 ? Math.max(0, Math.min(n, Math.floor(room / one))) : n;
    return { fit, one };
  }

  private async sendBatch<E>(
    spec: AiStageSpec<E>,
    runId: string,
    model: string,
    s: AiSettings,
  ): Promise<{ sent: number; answered: number; wait: AiWait | null }> {
    const rows = this.queuedRows(spec, runId, model, s.batchSize, this.labeledOnly(), 'batchable');
    if (!rows.length) return { sent: 0, answered: 0, wait: null };
    const inputs: { row: ReqRow; call: CallInput }[] = [];
    for (const row of rows) {
      const call = this.callInput(spec, row, s);
      if (!call) {
        this.finish(row.id, 'failed', null, null, null, 'no evidence record', false, s);
        continue;
      }
      inputs.push({ row, call });
    }
    if (!inputs.length) return { sent: 0, answered: 0, wait: null };
    const avgChars =
      inputs.reduce((a, x) => a + x.call.system.length + x.call.user.length, 0) / inputs.length;
    const f = this.fits(model, inputs.length, avgChars, true, s);
    if (f.fit === 0) return { sent: 0, answered: 0, wait: this.limitWait(f.one) };
    const take = inputs.slice(0, f.fit);
    const provider = providerOf(model);
    const client = this.client(provider)!;
    let batch: { id: string; inputFileId: string | null };
    try {
      batch = await client.submitBatch(
        take.map((x) => ({ customId: `r${x.row.id}`, call: x.call })),
      );
    } catch (err) {
      return {
        sent: 0,
        answered: 0,
        wait: this.sendError(
          provider,
          err,
          take.map((x) => x.row),
          s,
        ),
      };
    }
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ai_batches (id, provider, model, stage, state, requests, estimate_usd,
             input_file_id, submitted_at) VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`,
        )
        .run(
          batch.id,
          provider,
          model,
          spec.stage,
          take.length,
          f.one * take.length,
          batch.inputFileId,
          now,
        );
      const upd = this.db.prepare(
        `UPDATE ai_requests SET state = 'sent', mode = 'batch', batch_id = ?, sent_at = ?,
           attempts = attempts + 1 WHERE id = ?`,
      );
      for (const x of take) upd.run(batch.id, now, x.row.id);
    })();
    putHold(
      this.core.db,
      this.deps.source,
      batch.id,
      this.deps.featureOf(spec.stage),
      f.one * take.length,
      now,
    );
    this.deps.log?.(
      `AI: batch ${batch.id} sent to ${provider} (${model}, ${take.length} questions, about $${(f.one * take.length).toFixed(3)})`,
    );
    // The hold of the batch just sent is in the room already.
    const wait: AiWait | null = take.length < inputs.length ? this.limitWait(f.one) : null;
    return { sent: take.length, answered: 0, wait };
  }

  /** What a send error means: busy (wait), the key refused (wait), or final for these rows. */
  private sendError(
    provider: Provider,
    err: unknown,
    rows: ReqRow[],
    s: AiSettings,
  ): AiWait | null {
    if (err instanceof FinalError) {
      if (err.auth) return { kind: 'auth_failed', provider, error: err.message.slice(0, 300) };
      for (const r of rows) this.finish(r.id, 'failed', null, null, null, err.message, false, s);
      return null;
    }
    const e = err as RetryableError;
    const until = this.now() + Math.max(BUSY_WAIT_MS, e.retryAfterMs ?? 0);
    this.core.markBusy(provider, until, (e.message ?? String(err)).slice(0, 200));
    return { kind: 'provider_busy', provider, until, error: (e.message ?? '').slice(0, 200) };
  }

  /**
   * Fills this model's free slots (ai.directWorkers less its calls in flight) with queued
   * questions. Each call runs on its own and records its result when it ends; `step` waits
   * for one to end.
   */
  private async sendDirect<E>(
    spec: AiStageSpec<E>,
    runId: string,
    model: string,
    s: AiSettings,
    shouldStop: () => boolean,
    which: 'all' | 'returned' = 'all',
  ): Promise<{ sent: number; answered: number; wait: AiWait | null }> {
    let busy = 0;
    for (const c of this.inFlight.values()) if (c.model === model) busy++;
    const free = s.directWorkers - busy;
    if (free <= 0) return { sent: 0, answered: 0, wait: null };
    const rows = this.queuedRows(spec, runId, model, free, this.labeledOnly(), which);
    if (!rows.length) return { sent: 0, answered: 0, wait: null };
    const calls: { row: ReqRow; call: CallInput }[] = [];
    for (const row of rows) {
      const call = this.callInput(spec, row, s);
      if (call) calls.push({ row, call });
      else this.finish(row.id, 'failed', null, null, null, 'no evidence record', false, s);
    }
    if (!calls.length) return { sent: 0, answered: 0, wait: null };
    const avgChars =
      calls.reduce((a, x) => a + x.call.system.length + x.call.user.length, 0) / calls.length;
    const f = this.fits(model, calls.length, avgChars, false, s);
    if (f.fit === 0) {
      // Room held by calls in flight comes back when they are recorded: no pause for it.
      if (this.core.callsInFlight() > 0) return { sent: 0, answered: 0, wait: null };
      return { sent: 0, answered: 0, wait: this.limitWait(f.one) };
    }
    const take = calls.slice(0, f.fit);
    const provider = providerOf(model);
    const client = this.client(provider)!;
    const now = this.now();
    const mark = this.db.prepare(
      `UPDATE ai_requests SET state = 'sent', mode = 'direct', sent_at = ? WHERE id = ?`,
    );
    for (const x of take) {
      mark.run(now, x.row.id);
      this.inFlight.set(x.row.id, { model, stage: spec.stage, estimate: f.one });
      this.core.callStarted(this.flightKey(x.row.id), f.one);
      void this.runCall(spec, x.row, x.call, client, provider, model, s, shouldStop).finally(() => {
        this.inFlight.delete(x.row.id);
        this.core.callEnded(this.flightKey(x.row.id));
        for (const w of [...this.waiters]) w();
      });
    }
    return { sent: take.length, answered: 0, wait: null };
  }

  /**
   * Questions of a run that were given up (failed after their tries) go back to the queue with
   * fresh tries; the stage's next step asks them. Returns how many.
   */
  askAgain(stage: string, runId: string): number {
    return this.db
      .prepare(
        `UPDATE ai_requests SET state = 'queued', attempts = 0, error = NULL
         WHERE stage = ? AND run_id = ? AND state = 'failed'`,
      )
      .run(stage, runId).changes;
  }

  /** One call with its tries; records the result (never throws). */
  private async runCall<E>(
    spec: AiStageSpec<E>,
    row: ReqRow,
    call: CallInput,
    client: ProviderClient,
    provider: Provider,
    model: string,
    s: AiSettings,
    shouldStop: () => boolean,
  ): Promise<void> {
    const ended = () => this.endedSince.set(spec.stage, (this.endedSince.get(spec.stage) ?? 0) + 1);
    let attempts = row.attempts;
    try {
      for (;;) {
        attempts++;
        this.db.prepare('UPDATE ai_requests SET attempts = ? WHERE id = ?').run(attempts, row.id);
        try {
          const res = await client.call(call, s.requestTimeoutSeconds * 1000);
          this.record(spec, row.id, model, res, false, s);
          ended();
          return;
        } catch (err) {
          if (err instanceof FinalError) {
            if (err.auth) {
              if (!this.callWaits.has(spec.stage))
                this.callWaits.set(spec.stage, {
                  kind: 'auth_failed',
                  provider,
                  error: err.message.slice(0, 300),
                });
              this.db.prepare(`UPDATE ai_requests SET state = 'queued' WHERE id = ?`).run(row.id);
            } else this.finish(row.id, 'failed', null, null, null, err.message, false, s);
            return;
          }
          const e = err as RetryableError;
          if (e.busy) {
            // The provider's rate limit: this model's calls wait (the step reports the wait and
            // sends nothing until it ends), and the question goes back to the queue with the
            // try not counted. Calls in flight end on their own.
            const until = this.now() + Math.max(BUSY_WAIT_MS, e.retryAfterMs ?? 0);
            this.core.markBusy(provider, until, (e.message ?? '').slice(0, 200));
            this.db
              .prepare(`UPDATE ai_requests SET state = 'queued', attempts = ? WHERE id = ?`)
              .run(attempts - 1, row.id);
            return;
          }
          if (attempts >= s.attempts || shouldStop()) {
            if (attempts >= s.attempts)
              this.finish(row.id, 'failed', null, null, null, e.message, false, s);
            else
              this.db.prepare(`UPDATE ai_requests SET state = 'queued' WHERE id = ?`).run(row.id);
            return;
          }
          const backoff = Math.min(120_000, e.retryAfterMs ?? 5000 * 4 ** (attempts - 1));
          await this.sleep(backoff);
        }
      }
    } catch (err) {
      // A database error while recording: the question goes back to the queue.
      this.deps.log?.(`AI: a call to ${model} could not be recorded: ${(err as Error).message}`);
      try {
        this.db
          .prepare(`UPDATE ai_requests SET state = 'queued' WHERE id = ? AND state = 'sent'`)
          .run(row.id);
      } catch {
        /* the restart's requeue asks it again */
      }
    }
  }

  /** Records a provider's result for a question (answered, blocked or invalid), with its cost. */
  private record<E>(
    spec: AiStageSpec<E>,
    id: number,
    model: string,
    res: CallResult,
    batch: boolean,
    s: AiSettings,
  ): void {
    const price = priceOf(s, model);
    const cost = price ? costOf(price, res.usage, batch, s.batchPriceFactor) : null;
    if (res.kind === 'answered') {
      const parsed = spec.parseAnswer(res.json);
      if (parsed) {
        this.finish(id, 'answered', parsed, res.text, res.usage, null, batch, s, cost);
      } else {
        this.finish(
          id,
          'invalid',
          null,
          res.text,
          res.usage,
          'the answer does not fit the format',
          batch,
          s,
          cost,
        );
      }
    } else this.finish(id, res.kind, null, res.text, res.usage, res.detail, batch, s, cost);
    if (cost !== null) this.recordSpend(spec.stage, id, model, batch, cost);
  }

  /** The paid answer's row in the shared ledger (right after the feature's own record). */
  private recordSpend(stage: string, id: number, model: string, batch: boolean, cost: number) {
    try {
      this.core.record({
        source: this.deps.source,
        ref: id,
        feature: this.deps.featureOf(stage),
        stage,
        provider: providerOf(model),
        model,
        mode: batch ? 'batch' : 'direct',
        costUsd: cost,
        at: this.now(),
      });
    } catch (err) {
      // The next start adds it (repairLedger).
      this.deps.log?.(`AI: the spending record of question ${id}: ${(err as Error).message}`);
    }
  }

  private finish(
    id: number,
    state: 'answered' | 'blocked' | 'invalid' | 'failed',
    answer: Record<string, unknown> | null,
    raw: string | null,
    usage: { input: number; output: number; cacheRead: number } | null,
    error: string | null,
    _batch: boolean,
    _s: AiSettings,
    cost: number | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE ai_requests SET state = ?, answer_json = ?, raw_text = ?, input_tokens = ?,
           output_tokens = ?, cache_read_tokens = ?, cost_usd = ?, error = ?, answered_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        answer ? JSON.stringify(answer) : null,
        raw ? raw.slice(0, 8000) : null,
        usage?.input ?? null,
        usage?.output ?? null,
        usage?.cacheRead ?? null,
        cost,
        error ? error.slice(0, 500) : null,
        this.now(),
        id,
      );
  }

  /** Checks the batches at the providers (each at most every batchPollSeconds). */
  private async collect<E>(spec: AiStageSpec<E>): Promise<number> {
    const s = this.settings();
    const now = this.now();
    const due = this.db
      .prepare(
        `SELECT id, provider, model FROM ai_batches WHERE state = 'submitted' AND stage = ?
         AND COALESCE(checked_at, submitted_at) <= ?`,
      )
      .all(spec.stage, now - s.batchPollSeconds * 1000) as {
      id: string;
      provider: Provider;
      model: string;
    }[];
    const meta = this.db.prepare('SELECT submitted_at, error FROM ai_batches WHERE id = ?');
    let answered = 0;
    for (const b of due) {
      const client = this.client(b.provider);
      if (!client) continue;
      try {
        const st = await client.batchStatus(b.id);
        this.db
          .prepare('UPDATE ai_batches SET checked_at = ?, provider_status = ? WHERE id = ?')
          .run(this.now(), st.status, b.id);
        const m = meta.get(b.id) as { submitted_at: number; error: string | null };
        const stalled = (m.error ?? '').startsWith('stalled');
        if (!st.ended) {
          // The stall guard: nothing answered after batchStallMinutes -> cancelled; the answers
          // it has are kept and the rest asked directly (measured 2026-11-19: OpenAI ran no
          // gpt-6-luna batch at all).
          const limitMs = s.batchStallMinutes * 60_000;
          if (limitMs > 0 && !stalled && st.done === 0 && this.now() - m.submitted_at >= limitMs) {
            await client.cancelBatch(b.id);
            const why = `stalled: nothing answered in ${s.batchStallMinutes} min; cancelled, its questions asked directly`;
            this.db.prepare('UPDATE ai_batches SET error = ? WHERE id = ?').run(why, b.id);
            this.deps.log?.(`AI: batch ${b.id} (${b.provider}) ${why}`);
          }
          continue;
        }
        if (st.failed) {
          this.db.transaction(() => {
            this.db
              .prepare(
                `UPDATE ai_requests SET state = 'queued', batch_id = NULL${stalled ? `, mode = 'direct'` : ''} WHERE batch_id = ? AND state = 'sent'`,
              )
              .run(b.id);
            this.db
              .prepare(
                `UPDATE ai_batches SET state = 'failed', ended_at = ?, cost_usd = 0, error = ? WHERE id = ?`,
              )
              .run(this.now(), stalled ? m.error : st.status, b.id);
          })();
          dropHold(this.core.db, this.deps.source, b.id);
          this.deps.log?.(`AI: batch ${b.id} ${st.status}: its questions go back to the queue`);
          await this.deleteBatchData(b.id, b.provider);
          continue;
        }
        const results = await client.batchResults(b.id);
        answered += this.applyResults(spec, b.id, b.model, results, s, stalled);
        dropHold(this.core.db, this.deps.source, b.id);
        await this.deleteBatchData(b.id, b.provider);
      } catch (err) {
        this.deps.log?.(`AI: batch ${b.id}: ${(err as Error).message}`);
      }
    }
    return answered;
  }

  private applyResults<E>(
    spec: AiStageSpec<E>,
    batchId: string,
    model: string,
    results: Awaited<ReturnType<ProviderClient['batchResults']>>,
    s: AiSettings,
    stalled = false,
  ): number {
    let answered = 0;
    // A stalled batch's unanswered questions are asked directly next.
    const back = stalled ? `, mode = 'direct'` : '';
    this.db.transaction(() => {
      const rows = new Map(
        (
          this.db
            .prepare(`SELECT id, attempts FROM ai_requests WHERE batch_id = ? AND state = 'sent'`)
            .all(batchId) as { id: number; attempts: number }[]
        ).map((r) => [r.id, r]),
      );
      for (const o of results) {
        const id = Number(o.customId.replace(/^r/, ''));
        const row = rows.get(id);
        if (!row) continue;
        rows.delete(id);
        if ('result' in o) {
          this.record(spec, id, model, o.result, true, s);
          answered++;
        } else if (stalled || (o.retryable && row.attempts < s.attempts)) {
          this.db
            .prepare(
              `UPDATE ai_requests SET state = 'queued', batch_id = NULL, error = ?${back} WHERE id = ?`,
            )
            .run(o.error.slice(0, 500), id);
        } else this.finish(id, 'failed', null, null, null, o.error, true, s);
      }
      // Questions the batch gave nothing for go back to the queue.
      for (const id of rows.keys())
        this.db
          .prepare(`UPDATE ai_requests SET state = 'queued', batch_id = NULL${back} WHERE id = ?`)
          .run(id);
      const cost = this.db
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_requests WHERE batch_id = ?`)
        .get(batchId) as { c: number };
      this.db
        .prepare(
          `UPDATE ai_batches SET state = 'collected', ended_at = ?, cost_usd = ? WHERE id = ?`,
        )
        .run(this.now(), cost.c, batchId);
    })();
    this.deps.log?.(`AI: batch ${batchId} collected (${answered} answers)`);
    return answered;
  }

  // -------------------------------------------------------------------------------------------
  // what the providers keep of ended batches

  /**
   * Deletes what the provider keeps of an ended batch (OpenAI's input, output and error files,
   * Anthropic's batch: its prompts and answers), once its answers are in this database. A
   * failed delete is left for `sweepBatchData`.
   */
  private async deleteBatchData(id: string, provider: Provider): Promise<boolean> {
    const client = this.client(provider);
    if (!client) return false;
    try {
      await client.deleteBatchData?.(id);
      this.db
        .prepare('UPDATE ai_batches SET files_deleted_at = ? WHERE id = ?')
        .run(this.now(), id);
      return true;
    } catch (err) {
      this.deps.log?.(`AI: deleting batch ${id} at ${provider}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Deletes what the providers still keep of batches already collected or failed (a delete that
   * failed before, and once after the deploy the batches collected before deleting existed).
   * At most `limit` per call, at most once per `batchPollSeconds` (`force`: now). Returns how
   * many were deleted.
   */
  async sweepBatchData(limit = 20, force = false): Promise<number> {
    const now = this.now();
    if (!force && now - this.lastSweep < this.settings().batchPollSeconds * 1000) return 0;
    this.lastSweep = now;
    const rows = this.db
      .prepare(
        `SELECT id, provider FROM ai_batches WHERE state <> 'submitted' AND files_deleted_at IS NULL
         ORDER BY submitted_at LIMIT ?`,
      )
      .all(limit) as { id: string; provider: Provider }[];
    let n = 0;
    for (const r of rows) if (await this.deleteBatchData(r.id, r.provider)) n++;
    if (n) this.deps.log?.(`AI: deleted what the providers kept of ${n} collected batches`);
    return n;
  }

  /** Batches at the providers now, with how long the finished ones took (turnaround). */
  batches(stage: string): {
    open: number;
    collected: number;
    failed: number;
    /** Cancelled by the stall guard (nothing answered in time). */
    stalled: number;
    turnaroundMs: { median: number | null; max: number | null };
  } {
    const rows = this.db
      .prepare(`SELECT state, submitted_at, ended_at, error FROM ai_batches WHERE stage = ?`)
      .all(stage) as {
      state: string;
      submitted_at: number;
      ended_at: number | null;
      error: string | null;
    }[];
    const isStalled = (r: { error: string | null }) => (r.error ?? '').startsWith('stalled');
    const done = rows
      .filter((r) => r.state === 'collected' && r.ended_at && !isStalled(r))
      .map((r) => r.ended_at! - r.submitted_at)
      .sort((a, b) => a - b);
    return {
      open: rows.filter((r) => r.state === 'submitted').length,
      collected: done.length,
      failed: rows.filter((r) => r.state === 'failed').length,
      stalled: rows.filter(isStalled).length,
      turnaroundMs: {
        median: done.length ? done[Math.floor(done.length / 2)] : null,
        max: done.length ? done[done.length - 1] : null,
      },
    };
  }
}
