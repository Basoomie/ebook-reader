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
  /** Stage 3 (WP20c): content duplicates. Missing on an older server. */
  stage3?: Stage3Status;
}

/** Stage 3's analysis progress (the server's Stage3Progress, without the gate). */
export interface Stage3Progress {
  analysisId: string;
  phase: 'text' | 'candidates' | 'compare' | 'quality' | 'group' | 'done';
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  phaseStartedAt: number;
  phaseStartDone: number;
  times: Partial<Record<string, { ms: number; items: number }>>;
  textTotal: number;
  textDone: number;
  textRead: number;
  textReadMs: number;
  textPrepMs?: number;
  textErrors: number;
  imageOnly: number;
  readerCompared: number;
  readerDiffering: number;
  candidates: number;
  compareTotal: number;
  compareDone: number;
  compareErrors: number;
  omnibusByText: number;
  qualityTotal: number;
  qualityDone: number;
  qualityErrors: number;
  classes: Record<string, number>;
  sets: number;
  setsWithoutKeeper: number;
  toRemove: number;
  review: number;
  removedWithData: number;
  bothWithData: number;
  tagsCopied: number;
}

export interface Stage3GatePair {
  key: string;
  group: string;
  a: number;
  b: number;
  expected: string;
  got: string | null;
  measured: { aInB: number; bInA: number };
  ours: { aInB: number; bInA: number } | null;
  foundByIndex: boolean;
  note: string | null;
}

export interface Stage3Gate {
  checkedAt: number;
  passed: boolean;
  problems: string[];
  pairs: {
    file: string;
    total: number;
    sameAfterStage1: number;
    notInLibrary: number;
    checked: number;
    asMeasured: number;
    results?: Stage3GatePair[];
  } | null;
  spread: { ok: boolean | null; detail: string } | null;
  kinds: {
    guards: number;
    recognized: number;
    missed: { id: number; label: string; got: string }[];
    imageOnly: number;
    imageOnlyRecognized: number;
    imageOnlyMissed: number[];
  } | null;
  textLength: {
    compared: number;
    equal: number;
    differing: { id: number; ours: number; reader: number }[];
  } | null;
}

export interface Stage3Status {
  waiting: string | null;
  progress: Stage3Progress | null;
  gate: Stage3Gate | null;
  /** Removals per state (current analysis plus everything queued or applied). */
  counts: Record<string, number>;
  skipReasons: { reason: string; count: number }[];
  /** Copies removed in the last 20 minutes, and when the first of them was (for time left). */
  pace: { removed: number; firstAt: number | null };
  awaitingIngest: CleanupBatch | null;
}

export interface ExtraText {
  extraChars: number;
  runs: { start: number; length: number; interleaved: boolean }[];
  runCount: number;
  interleavedRuns: number;
  interleavedChars: number;
  interleavedShare: number;
  chaptersTouched: number;
}

export interface PairMeasure {
  name: 'text' | 'images' | 'ruby' | 'toc' | 'cover' | 'direction';
  winner: 'a' | 'b' | 'tie' | 'tradeoff';
  detail: string;
}

export interface PairBookFacts {
  calibreId: number;
  title: string | null;
  author: string | null;
  tags: string[];
  formats: string[];
  addedAt: number | null;
  chars?: number | null;
  reader_chars?: number | null;
  kind?: string | null;
  kind_marker?: string | null;
  kind_by?: string | null;
  ruby?: number | null;
  toc_entries?: number | null;
  vertical?: number | null;
  cover_side?: number | null;
  images?: number | null;
  image_entries?: number | null;
  error?: string | null;
  quality_error?: string | null;
}

/** A measured pair of books (stage 3). a and b are ordered by Calibre id. */
export interface Stage3Pair {
  id: number;
  source: 'index' | 'gate' | 'image_only';
  class: string | null;
  rule: string | null;
  reason: string | null;
  container: 'a' | 'b' | null;
  aInB: number | null;
  bInA: number | null;
  estAInB: number | null;
  estBInA: number | null;
  /** The copy to keep between the two; null when each is better somewhere. */
  keepId: number | null;
  error: string | null;
  spread: { a: ExtraText | null; b: ExtraText | null } | null;
  best: { keep: 'a' | 'b' | null; by: string; measures: PairMeasure[]; reason: string } | null;
  /** Your decision on the pair (survives a new analysis). */
  decision: 'keep_both' | 'remove_a' | 'remove_b' | null;
  a: PairBookFacts;
  b: PairBookFacts;
}

