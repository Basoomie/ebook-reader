/**
 * What every AI feature shares, one per server process (book summaries session 1): the
 * provider settings and keys (ttsu.db), the provider clients, the model checks (Check models),
 * the batch tests (Test batch), the one monthly spending limit with its ledger, the holds of
 * batches still at a provider and of calls in flight (every feature's, so two features can't
 * overspend it together), and the features waiting for room under the limit.
 *
 * Works without cleanup.db: nothing here reads a feature's database. A feature asks through
 * its own `AiRunner` (runner.ts), which keeps its questions in the feature's database.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import dns from 'dns';
import net from 'net';
import {
  readSettings as readNotificationSettings,
  serverTimeZone,
} from '../notifications/settings';
import { afterFailure, BATCH_HEALTH_KEY, held, type ModelBatchHealth } from './batch-health';
import { firstSpendAt, heldUsd, recordSpend, spentBetween, spentByFeature } from './ledger';
import type { SpendRow } from './ledger';
import { monthOf } from './month';
import { makeProvider, providerOf, type CallResult, type ProviderClient } from './providers';
import { AiSecretStore, KEY_NAME, type AiKeyReader } from './secrets';
import { BUILT_IN_PRICES, isChatModel } from './prices';
import {
  AiSettingsError,
  readAiSettings,
  stallMinutesOf,
  updateAiSettings,
  type AiPrice,
  type AiSettings,
} from './settings';
import { costOf, priceOf } from './spend';
import type { Provider } from './types';
import { waitText, type AiWait } from './waits';

const MODEL_RECHECK_MS = 3600_000;
/** Settings > AI's own spending (Test batch) in the ledger. */
export const SETTINGS_FEATURE = 'ai-settings';
export const SETTINGS_SOURCE = 'ai';

export interface AiCoreDeps {
  /** ttsu.db. */
  db: Database.Database;
  /** DB_DIR (the key file of the AI keys). */
  dbDir: string;
  /** Tests give their own keys and clients. */
  keys?: AiKeyReader;
  providers?: (provider: Provider, key: string) => ProviderClient;
  now?: () => number;
  /** The zone months start in (default: the Notifications time zone, else the server's). */
  timeZone?: () => string;
  log?: (m: string) => void;
}

export interface ModelCheck {
  checkedAt: number;
  models: string[] | null;
  error: string | null;
}

export interface BatchTest {
  state: string;
  submittedAt: number;
  endedAt: number | null;
  detail: string | null;
}

export interface RoomState {
  /** Spent this month, every feature together. */
  spentUsd: number;
  /** Held for batches at a provider and calls in flight. */
  reservedUsd: number;
  limitUsd: number | null;
  month: string;
  resumesAt: number;
  resumesOn: string;
}

export interface FeatureWait {
  feature: string;
  label: string;
  detail: string;
  since: number;
}

export class AiCore {
  readonly secrets: AiSecretStore;
  private readonly keys: AiKeyReader;
  private clients = new Map<string, ProviderClient>();
  /** The key each provider's model list was last read with (a new key reads it again). */
  private checkedWith = new Map<Provider, string>();
  private busyUntil = new Map<Provider, { until: number; error: string }>();
  /** Calls one at a time in flight, every feature's: their expected cost is held. */
  private inFlight = new Map<string, number>();
  private roomListeners = new Set<() => void>();
  private modelUsers = new Set<(model: string) => string[]>();
  private timer: NodeJS.Timeout | null = null;
  private lastMonth: string | null = null;
  private spentCache: {
    key: string;
    zone: string;
    start: number;
    end: number;
    usd: number;
  } | null = null;

  constructor(private readonly deps: AiCoreDeps) {
    this.secrets = new AiSecretStore(deps.db, deps.dbDir);
    this.keys = deps.keys ?? this.secrets;
  }

  get db(): Database.Database {
    return this.deps.db;
  }

  now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(m: string): void {
    this.deps.log?.(m);
  }

  // -------------------------------------------------------------------------------------------
  // settings and keys

