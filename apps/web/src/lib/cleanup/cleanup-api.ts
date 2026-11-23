/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { ArrivalsStatus } from './arrivals-text';
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
  /** Stage 4 (WP20d): online sources, Preview only. Missing on an older server. */
  stage4?: Stage4Status;
  /** Stage 5 (WP20f): genres and tags. Missing on an older server. */
  stage5?: Stage5Status;
}

/** One view of stage 5's gate: a label set scored as the genre test was. */
export interface Stage5SetScore {
  books: number;
  core: number;
  found: number;
  applied: number;
  right: number;
  full: number;
  foundPercent: number | null;
  rightPercent: number | null;
  wrong: { gid: string; id: string }[];
  missed: { gid: string; id: string }[];
}

export interface Stage5GateView {
  genres: Stage5SetScore;
  tags: Stage5SetScore;
}

export interface Stage5Gate {
  at: number;
  books: { genres: number; tags: number };
  models: Stage5GateView;
  own: Stage5GateView;
  noRanobedb: Stage5GateView;
  final: Stage5GateView;
  test: {
    genres: { found: number; right: number; full: number; books: number };
    tags: { found: number; right: number; full: number; books: number };
  };
  below: string[];
  held: { genres: boolean; tags: boolean };
  passed: boolean;
  notAsked: number;
}

export interface Stage5Counts {
  terms: Record<string, number>;
  formats: Record<string, number>;
  noGenre: number;
  removals: Record<string, number>;
  books: number;
  added: number;
  removed: number;
  outside: number;
  outsideChanged: number;
  inBatch: number;
}

export interface Stage5Progress {
  phase: string;
  bar: { phase: string; done: number; total: number; secondsLeft: number | null } | null;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  items: number;
  labeledItems: number;
  decided: number;
  asked: number;
  oneModel: number;
  droppedTerms: number;
  marks: number | null;
  answers: {
    queued: number;
    sent: number;
    answered: number;
    failed: number;
    blocked: number;
    invalid: number;
  } | null;
  wait: string | null;
  costUsd: number | null;
  gate: Stage5Gate | null;
  counts: Stage5Counts | null;
  error: string | null;
}

export interface Stage5Status {
  waiting: string | null;
  /** Stage 4's analysis and AI check are done. */
  ready: boolean;
  progress: Stage5Progress | null;
  fieldPauses: FieldPause[];
  write?: Stage4Write | null;
  terms: { id: string; ja: string; en: string; kind: string }[];
  cachedAt: number;
}

/** One book's change in stage 5's list. */
export interface Stage5Proposal {
  id: number;
  calibreId: number;
  title: string;
  series: string | null;
  format: string | null;
  before: string[];
  change: { add: string[]; remove: string[] };
  sources: Record<string, { from: string[]; books: number }>;
  outside: boolean;
  cls: string;
  reason: string | null;
  state: string;
}

/** One site's queue in the fetch container (WP20d). */
export interface Stage4Site {
  site: string;
  enabled: boolean;
  intervalSeconds: number;
  queued: number;
  leased: number;
  done: number;
  gone: number;
  failed: number;
  attempts: number;
  challenges: number;
  errors: number;
  busy: number;
  recent: { requests: number; challenges: number; errors: number; avgMs: number | null } | null;
  secondsPerRequest: number;
  secondsLeft: number;
  pausedReason: string | null;
  backoffUntil: number | null;
  backoffReason: string | null;
  slowFactor: number;
  /** Amazon's product pages and searches share one slot: pace and time left are the slot's. */
  sharedSlot?: boolean;
}

export interface Stage4Status {
  waiting: string | null;
  fetcher: {
    online: boolean;
    lastSeenAt: number | null;
    version: string | null;
    problem: string | null;
    sudachi: string | null;
  };
  amazonPace: string;
  sites: Stage4Site[];
  books: { state: string; labeled: number; n: number }[];
  readings: { state: string; n: number }[];
  natively: { listed: number; read: number | null; withIsbn: number | null; asins: number };
  fields: { field: string; class: string; n: number }[];
  /** Automatic values that are the AI's best guess, marked unconfirmed (WP20e). */
  unconfirmed?: { field: string; n: number }[];
  /** The AI check after the rules (WP20e); null before it starts. */
  ai?: Stage4AiStatus | null;
  fieldPauses: FieldPause[];
  /** Books whose changes were all undone (the test batches), written on the card's button (WP20f). */
  undoneBooks?: number;
  /** Stage 4 On (WP20e): books and changes written, the changes left, the time left. */
  write?: Stage4Write | null;
  /** The reading: books read (each once, from the database), the books with an EPUB, the pace. */
  read: { done: number; total: number; perSecond: number | null } | null;
  /** Time left (seconds; null while not measured yet). */
  timeLeft: Stage4TimeLeft | null;
  cachedAt: number;
}

/** Stage 4 On's progress: changes written of all, books written, seconds left (null: not measured yet). */
export interface Stage4Write {
  books: { done: number };
  changes: { done: number; total: number };
  secondsLeft: number | null;
  batches: number;
}

/** One field of the AI check's gate: confirmed values against the bar, and every value. */
export interface Stage4AiGateField {
  scored: number;
  auto: number;
  autoRight: number;
  autoPercent: number | null;
  allRight: number;
  allPercent: number | null;
  wrong: string[];
}
export interface Stage4AiGateGroup {
  books: number;
  everyFieldRight: number;
  everyFieldPercent: number | null;
  fields: Record<string, Stage4AiGateField>;
}
export interface Stage4AiStatus {
  phase: 'evidence' | 'models' | 'decide' | 'spelling' | 'series' | 'gate' | 'done';
  /** The running phase: how far, and the seconds left (null: not measured yet). */
  bar?: { phase: string; done: number; total: number; secondsLeft: number | null } | null;
  items: number;
  labeledItems: number;
  decided: number;
  answers: {
    queued: number;
    sent: number;
    answered: number;
    failed: number;
    blocked: number;
    invalid: number;
  } | null;
  wait: string | null;
  costUsd: number | null;
  invented: number;
  flaggedAgainstRules: Record<string, number> | null;
  /** The series step (series-order follow-up). */
  seriesOrder?: Stage4SeriesOrder | null;
  gate: {
    passed: boolean;
    below: string[];
    books: number;
    notAsked: number;
    all: Stage4AiGateGroup;
    the600: Stage4AiGateGroup;
    checkD: Stage4AiGateGroup;
  } | null;
  error: string | null;
  finishedAt: number | null;
}

export interface Stage4TimeLeft {
  read: number | null;
  sites: Record<string, number>;
  slowest: { site: string; seconds: number } | null;
  final: number | null;
  total: number | null;
  /** Books not started yet (requests per book), and where that rate comes from: the reference
   * run, or this run's labeled books once done. Missing on an older server. */
  notStarted?: number;
  basis: 'labeled' | 'reference';
  /** What the open lookups ask next: at this run's measured rates, or an upper bound until a
   * step is measured ('none' when nothing is open). Missing on an older server. */
  followUps?: 'measured' | 'bound' | 'none';
}