export type PairDecision = 'keep_both' | 'remove_a' | 'remove_b' | 'clear';

export interface Stage3Book {
  calibre_id: number;
  title: string | null;
  author: string | null;
  chars: number | null;
  kind: string | null;
  kind_marker: string | null;
  kind_by: string | null;
  image_entries: number | null;
  error: string | null;
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

/** Shared by every stage (the server's settings.ts). */
export interface GateSettings {
  defaultPercent: number;
  /** Fields with their own bar, e.g. { title: 85 }. */
  fieldPercent: Record<string, number>;
  marginPoints: number;
  minBooks: number;
  labeledBooksFile: string;
  /** Stage 3's measured duplicate pairs; empty = the one beside the labeled books. */
  duplicatePairsFile: string;
}

/** Stage 3: the thresholds of plan section 5 (shared settings, group "duplicates"). */
export interface DuplicateSettings {
  bothWays: number;
  superset: number;
  reviewFloor: number;
  /** null until set after the Preview report (until then such pairs go to review). */
  spreadKeepBoth: number | null;
  spreadIgnore: number | null;
  imageOnlyMaxChars: number;
  imageMatchDistance: number;
  commonWindowBooks: number;
  textTimeoutSeconds: number;
  textWorkers: number;
}

export interface CleanupSettings {
  contentServerUrl: string;
  calibreLibraryId: string;
  calibreUsername: string;
  targetLibraryId: string | null;
  models: Record<string, string>;
  pacing: {
    readMbPerSecond: number;
    itemDelaySeconds: number;
    batchSize: number;
    maxBatchPercent: number;
    lookupChunk: number;
  };
  customTags: string[];
  gate: GateSettings;
  reviewAlarmPercent: number;
  libraryChangedPausePercent: number;
  /** A batch pauses its stage only when more than this share of its items failed. */
  failedPausePercent: number;
  covers: { maxMb: number; maxSide: number; sameDistance: number; largerPercent: number };
  /** Missing on an older server. */
  duplicates?: DuplicateSettings;
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
  /** Stage 1: why the kept copy stays; stage 3: 'stage3' (see stage3). */
  rule: 'tags' | 'older' | 'stage3';
  kept: CopyEvidence;
  removed: CopyEvidence;
  /** Stage 3 (WP20c): what the pair's comparison found. */
  stage3?: {
    pairId: number;
    class: string;
    rule: string;
    reason: string;
    removedInKept: number | null;
    keptInRemoved: number | null;
    best: { keep: 'a' | 'b' | null; by: string; measures: PairMeasure[]; reason: string } | null;
    byUser: boolean;
    /** Who decided the pair in the review ('you' on the page, 'claude'), and why. */
    decidedBy?: string | null;
    decisionNote?: string | null;
  };
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

  /** Stage 3's pairs: view = review, a class, image_only, errors, spread or examples (class). */
  stage3Pairs(
    view: string,
    { cls, offset = 0, limit = 50 }: { cls?: string; offset?: number; limit?: number } = {}
  ): Promise<{ total: number; items: Stage3Pair[] }> {
    const q = new URLSearchParams({ view, offset: String(offset), limit: String(limit) });
    if (cls) q.set('class', cls);
    return this.request('GET', `/cleanup/stage3/pairs?${q}`) as Promise<{
      total: number;
      items: Stage3Pair[];
    }>;
  }

  decidePair(id: number, decision: PairDecision): Promise<unknown> {
    return this.request('POST', `/cleanup/stage3/pairs/${id}`, { decision });
  }

  /** Stage 3's books: view = omnibus, errors or image_only. */
  stage3Books(view: string, offset = 0): Promise<{ total: number; items: Stage3Book[] }> {
    return this.request(
      'GET',
      `/cleanup/stage3/books?view=${encodeURIComponent(view)}&offset=${offset}`
    ) as Promise<{ total: number; items: Stage3Book[] }>;
  }

  stage3Gate(): Promise<{ gate: Stage3Gate | null }> {
    return this.request('GET', '/cleanup/stage3/gate') as Promise<{ gate: Stage3Gate | null }>;
  }

  spotCheck(stage = 1): Promise<{ items: Proposal[] }> {
    return this.request('GET', `/cleanup/spot-check?stage=${stage}`) as Promise<{
      items: Proposal[];
    }>;
  }
}
