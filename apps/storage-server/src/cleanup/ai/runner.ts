/**
 * Asks the models (WP21d): a resumable queue of questions in cleanup.db, sent in batches (the
 * providers' Batch APIs, half price) or one by one, within the spending limit.
 *
 * - Each item's evidence record is kept (`ai_items`, gzip JSON with a hash).
 * - A question is one row per item, model, prompt version and evidence hash (`ai_requests`):
 *   a restart, a rules change or a new analysis with the same evidence never asks again.
 *   A failed question is asked again only in a later run; a blocked one never (final).
 * - Batches survive restarts (their ids are stored and checked every `batchPollSeconds`).
 * - Nothing is sent while: the spending limit is not set or would be passed, a key is missing
 *   or refused, a model id is not in its provider's list, a model has no price.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { getSettings, type AiSettings } from '../settings';
import {
  FinalError,
  makeProvider,
  providerOf,
  RetryableError,
  type CallInput,
  type CallResult,
  type ProviderClient,
} from './providers';
import { costOf, expectedListCost, priceOf, spendNow } from './spend';
import type { AiStageSpec, Provider, Role, StoredAnswer } from './types';

export type AiWait =
  | { kind: 'no_limit' }
  | {
      kind: 'limit_reached';
      spentUsd: number;
      reservedUsd: number;
      limitUsd: number;
      nextUsd: number;
    }
  | { kind: 'no_key'; provider: Provider }
  | { kind: 'auth_failed'; provider: Provider; error: string }
  | { kind: 'model_missing'; provider: Provider; model: string }
  | { kind: 'no_price'; model: string }
  | { kind: 'model_check_failed'; provider: Provider; error: string }
  | { kind: 'provider_busy'; provider: Provider; until: number; error: string };

/** US$ with cents, or four places below a cent ($0.0030). */
const usd = (v: number) => (v > 0 && v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** The page's words for a wait. */
export function waitText(w: AiWait): string {
  const name = (p: Provider) => (p === 'anthropic' ? 'Anthropic' : 'OpenAI');
  switch (w.kind) {
    case 'no_limit':
      return 'Set a spending limit first (Settings > AI)';
    case 'limit_reached':
      return `Spending limit reached (${usd(w.spentUsd)} spent, ${usd(w.reservedUsd)} held for batches, limit ${usd(w.limitUsd)})`;
    case 'no_key':
      return `The ${name(w.provider)} API key is missing (Settings > AI keys)`;
    case 'auth_failed':
      return `${name(w.provider)} refused the API key: ${w.error}`;
    case 'model_missing':
      return `${name(w.provider)} does not offer the model "${w.model}" (Settings > Models; Check models)`;
    case 'no_price':
      return `No price for the model "${w.model}" (Settings > AI): its cost can't be counted`;
    case 'model_check_failed':
      return `Can't read ${name(w.provider)}'s model list: ${w.error}`;
    case 'provider_busy':
      return `${name(w.provider)} is busy; trying again soon (${w.error})`;
  }
}

/** Stops that need the user (the stage pauses and a notification goes out). */
export function waitNeedsUser(w: AiWait): boolean {
  return w.kind !== 'provider_busy';
}

export interface SecretsReader {
  read(name: 'anthropicApiKey' | 'openaiApiKey'): string | null;
}

export interface AiRunnerDeps {
  db: Database.Database;
  secrets: SecretsReader;
  /** Tests give their own clients. */
  providers?: (provider: Provider, key: string) => ProviderClient;
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

const MODEL_RECHECK_MS = 3600_000;
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

const KEY_NAME: Record<Provider, 'anthropicApiKey' | 'openaiApiKey'> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
};

export class AiRunner {
  private busyUntil = new Map<Provider, { until: number; error: string }>();
  private clients = new Map<string, ProviderClient>();
  /** The key each provider's model list was last read with (a new key reads it again). */
  private checkedWith = new Map<Provider, string>();

  private keyId(provider: Provider): string | null {
    const key = this.deps.secrets.read(KEY_NAME[provider]);
    return key ? createHash('sha1').update(key).digest('hex').slice(0, 8) : null;
  }

  constructor(private readonly deps: AiRunnerDeps) {}

  private get db(): Database.Database {
    return this.deps.db;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms));
  }

  private settings(): AiSettings {
    return getSettings(this.db).ai;
  }

  /** The model a role of a stage uses now (settings.models). */
  modelOf(spec: AiStageSpec<unknown>, role: Role): string {
    return getSettings(this.db).models[spec.tasks[role]] ?? '';
  }

  private client(provider: Provider): ProviderClient | null {
    const key = this.deps.secrets.read(KEY_NAME[provider]);
    if (!key) return null;
    const id = `${provider}:${createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
    let c = this.clients.get(id);
    if (!c) {
      c = (this.deps.providers ?? makeProvider)(provider, key);
      this.clients.set(id, c);
    }
    return c;
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
    let changed = 0;
    this.db.transaction(() => {
      for (const it of items) {
        const hash = evidenceHash(version, it.evidence);
        const cur = get.get(spec.stage, it.key) as
          | { evidence_hash: string; labeled: number }
          | undefined;
        if (cur && cur.evidence_hash === hash && cur.labeled === (it.labeled ? 1 : 0)) continue;
        put.run(spec.stage, it.key, gz(it.evidence), version, hash, it.labeled ? 1 : 0, now);
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
  enqueue(spec: AiStageSpec<unknown>, role: Role, keys: string[], runId: string): number {
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
         AND ((state = 'failed' AND COALESCE(run_id, '') <> ?) OR state IN ('queued', 'sent'))`,
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
      }
    })();
    return n;
  }

  /** A role's stored answer for an item at its current evidence (null = not asked yet). */
  answerOf(spec: AiStageSpec<unknown>, role: Role, key: string): StoredAnswer | null {
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

  counts(stage: string, runId: string): AiCounts {
    const out: AiCounts = { queued: 0, sent: 0, answered: 0, blocked: 0, invalid: 0, failed: 0 };
    for (const r of this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = ? GROUP BY state`,
      )
      .all(runId, stage) as { state: keyof AiCounts; n: number }[])
      out[r.state] = r.n;
    return out;
  }

  pending(stage: string, runId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = ? AND state IN ('queued', 'sent')`,
        )
        .get(runId, stage) as { n: number }
    ).n;
  }

  // -------------------------------------------------------------------------------------------
  // models

  /** Reads each provider's model list with the stored key (Settings: Check models). */
  async checkModels(): Promise<
    Record<Provider, { models: string[] | null; error: string | null }>
  > {
    const out = {} as Record<Provider, { models: string[] | null; error: string | null }>;
    for (const p of ['anthropic', 'openai'] as const) out[p] = await this.checkProvider(p);
    return out;
  }

  private async checkProvider(
    p: Provider,
  ): Promise<{ models: string[] | null; error: string | null }> {
    const c = this.client(p);
    if (!c) return { models: null, error: 'no API key' };
    let models: string[] | null = null;
    let error: string | null = null;
    const id = this.keyId(p);
    if (id) this.checkedWith.set(p, id);
    try {
      models = (await c.listModels()).sort();
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    this.db
      .prepare(
        `INSERT INTO ai_model_checks (provider, checked_at, models_json, error) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET checked_at = excluded.checked_at,
           models_json = excluded.models_json, error = excluded.error`,
      )
      .run(p, this.now(), models ? JSON.stringify(models) : null, error);
    return { models, error };
  }

  modelChecks(): Record<
    string,
    { checkedAt: number; models: string[] | null; error: string | null }
  > {
    const out: Record<
      string,
      { checkedAt: number; models: string[] | null; error: string | null }
    > = {};
    for (const r of this.db.prepare('SELECT * FROM ai_model_checks').all() as {
      provider: string;
      checked_at: number;
      models_json: string | null;
      error: string | null;
    }[])
      out[r.provider] = {
        checkedAt: r.checked_at,
        models: r.models_json ? (JSON.parse(r.models_json) as string[]) : null,
        error: r.error,
      };
    return out;
  }

  /** Null when the model can be asked; otherwise what stands in the way. */
  private async usable(model: string): Promise<AiWait | null> {
    const provider = providerOf(model);
    if (!this.client(provider)) return { kind: 'no_key', provider };
    if (!priceOf(this.settings(), model)) return { kind: 'no_price', model };
    const busy = this.busyUntil.get(provider);
    if (busy && busy.until > this.now())
      return { kind: 'provider_busy', provider, until: busy.until, error: busy.error };
    // The model list is read before a model is first used, and again at most hourly while a
    // model is missing from it or the last read failed (Settings: Check models reads it now).
    let check = this.modelChecks()[provider];
    const stale = !check || this.now() - check.checkedAt > MODEL_RECHECK_MS;
    const newKey = this.checkedWith.get(provider) !== this.keyId(provider);
    if (!check || ((stale || newKey) && (check.error || !check.models?.includes(model)))) {
      await this.checkProvider(provider);
      check = this.modelChecks()[provider];
    }
    if (check?.error) {
      if (/^40[13]\b/.test(check.error))
        return { kind: 'auth_failed', provider, error: check.error };
      return { kind: 'model_check_failed', provider, error: check.error };
    }
    if (!check?.models?.includes(model)) return { kind: 'model_missing', provider, model };
    return null;
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
    let answered = await this.collect(spec);
    let sent = 0;
    let wait: AiWait | null = null;
    const s = this.settings();
    if (s.spendLimitUsd === null) wait = { kind: 'no_limit' };
    else {
      const models = this.db
        .prepare(
          `SELECT model, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = ? AND state = 'queued'
           ${s.labeledOnly ? 'AND labeled = 1' : ''} GROUP BY model`,
        )
        .all(runId, spec.stage) as { model: string; n: number }[];
      for (const m of models) {
        if (shouldStop()) break;
        const why = await this.usable(m.model);
        if (why) {
          wait ??= why;
          continue;
        }
        const r =
          s.mode === 'batch'
            ? await this.sendBatch(spec, runId, m.model, s)
            : await this.sendDirect(spec, runId, m.model, s, shouldStop);
        sent += r.sent;
        answered += r.answered;
        if (r.wait) wait ??= r.wait;
      }
    }
    return { pending: this.pending(spec.stage, runId), wait, sent, answered };
  }

  private queuedRows(
    spec: AiStageSpec<unknown>,
    runId: string,
    model: string,
    limit: number,
    labeledOnly: boolean,
  ): ReqRow[] {
    return this.db
      .prepare(
        `SELECT id, item_key, role, provider, model, attempts, labeled FROM ai_requests
         WHERE run_id = ? AND stage = ? AND state = 'queued' AND model = ? ${labeledOnly ? 'AND labeled = 1' : ''}
         ORDER BY labeled DESC, id LIMIT ?`,
      )
      .all(runId, spec.stage, model, limit) as ReqRow[];
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
    const { spentUsd, reservedUsd } = spendNow(this.db);
    const room = (s.spendLimitUsd ?? 0) - spentUsd - reservedUsd;
    const fit = one > 0 ? Math.max(0, Math.min(n, Math.floor(room / one))) : n;
    return { fit, one, spentUsd, reservedUsd };
  }

  private async sendBatch<E>(
    spec: AiStageSpec<E>,
    runId: string,
    model: string,
    s: AiSettings,
  ): Promise<{ sent: number; answered: number; wait: AiWait | null }> {
    const rows = this.queuedRows(spec, runId, model, s.batchSize, s.labeledOnly);
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
    if (f.fit === 0) {
      return {
        sent: 0,
        answered: 0,
        wait: {
          kind: 'limit_reached',
          spentUsd: f.spentUsd,
          reservedUsd: f.reservedUsd,
          limitUsd: s.spendLimitUsd ?? 0,
          nextUsd: f.one,
        },
      };
    }
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
    this.deps.log?.(
      `AI: batch ${batch.id} sent to ${provider} (${model}, ${take.length} questions, about $${(f.one * take.length).toFixed(3)})`,
    );
    const wait: AiWait | null =
      take.length < inputs.length
        ? {
            kind: 'limit_reached',
            spentUsd: f.spentUsd,
            reservedUsd: f.reservedUsd + f.one * take.length,
            limitUsd: s.spendLimitUsd ?? 0,
            nextUsd: f.one,
          }
        : null;
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
    this.busyUntil.set(provider, { until, error: (e.message ?? String(err)).slice(0, 200) });
    return { kind: 'provider_busy', provider, until, error: (e.message ?? '').slice(0, 200) };
  }

  private async sendDirect<E>(
    spec: AiStageSpec<E>,
    runId: string,
    model: string,
    s: AiSettings,
    shouldStop: () => boolean,
  ): Promise<{ sent: number; answered: number; wait: AiWait | null }> {
    const rows = this.queuedRows(spec, runId, model, s.directWorkers, s.labeledOnly);
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
    if (f.fit === 0)
      return {
        sent: 0,
        answered: 0,
        wait: {
          kind: 'limit_reached',
          spentUsd: f.spentUsd,
          reservedUsd: f.reservedUsd,
          limitUsd: s.spendLimitUsd ?? 0,
          nextUsd: f.one,
        },
      };
    const take = calls.slice(0, f.fit);
    const provider = providerOf(model);
    const client = this.client(provider)!;
    let answered = 0;
    let wait: AiWait | null = null;
    const now = this.now();
    const mark = this.db.prepare(
      `UPDATE ai_requests SET state = 'sent', mode = 'direct', sent_at = ? WHERE id = ?`,
    );
    for (const x of take) mark.run(now, x.row.id);
    await Promise.all(
      take.map(async ({ row, call }) => {
        let attempts = row.attempts;
        for (;;) {
          attempts++;
          this.db.prepare('UPDATE ai_requests SET attempts = ? WHERE id = ?').run(attempts, row.id);
          try {
            const res = await client.call(call, s.requestTimeoutSeconds * 1000);
            this.record(spec, row.id, model, res, false, s);
            answered++;
            return;
          } catch (err) {
            if (err instanceof FinalError) {
              if (err.auth) {
                wait ??= { kind: 'auth_failed', provider, error: err.message.slice(0, 300) };
                this.db.prepare(`UPDATE ai_requests SET state = 'queued' WHERE id = ?`).run(row.id);
              } else this.finish(row.id, 'failed', null, null, null, err.message, false, s);
              return;
            }
            const e = err as RetryableError;
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
      }),
    );
    return { sent: take.length, answered, wait };
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
        return;
      }
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
      return;
    }
    this.finish(id, res.kind, null, res.text, res.usage, res.detail, batch, s, cost);
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
    let answered = 0;
    for (const b of due) {
      const client = this.client(b.provider);
      if (!client) continue;
      try {
        const st = await client.batchStatus(b.id);
        this.db
          .prepare('UPDATE ai_batches SET checked_at = ?, provider_status = ? WHERE id = ?')
          .run(this.now(), st.status, b.id);
        if (!st.ended) continue;
        if (st.failed) {
          this.db.transaction(() => {
            this.db
              .prepare(
                `UPDATE ai_requests SET state = 'queued', batch_id = NULL WHERE batch_id = ? AND state = 'sent'`,
              )
              .run(b.id);
            this.db
              .prepare(
                `UPDATE ai_batches SET state = 'failed', ended_at = ?, cost_usd = 0, error = ? WHERE id = ?`,
              )
              .run(this.now(), st.status, b.id);
          })();
          this.deps.log?.(`AI: batch ${b.id} ${st.status}: its questions go back to the queue`);
          continue;
        }
        const results = await client.batchResults(b.id);
        answered += this.applyResults(spec, b.id, b.model, results, s);
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
  ): number {
    let answered = 0;
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
        } else if (o.retryable && row.attempts < s.attempts) {
          this.db
            .prepare(
              `UPDATE ai_requests SET state = 'queued', batch_id = NULL, error = ? WHERE id = ?`,
            )
            .run(o.error.slice(0, 500), id);
        } else this.finish(id, 'failed', null, null, null, o.error, true, s);
      }
      // Questions the batch gave nothing for go back to the queue.
      for (const id of rows.keys())
        this.db
          .prepare(`UPDATE ai_requests SET state = 'queued', batch_id = NULL WHERE id = ?`)
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

  /** Batches at the providers now, with how long the finished ones took (turnaround). */
  batches(stage: string): {
    open: number;
    collected: number;
    failed: number;
    turnaroundMs: { median: number | null; max: number | null };
  } {
    const rows = this.db
      .prepare(`SELECT state, submitted_at, ended_at FROM ai_batches WHERE stage = ?`)
      .all(stage) as { state: string; submitted_at: number; ended_at: number | null }[];
    const done = rows
      .filter((r) => r.state === 'collected' && r.ended_at)
      .map((r) => r.ended_at! - r.submitted_at)
      .sort((a, b) => a - b);
    return {
      open: rows.filter((r) => r.state === 'submitted').length,
      collected: done.length,
      failed: rows.filter((r) => r.state === 'failed').length,
      turnaroundMs: {
        median: done.length ? done[Math.floor(done.length / 2)] : null,
        max: done.length ? done[done.length - 1] : null,
      },
    };
  }
}