  settings(): AiSettings {
    return readAiSettings(this.db);
  }

  /**
   * A feature says which of its tasks use a model (e.g. the cleanup's "audio5.primary"), so a
   * model in use is never deleted from under it.
   */
  registerModelUse(uses: (model: string) => string[]): () => void {
    this.modelUsers.add(uses);
    return () => this.modelUsers.delete(uses);
  }

  modelUses(model: string): string[] {
    const out: string[] = [];
    for (const u of this.modelUsers) {
      try {
        out.push(...u(model));
      } catch {
        // a feature that can't answer now (its database closed) holds nothing
      }
    }
    return out;
  }

  /**
   * Takes a model off the list in Settings > AI (its mode and any price typed before prices were
   * built in go with it). Refused while a feature's task uses it.
   */
  deleteModel(model: string): AiSettings {
    const s = this.settings();
    if (!s.models.includes(model)) throw new AiSettingsError(`${model} is not in the list`);
    const uses = this.modelUses(model);
    if (uses.length)
      throw new AiSettingsError(
        `${model} is in use (${uses.join('; ')}): choose another model there first`,
      );
    const { [model]: _price, ...prices } = s.prices;
    const { [model]: _mode, ...modes } = s.modes;
    return updateAiSettings(
      this.db,
      { models: s.models.filter((m) => m !== model), prices, modes },
      this.now(),
    );
  }

  /**
   * The chat models each provider offers to the stored key, read from the provider now, each
   * with its price when the app knows it and whether it is already in the list (the Add dialog).
   */
  async availableModels(): Promise<
    Record<
      Provider,
      {
        error: string | null;
        models: { model: string; price: AiPrice | null; listed: boolean }[];
      }
    >
  > {
    const s = this.settings();
    const out = {} as Record<
      Provider,
      { error: string | null; models: { model: string; price: AiPrice | null; listed: boolean }[] }
    >;
    for (const p of ['anthropic', 'openai'] as const) {
      const r = await this.checkProvider(p);
      out[p] = {
        error: r.error,
        models: (r.models ?? [])
          .filter((m) => isChatModel(m))
          .map((m) => ({
            model: m,
            price: BUILT_IN_PRICES[m] ?? null,
            listed: s.models.includes(m),
          }))
          .sort(
            (x, y) => Number(!x.price) - Number(!y.price) || x.model.localeCompare(y.model, 'en'),
          ),
      };
    }
    return out;
  }

  /**
   * Adds a model to the list after three checks: the provider offers it to the stored key (its
   * model list read now), the app knows its price, and one tiny test request is answered (its
   * cost counted as Settings' own). Throws AiSettingsError saying which check failed.
   */
  async addModel(model: string): Promise<{ settings: AiSettings; ms: number; costUsd: number }> {
    const s = this.settings();
    const id = model.trim();
    if (!id) throw new AiSettingsError('Choose a model');
    if (s.models.includes(id)) throw new AiSettingsError(`${id} is already in the list`);
    const provider = providerOf(id);
    const name = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const client = this.client(provider);
    if (!client) throw new AiSettingsError(`Save the ${name} API key first`);
    const check = await this.checkProvider(provider);
    if (check.error) throw new AiSettingsError(`Can't read ${name}'s model list: ${check.error}`);
    if (!check.models?.includes(id))
      throw new AiSettingsError(`${name} does not offer ${id} to your API key`);
    const price = BUILT_IN_PRICES[id];
    if (!price)
      throw new AiSettingsError(
        `The app doesn't know ${id}'s price yet, so its cost couldn't be counted; it can be added once an app update brings its price`,
      );
    if (s.spendLimitUsd === null)
      throw new AiSettingsError(
        'Set a monthly spending limit first: the test request costs a fraction of a cent',
      );
    const t0 = Date.now();
    let res: CallResult;
    try {
      res = await client.call(
        {
          model: id,
          system: 'You answer with one JSON object and nothing else.',
          user: 'Reply with {"ok": true}.',
          schema: null,
          maxTokens: 2000,
        },
        Math.min(120, s.requestTimeoutSeconds) * 1000,
      );
    } catch (err) {
      throw new AiSettingsError(`The test request to ${id} failed: ${(err as Error).message}`);
    }
    const ms = Date.now() - t0;
    const costUsd = costOf(price, res.usage, false, s.batchPriceFactor);
    const seq = this.state('modelTestSeq', 0) + 1;
    this.setState('modelTestSeq', seq);
    this.record({
      source: SETTINGS_SOURCE,
      ref: -seq,
      feature: SETTINGS_FEATURE,
      stage: 'model-test',
      provider,
      model: id,
      mode: 'direct',
      costUsd,
      at: this.now(),
    });
    if (res.kind === 'blocked')
      throw new AiSettingsError(`${id} refused the test request (${res.detail})`);
    const settings = updateAiSettings(this.db, { models: [...s.models, id] }, this.now());
    this.log(`AI: ${id} added after a test request (${ms} ms, $${costUsd.toFixed(5)})`);
    return { settings, ms, costUsd };
  }