/** One field of the stage-4 gate (the server's precision.gate.fields). */
export interface Stage4GateField {
  auto: number;
  scored: number;
  right: number;
  percent: number | null;
  bar: number;
  below: boolean;
  the600: { auto: number; right: number; percent: number | null; measured: number };
  checkD: { auto: number; right: number; percent: number | null; measured: number };
}

export interface Stage4Gate {
  books: number;
  at: number;
  fields: Record<string, Stage4GateField>;
  kind: { right: number; all: number; percent: number | null };
}

export interface Stage4Proposal {
  id: number;
  calibreId: number;
  title: string | null;
  field: string;
  old: unknown;
  new: unknown;
  class: 'auto' | 'review';
  source: string;
  reason: string | null;
  evidence: Record<string, unknown>;
}

export interface Stage4SeriesChecks {
  series: number;
  multi: number;
  collisions: number;
  collisionsUnmarked: number;
  missing: number;
  missingUnmarked: number;
  guesses: number;
  reviews: number;
  examples: string[];
}
export interface Stage4SeriesOrder {
  series: number;
  choices: number;
  changed: number;
  guesses: number;
  reviews: number;
  checks: Stage4SeriesChecks | null;
}
/** A book of a series in the Best guesses list (the series is shown whole, in order). */
export interface Stage4GuessBook {
  calibreId: number;
  title: string;
  index: number | null;
  guess: boolean;
  reason: string | null;
  review: string | null;
  from: string;
  fields: { field: string; reason: string | null }[];
}
export interface Stage4GuessSeries {
  series: string;
  books: Stage4GuessBook[];
}
export interface Stage4GuessOther {
  calibreId: number;
  title: string;
  fields: { field: string; value: unknown; reason: string | null }[];
}

export interface AuthorReading {
  name: string;
  state: string;
  reading: string | null;
  source: string | null;
  authority: string | null;
  ambiguous: number;
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
  name: 'text' | 'images' | 'artwork' | 'ruby' | 'toc' | 'cover' | 'direction';
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
  /** Audiobooks stage 3's labeled pairs; empty = reference-sample/audio/labels.json (WP21b). */
  audiobookPairsFile?: string;
  /** Audiobooks stage 5: the bar per field on automatic values (WP21d). */
  audiobookMetaPercent?: number;
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
  /** The audiobook cleanup (WP21a); missing on an older server. */
  audiobooks?: AudiobookSettings;
  /** Stage 4's online lookups (WP20d); missing on an older server. */
  fetch?: FetchSettings;
  /** The AI models (WP21d); missing on an older server. */
  ai?: AiSettings;
  /** WP20g: the Calibre library's new arrivals and the import; missing on an older server. */
  arrivals?: BookArrivalSettings;
  backup: { path: string; verifiedOn: string; confirmedAt: number | null };
}

/** WP20g: one source folder (under the sources mount) whose EPUBs are added to a library. */
export interface ArrivalPairSetting {
  id: string;
  source: string;
  libraryId: string;
}

/** WP20g: the new arrivals' settings. */
export interface BookArrivalSettings {
  pairs: ArrivalPairSetting[];
  time: string;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
  settleMinutes: number;
  handCheckMinutes: number;
  addBatchSize: number;
  addLeaseSeconds: number;
}

export interface FetchSettings {
  /** inFlight: requests of the site at once (1-4; Amazon's queues always 1). */
  sites: Record<string, { enabled: boolean; intervalSeconds: number; inFlight?: number }>;
  amazonPace: 'shared' | 'separate' | 'trial';
  challengeBackoffSeconds: number;
  challengeBackoffMaxSeconds: number;
  challengePauseAfter: number;
  slowDownPercent: number;
  slowDownWindow: number;
  retrySeconds: number;
  maxAttempts: number;
  leaseSeconds: number;
  requestTimeoutSeconds: number;
  maxPageMb: number;
  ndlNamesPerQuery: number;
  ndlOutageStartJst: string;
  ndlOutageMinutes: number;
  nativelyRereadDays: number;
  smallCoverPx: number;
  offlineSeconds: number;
}

export interface AudiobookSettings {
  absUrl: string;
  readMbPerSecond: number;
  healthWorkers: number;
  decodeSeconds: number;
  toolTimeoutSeconds: number;
  copyHintMinMinutes: number;
  copyHintPercent: number;
  absTimeoutSeconds: number;
  /** Stage 3 (WP21b); missing on an older server. */
  dupWindowSeconds?: number;
  dupShiftSeconds?: number;
  dupMiddleSearchMinutes?: number;
  dupSameScore?: number;
  dupCandidatePercent?: number;
  dupAsinToleranceSeconds?: number;
  dupLengthEqualSeconds?: number;
  dupIncompleteSeconds?: number;
  dupBitrateMarginPercent?: number;
  dupChapterToleranceSeconds?: number;
  dupFingerprintWorkers?: number;
  dupDecodeWorkers?: number;
  dupClipSeconds?: number;
  dupBrandingMaxSeconds?: number;
  dupBrandingScore?: number;
  dupNoticeableErrors?: number;
  /** Stage 2: files of a folder this long (minutes) are separate books. */
  fullBookMinutes?: number;
  /** Stage 4 (WP21c); missing on an older server. */
  onlineRuntimeMinutes?: number;
  onlineTitleScore?: number;
  /** WP21c follow-up (2); missing on an older server. */
  onlineTitleMinChars?: number;
  onlineTitleMinShare?: number;
  onlineSearchProducts?: number;
  onlineStorePages?: number;
  onlineOpeningSeconds?: number;
  noStoreRecordFolders?: string[];
  /** Stage 5 (WP21d): 複数ナレーター from this many narrators. */
  multiNarratorMin?: number;
  /** Stage 7 (WP21f-1): the daily new arrivals; missing on an older server. */
  arrivalsTime?: string;
  arrivalsQuietStart?: string;
  arrivalsQuietEnd?: string;
  arrivalsTimeZone?: string;
  arrivalsSettleMinutes?: number;
  arrivalsAbsWaitMinutes?: number;
  librarySeenSlackSeconds?: number;
  arrivalsAbsNudge?: boolean;
  /** WP21f-2: changes to books already in the library: off, Preview (analyse) or On. */
  libraryChanges?: 'off' | 'analyse' | 'on';
  extractLeaseSeconds?: number;
}

/** The cleanup's own secrets (the AI keys are Settings > AI's: $lib/ai/ai-api). */
export type SecretName = 'calibrePassword' | 'absApiKey';

// ---------------------------------------------------------------- the audiobook cleanup (WP21a)

