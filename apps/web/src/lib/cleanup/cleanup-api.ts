/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { errorFrom, send, type RequestOptions } from '$lib/library/api';

/** The /cleanup page's client for /api/v1/cleanup/* (WP20a). */

export type StageMode = 'off' | 'analyse' | 'on';

export interface CleanupStage {
  stage: number;
  name: string;
  built: boolean;
  mode: StageMode;
  state: string;
  pauseReason: string | null;
  pauseDetail: string | null;
  pausedAt: number | null;
  progress: Record<string, unknown>;
  precision: Record<string, unknown>;
  updatedAt: number;
}

export interface CleanupCheck {
  name: string;
  label: string;
  ok: boolean;
  detail: string | null;
  source: 'sidecar' | 'server';
  checkedAt: number | null;
  required: boolean;
}

export interface CleanupBatch {
  id: string;
  stage: number;
  libraryId: string;
  kind: 'apply' | 'undo';
  undoOf: string | null;
  state: 'planned' | 'claimed' | 'applied' | 'partial' | 'failed' | 'undone';
  itemCount: number;
  snapshotSaved: boolean;
  createdAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  ingestedAt: number | null;
  error: string | null;
  counts: Record<string, number>;
}

export interface CleanupStatus {
  available: boolean;
  error?: string;
  stages: CleanupStage[];
  waiting: string | null;
  checks: CleanupCheck[];
  sidecar: {
    online: boolean;
    lastSeenAt: number | null;
    version: string | null;
    calibredb: string | null;
    serverVersion: string | null;
    trashRestore: boolean | null;
    problem: string | null;
  };
  target: { id: string; name: string; folder: string; present: number } | null;
  libraries: { id: string; name: string; folder: string }[];
  /** The content server's libraries and its id for the library to clean (auto = found by itself). */
  calibre: { id: string | null; auto: boolean; libraries: string[] };
  stage1: {
    counts: Record<string, number>;
    /** Why copies were skipped, most common first. */
    skipReasons?: { reason: string; count: number }[];
    /** Copies removed in the last 20 minutes, and when the first of them was (for time left). */
    pace?: { removed: number; firstAt: number | null };
    openBatch: CleanupBatch | null;
    awaitingIngest: CleanupBatch | null;
  };
  /** Stage 2 (WP20b): metadata and covers from the files. Missing on an older server. */
  stage2?: Stage2Status;
}

export interface FieldPause {
  field: string;
  /** gate: below its bar on the labeled books; no_labels; review_alarm; failures. */
  reason: string;
  detail: string | null;
  pausedAt: number;
}

export interface Stage2Status {
  waiting: string | null;
  /** Proposals per field, class (auto / review) and state. */
  counts: { field: string; class: string; state: string; n: number }[];
  skipReasons: { reason: string; count: number }[];
  fieldPauses: FieldPause[];
  /** Books written in the last 20 minutes, and when the first of them was (for time left). */
  pace: { written: number; firstAt: number | null };
  /** Books with changes still to write (auto, not paused). */
  booksLeft: number;
}

export interface Stage2Settings {
  filesPerSecond: number;
  itemDelaySeconds: number;
  chunkSize: number;
  titleMinPercent: number;
  titleMarginPoints: number;
  authorsMinPercent: number;
  gateMinBooks: number;
  coverMaxMb: number;
  coverMaxSide: number;
  coverSameDistance: number;
  coverLargerPercent: number;
  referenceFile: string;
}

export interface CleanupSettings {
  contentServerUrl: string;
  calibreLibraryId: string;
  calibreUsername: string;
  targetLibraryId: string | null;
  models: Record<string, string>;
  pacing: {
    hashMbPerSecond: number;
    itemDelaySeconds: number;
    batchSize: number;
    maxBatchPercent: number;
  };
  customTags: string[];
  gateThresholdPercent: number;
  reviewAlarmPercent: number;
  libraryChangedPausePercent: number;
  stage2?: Stage2Settings;
  backup: { path: string; verifiedOn: string; confirmedAt: number | null };
}

export type SecretName = 'anthropicApiKey' | 'openaiApiKey' | 'calibrePassword';

export interface SecretInfo {
  set: boolean;
  hint: string | null;
  updatedAt: number | null;
}

export interface SettingsAnswer {
  settings: CleanupSettings;
  secrets: Record<SecretName, SecretInfo>;
}

export interface CopyEvidence {
  calibreId: number;
  uuid: string;
  title: string;
  tags: string[];
  formats: string[];
  addedAt: number | null;
  readerData: boolean;
  extraFormats?: string[];
  customTags?: string[];
}

export interface CopyProposalEvidence {
  sha256: string;
  size: number;
  setSize: number;
  rule: 'tags' | 'older';
  kept: CopyEvidence;
  removed: CopyEvidence;
}

