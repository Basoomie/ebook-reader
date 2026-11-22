/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { errorFrom, send } from '$lib/library/api';

/**
 * Settings > AI (book summaries session 1): the server's /api/v1/ai routes, the AI layer every
 * feature shares (the library cleanup now, book summaries later). The keys can only be
 * written; the page learns whether one is saved and its last four characters.
 */

export type AiProvider = 'anthropic' | 'openai';
export type AiKeyName = 'anthropicApiKey' | 'openaiApiKey';

export interface AiPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface AiSettings {
  spendLimitUsd: number | null;
  modes: Record<string, 'batch' | 'direct'>;
  batchStallMinutes: number;
  connectAttemptMs: number;
  batchTurnaroundMinutes: number;
  directWorkers: number;
  batchSize: number;
  batchPollSeconds: number;
  maxTokens: number;
  requestTimeoutSeconds: number;
  attempts: number;
  batchPriceFactor: number;
  prices: Record<string, AiPrice>;
  structuredOutputs: boolean;
}

export interface AiKeyInfo {
  set: boolean;
  hint: string | null;
  updatedAt: number | null;
  unreadable?: boolean;
}

export interface AiBatchTest {
  state: string;
  submittedAt: number;
  endedAt: number | null;
  detail: string | null;
}

export interface AiStatus {
  settings: AiSettings;
  keys: Record<AiKeyName, AiKeyInfo>;
  checks: Partial<
    Record<AiProvider, { checkedAt: number; error: string | null; models: number | null }>
  >;
  /** Every model with a price: its provider, mode and whether the provider offers it. */
  models: {
    model: string;
    provider: AiProvider;
    price: AiPrice;
    mode: 'batch' | 'direct';
    offered: boolean | null;
  }[];
  spend: {
    spentUsd: number;
    reservedUsd: number;
    limitUsd: number | null;
    /** This month (YYYY-MM), when the next one starts ("Dec 1") and in which time zone. */
    month: string;
    resumesOn: string;
    timeZone: string;
  };
  /** This month first, then earlier ones, each with its split per feature. */
  months: { month: string; totalUsd: number; byFeature: Record<string, number> }[];
  /** Feature ids and their names. */
  features: Record<string, string>;
  /** Features waiting in their queue for room under the limit. */
  waiting: { feature: string; label: string; detail: string; since: number }[];
  batchTests: Record<string, AiBatchTest>;
}

export type AiSettingsPatch = Partial<AiSettings>;

export class AiApi {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 0,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutSeconds = this.timeoutSeconds
  ): Promise<AiStatus> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.json() as Promise<AiStatus>;
  }

  status(): Promise<AiStatus> {
    return this.request('GET', '/ai/status');
  }

  update(patch: AiSettingsPatch): Promise<AiStatus> {
    return this.request('PUT', '/ai/settings', patch);
  }

  putKey(name: AiKeyName, value: string): Promise<AiStatus> {
    return this.request('PUT', `/ai/secrets/${name}`, { value });
  }

  removeKey(name: AiKeyName): Promise<AiStatus> {
    return this.request('DELETE', `/ai/secrets/${name}`);
  }

  /** Reads each provider's model list (the server waits for both). */
  checkModels(): Promise<AiStatus> {
    return this.request('POST', '/ai/models/check', undefined, 0);
  }

  testBatch(model: string): Promise<AiStatus> {
    return this.request('POST', `/ai/models/${encodeURIComponent(model)}/batch-test`, undefined, 0);
  }
}