export type AudioStageMode = 'off' | 'analyse';

export interface DiskLockState {
  holder: { owner: string; side: 'calibre' | 'audio'; since: number } | null;
  waiting: { owner: string; side: 'calibre' | 'audio'; since: number }[];
  /** A Calibre batch being applied (missing on an older server). */
  calibreApplying?: string | null;
}

export interface AudioStageRow {
  stage: number;
  name: string;
  mode: AudioStageMode | 'on';
  state: string;
  pauseReason: string | null;
  pauseDetail: string | null;
  progress: Record<string, unknown>;
  updatedAt: number;
}

export interface WalkResult {
  startedAt: number;
  finishedAt: number;
  files: { torrents: number; library: number };
  audio: { torrents: number; library: number };
  bytes: { torrents: number; library: number };
  skippedFolders: number;
  links: number;
  errors: string[];
  gone: number;
  rawNames: number;
}

export interface AudioStage1Progress {
  analysisId: string;
  phase: 'walk' | 'hash' | 'classify' | 'done';
  startedAt: number;
  finishedAt: number | null;
  walk: WalkResult | null;
  hashTotal: number;
  hashDone: number;
  hashBytesTotal: number;
  bytesHashed: number;
  hashErrors: number;
  hashChanged: number;
  hashReused: number;
  phaseStartedAt: number;
  phaseStartBytes: number;
  yields: number;
  error: string | null;
}

export interface AudioStage2Progress {
  analysisId: string;
  phase: 'walk' | 'units' | 'health' | 'classify' | 'done';
  startedAt: number;
  finishedAt: number | null;
  walk: WalkResult | null;
  books: number;
  /** Folders split into one book per full-length file (missing on older servers). */
  splitFolders?: number;
  healthTotal: number;
  healthDone: number;
  healthReused: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  error: string | null;
}

export interface AbsSnapshotSummary {
  takenAt: number;
  serverVersion: string | null;
  libraries: number;
  items: number;
  /** Each library on its own: item count (null: not known) and books with listening progress. */
  perLibrary?: { name: string | null; items: number | null; progress: number }[];
  users: number;
  progress: number;
  finished: number;
  inProgress: number;
  notInAbs: number;
  problems: number;
}

export interface AbsProgressRow {
  user: string;
  title: string | null;
  author: string | null;
  library: string | null;
  path: string | null;
  relPath: string | null;
  inAbs: boolean;
  isFinished: boolean;
  progressPercent: number;
  currentTime: number | null;
  duration: number | null;
  lastUpdate: number | null;
}

export interface AbsSnapshot {
  takenAt: number;
  serverVersion: string | null;
  libraries: {
    id: string;
    name: string | null;
    provider: string | null;
    folders: string[];
    itemCount: number | null;
  }[];
  serverSettings: string;
  users: { id: string; username: string; type: string | null; progressCount: number }[];
  progress: AbsProgressRow[];
  problems: string[];
}

/** WP21e-2: one step of the switch (its bar). */
export interface SwitchStep {
  step: string;
  done: number;
  total: number;
  startedAt: number;
}

export type SwitchAction = 'switch' | 'undo' | 'delete';

export interface SwitchProgress {
  runId: string;
  action: SwitchAction;
  phase: string;
  startedAt: number;
  finishedAt: number | null;
  phaseTimes: Record<string, number>;
  current: SwitchStep | null;
  waiting: string | null;
  lateArrivals: string[];
  fromLibrary: { rel: string; dst: string; link: string }[];
  check: {
    passed: boolean;
    items: { key: string; name: string; ok: boolean | null; detail: string }[];
  } | null;
  links: Record<string, number> | null;
  linksBefore: number | null;
  snapshot: string | null;
  renamed: { from: string; to: string }[];
  rescan: { folders: number; ms: number } | null;
  verify: {
    links: number;
    resolved: number;
    notResolved: number;
    playableLost: number;
    countBefore: number;
    countAfter: number;
    passed: boolean;
  } | null;
  restored: { restored: number; listed: number } | null;
  files: {
    total: number;
    same: number;
    different: number;
    noTwin: number;
    unreadable: number;
    bytes: number;
  } | null;
  inventory: { copied: string[] } | null;
  deletion: {
    entries: number;
    files: number;
    dirs: number;
    bytes: number;
    freed: number;
    freeBefore: number | null;
    freeAfter: number | null;
    unknown: string[];
  } | null;
  history: { action: SwitchAction; startedAt: number; finishedAt: number; result: string }[];
  error: string | null;
}

export interface CoversProgress {
  runId: string;
  phase: 'find' | 'set' | 'done';
  startedAt: number;
  finishedAt: number | null;
  libraries: { main: string | null; ai: string | null };
  current: SwitchStep | null;
  counts: Record<string, number>;
  coverPng: { total: number; ofTheseBooks: number; used: number } | null;
  error: string | null;
}

export interface AudioSwitchStatus {
  available: boolean;
  state?: 'none' | 'running' | 'switched' | 'deleted';
  pause?: { reason: string; detail: string | null } | null;
  progress?: SwitchProgress | null;
  refusals?: Record<SwitchAction, string[]>;
  cancellable?: boolean;
  phases?: string[];
  covers?: {
    state: 'none' | 'running' | 'done';
    pause: { reason: string; detail: string | null } | null;
    progress: CoversProgress | null;
    refusals: string[];
  } | null;
}

export interface AudioStatus {
  available: boolean;
  error?: string;
  roots: { ok: boolean; problem: string | null; checkedAt: number };
  stages: AudioStageRow[];
  lock: DiskLockState;
  stage0: {
    snapshotting: boolean;
    latest: { id: number; summary: AbsSnapshotSummary } | null;
    snapshots: { id: number; summary: AbsSnapshotSummary }[];
    absUrlSet: boolean;
    keySet: boolean;
  };
  stage1: {
    waiting: string | null;
    progress: AudioStage1Progress | null;
    counts: Record<string, number> | null;
  };
  stage2: {
    waiting: string | null;
    progress: AudioStage2Progress | null;
    counts: Record<string, number> | null;
  };
  /** Missing on an older server (WP21b). */
  stage3?: {
    waiting: string | null;
    progress: AudioStage3Progress | null;
    counts: Record<string, number> | null;
  };
  /** Missing on an older server (WP21c). */
  stage4?: AudioStage4Status;
  /** Missing on an older server (WP21d). */
  stage5?: AudioStage5Status;
  /** Missing on an older server (WP21e-1). */
  stage6?: AudioStage6Status;
  /** WP21e-2: the switch to the new library, Undo, deleting japanese-old, and the covers. */
  switch?: AudioSwitchStatus;
  /** WP21f-1: the daily new arrivals. */
  stage7?: AudioStage7Status;
}

// ---------------------------------------------------------------- audiobooks stage 7 (WP21f-1)