/** Stage 2: what a field change was proposed from. */
export interface FieldEvidence {
  /** Calibre's title and authors when the book was analysed. */
  title: string;
  authors?: string[];
  group: 'unknown' | 'processed' | 'agree' | 'conflict' | null;
  reason: string | null;
  extra?: Record<string, { old: unknown; new: unknown }> | null;
}

export interface Proposal {
  id: number;
  stage?: number;
  calibre_id: number;
  calibre_uuid: string;
  state: string;
  class?: string;
  review_reason?: string | null;
  batch_id?: string | null;
  /** Stage 2: the field, its source, and the value before and after. */
  field?: string;
  source?: string;
  old?: unknown;
  new?: unknown;
  evidence: CopyProposalEvidence | FieldEvidence | null;
  handoff?: { kind: string } | null;
  quarantine_dir?: string | null;
  restore_method?: string | null;
  detail?: string | null;
}

export class CleanupApi {
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
    options: RequestOptions = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.json();
  }

  status(): Promise<CleanupStatus> {
    return this.request('GET', '/cleanup/status') as Promise<CleanupStatus>;
  }

  settings(): Promise<SettingsAnswer> {
    return this.request('GET', '/cleanup/settings') as Promise<SettingsAnswer>;
  }

  saveSettings(changes: Partial<CleanupSettings>): Promise<SettingsAnswer> {
    return this.request('PUT', '/cleanup/settings', changes) as Promise<SettingsAnswer>;
  }

  /** Write-only: the answer never contains the value. */
  saveSecret(name: SecretName, value: string): Promise<{ secrets: SettingsAnswer['secrets'] }> {
    return this.request('PUT', `/cleanup/secrets/${name}`, { value }) as Promise<{
      secrets: SettingsAnswer['secrets'];
    }>;
  }

  removeSecret(name: SecretName): Promise<{ secrets: SettingsAnswer['secrets'] }> {
    return this.request('DELETE', `/cleanup/secrets/${name}`) as Promise<{
      secrets: SettingsAnswer['secrets'];
    }>;
  }

  setStageMode(stage: number, mode: StageMode): Promise<{ stage: CleanupStage }> {
    return this.request('PUT', `/cleanup/stages/${stage}`, { mode }) as Promise<{
      stage: CleanupStage;
    }>;
  }

  resumeStage(stage: number): Promise<{ stage: CleanupStage }> {
    return this.request('POST', `/cleanup/stages/${stage}/resume`, {}) as Promise<{
      stage: CleanupStage;
    }>;
  }

  analyseAgain(stage = 1): Promise<unknown> {
    return this.request('POST', `/cleanup/stages/${stage}/analyse`, {});
  }

  /** Stage 2: resume one paused field (a gate pause lifts only with a new analysis). */
  resumeField(stage: number, field: string): Promise<unknown> {
    return this.request(
      'POST',
      `/cleanup/stages/${stage}/fields/${encodeURIComponent(field)}/resume`,
      {}
    );
  }

  proposals(
    stage: number,
    state: string | null,
    offset = 0,
    limit = 50,
    filters: { field?: string; class?: string } = {}
  ): Promise<{ total: number; items: Proposal[] }> {
    const q = new URLSearchParams({
      stage: String(stage),
      offset: String(offset),
      limit: String(limit)
    });
    if (state) q.set('state', state);
    if (filters.field) q.set('field', filters.field);
    if (filters.class) q.set('class', filters.class);
    return this.request('GET', `/cleanup/proposals?${q}`) as Promise<{
      total: number;
      items: Proposal[];
    }>;
  }

  review(offset = 0): Promise<{ total: number; items: Proposal[] }> {
    return this.request('GET', `/cleanup/review?offset=${offset}`) as Promise<{
      total: number;
      items: Proposal[];
    }>;
  }

  decide(id: number, decision: 'apply' | 'keep'): Promise<unknown> {
    return this.request('POST', `/cleanup/review/${id}`, { decision });
  }

  batches(): Promise<{ batches: CleanupBatch[] }> {
    return this.request('GET', '/cleanup/batches') as Promise<{ batches: CleanupBatch[] }>;
  }

  batch(id: string): Promise<{ batch: CleanupBatch; items: Proposal[] }> {
    return this.request('GET', `/cleanup/batches/${encodeURIComponent(id)}`) as Promise<{
      batch: CleanupBatch;
      items: Proposal[];
    }>;
  }

  undo(id: string): Promise<{ batch: CleanupBatch }> {
    return this.request('POST', `/cleanup/batches/${encodeURIComponent(id)}/undo`, {}) as Promise<{
      batch: CleanupBatch;
    }>;
  }

  spotCheck(stage = 1): Promise<{ items: Proposal[] }> {
    return this.request('GET', `/cleanup/spot-check?stage=${stage}`) as Promise<{
      items: Proposal[];
    }>;
  }
}