  /** Saves provider settings; a raised limit lets waiting features go on at once. */
  updateSettings(changes: unknown): AiSettings {
    const next = updateAiSettings(this.db, changes, this.now());
    this.tellRoom();
    return next;
  }

  key(provider: Provider): string | null {
    return this.keys.read(KEY_NAME[provider]);
  }

  private keyId(provider: Provider): string | null {
    const key = this.key(provider);
    return key ? createHash('sha1').update(key).digest('hex').slice(0, 8) : null;
  }

  /** The provider's client with the stored key (null: no key). */
  client(provider: Provider): ProviderClient | null {
    // Node's per-address connect wait (250 ms by default) cut off every call from the busy live
    // server: see ai.connectAttemptMs. Set before each use, so a changed setting applies.
    const wait = this.settings().connectAttemptMs;
    if (net.getDefaultAutoSelectFamilyAttemptTimeout() !== wait)
      net.setDefaultAutoSelectFamilyAttemptTimeout(wait);
    const key = this.key(provider);
    if (!key) return null;
    const id = `${provider}:${createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
    let c = this.clients.get(id);
    if (!c) {
      c = (this.deps.providers ?? makeProvider)(provider, key);
      this.clients.set(id, c);
    }
    return c;
  }

  /** The provider's rate limit: its calls wait until then (every feature's). */
  markBusy(provider: Provider, until: number, error: string): void {
    const cur = this.busyUntil.get(provider);
    if (!cur || cur.until < until) this.busyUntil.set(provider, { until, error });
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
    const t0 = Date.now();
    try {
      models = (await c.listModels()).sort();
    } catch (err) {
      // What the server saw: the error with its addresses, how long it took, and what DNS
      // answers now (a connection error the live server alone got, stop 2, 2026-11-19).
      const host = p === 'anthropic' ? 'api.anthropic.com' : 'api.openai.com';
      const dnsNow = await dns.promises
        .lookup(host, { all: true })
        .then((a) => a.map((x) => x.address).join(', '))
        .catch((e: NodeJS.ErrnoException) => e.code ?? 'lookup failed');
      error = `${(err as Error).message} after ${Date.now() - t0} ms; DNS ${host}: ${dnsNow}`.slice(
        0,
        600,
      );
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

  modelChecks(): Record<string, ModelCheck> {
    const out: Record<string, ModelCheck> = {};
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
  async usable(model: string): Promise<AiWait | null> {
    const provider = providerOf(model);
    if (!this.client(provider)) return { kind: 'no_key', provider };
    const s = this.settings();
    if (!priceOf(s, model)) return { kind: 'no_price', model };
    const busy = this.busyUntil.get(provider);
    if (busy && busy.until > this.now())
      return { kind: 'provider_busy', provider, until: busy.until, error: busy.error };
    // The model list is read before a model is first used, and again at most hourly while a
    // model is missing from it or the last read failed (Settings: Check models reads it now).
    let check = this.modelChecks()[provider];
    // A read that failed (not a refused key) is tried again at the batch poll pace: one that
    // failed while the server was starting left stage 5 paused for an hour (stop 2).
    const recheckMs =
      check?.error && !/^40[13]\b/.test(check.error) ? s.batchPollSeconds * 1000 : MODEL_RECHECK_MS;
    const stale = !check || this.now() - check.checkedAt > recheckMs;
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
  // the monthly limit

  timeZone(): string {
    if (this.deps.timeZone) return this.deps.timeZone();
    try {
      return readNotificationSettings(this.db).digest.timeZone ?? serverTimeZone();
    } catch {
      return serverTimeZone();
    }
  }

  month(at = this.now()): { key: string; start: number; end: number } {
    return monthOf(at, this.timeZone());
  }

  private dateText(ms: number): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: this.timeZone(),
      month: 'short',
      day: 'numeric',
    }).format(new Date(ms));
  }

  /** This month's spending, what is held, and the limit. */
  /**
   * This month's total, kept in memory: summing the month's ledger rows took 69 ms at the live
   * size (122,479 paid questions, 2026-11-21), and every step of every stage asks it. Read once
   * per month and time zone; each new row this process records adds to it.
   */
  private spentThisMonth(m: { key: string; start: number; end: number }): number {
    const zone = this.timeZone();
    const c = this.spentCache;
    if (c && c.key === m.key && c.zone === zone) return c.usd;
    const usd = spentBetween(this.db, m.start, m.end);
    this.spentCache = { key: m.key, zone, start: m.start, end: m.end, usd };
    return usd;
  }

  /** Rows were written to the ledger without `record` (the ledger repair): read it again. */
  invalidateSpend(): void {
    this.spentCache = null;
  }

  room(): RoomState {
    const m = this.month();
    let flight = 0;
    for (const v of this.inFlight.values()) flight += v;
    return {
      spentUsd: this.spentThisMonth(m),
      reservedUsd: heldUsd(this.db) + flight,
      limitUsd: this.settings().spendLimitUsd,
      month: m.key,
      resumesAt: m.end,
      resumesOn: this.dateText(m.end),
    };
  }

  /** Calls in flight now (a full limit is not reported while they hold room). */
  callsInFlight(): number {
    return this.inFlight.size;
  }

  callStarted(key: string, estimateUsd: number): void {
    this.inFlight.set(key, estimateUsd);
  }

  callEnded(key: string): void {
    this.inFlight.delete(key);
  }

  /** Records a paid request in the ledger. */
  record(row: SpendRow): void {
    const c = this.spentCache;
    if (recordSpend(this.db, row) && c && row.at >= c.start && row.at < c.end) c.usd += row.costUsd;
  }

  // -------------------------------------------------------------------------------------------
  // features and their waits

  /** A feature's name for Settings > AI and the alerts (kept, so history keeps its names). */
  registerFeature(id: string, label: string): void {
    const cur = this.features();
    if (cur[id] === label) return;
    this.setState('features', { ...cur, [id]: label });
  }

  features(): Record<string, string> {
    return { [SETTINGS_FEATURE]: 'Settings: Test batch', ...this.state('features', {}) };
  }

  featureLabel(id: string): string {
    return this.features()[id] ?? id;
  }

  /** A feature whose questions wait for room (one alert, `ai_limit_waiting`). */
  setWaiting(feature: string, detail: string): void {
    this.db
      .prepare(
        `INSERT INTO ai_waits (feature, label, detail, since) VALUES (?, ?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET detail = excluded.detail, label = excluded.label`,
      )
      .run(feature, this.featureLabel(feature), detail, this.now());
  }

  clearWaiting(feature: string): void {
    this.db.prepare('DELETE FROM ai_waits WHERE feature = ?').run(feature);
  }

  waiting(): FeatureWait[] {
    return this.db
      .prepare('SELECT feature, label, detail, since FROM ai_waits')
      .all() as FeatureWait[];
  }

  /** Called when there may be room again: a new month or a changed limit. */
  onRoom(listener: () => void): () => void {
    this.roomListeners.add(listener);
    return () => this.roomListeners.delete(listener);
  }

  private tellRoom(): void {
    for (const l of [...this.roomListeners]) {
      try {
        l();
      } catch (err) {
        this.log(`AI: a room listener failed: ${(err as Error).message}`);
      }
    }
  }

  /** The month changed since the last look: tell the waiting features. */
  checkMonth(): void {
    const key = this.month().key;
    if (this.lastMonth !== null && this.lastMonth !== key) this.tellRoom();
    this.lastMonth = key;
  }

  // -------------------------------------------------------------------------------------------
  // batches a provider refused (batch-health.ts)

  /** Every model whose batches failed lately, by model id. */
  batchHealth(): Record<string, ModelBatchHealth> {
    return this.state<Record<string, ModelBatchHealth>>(BATCH_HEALTH_KEY, {});
  }

  private saveBatchHealth(model: string, h: ModelBatchHealth | null): void {
    const all = this.batchHealth();
    if (h) all[model] = h;
    else delete all[model];
    this.setState(BATCH_HEALTH_KEY, all);
  }

  /** A clock time in the Notifications time zone ("9:40 AM"). */
  private timeText(ms: number): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: this.timeZone(),
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  }

  /** A batch of the model failed as a whole (or its provider refused to take it). */
  batchFailed(f: {
    provider: Provider;
    model: string;
    reason: string;
    capacity: boolean;
    open: number;
  }): ModelBatchHealth {
    const cur = this.batchHealth()[f.model] ?? null;
    const h = afterFailure(cur, { ...f, at: this.now() }, this.settings());
    this.saveBatchHealth(f.model, h);
    const next = h.pausedSince !== null ? 'batches paused, next try' : 'next batch';
    const end = h.waitForEnd ? ' once one of its batches has ended' : '';
    this.log(
      `AI: ${f.provider} refused a ${f.model} batch (${f.reason}); ${h.failures} in a row, ${next} at ${this.timeText(h.nextAt)}${end}`,
    );
    return h;
  }

  /** A batch of the model ended at the provider: its queue has room again. */
  batchEnded(model: string): void {
    const h = this.batchHealth()[model];
    if (h?.waitForEnd) this.saveBatchHealth(model, { ...h, waitForEnd: false });
  }

  /**
   * The provider accepted a batch of the model sent at `submittedAt` (in progress or later):
   * the failures end with one sent after the last of them.
   */
  batchAccepted(model: string, submittedAt: number): void {
    const h = this.batchHealth()[model];
    if (!h || submittedAt < h.failedAt) return;
    this.saveBatchHealth(model, null);
    this.log(`AI: ${h.provider} accepted a ${model} batch again after ${h.failures} failed`);
  }

  /** Settings > AI "Try now": the model's next batch may go at once. False: nothing held. */
  tryBatchesNow(model: string): boolean {
    const h = this.batchHealth()[model];
    if (!h) return false;
    this.saveBatchHealth(model, { ...h, nextAt: this.now(), waitForEnd: false, fallbackRun: null });
    this.log(`AI: ${model}: a batch is tried now (Settings > AI)`);
    return true;
  }

  /**
   * What stands in the way of the model's next batch in a run: a wait (no batch now), or the
   * fallback (its questions asked one call each; the wait is the page's words). Null: send.
   */
  batchHold(model: string, runId: string): { wait: AiWait; direct: boolean } | null {
    const h = this.batchHealth()[model];
    if (!h) return null;
    const s = this.settings();
    if (
      h.pausedSince !== null &&
      s.batchFailFallback === 'direct' &&
      (h.fallbackRun === null || h.fallbackRun === runId)
    ) {
      if (h.fallbackRun === null) {
        this.saveBatchHealth(model, { ...h, fallbackRun: runId });
        this.log(
          `AI: ${model}'s batches keep failing: its questions are asked one call each for the rest of this run`,
        );
      }
      return { wait: this.batchWait(h, true), direct: true };
    }
    if (!held(h, this.now(), s)) return null;
    return { wait: this.batchWait(h, false), direct: false };
  }

  /** The model's failing batches as the page words them (Settings > AI), null when none. */
  batchFailingWait(model: string): AiWait | null {
    const h = this.batchHealth()[model];
    if (!h) return null;
    const s = this.settings();
    return this.batchWait(
      h,
      h.pausedSince !== null && s.batchFailFallback === 'direct' && h.fallbackRun !== null,
    );
  }

  private batchWait(h: ModelBatchHealth, fallback: boolean): AiWait {
    return {
      kind: 'batch_failing',
      provider: h.provider,
      model: h.model,
      failures: h.failures,
      paused: h.pausedSince !== null,
      reason: h.reason,
      nextAt: h.nextAt,
      nextAtText: this.timeText(h.nextAt),
      waitForEnd: h.waitForEnd,
      fallback,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Settings > AI "Test batch": does the provider run batches for this model, and how fast?

  /**
   * Sends one tiny question to a model as a batch (a fraction of a cent). Its outcome comes from
   * `pollBatchTests`: answered (with the time), nothing within batchStallMinutes (cancelled), or
   * failed. Needs the key, a price and a spending limit, like every question.
   */
  async testBatch(model: string): Promise<void> {
    const s = this.settings();
    const provider = providerOf(model);
    if (s.spendLimitUsd === null) throw new Error(waitText({ kind: 'no_limit' }));
    const why = await this.usable(model);
    if (why) throw new Error(waitText(why));
    const open = this.db
      .prepare(`SELECT id FROM ai_batch_tests WHERE model = ? AND state = 'open'`)
      .get(model);
    if (open) throw new Error(`A batch test of ${model} is already running`);
    const client = this.client(provider)!;
    const b = await client.submitBatch([
      {
        customId: 'batch-test',
        call: {
          model,
          system: 'You answer with one JSON object and nothing else.',
          user: 'Reply with {"ok": true}.',
          schema: null,
          maxTokens: 1000,
        },
      },
    ]);
    this.db
      .prepare(
        `INSERT INTO ai_batch_tests (provider, model, batch_id, state, submitted_at) VALUES (?, ?, ?, 'open', ?)`,
      )
      .run(provider, model, b.id, this.now());
    this.log(`AI: batch test of ${model} sent (${b.id})`);
  }

  /** Checks the open batch tests (each at most every batchPollSeconds). */
  async pollBatchTests(): Promise<void> {
    const s = this.settings();
    const rows = this.db
      .prepare(
        `SELECT id, provider, model, batch_id, submitted_at, checked_at FROM ai_batch_tests WHERE state = 'open'`,
      )
      .all() as {
      id: number;
      provider: Provider;
      model: string;
      batch_id: string;
      submitted_at: number;
      checked_at: number | null;
    }[];
    for (const t of rows) {
      if (this.now() - (t.checked_at ?? t.submitted_at) < s.batchPollSeconds * 1000) continue;
      const client = this.client(t.provider);
      if (!client) continue;
      const end = (state: string, detail: string, cost: number | null = null) => {
        this.db
          .prepare(
            `UPDATE ai_batch_tests SET state = ?, detail = ?, cost_usd = ?, ended_at = ?, checked_at = ? WHERE id = ?`,
          )
          .run(state, detail, cost, this.now(), this.now(), t.id);
        if (cost !== null)
          this.record({
            source: SETTINGS_SOURCE,
            ref: t.id,
            feature: SETTINGS_FEATURE,
            stage: 'batch-test',
            provider: t.provider,
            model: t.model,
            mode: 'batch',
            costUsd: cost,
            at: this.now(),
          });
      };
      try {
        const st = await client.batchStatus(t.batch_id);
        this.db
          .prepare('UPDATE ai_batch_tests SET checked_at = ? WHERE id = ?')
          .run(this.now(), t.id);
        const minutes = Math.max(1, stallMinutesOf(s, t.provider) || 30);
        if (!st.ended) {
          if (st.done === 0 && this.now() - t.submitted_at >= minutes * 60_000) {
            await client.cancelBatch(t.batch_id);
            end('nothing', `nothing answered in ${minutes} min (${st.status}); cancelled`);
            this.log(`AI: batch test of ${t.model}: nothing answered in ${minutes} min`);
          }
          continue;
        }
        if (st.failed) {
          end('failed', st.status);
          continue;
        }
        const out = (await client.batchResults(t.batch_id))[0];
        if (out && 'result' in out && out.result.kind !== 'blocked') {
          const price = priceOf(s, t.model);
          const cost = price ? costOf(price, out.result.usage, true, s.batchPriceFactor) : null;
          end(
            'answered',
            `answered in ${Math.round((this.now() - t.submitted_at) / 1000)} s`,
            cost,
          );
        } else end('failed', out && 'error' in out ? out.error : 'no answer in the results');
      } catch (err) {
        this.log(`AI: batch test of ${t.model}: ${(err as Error).message}`);
      }
    }
    await this.deleteTestData();
  }

  /**
   * Deletes what the providers keep of ended batch tests. A batch cancelled by the stall
   * guard is deleted once the provider has ended it; a failed delete is tried at the next poll.
   */
  private async deleteTestData(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT id, provider, batch_id FROM ai_batch_tests
         WHERE state <> 'open' AND files_deleted_at IS NULL ORDER BY id LIMIT 20`,
      )
      .all() as { id: number; provider: Provider; batch_id: string }[];
    for (const t of rows) {
      const client = this.client(t.provider);
      if (!client) continue;
      try {
        if (client.deleteBatchData) {
          const st = await client.batchStatus(t.batch_id).catch(() => null);
          if (st && !st.ended) continue;
          await client.deleteBatchData(t.batch_id);
        }
        this.db
          .prepare('UPDATE ai_batch_tests SET files_deleted_at = ? WHERE id = ?')
          .run(this.now(), t.id);
      } catch (err) {
        this.log(
          `AI: deleting batch test ${t.batch_id} at ${t.provider}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** The latest batch test of each model. */
  batchTests(): Record<string, BatchTest> {
    const out: Record<string, BatchTest> = {};
    for (const r of this.db
      .prepare(
        `SELECT model, state, submitted_at, ended_at, detail FROM ai_batch_tests t
         WHERE id = (SELECT MAX(id) FROM ai_batch_tests WHERE model = t.model)`,
      )
      .all() as {
      model: string;
      state: string;
      submitted_at: number;
      ended_at: number | null;
      detail: string | null;
    }[])
      out[r.model] = {
        state: r.state,
        submittedAt: r.submitted_at,
        endedAt: r.ended_at,
        detail: r.detail,
      };
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // spending for Settings > AI

  /** This month and the earlier months (newest first), each with its split per feature. */
  spending(months = 12): {
    month: string;
    totalUsd: number;
    byFeature: Record<string, number>;
  }[] {
    const out: { month: string; totalUsd: number; byFeature: Record<string, number> }[] = [];
    const first = firstSpendAt(this.db);
    let m = this.month();
    for (let i = 0; i < months; i++) {
      const byFeature = spentByFeature(this.db, m.start, m.end);
      out.push({
        month: m.key,
        totalUsd: Object.values(byFeature).reduce((a, b) => a + b, 0),
        byFeature,
      });
      if (first === null || m.start <= first) break;
      m = this.month(m.start - 1);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // state

  state<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM ai_state WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    return r ? (JSON.parse(r.value_json) as T) : fallback;
  }

  setState(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ai_state (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), this.now());
  }

  /** Polls the batch tests and watches for a new month (every 15 s; nothing to do = no call). */
  start(): void {
    if (this.timer) return;
    this.checkMonth();
    this.timer = setInterval(() => {
      this.checkMonth();
      void this.pollBatchTests().catch((err: Error) => this.log(`AI: batch tests: ${err.message}`));
    }, 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