export type Stage7Phase =
  | 'stage1'
  | 'archives'
  | 'stage1b'
  | 'stages'
  | 'classify'
  | 'plan'
  | 'walk_before'
  | 'build'
  | 'walk_after'
  | 'check'
  | 'changes'
  | 'abs'
  | 'report'
  | 'done';

/** WP21f-2: the changes to books already in the library (a step of every stage-7 run). */
export interface LibraryChangesProgress {
  mode: 'analyse' | 'on';
  phase: string;
  startedAt: number;
  phaseStartedAt: number;
  phaseTimes: Record<string, { ms: number; items: number }>;
  waitMs: number;
  waitSince: number | null;
  waiting: string | null;
  done: number;
  total: number;
  ledger: number;
  candidates: number;
  counts: {
    changes: number;
    metadata: number;
    moves: number;
    renames: number;
    renamesHeld: number;
    rmdirs: number;
    readerFiles: number;
    readerWaiting: number;
    links: number;
    reviews: number;
    kept: number;
    userFields: number;
    absKept?: number;
  };
  /** What Audiobookshelf made of the cleanup's writes (proven by time), per book not known yet. */
  seen?: {
    checked: number;
    proven: number;
    unproven: number;
    notInAbs: number;
    cursor: number;
    skipped: string | null;
  };
  apply: {
    total: number;
    done: number;
    failed: number;
    batches: number;
    lockWaitMs: number;
    yields: number;
  };
  preflightProblems: string[];
  snapshot: string | null;
  remap: { changed: number; resolveBefore: number; resolveAfter: number } | null;
  abs: {
    library: string | null;
    before: number | null;
    after: number | null;
    scannedAt: number | null;
    verified: number;
    notYet: number;
    cleared?: number;
    set?: number;
    problems: string[];
    error: string | null;
  };
  error: string | null;
}

/** One book's change in a run's lists. */
export interface LibraryChangeItem {
  id: number;
  bookId: number;
  state: 'planned' | 'applied' | 'failed' | 'skipped' | 'review';
  folderFrom: string;
  folderTo: string | null;
  fields: { field: string; from: unknown; to: unknown; mine?: unknown }[];
  userFields: string[];
  conflicts: { field: string; from: unknown; to: unknown; mine?: unknown }[];
  /** Fields where Audiobookshelf kept an older value: `mine` is its value (item 6). */
  absKept?: { field: string; from: unknown; to: unknown; mine?: unknown }[];
  renames: { from: string; to: string }[];
  renamesHeld: boolean;
  reviews: { kind: string; text: string }[];
  skipped: string | null;
}

export interface AudioStage7Run {
  runId: number;
  trigger: 'schedule' | 'now';
  mode: 'analyse' | 'on';
  phase: Stage7Phase;
  startedAt: number;
  finishedAt: number | null;
  phaseStartedAt: number;
  phaseStartDone: number;
  phaseTimes: Record<string, { ms: number; items: number }>;
  archives: {
    total: number;
    waiting: number;
    toList: number;
    listed: number;
    entries: number;
    bytes: number;
    extracted: number;
    extractedBytes: number;
    thisRun: number;
    problems: Record<string, number>;
  };
  classify: Record<string, number> | null;
  plan: {
    books: number;
    main: number;
    ai: number;
    links: number;
    pdfs: number;
    folders: number;
    collisions: { narrator: number; number: number; series: number };
    newAuthors: number;
  } | null;
  build: {
    total: number;
    done: number;
    failed: number;
    batches: number;
    startedAt: number | null;
    lockWaitMs: number;
    yields: number;
    firstFailure: string | null;
  };
  walks: Record<string, { entries: number; ms: number; pausedMs: number }>;
  walk?: { root: string; done: number; total: number; startedAt: number } | null;
  check: { passed: boolean; lines: string[] } | null;
  abs: {
    library: string | null;
    before: number | null;
    after: number | null;
    found: number;
    missing: number;
    valuesOk: number;
    valuesDiffer: number;
    nudged: number;
    waitingSince: number | null;
    error: string | null;
    precedence: string | null;
  };
  waiting: string | null;
  error: string | null;
  changes?: LibraryChangesProgress;
}

export interface AudioStage7Report {
  mode: 'analyse' | 'on';
  added: number;
  planned: number;
  outcomes: Record<string, number>;
  newReview: number;
  openReview: number;
  aiCostUsd: number;
  designs: Record<'E' | 'F' | 'J', number>;
  times: Record<string, { ms: number; items: number }>;
  lockWaitMs: number;
  yields: number;
  /** WP21f-1 reports only (replaced by `changes`). */
  changedExisting?: { differ: number; same: number; rekeyed: number };
  /** WP21f-2: the changes to books already in the library. */
  changes?:
    | (Pick<
        LibraryChangesProgress,
        | 'mode'
        | 'ledger'
        | 'candidates'
        | 'seen'
        | 'counts'
        | 'apply'
        | 'snapshot'
        | 'remap'
        | 'abs'
        | 'error'
      > & { times: Record<string, { ms: number; items: number }> })
    | null;
}

export interface AudioStage7Status {
  available: boolean;
  mode?: AudioStageMode | 'on';
  pause?: { reason: string; detail: string | null } | null;
  running?: boolean;
  nextRunAt?: number | null;
  /** The schedule's time zone (the setting, else the server's). */
  timeZone?: string;
  run?: AudioStage7Run | null;
  report?: AudioStage7Report | null;
  sidecarReady?: boolean;
  switched?: boolean;
  designs?: Record<'E' | 'F' | 'J', number>;
  upgrade?: {
    F: { items: number; fields: number; costUsd: number | null };
    J: { items: number; fields: number; costUsd: number | null };
    includeDecided: boolean;
    models: string[];
  };
  openReviews?: Record<string, number>;
  absWaitMinutes?: number;
  /** Settings > Audiobooks: changes to books already in the library (WP21f-2). */
  libraryChanges?: 'off' | 'analyse' | 'on';
}

// ---------------------------------------------------------------- audiobooks stage 6 (WP21e-1)

export type Stage6Phase =
  | 'plan'
  | 'preflight'
  | 'planned'
  | 'walk_before'
  | 'build'
  | 'walk_after'
  | 'check'
  | 'done';

export interface Stage6Counts {
  units: number;
  books: { main: number; ai: number; pending: number };
  shapes: { seriesVol: number; seriesNoVol: number; standalone: number };
  unknownAuthor: number;
  links: number;
  pdfLinks: number;
  pdfs: { placed: number; unplaced: number; otherCopy?: number; noBook?: number; total: number };
  folders: number;
  metadata: number;
  ops: number;
  collisions: { narrator: number; number: number };
  namesCut: number;
  namesReplaced: number;
  noCover: number;
  noValues: number;
  droppedCopies: number;
  keptReview: number;
  moves: Record<
    'moved' | 'ai' | 'dropped' | 'library_only_pending' | 'reader_written' | 'unaccounted',
    number
  >;
}

export interface Stage6CheckItem {
  key: string;
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface Stage6Progress {
  analysisId: string;
  phase: Stage6Phase;
  startedAt: number;
  finishedAt: number | null;
  counts: Stage6Counts | null;
  archives: { count: number; bytes: number } | null;
  libraryOther: { ext: string; kind: string; count: number; bytes: number }[] | null;
  phaseTimes: Record<string, { ms: number; items: number }>;
  preflight: {
    total: number;
    done: number;
    problems: number;
    byProblem: Record<string, number>;
  };
  build: {
    startedAt: number | null;
    finishedAt: number | null;
    total: number;
    done: number;
    failed: number;
    batches: number;
    lockWaits: number;
    lockWaitMs: number;
    yields: number;
    firstFailure: string | null;
  };
  walk: {
    before: { entries: number; ms: number; pausedMs: number; errors: string[] } | null;
    after: { entries: number; ms: number; pausedMs: number; errors: string[] } | null;
    current: { done: number; expected: number } | null;
  };
  /** The check's step now (missing on an older server). */
  checking?: { step: string; done: number; total: number; startedAt: number } | null;
  check: {
    passed: boolean;
    at: number;
    items: Stage6CheckItem[];
    labels: {
      books: number;
      notFound: string[];
      folderRight: number;
      folderWrong: { id: string; expected: string; got: string; why: string }[];
      valuesWrong: { id: string; field: string; expected: unknown; got: unknown; why: string }[];
      valuesChecked: number;
      unexplained: number;
    };
  } | null;
  error: string | null;
}

export interface AudioStage6Status {
  available: boolean;
  waiting: string | null;
  progress?: Stage6Progress | null;
  secondsLeft?: number | null;
  sidecar?: {
    online: boolean;
    lastSeenAt: number | null;
    version: string | null;
    problem: string | null;
    info: Record<string, unknown> | null;
  };
  handing?: boolean;
  /** Why On can't be switched on now (empty: it can). */
  onRefusals?: string[];
}

export interface AudioBuildBook {
  id: number;
  area: 'main' | 'ai';
  state: 'build' | 'pending';
  folder: string;
  baseFolder: string;
  author: string;
  series: string | null;
  title: string;
  notes: string[];
  files: { kind: string; from: string; to: string }[];
  fileCount: number;
  pdfs: number;
  cover: boolean;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------- audiobooks stage 5 (WP21d)

export type AudioStage5Phase = 'evidence' | 'models' | 'decide' | 'gate' | 'done';

export interface AudioMetaGateField {
  auto: number;
  autoRight: number;
  flagged: number;
  flaggedRight: number;
  percent: number | null;
  passed: boolean;
}

export interface AudioMetaGateMiss {
  id: string;
  field: string;
  expected: unknown;
  got: unknown;
  source: string;
  unitKey: string | null;
  name: string | null;
  record: string | null;
}

export interface AudioMetaGate {
  passed: boolean;
  books: number;
  notFound: string[];
  fields: Record<string, AudioMetaGateField>;
  misses: AudioMetaGateMiss[];
  /** How many flagged values differ from their label (shown, not misses). */
  flaggedWrong: number;
  error: string | null;
}

export interface AiCounts {
  queued: number;
  sent: number;
  answered: number;
  blocked: number;
  invalid: number;
  failed: number;
}

export interface AudioStage5Progress {
  analysisId: string;
  phase: AudioStage5Phase;
  startedAt: number;
  finishedAt: number | null;
  units: number;
  labeledUnits: number;
  decided: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  ai: AiCounts | null;
  wait: string | null;
  invented: number;
  counts: Record<string, Record<string, number>> | null;
  /** The answers the decisions use, whatever run asked them, with their cost. */
  inUse?: { answered: number; failed: number; blocked: number; invalid: number; costUsd: number };
  cost: {
    costUsd: number;
    items: number;
    perItemUsd: number | null;
    byModel: Record<string, number>;
  } | null;
  gate: AudioMetaGate | null;
  error: string | null;
}

export interface AudioStage5Status {
  available: boolean;
  waiting: string | null;
  progress: AudioStage5Progress | null;
  secondsLeft: number | null;
  spend: { spentUsd: number; reservedUsd: number; limitUsd: number | null };
  batches: {
    open: number;
    collected: number;
    failed: number;
    /** Cancelled by the stall guard (nothing answered in time). */
    stalled?: number;
    turnaroundMs: { median: number | null; max: number | null };
  };
  /** How stage 5's two models are asked now. */
  modes: { primary: 'batch' | 'direct'; secondary: 'batch' | 'direct' };
  models: { primary: string; secondary: string };
  batchStallMinutes: number;
  labeledOnly: boolean;
}

export interface AudioMetaField {
  field: string;
  value: unknown;
  source: string;
  flagged: boolean;
  reason: string | null;
  rules: unknown;
  primary: unknown;
  secondary: unknown;
}

export interface AudioMetaItem {
  unitKey: string;
  name: string;
  labeled: boolean;
  kind: 'record' | 'no_record' | 'ai' | 'radio';
  stage4Class: string | null;
  record: string | null;
  state: string;
  flagged: number;
  error: string | null;
  gateMisses: { id: string; field: string; expected: unknown; got: unknown; source: string }[];
  fields: AudioMetaField[];
}

export interface AiPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  longAboveTokens?: number;
  long?: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number };
}

/** The cleanup's own AI choices (the provider settings are Settings > AI's). */
export interface AiSettings {
  labeledOnly: boolean;
  /** WP21f-1: the new arrivals' AI setup (default J); missing on an older server. */
  arrivalsDesign?: 'E' | 'F' | 'J';
  /** WP20g: the Calibre library's new arrivals' AI setup (default J); missing on an older server. */
  booksArrivalsDesign?: 'E' | 'F' | 'J';
  /** WP21f-1: an upgrade also re-checks values already decided by that setup or a stronger one. */
  upgradeIncludeDecided?: boolean;
}

/** /cleanup's AI part: which model does what, with this month's spending of every AI feature. */
export interface AiStatus {
  settings: AiSettings;
  /** The models with a price (Settings > AI): the ones a task can choose. */
  prices: Record<string, AiPrice>;
  spend: {
    spentUsd: number;
    reservedUsd: number;
    limitUsd: number | null;
    resumesOn?: string;
  };
  keys: { anthropic: boolean; openai: boolean };
  checks: Record<string, { checkedAt: number; error: string | null; models: number | null }>;
  tasks: {
    task: string;
    model: string;
    provider: 'anthropic' | 'openai';
    price: AiPrice | null;
    /** true/false = in the provider's list when last checked; null = not checked. */
    checked: boolean | null;
    mode: 'batch' | 'direct';
  }[];
  /** The steps that ask models today and the model tasks each uses. */
  steps?: {
    id: string;
    name: string;
    about: string;
    models: { task: string; role: string }[];
  }[];
}

// ---------------------------------------------------------------- audiobooks stage 4 (WP21c)

export type AudioStage4Phase = 'units' | 'lookups' | 'records' | 'gate' | 'done';

export interface AudioOnlineGateBook {
  id: string;
  title: string | null;
  expected: string;
  got: string;
  source: string;
  outcome: 'auto_agrees' | 'review' | 'unknown' | 'none_expected' | 'not_found' | 'miss';
  ok: boolean;
  note?: string;
}

export interface AudioOnlineGate {
  passed: boolean;
  checked: number;
  misses: AudioOnlineGateBook[];
  bySource: Record<string, Record<string, number>>;
  error: string | null;
}

export interface AudioStage4Progress {
  analysisId: string;
  phase: AudioStage4Phase;
  startedAt: number;
  finishedAt: number | null;
  units: number;
  lookupUnits: number;
  noRecordUnits: number;
  labeledUnits: number;
  decided: number;
  openingsRead: number;
  openingErrors: number;
  samplesRead: number;
  sampleErrors: number;
  yields: number;
  /** One store record per recording (WP21c follow-up (3)); missing before it. */
  records?: {
    rounds: number;
    shared: number;
    compared: number;
    toCompare: number;
    different: number;
    review: number;
    lookedUpAgain: number;
    windows?: number;
    windowErrors?: number;
  };
  phaseStartedAt: number;
  phaseStartDone: number;
  phaseTimes: Record<string, { ms: number; items: number }>;
  counts: Record<string, number> | null;
  gate: AudioOnlineGate | null;
  error: string | null;
}

export interface AudioSiteLine {
  site: string;
  enabled: boolean;
  intervalSeconds: number;
  queued: number;
  leased: number;
  done: number;
  gone: number;
  failed: number;
  attempts: number;
  refused: number;
  errors: number;
  busy: number;
  recent: { requests: number; errors: number; avgMs: number | null } | null;
  secondsPerRequest: number;
  expected: number;
  secondsLeft: number;
  pausedReason: string | null;
  backoffUntil: number | null;
  backoffReason: string | null;
}

export interface AudioStage4Status {
  available: boolean;
  waiting: string | null;
  fetcher: { online: boolean; version: string | null; lastSeenAt: number | null } | null;
  progress: AudioStage4Progress | null;
  units: Record<string, number>;
  sites: AudioSiteLine[];
  secondsLeft: number | null;
  ratios: string;
  counts: Record<string, number> | null;
}

export interface AudioOnlineRecordBrief {
  title: string;
  authors: string[];
  narrators: string[];
  seconds: number | null;
  publisher: string | null;
  releaseDate: string | null;
  series: { name: string; sequence: string | null; sort: string | null }[];
}

export interface AudioOnlineCheck {
  ok: boolean;
  unknown?: boolean;
  file: unknown;
  store: unknown;
  detail?: string;
}

export interface AudioOnlineItem {
  id: number;
  name: string;
  seconds: number | null;
  labeled: boolean;
  kind: string;
  state: string;
  class: string | null;
  source: string | null;
  storeId: string | null;
  reason: string | null;
  detail: string | null;
  error: string | null;
  copies: number;
  file: {
    title: string;
    authors: string[];
    narrators: string[];
    volume: string | null;
    drama: { number: string | null } | null;
    seconds: number | null;
    files: number;
    paths: string[];
    asins: string[];
    absAsins: string[];
    queries: string[];
  };
  record: AudioOnlineRecordBrief | null;
  candidates: {
    source: string;
    storeId: string;
    via: string;
    verdict: string;
    sampleScore: number | null;
    checks: Record<string, AudioOnlineCheck>;
    record: AudioOnlineRecordBrief | null;
  }[];
}

export type AudioStage3Phase =
  | 'copies'
  | 'candidates'
  | 'fingerprints'
  | 'compare'
  | 'decode'
  | 'verify'
  | 'decide'
  | 'done';

export interface AudioGateResult {
  passed: boolean;
  checked: number;
  correct: number;
  sameChecked: number;
  sameCorrect: number;
  bestChecked: number;
  bestCorrect: number;
  skipped: number;
  misses: { n: number; kind: string; expected: string; got: string; ok: boolean; note?: string }[];
  error: string | null;
}

export interface AudioStage3Progress {
  analysisId: string;
  phase: AudioStage3Phase;
  startedAt: number;
  finishedAt: number | null;
  copies: number;
  excluded: number;
  pairsByTest: Record<string, number>;
  windowsTotal: number;
  windowsDone: number;
  windowsReused: number;
  windowErrors: number;
  decodesDone: number;
  decodesReused: number;
  /** Missing on a server before the progress fix. */
  decodesLeft?: number;
  decodeAudioLeft?: number;
  decodeAudioDone?: number;
  decodeRateFrom?: { at: number; audio: number } | null;
  compareDone?: number;
  compareTotal?: number;
  /** The frame-by-frame step (missing on a server before it). */
  verifyDone?: number;
  verifyLeft?: number;
  verifyRateFrom?: { at: number; done: number } | null;
  yields: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  phaseTimes: Record<string, { ms: number; items: number }>;
  tools: { fpcalc: string | null; faad: string | null; ffmpeg: string | null } | null;
  counts: Record<string, number> | null;
  gate: AudioGateResult | null;
  error: string | null;
}

/** One copy of a recording, as the review page shows it (WP21b). */
export interface AudioDupCopy {
  id: number;
  key: string;
  kind: 'file' | 'parts' | 'library_only';
  name: string;
  paths: string[];
  files: number;
  seconds: number | null;
  codec: string | null;
  bitrate: number | null;
  sampleRate: number | null;
  chapters: number;
  cover: boolean;
  asins: string[];
  absAsins: string[];
  ai: boolean;
  damage: 'damaged' | 'suspect' | 'ok' | null;
  damageDetail: string | null;
  excluded: string | null;
  rank?: number;
  role?: 'keep' | 'drop' | 'review';
}

export interface AudioWindowScore {
  name: 'start' | 'middle' | 'end';
  score: number | null;
  shiftSeconds: number | null;
  reason?: string;
}

export interface AudioDupPair {
  a_id: number;
  b_id: number;
  test: string;
  verdict: string;
  fp_verdict: string | null;
  length_diff: number | null;
  detail: string | null;
  scores: { windows: AudioWindowScore[]; skipped: { name: string; reason: string }[] } | null;
}

export interface AudioDupGroup {
  id: number;
  groupKey: string;
  kind: 'group' | 'unsure';
  firstTest: string;
  tests: string[];
  rule: string | null;
  outcome: 'auto' | 'review';
  reviewReason: string | null;
  damaged: boolean;
  bestCopyId: number | null;
  decision: { decision: string; decided_by: string; decided_at: number } | null;
  copies: AudioDupCopy[];
  pairs: AudioDupPair[];
}

/** Rows of the 'different' list: pairs measured as different recordings. */
export interface AudioDupDifferent {
  id: number;
  test: string;
  verdict: string;
  lengthDiff: number | null;
  detail: string | null;
  scores: AudioDupPair['scores'];
  copies: AudioDupCopy[];
}

export interface AudioFileRow {
  id: number;
  root: 'torrents' | 'library';
  rel_path: string;
  decoded_path: string | null;
  raw_name: number;
  size: number;
  ext: string;
  nlink: number;
  class?: string;
  detail?: string | null;
  originals?: { root: string; rel_path: string }[];
  format?: string | null;
  codec?: string | null;
  duration?: number | null;
  error?: string | null;
  decode_error?: string | null;
}

export interface AudioBookRow {
  id: number;
  root: 'torrents' | 'library';
  unit_rel_path: string;
  unit_kind: 'folder' | 'file';
  source: string;
  name_raw: string;
  name_decoded: string | null;
  file_count: number;
  total_seconds: number | null;
  multi_class: string | null;
  class_reason: string | null;
  files: {
    rel_path: string;
    size: number;
    duration: number | null;
    format: string | null;
    codec: string | null;
    chapter_count: number | null;
  }[];
}

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

  // ---------------------------------------------------------------- stage 4 (WP20d)

  stage4Proposals({
    field,
    cls,
    source,
    offset = 0,
    limit = 50
  }: {
    field?: string;
    cls?: string;
    source?: string;
    offset?: number;
    limit?: number;
  } = {}): Promise<{
    total: number;
    items: Stage4Proposal[];
  }> {
    const q = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (field) q.set('field', field);
    if (cls) q.set('class', cls);
    if (source) q.set('source', source);
    return this.request('GET', `/cleanup/stage4/proposals?${q}`) as Promise<{
      total: number;
      items: Stage4Proposal[];
    }>;
  }

  /** The Best guesses list: series (each whole, in order) or books outside a series. */
  stage4GuessSeries(
    offset = 0,
    limit = 20
  ): Promise<{ total: number; series: Stage4GuessSeries[] }> {
    const q = new URLSearchParams({ kind: 'series', offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/stage4/guesses?${q}`) as Promise<{
      total: number;
      series: Stage4GuessSeries[];
    }>;
  }

  stage4GuessOther(offset = 0, limit = 20): Promise<{ total: number; books: Stage4GuessOther[] }> {
    const q = new URLSearchParams({ kind: 'other', offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/stage4/guesses?${q}`) as Promise<{
      total: number;
      books: Stage4GuessOther[];
    }>;
  }

  stage4Readings(state = '', offset = 0): Promise<{ total: number; items: AuthorReading[] }> {
    const q = new URLSearchParams({ offset: String(offset) });
    if (state) q.set('state', state);
    return this.request('GET', `/cleanup/stage4/readings?${q}`) as Promise<{
      total: number;
      items: AuthorReading[];
    }>;
  }

  resumeSite(site: string): Promise<unknown> {
    return this.request('POST', `/cleanup/stage4/sites/${encodeURIComponent(site)}/resume`);
  }

  retrySite(site: string): Promise<{ retried: { requests: number; books: number } }> {
    return this.request(
      'POST',
      `/cleanup/stage4/sites/${encodeURIComponent(site)}/retry`
    ) as Promise<{
      retried: { requests: number; books: number };
    }>;
  }

  /** Stage 4's AI questions that were given up, asked again. */
  askAiAgain(): Promise<{ questions: number }> {
    return this.request('POST', '/cleanup/stage4/ai/ask-again') as Promise<{ questions: number }>;
  }

  /** Stage 4's books whose changes were all undone (the test batches), proposed again (WP20f). */
  reproposeStage4Undone(): Promise<{ books: number }> {
    return this.request('POST', '/cleanup/stage4/repropose-undone') as Promise<{ books: number }>;
  }

  // ---------------------------------------------------------------- stage 5 (WP20f)

  stage5Proposals({
    state = 'proposed',
    outside,
    offset = 0,
    limit = 50
  }: { state?: string; outside?: boolean; offset?: number; limit?: number } = {}): Promise<{
    total: number;
    rows: Stage5Proposal[];
  }> {
    const q = new URLSearchParams({ state, offset: String(offset), limit: String(limit) });
    if (outside !== undefined) q.set('outside', outside ? '1' : '0');
    return this.request('GET', `/cleanup/stage5/proposals?${q}`) as Promise<{
      total: number;
      rows: Stage5Proposal[];
    }>;
  }

  /** Stage 5's AI questions that were given up, asked again. */
  askStage5AiAgain(): Promise<{ questions: number }> {
    return this.request('POST', '/cleanup/stage5/ai/ask-again') as Promise<{ questions: number }>;
  }

  // ---------------------------------------------------------------- audiobooks (WP21a)

  audioStatus(): Promise<AudioStatus> {
    return this.request('GET', '/cleanup/audio/status') as Promise<AudioStatus>;
  }

  setAudioStageMode(stage: number, mode: AudioStageMode | 'on'): Promise<AudioStatus> {
    return this.request('PUT', `/cleanup/audio/stages/${stage}`, { mode }) as Promise<AudioStatus>;
  }

  audioAnalyseAgain(stage: number): Promise<AudioStatus> {
    return this.request(
      'POST',
      `/cleanup/audio/stages/${stage}/analyse`,
      {}
    ) as Promise<AudioStatus>;
  }

  takeAbsSnapshot(): Promise<AudioStatus> {
    return this.request('POST', '/cleanup/audio/abs-snapshots', {}) as Promise<AudioStatus>;
  }

  absSnapshot(id: number): Promise<AbsSnapshot> {
    return this.request('GET', `/cleanup/audio/abs-snapshots/${id}`) as Promise<AbsSnapshot>;
  }

  /** The snapshot as a file to save (JSON, or the progress list as CSV). */
  async absSnapshotFile(id: number, format: 'json' | 'csv'): Promise<Blob> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/cleanup/audio/abs-snapshots/${id}.${format}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.blob();
  }

  audioFiles(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: AudioFileRow[] }> {
    const q = new URLSearchParams({ list, offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/audio/files?${q}`) as Promise<{
      total: number;
      items: AudioFileRow[];
    }>;
  }

  audioBooks(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: AudioBookRow[] }> {
    const q = new URLSearchParams({ list, offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/audio/books?${q}`) as Promise<{
      total: number;
      items: AudioBookRow[];
    }>;
  }

  // ---------------------------------------------------------------- audiobooks stage 3 (WP21b)

  audioDups(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: Record<string, unknown>[] }> {
    const q = new URLSearchParams({ list, offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/audio/dups?${q}`) as Promise<{
      total: number;
      items: Record<string, unknown>[];
    }>;
  }

  /** Records a choice for a group: keep_all, keep:<copy key>, or clear (WP21e applies it). */
  decideAudioDup(id: number, decision: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/cleanup/audio/dups/${id}`, { decision }) as Promise<{
      ok: boolean;
    }>;
  }

  /**
   * A few seconds from the start or the end of a copy (mp3). Null while the Calibre cleanup uses
   * the disk (the server answers 503: try again in a moment).
   */
  async audioClip(copyId: number, at: 'start' | 'end'): Promise<Blob | null> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/cleanup/audio/clip/${copyId}/${at}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (response.status === 503) return null;
    if (!response.ok) throw await errorFrom(response);
    return response.blob();
  }

  // ---------------------------------------------------------------- audiobooks stage 4 (WP21c)

  audioOnline(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: AudioOnlineItem[] | AudioOnlineGateBook[] }> {
    const q = new URLSearchParams({ list, offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/audio/online?${q}`) as Promise<{
      total: number;
      items: AudioOnlineItem[] | AudioOnlineGateBook[];
    }>;
  }

  /** "Ask again": an audiobook site's given-up requests go back to the queue. */
  retryAudioSite(site: string): Promise<{ requests: number; units: number }> {
    return this.request(
      'POST',
      `/cleanup/audio/online/sites/${encodeURIComponent(site)}/retry`,
      {}
    ) as Promise<{ requests: number; units: number }>;
  }

  // ---------------------------------------------------------------- stage 6 (WP21e-1)

  audioBuild(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: Record<string, unknown>[] }> {
    const q = new URLSearchParams({ list, offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/audio/build?${q}`) as Promise<{
      total: number;
      items: Record<string, unknown>[];
    }>;
  }

  async audioBuildFile(file: 'moves.csv' | 'plan.csv'): Promise<Blob> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/cleanup/audio/build/${file}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.blob();
  }

  audioBuildCheckAgain(): Promise<AudioStatus> {
    return this.request('POST', '/cleanup/audio/build/check-again', {}) as Promise<AudioStatus>;
  }

  // ---------------------------------------------------------------- stage 7 (WP21f-1)

  audioArrivals(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: Record<string, unknown>[] }> {
    const q = new URLSearchParams({ list, offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/audio/arrivals?${q}`) as Promise<{
      total: number;
      items: Record<string, unknown>[];
    }>;
  }

  /** WP21f-2: a review choice for a book of the library changes (applied at the next run). */
  audioLibraryChoice(bookId: number, field: string, choice: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/cleanup/audio/library-changes/${bookId}/choice`, {
      field,
      choice
    }) as Promise<{ ok: boolean }>;
  }

  audioArrivalsDecide(reviewId: number, decision: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/cleanup/audio/arrivals/reviews/${reviewId}`, {
      decision
    }) as Promise<{ ok: boolean }>;
  }

  audioArrivalsResume(): Promise<AudioStatus> {
    return this.request('POST', '/cleanup/audio/arrivals/resume', {}) as Promise<AudioStatus>;
  }

  async audioArrivalsPlanFile(): Promise<Blob> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/cleanup/audio/arrivals/plan.csv`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.blob();
  }

  // ---------------------------------------------------------------- the switch (WP21e-2)

  audioSwitchStart(action: SwitchAction): Promise<AudioStatus> {
    return this.request('POST', '/cleanup/audio/switch/start', { action }) as Promise<AudioStatus>;
  }

  audioSwitchResume(): Promise<AudioStatus> {
    return this.request('POST', '/cleanup/audio/switch/resume', {}) as Promise<AudioStatus>;
  }

  audioSwitchCancel(): Promise<AudioStatus> {
    return this.request('POST', '/cleanup/audio/switch/cancel', {}) as Promise<AudioStatus>;
  }

  audioCovers(action: 'start' | 'resume'): Promise<AudioStatus> {
    return this.request('POST', '/cleanup/audio/switch/covers', { action }) as Promise<AudioStatus>;
  }

  async audioSwitchLinksCsv(): Promise<Blob> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/cleanup/audio/switch/links.csv`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.blob();
  }

  // ---------------------------------------------------------------- stage 5 and the AI (WP21d)

  audioMeta(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: AudioMetaItem[] }> {
    const q = new URLSearchParams({ list, offset: String(offset), limit: String(limit) });
    return this.request('GET', `/cleanup/audio/meta?${q}`) as Promise<{
      total: number;
      items: AudioMetaItem[];
    }>;
  }

  aiStatus(): Promise<AiStatus> {
    return this.request('GET', '/cleanup/ai/status') as Promise<AiStatus>;
  }

  // ---------------------------------------------------------------- new arrivals (WP20g)

  arrivals(): Promise<ArrivalsStatus> {
    return this.request('GET', '/cleanup/arrivals') as Promise<ArrivalsStatus>;
  }

  setArrivalsMode(mode: 'off' | 'analyse' | 'on'): Promise<ArrivalsStatus> {
    return this.request('PUT', '/cleanup/arrivals/mode', { mode }) as Promise<ArrivalsStatus>;
  }

  arrivalsRunNow(): Promise<ArrivalsStatus> {
    return this.request('POST', '/cleanup/arrivals/run-now', {}) as Promise<ArrivalsStatus>;
  }

  arrivalsStop(): Promise<ArrivalsStatus> {
    return this.request('POST', '/cleanup/arrivals/stop', {}) as Promise<ArrivalsStatus>;
  }

  arrivalsResume(): Promise<ArrivalsStatus> {
    return this.request('POST', '/cleanup/arrivals/resume', {}) as Promise<ArrivalsStatus>;
  }

  arrivalsList(
    list: string,
    offset = 0,
    limit = 50
  ): Promise<{ total: number; items: Record<string, unknown>[] }> {
    const q = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.request(
      'GET',
      `/cleanup/arrivals/lists/${encodeURIComponent(list)}?${q}`
    ) as Promise<{
      total: number;
      items: Record<string, unknown>[];
    }>;
  }

  arrivalsDecide(reviewId: number, decision: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/cleanup/arrivals/reviews/${reviewId}`, {
      decision
    }) as Promise<{ ok: boolean }>;
  }

  arrivalsUndo(batchId: number): Promise<{ undo: number }> {
    return this.request('POST', `/cleanup/arrivals/batches/${batchId}/undo`, {}) as Promise<{
      undo: number;
    }>;
  }

  async arrivalsNotImportedFile(): Promise<Blob> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/cleanup/arrivals/not-imported.csv`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.blob();
  }

  spotCheck(stage = 1): Promise<{ items: Proposal[] }> {
    return this.request('GET', `/cleanup/spot-check?stage=${stage}`) as Promise<{
      items: Proposal[];
    }>;
  }
}
