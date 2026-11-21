/**
 * The cleanup's settings (edited on /cleanup, stored in cleanup.db). Every behavior
 * threshold is a setting (CLAUDE.md); defaults are here. Bad values are refused with a
 * message, never silently clamped.
 *
 * Settings are shared by every stage (decided with the user 2026-11-14): one pacing, one gate
 * with per-field exceptions, one cover group, one set of safety thresholds. A later stage adds
 * a field exception or a group about a thing (covers, sources), never a copy per stage.
 * Values stored in the earlier per-stage shape are carried over when read (`fromLegacy`).
 */
import type Database from 'better-sqlite3';
import { DEFAULT_DUPLICATE_SETTINGS, type DuplicateSettings } from './stage3-rules';

export interface PacingSettings {
  /** How fast an analysis reads book files (MB/s); 0 = no limit. */
  readMbPerSecond: number;
  /** Pause between two items in the sidecar (seconds). */
  itemDelaySeconds: number;
  /** Items per batch (copies for removals, books for metadata; at most 500). */
  batchSize: number;
  /** Items per batch as a share of the library's present books (%), far under the reader's
   * 20 % mass-missing guard. */
  maxBatchPercent: number;
  /** Books the sidecar looks up in Calibre with one call (before and after its writes). */
  lookupChunk: number;
}

/** The check on the labeled books, for every stage and field. */
export interface GateSettings {
  /** A field must be right on the labeled books at least this often (%). */
  defaultPercent: number;
  /** Stage 2's fields with their own bar (decided: titles 85 % for stage 2's file titles). */
  fieldPercent: Record<string, number>;
  /** Stage 4's fields with their own bar; a field not listed uses the shared bar (WP20d). */
  stage4Percent: Record<string, number>;
  /** Titles from the file must also be this many points better than Calibre's current ones. */
  marginPoints: number;
  /** A group with fewer labeled books than this is shown but not checked. */
  minBooks: number;
  /** The labeled books (gold800.json); empty = <DB_DIR>/cleanup/reference-sample/gold800.json. */
  labeledBooksFile: string;
  /**
   * Stage 3: the measured duplicate pairs with their expected classes; empty =
   * <DB_DIR>/cleanup/reference-sample/stage3-pairs.json.
   */
  duplicatePairsFile: string;
  /**
   * Audiobooks stage 3: the labeled pairs (labels.json); empty =
   * <DB_DIR>/cleanup/reference-sample/audio/labels.json.
   */
  audiobookPairsFile: string;
  /**
   * Audiobooks stage 5 (WP21d): a field's automatic values (the rules', or both models agreeing)
   * must be right on the labeled books at least this often (%).
   */
  audiobookMetaPercent: number;
  /**
   * Stage 5 (WP20f): the genre test's blind labels (genre-labels.json); empty =
   * <DB_DIR>/cleanup/reference-sample/genre-labels.json.
   */
  genreLabelsFile: string;
  /** Stage 5's bars on those labels (%): right share and found share, genres and tags apart. */
  stage5: { genresRight: number; tagsRight: number; genresFound: number; tagsFound: number };
}

export interface CoverSettings {
  /** Covers up to this size (MB) are handed to Calibre unchanged (JPEG/PNG). */
  maxMb: number;
  /** Covers longer than this (px) on their longest side are scaled down (JPEG). */
  maxSide: number;
  /** Two covers within this difference-hash distance are the same picture. */
  sameDistance: number;
  /** A cover counts as larger when its longest side is at least this much bigger (%). */
  largerPercent: number;
}

/** The audiobook cleanup (WP21a). Audiobookshelf is only read. */
export interface AudiobookSettings {
  /** Audiobookshelf's address as the storage server reaches it, e.g. http://192.168.1.5:13378. */
  absUrl: string;
  /**
   * WP21e-2: where Audiobookshelf sees media/audiobooks (its container's path; the old library
   * was on `/audiobooks/japanese`). The switch and the covers compare its libraries' folders
   * against `<this>/japanese` etc. as whole paths (a podcasts library on /podcasts/japanese is
   * not one of them: found live 2026-11-20).
   */
  absMediaFolder: string;
  /** Stage 1: how fast files are hashed (MB/s); 0 = no limit (it holds the disk lock alone). */
  readMbPerSecond: number;
  /**
   * Stage 2: files checked at the same time. While a Calibre job uses the disk, stage 2 waits
   * (it doesn't check slowly: even listing the folders slowed Calibre stage 3 down 3-4x).
   */
  healthWorkers: number;
  /** Stage 2: seconds decoded at the start and at the end of every file. */
  decodeSeconds: number;
  /** Stage 2: time limit for one ffprobe or ffmpeg run (s). */
  toolTimeoutSeconds: number;
  /** A folder's files look like full copies when each is at least this long (minutes) ... */
  copyHintMinMinutes: number;
  /** ... and their lengths are within this share of the longest (%). */
  copyHintPercent: number;
  /**
   * Files of one folder that are each at least this long (minutes) are separate books; shorter
   * files are parts of one book (stage 2; measured: every multi-file folder is all one or all
   * the other at 2 h).
   */
  fullBookMinutes: number;
  /** Time limit for one request to Audiobookshelf (s). */
  absTimeoutSeconds: number;
  /** Stage 3 (WP21b): length of each compared window (s). */
  dupWindowSeconds: number;
  /** Stage 3: how far two copies may be shifted at their start and at their end (s). */
  dupShiftSeconds: number;
  /** Stage 3: the middle window searches at most this much of the other copy (minutes). */
  dupMiddleSearchMinutes: number;
  /** Stage 3: a window counts as the same recording at this score or above (0-1). */
  dupSameScore: number;
  /** Stage 3: same title and volume are compared when the lengths are within this (%). */
  dupCandidatePercent: number;
  /** Stage 3: same ASIN counts as the same recording when the lengths are within this (s). */
  dupAsinToleranceSeconds: number;
  /** Stage 3: lengths this close count as equal (s). */
  dupLengthEqualSeconds: number;
  /** Stage 3: a copy this much shorter than its twin is incomplete (rule 0; s). */
  dupIncompleteSeconds: number;
  /** Stage 3: bitrates within this share count as equal (rule 5; %). */
  dupBitrateMarginPercent: number;
  /** Stage 3: chapters within this length count as the same (rule 1; s). */
  dupChapterToleranceSeconds: number;
  /** Stage 3: windows fingerprinted at the same time (small reads; wait while Calibre reads). */
  dupFingerprintWorkers: number;
  /** Stage 3: full decodes at the same time (they hold the shared disk lock). */
  dupDecodeWorkers: number;
  /** Stage 3: seconds played from the start or the end of a copy on the review page. */
  dupClipSeconds: number;
  /**
   * Stage 3: extra audio at most this long at the very start or end of the longer copy can be
   * Audible's opening and closing (checked against other books before it counts).
   */
  dupBrandingMaxSeconds: number;
  /** Stage 3: the extra audio is the same opening/closing as other books' at this score. */
  dupBrandingScore: number;
  /**
   * Stage 3: a copy counts as damaged when a player reports more than this many bad frames
   * (a few at the very start or end can't be heard: user, 2026-11-18).
   */
  dupNoticeableErrors: number;
  /**
   * Stage 4 (WP21c): a store record's length agrees with the recording within this many
   * minutes (Audible gives whole minutes; the sample's confirmed matches were within 1-2).
   */
  onlineRuntimeMinutes: number;
  /** Stage 4: the titles agree at this share of the file title's character pairs (0-1). */
  onlineTitleScore: number;
  /**
   * Stage 4: one title inside the other (or the pair share) counts only when the shorter has at
   * least this many characters (cleaned)... (WP21c follow-up (2): "audio" agreed with
   * "Académie de trading : Leçons audio").
   */
  onlineTitleMinChars: number;
  /** ...and at least this share of the longer title's characters (0-1). */
  onlineTitleMinShare: number;
  /** Stage 4: Audible search hits whose full record is fetched (per search). */
  onlineSearchProducts: number;
  /** Stage 4: kikubon and audiobook.jp product pages read per search (title agreeing only). */
  onlineStorePages: number;
  /** Stage 4: seconds of a recording's opening compared with the stores' sample audio. */
  onlineOpeningSeconds: number;
  /**
   * Stage 4: folders under the torrents whose recordings have no store record by nature (the
   * radio bonus clips; user, 2026-11-18): looked up nowhere. AI books never are either.
   */
  noStoreRecordFolders: string[];
  /**
   * Stage 5 (WP21d): 複数ナレーター when the chosen record lists at least this many narrators
   * (measured on the labeled books: every book with 2 or more is labeled multi-narrator).
   */
  multiNarratorMin: number;
  /** Stage 6 (WP21e-1): links, folders and metadata files the linking sidecar makes per batch. */
  buildBatchOps: number;
  /** Stage 6: source files the sidecar checks per preflight batch (read only). */
  buildPreflightOps: number;
  /** Stage 6: seconds the sidecar has for a batch before it is handed out again. */
  buildLeaseSeconds: number;
  /** Stage 6's check: linked files read again and compared with stage 1's SHA-256. */
  buildRehashSample: number;
  /** The switch (WP21e-2): seconds the sidecar has for a batch before it is handed out again. */
  switchLeaseSeconds: number;
  /** Deleting japanese-old (WP21e-2): entries the sidecar removes per batch. */
  deleteBatchOps: number;
  /** Covers (WP21e-2): milliseconds between two covers set through Audiobookshelf's API. */
  coverPaceMs: number;
  /**
   * Stage 7 (WP21f-1): the daily run's time of day (HH:MM in the server's time zone). It never
   * starts inside the backup window below (CA Appdata Backup stops ttsu-storage at 00:00).
   */
  arrivalsTime: string;
  /** Stage 7: no run starts from this time (HH:MM) ... */
  arrivalsQuietStart: string;
  /** ... until this time (HH:MM; may be after midnight). */
  arrivalsQuietEnd: string;
  /**
   * Stage 7: the time zone of the three times above (IANA name, e.g. America/Los_Angeles); empty:
   * the server's (its TZ, UTC when the container has none). The backup runs at 00:00 NAS time.
   */
  arrivalsTimeZone: string;
  /** Stage 7: a file counts once its size and mtime have been unchanged this long (minutes). */
  arrivalsSettleMinutes: number;
  /** Stage 7: how long to wait for Audiobookshelf to show a new book (minutes). */
  arrivalsAbsWaitMinutes: number;
  /**
   * Stage 7: when Audiobookshelf hasn't shown a new book after the wait, tell it the new folder
   * (its watcher API, one folder; no setting is changed). Off until stop 3 shows it is needed
   * (user, 2026-11-20).
   */
  arrivalsAbsNudge: boolean;
  /** Stage 7: seconds the sidecar has to unpack one archive entry before it is handed out again. */
  extractLeaseSeconds: number;
  /**
   * Stage 7 (WP21f-2): changes to books already in the library (metadata.json, folders, link
   * names, reader-written files' originals). Its own mode, so a stage 7 that is On adds new books
   * while these stay a Preview until approved (user, 2026-11-21): off | analyse (Preview) | on.
   */
  libraryChanges: 'off' | 'analyse' | 'on';
}

/** A model's list price per million tokens (US$). */
export interface AiPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * The cleanup's AI models (WP21d, shared by every stage that asks them: the audiobook stage 5,
 * later the Calibre stage 4 of WP20e). Nothing is asked while the spending limit is not set.
 */
export interface AiSettings {
  /** All AI spending of the cleanup may reach this (US$); null = not set (nothing is asked). */
  spendLimitUsd: number | null;
  /**
   * Per model id: batch = its provider's Batch API (half price, answered when the provider runs
   * it); direct = one call each (full price, answered at once). A model not listed: batch.
   * Measured 2026-11-19: Anthropic answered a batch of 195 questions for claude-haiku-5-5 in 2 min;
   * OpenAI ran no batch for gpt-6-luna (six batches, none answered in 15-75 min, on both of its
   * endpoints) while a gpt-6.1-sol batch finished in 80 s and Luna answers one call in ~7 s.
   */
  modes: Record<string, 'batch' | 'direct'>;
  /**
   * A batch with nothing answered after this many minutes is cancelled (answers it has are kept)
   * and its questions are sent directly. 0 = wait for the provider (up to its 24 h).
   */
  batchStallMinutes: number;
  /**
   * How long one address may take to connect before the next is tried (ms). Node's default,
   * 250, failed every call from the live server on 2026-11-19: the NAS's DNS answers with IPv6
   * addresses it has no route to, so the IPv4 attempt was cut off after 250 ms (the busy
   * server took longer) and the IPv6 one failed at once. Process-wide while the AI is used.
   */
  connectAttemptMs: number;
  /** Time left before a stage has a batch back: the expected batch turnaround (minutes). */
  batchTurnaroundMinutes: number;
  /** Direct mode: calls at the same time per model. */
  directWorkers: number;
  /** Batch mode: requests per batch. */
  batchSize: number;
  /** Batch mode: how often a batch at the provider is checked (s). */
  batchPollSeconds: number;
  /** Claude: max_tokens, which includes the adaptive thinking (leave room). */
  maxTokens: number;
  /** Direct mode: time limit for one call (s). */
  requestTimeoutSeconds: number;
  /** Busy (429), server errors and network errors are tried this many times in all. */
  attempts: number;
  /** The Batch APIs' price as a share of the list price. */
  batchPriceFactor: number;
  /** List prices per model id (models not listed are refused: their cost can't be counted). */
  prices: Record<string, AiPrice>;
  /** Ask for the answer in the stage's JSON schema (the providers' structured outputs). */
  structuredOutputs: boolean;
  /**
   * Ask the models only about the labeled books (the gate's check before a library run); the
   * other items are decided by the rules alone, with every open field flagged.
   */
  labeledOnly: boolean;
  /**
   * WP21f-1: the setup the daily new arrivals are decided with (default J: E, then the stronger
   * pair re-checks what E decided or guessed; user, 2026-11-17).
   */
  arrivalsDesign: 'E' | 'F' | 'J';
  /**
   * WP21f-1: a library-wide F or J upgrade also re-checks values already decided by that design
   * or a stronger one (the new arrivals decided with J). Off: they are skipped.
   */
  upgradeIncludeDecided: boolean;
}

/** The shortest interval a site can be set to (seconds; Sudachi runs locally and has none). */
export const MIN_INTERVAL_SECONDS = 0.25;
/** The most requests one site may have in flight at once. */
export const MAX_IN_FLIGHT = 4;

/** One site's queue in the fetch container (WP20d). */
export interface FetchSiteSettings {
  enabled: boolean;
  /** Seconds from the start of one request to the start of the next on this queue. */
  intervalSeconds: number;
  /**
   * Requests of this site in flight at once (1-4, for every site: the user's choice, 2026-11-19).
   * A site answering in about a second can't go faster than one request a second with one in
   * flight, whatever its interval (found 2026-11-19: Bookmeter at 1 s ran at 1.3 s). The pace
   * between starts holds either way (Amazon's shared slot included).
   */
  inFlight: number;
}

/**
 * Stage 4's online lookups (WP20d, plan section 6). The fetch container runs through gluetun; the
 * server hands out one request per site when its pace allows. Every threshold is a setting.
 */
export interface FetchSettings {
  sites: Record<string, FetchSiteSettings>;
  /**
   * Amazon's product pages and Kindle searches: one shared slot ('shared', the reference run's
   * rate), each its own pace ('separate'), or 'trial': the labeled books' first half shared, the
   * second half separate, to measure which is faster without more challenge pages.
   */
  amazonPace: 'shared' | 'separate' | 'trial';
  /** A challenge page backs off Amazon this long first (s), doubling up to the longest (s). */
  challengeBackoffSeconds: number;
  challengeBackoffMaxSeconds: number;
  /** This many challenge pages in a row pause the site until resumed on the page. */
  challengePauseAfter: number;
  /** Slow Amazon down (interval x 1.5) while challenges in the last N requests exceed this share (%). */
  slowDownPercent: number;
  slowDownWindow: number;
  /** A failed request (network, busy) is asked again after this long (s), doubling. */
  retrySeconds: number;
  /** A request is given up after this many attempts (it can be asked again later). */
  maxAttempts: number;
  /** A claimed request goes back to the queue when the fetcher hasn't answered in this time (s). */
  leaseSeconds: number;
  /** The fetcher's time limit for one request (s). */
  requestTimeoutSeconds: number;
  /** Largest answer kept (MB). */
  maxPageMb: number;
  /** Names per NDL query (NDL allows 1,000 result rows per query). */
  ndlNamesPerQuery: number;
  /** NDL's daily outage (from about 4:00 JST): no queries from this time (JST, HH:MM) ... */
  ndlOutageStartJst: string;
  /** ... for this long (minutes). */
  ndlOutageMinutes: number;
  /** Natively's sitemap is read again after this many days (new books). */
  nativelyRereadDays: number;
  /** A file cover whose longer side is under this (px) counts as small (store image looked up). */
  smallCoverPx: number;
  /** The fetcher counts as offline after this long without a heartbeat (s). */
  offlineSeconds: number;
}

/** The Calibre cleanup's sites (WP20d): its stage-4 card and its lookups use only these. */
export const CALIBRE_FETCH_SITES = [
  'amazon-dp',
  'amazon-search',
  'amazon-img',
  'ranobedb',
  'bookwalker',
  'bookmeter',
  'natively',
  'ndl',
  'sudachi',
] as const;
/** The audiobook cleanup's sites (WP21c): Audible, kikubon, audiobook.jp and their samples. */
export const AUDIO_FETCH_SITES = [
  'audible',
  'audible-sample',
  'kikubon',
  'audiobookjp',
  'audiobookjp-sample',
] as const;
export const FETCH_SITES = [...CALIBRE_FETCH_SITES, ...AUDIO_FETCH_SITES] as const;
export type FetchSite = (typeof FETCH_SITES)[number];
export type CalibreFetchSite = (typeof CALIBRE_FETCH_SITES)[number];
export type AudioFetchSite = (typeof AUDIO_FETCH_SITES)[number];

export interface BackupRecord {
  path: string;
  /** When the backup was verified (free text date, e.g. 2026-11-12). */
  verifiedOn: string;
  /** Set when the user ticked "the full library backup is done". */
  confirmedAt: number | null;
}

export interface CleanupSettings {
  /** The content server, e.g. http://192.168.1.5:8083 (the sidecar adds #<library id>). */
  contentServerUrl: string;
  calibreLibraryId: string;
  calibreUsername: string;
  /** The reader library (id) the cleanup works on; null = not chosen. */
  targetLibraryId: string | null;
  /** Model per task (stored only in WP20a; used from WP20e). */
  models: Record<string, string>;
  pacing: PacingSettings;
  /** The user's own Calibre tags (a trailing * matches any ending). */
  customTags: string[];
  gate: GateSettings;
  /** A field pauses when its share of review results is this many points above the labeled books'. */
  reviewAlarmPercent: number;
  /**
   * A stage pauses (instead of skipping items one by one) when more than this share of the
   * next batch changed in Calibre since the analysis (%).
   */
  libraryChangedPausePercent: number;
  /**
   * A batch pauses its stage only when more than this share of its items failed (%); fewer
   * failed items are listed in the batch and the run goes on. 0 = any failure pauses.
   */
  failedPausePercent: number;
  covers: CoverSettings;
  /** Stage 3: content duplicates (thresholds of plan section 5). */
  duplicates: DuplicateSettings;
  /** The audiobook cleanup (WP21a). */
  audiobooks: AudiobookSettings;
  /** Stage 4's online lookups (WP20d). */
  fetch: FetchSettings;
  /** The AI models (WP21d). */
  ai: AiSettings;
  backup: BackupRecord;
}

export const MODEL_TASKS = [
  'stage4.primary',
  'stage4.secondary',
  'stage4.upgradePrimary',
  'stage4.upgradeSecondary',
  'stage5.primary',
  'stage5.secondary',
  // The audiobook cleanup's stage 5 (WP21d).
  'audio5.primary',
  'audio5.secondary',
  'audio5.upgradePrimary',
  'audio5.upgradeSecondary',
] as const;

export const DEFAULT_SETTINGS: CleanupSettings = {
  contentServerUrl: '',
  calibreLibraryId: '',
  calibreUsername: '',
  targetLibraryId: null,
  models: {
    'stage4.primary': 'claude-haiku-5-5',
    'stage4.secondary': 'gpt-6-luna',
    'stage4.upgradePrimary': 'claude-sonnet-5-5',
    'stage4.upgradeSecondary': 'gpt-6.1-sol',
    'stage5.primary': 'claude-haiku-5-5',
    'stage5.secondary': 'gpt-6-luna',
    'audio5.primary': 'claude-haiku-5-5',
    'audio5.secondary': 'gpt-6-luna',
    'audio5.upgradePrimary': 'claude-sonnet-5-5',
    'audio5.upgradeSecondary': 'gpt-6.1-sol',
  },
  pacing: {
    readMbPerSecond: 40,
    itemDelaySeconds: 0,
    batchSize: 500,
    maxBatchPercent: 2,
    lookupChunk: 25,
  },
  customTags: ['PeepoHappyBooks', 'alpindale', 'TMW-collection-*'],
  gate: {
    defaultPercent: 95,
    fieldPercent: { title: 85 },
    stage4Percent: {},
    marginPoints: 20,
    minBooks: 20,
    labeledBooksFile: '',
    duplicatePairsFile: '',
    audiobookPairsFile: '',
    audiobookMetaPercent: 95,
    genreLabelsFile: '',
    stage5: { genresRight: 95, tagsRight: 95, genresFound: 85, tagsFound: 70 },
  },
  reviewAlarmPercent: 5,
  libraryChangedPausePercent: 5,
  failedPausePercent: 1,
  covers: { maxMb: 10, maxSide: 4096, sameDistance: 5, largerPercent: 10 },
  duplicates: { ...DEFAULT_DUPLICATE_SETTINGS },
  audiobooks: {
    absUrl: '',
    absMediaFolder: '/audiobooks',
    readMbPerSecond: 0,
    healthWorkers: 4,
    decodeSeconds: 20,
    toolTimeoutSeconds: 60,
    copyHintMinMinutes: 60,
    copyHintPercent: 3,
    fullBookMinutes: 120,
    absTimeoutSeconds: 30,
    // Stage 3 (WP21b). The score and the length limits were set from the labeled pairs (see
    // decisions.md "WP21b"): same recording >= 0.894 and different <= 0.613 in every window of
    // the sample, so the line sits in the middle of that gap; the same recording differed by at
    // most 15 s (Discord vs TMW), so 60 s is "incomplete".
    dupWindowSeconds: 45,
    dupShiftSeconds: 60,
    dupMiddleSearchMinutes: 15,
    dupSameScore: 0.75,
    dupCandidatePercent: 5,
    dupAsinToleranceSeconds: 60,
    dupLengthEqualSeconds: 2,
    dupIncompleteSeconds: 60,
    dupBitrateMarginPercent: 5,
    dupChapterToleranceSeconds: 2,
    dupFingerprintWorkers: 4,
    dupDecodeWorkers: 2,
    dupClipSeconds: 10,
    dupBrandingMaxSeconds: 12,
    dupBrandingScore: 0.9,
    dupNoticeableErrors: 100,
    // Stage 4 (WP21c). The runtime and title lines are checked on the labeled books (decisions.md
    // "WP21c"); the search and page counts are the reference sample's (refsample.py).
    onlineRuntimeMinutes: 2,
    onlineTitleScore: 0.8,
    // Measured on the live run's 196 partial agreements (decisions.md "WP21c follow-up (2)").
    onlineTitleMinChars: 3,
    onlineTitleMinShare: 0.25,
    onlineSearchProducts: 2,
    onlineStorePages: 3,
    onlineOpeningSeconds: 240,
    noStoreRecordFolders: ['Discord/moved/山田じぇみ子の ざこざこお兄さん取締ラジオ'],
    multiNarratorMin: 2,
    // Stage 6 (WP21e-1): a batch of 50 small operations is about a second of disk time.
    buildBatchOps: 50,
    buildPreflightOps: 500,
    buildLeaseSeconds: 120,
    buildRehashSample: 20,
    // The switch (WP21e-2): the renames and the five library-only files are small batches; a
    // batch of 200 deletions is about a second of disk time.
    switchLeaseSeconds: 300,
    deleteBatchOps: 200,
    coverPaceMs: 1000,
    // Stage 7 (WP21f-1): after the backup (00:00-00:07 NAS time) and before the day starts.
    arrivalsTime: '05:00',
    arrivalsQuietStart: '23:30',
    arrivalsQuietEnd: '00:30',
    arrivalsTimeZone: '',
    arrivalsSettleMinutes: 30,
    arrivalsAbsWaitMinutes: 30,
    arrivalsAbsNudge: false,
    extractLeaseSeconds: 1800,
    libraryChanges: 'analyse',
  },
  ai: {
    spendLimitUsd: null,
    modes: { 'gpt-6-luna': 'direct' },
    batchStallMinutes: 30,
    connectAttemptMs: 5000,
    batchTurnaroundMinutes: 3,
    directWorkers: 3,
    batchSize: 500,
    batchPollSeconds: 60,
    maxTokens: 16000,
    requestTimeoutSeconds: 180,
    attempts: 4,
    batchPriceFactor: 0.5,
    // The bake-off's measured list prices (reference-sample.md, 2026-11-12).
    prices: {
      'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
      'gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
      'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
      'gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10 },
    },
    structuredOutputs: true,
    labeledOnly: false,
    arrivalsDesign: 'J',
    upgradeIncludeDecided: false,
  },
  fetch: {
    // Paces of plan section 6 (Bookmeter and Natively as BookWalker; the cover images as decided
    // in the WP20d plan); Sudachi runs inside the fetch container, no network.
    sites: {
      'amazon-dp': { enabled: true, intervalSeconds: 8, inFlight: 1 },
      'amazon-search': { enabled: true, intervalSeconds: 8, inFlight: 1 },
      'amazon-img': { enabled: true, intervalSeconds: 5, inFlight: 1 },
      ranobedb: { enabled: true, intervalSeconds: 1, inFlight: 1 },
      bookwalker: { enabled: true, intervalSeconds: 5, inFlight: 1 },
      bookmeter: { enabled: true, intervalSeconds: 5, inFlight: 1 },
      natively: { enabled: true, intervalSeconds: 5, inFlight: 1 },
      ndl: { enabled: true, intervalSeconds: 30, inFlight: 1 },
      sudachi: { enabled: true, intervalSeconds: 0, inFlight: 1 },
      // The audiobook cleanup (WP21c): its own sites, never paced or backed off with Amazon's.
      // Paces of the audiobook plan section 6 (the probes' and the reference sample's).
      audible: { enabled: true, intervalSeconds: 3, inFlight: 1 },
      'audible-sample': { enabled: true, intervalSeconds: 5, inFlight: 1 },
      kikubon: { enabled: true, intervalSeconds: 5, inFlight: 1 },
      audiobookjp: { enabled: true, intervalSeconds: 5, inFlight: 1 },
      'audiobookjp-sample': { enabled: true, intervalSeconds: 5, inFlight: 1 },
    },
    amazonPace: 'trial',
    challengeBackoffSeconds: 60,
    challengeBackoffMaxSeconds: 900,
    challengePauseAfter: 8,
    slowDownPercent: 10,
    slowDownWindow: 100,
    retrySeconds: 30,
    maxAttempts: 6,
    leaseSeconds: 120,
    requestTimeoutSeconds: 30,
    maxPageMb: 16,
    ndlNamesPerQuery: 50,
    ndlOutageStartJst: '03:55',
    ndlOutageMinutes: 20,
    nativelyRereadDays: 30,
    smallCoverPx: 800,
    offlineSeconds: 90,
  },
  backup: {
    path: '/mnt/user/data/backups/japanese-library-2026-11-11/',
    verifiedOn: '2026-11-12',
    confirmedAt: null,
  },
};

export const MAX_BATCH_SIZE = 500;
export const MAX_BATCH_PERCENT = 10;
/** Fields the gate knows (a bar for anything else is refused). */
export const GATE_FIELDS = [
  'title',
  'authors',
  'illustrators',
  'series',
  'number',
  'format',
] as const;

export class SettingsError extends Error {}

type Key = keyof CleanupSettings;
/** Keys of the earlier per-stage shape, removed when the settings are saved again. */
const LEGACY_KEYS = ['gateThresholdPercent', 'stage2'];

function readRaw(db: Database.Database): Map<string, unknown> {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as {
    key: string;
    value_json: string;
  }[];
  return new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Settings stored in the earlier per-stage shape (WP20a's pacing with hashMbPerSecond, the
 * unused gateThresholdPercent, WP20b's stage2 group) in today's shape. The old page saved every
 * field, so the old defaults it stored (200 per batch, a 2 s pause) become today's
 * recommendations (500, none); any other stored value is kept.
 */
export function fromLegacy(raw: Map<string, unknown>): Map<string, unknown> {
  const out = new Map(raw);
  const pacing = raw.get('pacing');
  if (isObj(pacing) && 'hashMbPerSecond' in pacing) {
    const { hashMbPerSecond, ...rest } = pacing;
    out.set('pacing', {
      ...rest,
      readMbPerSecond: hashMbPerSecond,
      batchSize: rest.batchSize === 200 ? 500 : rest.batchSize,
      itemDelaySeconds: rest.itemDelaySeconds === 2 ? 0 : rest.itemDelaySeconds,
    });
  }
  const stage2 = raw.get('stage2');
  const oldGate = raw.get('gateThresholdPercent');
  if (!raw.has('gate') && (isObj(stage2) || typeof oldGate === 'number')) {
    const gate: Obj = {};
    if (typeof oldGate === 'number') gate.defaultPercent = oldGate;
    if (isObj(stage2)) {
      const fieldPercent: Obj = {};
      if (typeof stage2.titleMinPercent === 'number') fieldPercent.title = stage2.titleMinPercent;
      if (
        typeof stage2.authorsMinPercent === 'number' &&
        stage2.authorsMinPercent !== (gate.defaultPercent ?? 95)
      ) {
        fieldPercent.authors = stage2.authorsMinPercent;
      }
      gate.fieldPercent = fieldPercent;
      if (stage2.titleMarginPoints !== undefined) gate.marginPoints = stage2.titleMarginPoints;
      if (stage2.gateMinBooks !== undefined) gate.minBooks = stage2.gateMinBooks;
      if (stage2.referenceFile !== undefined) gate.labeledBooksFile = stage2.referenceFile;
    }
    out.set('gate', gate);
  }
  if (!raw.has('covers') && isObj(stage2)) {
    const covers: Obj = {};
    if (stage2.coverMaxMb !== undefined) covers.maxMb = stage2.coverMaxMb;
    if (stage2.coverMaxSide !== undefined) covers.maxSide = stage2.coverMaxSide;
    if (stage2.coverSameDistance !== undefined) covers.sameDistance = stage2.coverSameDistance;
    if (stage2.coverLargerPercent !== undefined) covers.largerPercent = stage2.coverLargerPercent;
    out.set('covers', covers);
  }
  if (isObj(stage2) && typeof stage2.chunkSize === 'number') {
    const p = out.get('pacing');
    out.set('pacing', { ...(isObj(p) ? p : {}), lookupChunk: stage2.chunkSize });
  }
  // WP21a: the per-second pace of stage 2 was replaced by waiting for Calibre (never deployed,
  // but test and dry-run databases may hold it).
  const audio = out.get('audiobooks');
  if (isObj(audio) && 'healthFilesPerSecond' in audio) {
    const { healthFilesPerSecond: _pace, ...rest } = audio;
    out.set('audiobooks', rest);
  }
  for (const k of LEGACY_KEYS) out.delete(k);
  return out;
}

function stage5Bars(value: unknown): GateSettings['stage5'] {
  if (!isObj(value)) throw new SettingsError('Genre and tag bars must be an object');
  const v = value as Record<string, unknown>;
  return {
    genresRight: num('Genres: right at least (%)', v.genresRight, 50, 100),
    tagsRight: num('Tags: right at least (%)', v.tagsRight, 50, 100),
    genresFound: num('Genres: found at least (%)', v.genresFound, 0, 100),
    tagsFound: num('Tags: found at least (%)', v.tagsFound, 0, 100),
  };
}

export function getSettings(db: Database.Database): CleanupSettings {
  const raw = fromLegacy(readRaw(db));
  const s: CleanupSettings = structuredClone(DEFAULT_SETTINGS);
  for (const key of Object.keys(DEFAULT_SETTINGS) as Key[]) {
    if (!raw.has(key)) continue;
    const value = raw.get(key);
    try {
      (s as unknown as Record<string, unknown>)[key] = validate(key, value, s);
    } catch {
      // A stored value that no longer validates falls back to the default.
    }
  }
  return s;
}

/** An absolute folder path inside Audiobookshelf's container, without a trailing slash. */
export function absFolder(value: unknown): string {
  if (typeof value !== 'string' || !/^\/[^\0]*$/.test(value.trim()) || value.length > 200)
    throw new SettingsError(
      'Audiobookshelf’s audiobooks folder must be an absolute path like /audiobooks',
    );
  return value.trim().replace(/\/+$/, '') || '/';
}

function num(name: string, value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SettingsError(`${name} must be a number from ${min} to ${max}`);
  }
  if (integer && !Number.isInteger(value))
    throw new SettingsError(`${name} must be a whole number`);
  return value;
}

function bool(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SettingsError(`${name} must be on or off`);
  return value;
}

/** A time of day, HH:MM (24 h). */
function clock(name: string, value: unknown): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()))
    throw new SettingsError(`${name} must be a time like 05:00`);
  return value.trim();
}

/** An IANA time zone name, or empty (the server's). */
function zone(name: string, value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (typeof value !== 'string') throw new SettingsError(`${name} must be a time zone name`);
  if (!v) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v }).format(0);
  } catch {
    throw new SettingsError(`${name} must be a time zone name like America/Los_Angeles`);
  }
  return v;
}

function text(name: string, value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new SettingsError(`${name} must be text of at most ${max} characters`);
  }
  return value.trim();
}

function group<T extends object>(name: string, value: unknown, current: T): T {
  if (!isObj(value)) throw new SettingsError(`${name} must be an object`);
  for (const k of Object.keys(value)) {
    if (!(k in current)) throw new SettingsError(`Unknown ${name.toLowerCase()} setting: ${k}`);
  }
  return { ...current, ...(value as Partial<T>) };
}

/** Folders under the torrents root (relative, "/"-separated, no "..": at most 50). */
function folderList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new SettingsError('Folders without a store record must be a list of at most 50 folders');
  }
  const out: string[] = [];
  for (const v of value) {
    const f = text('Folder', v, 500)
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (f === '') continue;
    if (f.split('/').some((s) => s === '..' || s === '.')) {
      throw new SettingsError(`Folder ${f}: no "." or ".." parts`);
    }
    out.push(f);
  }
  return [...new Set(out)];
}

/** Audiobookshelf's address: http(s), no query, fragment or login; '' = not set. */
function absAddress(value: unknown): string {
  const v = text('Audiobookshelf address', value);
  if (v === '') return v;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new SettingsError('Audiobookshelf address must look like http://192.168.1.5:13378');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SettingsError('Audiobookshelf address must start with http:// or https://');
  }
  if (url.hash || url.search || url.username || url.password) {
    throw new SettingsError(
      'Audiobookshelf address: no #, query or login in the address (the API key has its own field)',
    );
  }
  return url.toString().replace(/\/$/, '');
}

function validate(key: Key, value: unknown, current: CleanupSettings): unknown {
  switch (key) {
    case 'contentServerUrl': {
      const v = text('Content server address', value);
      if (v === '') return v;
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        throw new SettingsError('Content server address must look like http://192.168.1.5:8083');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new SettingsError('Content server address must start with http:// or https://');
      }
      if (url.hash || url.search || url.username || url.password) {
        throw new SettingsError(
          'Content server address: no #library id, query or login in the address (they have their own fields)',
        );
      }
      return url.toString().replace(/\/$/, '');
    }
    case 'audiobooks': {
      const v = group('Audiobooks', value, current.audiobooks);
      return {
        absUrl: absAddress(v.absUrl),
        absMediaFolder: absFolder(v.absMediaFolder),
        readMbPerSecond: num('Hashing speed (MB/s)', v.readMbPerSecond, 0, 2000),
        healthWorkers: num('Files checked at the same time', v.healthWorkers, 1, 16, true),
        decodeSeconds: num('Seconds decoded at each end', v.decodeSeconds, 1, 600, true),
        toolTimeoutSeconds: num(
          'Time limit for one check (s)',
          v.toolTimeoutSeconds,
          5,
          3600,
          true,
        ),
        copyHintMinMinutes: num(
          'Copies: each file at least (minutes)',
          v.copyHintMinMinutes,
          0,
          6000,
        ),
        copyHintPercent: num('Copies: lengths within (%)', v.copyHintPercent, 0, 50),
        fullBookMinutes: num(
          'Files this long are separate books (minutes)',
          v.fullBookMinutes,
          1,
          6000,
        ),
        absTimeoutSeconds: num('Audiobookshelf time limit (s)', v.absTimeoutSeconds, 1, 600, true),
        dupWindowSeconds: num('Window length (s)', v.dupWindowSeconds, 10, 300, true),
        dupShiftSeconds: num('Shift searched at each end (s)', v.dupShiftSeconds, 0, 600, true),
        dupMiddleSearchMinutes: num(
          'Middle window: minutes searched',
          v.dupMiddleSearchMinutes,
          1,
          120,
        ),
        dupSameScore: num('Same recording at a score of', v.dupSameScore, 0.5, 1),
        dupCandidatePercent: num('Same title: lengths within (%)', v.dupCandidatePercent, 0, 50),
        dupAsinToleranceSeconds: num(
          'Same ASIN: lengths within (s)',
          v.dupAsinToleranceSeconds,
          0,
          3600,
        ),
        dupLengthEqualSeconds: num('Lengths equal within (s)', v.dupLengthEqualSeconds, 0, 600),
        dupIncompleteSeconds: num(
          'Incomplete when shorter by (s)',
          v.dupIncompleteSeconds,
          1,
          36000,
        ),
        dupBitrateMarginPercent: num('Bitrates equal within (%)', v.dupBitrateMarginPercent, 0, 50),
        dupChapterToleranceSeconds: num(
          'Chapters equal within (s)',
          v.dupChapterToleranceSeconds,
          0,
          600,
        ),
        dupFingerprintWorkers: num(
          'Windows read at the same time',
          v.dupFingerprintWorkers,
          1,
          16,
          true,
        ),
        dupDecodeWorkers: num('Full decodes at the same time', v.dupDecodeWorkers, 1, 8, true),
        dupClipSeconds: num('Seconds played on the review page', v.dupClipSeconds, 2, 60, true),
        dupBrandingMaxSeconds: num('Opening/closing at most (s)', v.dupBrandingMaxSeconds, 0, 60),
        dupBrandingScore: num('Opening/closing match at a score of', v.dupBrandingScore, 0.5, 1),
        dupNoticeableErrors: num(
          'Damaged above this many bad frames',
          v.dupNoticeableErrors,
          0,
          1000000,
          true,
        ),
        onlineRuntimeMinutes: num(
          'Store length agrees within (minutes)',
          v.onlineRuntimeMinutes,
          0,
          60,
        ),
        onlineTitleScore: num('Titles agree at a score of', v.onlineTitleScore, 0.3, 1),
        onlineTitleMinChars: num(
          'A title inside another counts from (characters)',
          v.onlineTitleMinChars,
          1,
          20,
          true,
        ),
        onlineTitleMinShare: num(
          'A title inside another counts from (share of the longer)',
          v.onlineTitleMinShare,
          0,
          1,
        ),
        onlineSearchProducts: num(
          'Audible records read per search',
          v.onlineSearchProducts,
          1,
          10,
          true,
        ),
        onlineStorePages: num(
          'kikubon / audiobook.jp pages read per search',
          v.onlineStorePages,
          1,
          10,
          true,
        ),
        onlineOpeningSeconds: num(
          'Opening compared with sample audio (s)',
          v.onlineOpeningSeconds,
          30,
          900,
          true,
        ),
        noStoreRecordFolders: folderList(v.noStoreRecordFolders),
        multiNarratorMin: num('Several narrators from', v.multiNarratorMin, 2, 20, true),
        buildBatchOps: num('Operations per build batch', v.buildBatchOps, 1, 1000, true),
        buildPreflightOps: num('Files per preflight batch', v.buildPreflightOps, 10, 5000, true),
        buildLeaseSeconds: num('Seconds per build batch', v.buildLeaseSeconds, 15, 3600, true),
        buildRehashSample: num(
          'Linked files read again in the check',
          v.buildRehashSample,
          0,
          1000,
          true,
        ),
        switchLeaseSeconds: num('Seconds per switch batch', v.switchLeaseSeconds, 30, 3600, true),
        deleteBatchOps: num('Entries deleted per batch', v.deleteBatchOps, 1, 5000, true),
        coverPaceMs: num('Milliseconds between covers', v.coverPaceMs, 0, 60000, true),
        arrivalsTime: clock('Time of the daily run', v.arrivalsTime),
        arrivalsQuietStart: clock('No run from', v.arrivalsQuietStart),
        arrivalsQuietEnd: clock('No run until', v.arrivalsQuietEnd),
        arrivalsTimeZone: zone('Time zone of the daily run', v.arrivalsTimeZone),
        arrivalsSettleMinutes: num(
          'A file counts once unchanged for (minutes)',
          v.arrivalsSettleMinutes,
          0,
          10080,
        ),
        arrivalsAbsWaitMinutes: num(
          'Wait for Audiobookshelf to show a new book (minutes)',
          v.arrivalsAbsWaitMinutes,
          0,
          1440,
        ),
        arrivalsAbsNudge: bool('Tell Audiobookshelf the new folder', v.arrivalsAbsNudge),
        extractLeaseSeconds: num(
          'Seconds to unpack one archive entry',
          v.extractLeaseSeconds,
          60,
          86400,
          true,
        ),
        libraryChanges: (() => {
          const m = v.libraryChanges ?? 'analyse';
          if (m !== 'off' && m !== 'analyse' && m !== 'on')
            throw new Error('Changes to books in the library: off, Preview or On');
          return m;
        })(),
      };
    }
    case 'ai': {
      const v = group('AI', value, current.ai);
      if (!isObj(v.modes)) throw new SettingsError('AI: modes must be an object');
      if (Object.keys(v.modes).length > 30) throw new SettingsError('AI: at most 30 model modes');
      const modes: Record<string, 'batch' | 'direct'> = {};
      for (const [model, m] of Object.entries(v.modes)) {
        const id = text('Model id', model, 100);
        if (m !== 'batch' && m !== 'direct')
          throw new SettingsError(`AI: ${id} must be batch or direct`);
        if (id) modes[id] = m;
      }
      if (!isObj(v.prices)) throw new SettingsError('AI: prices must be an object');
      const entries = Object.entries(v.prices);
      if (entries.length > 30) throw new SettingsError('AI: at most 30 prices');
      const prices: Record<string, AiPrice> = {};
      for (const [model, p] of entries) {
        const id = text('Model id', model, 100);
        if (!id) continue;
        if (!isObj(p)) throw new SettingsError(`AI: the price of ${id} must be an object`);
        prices[id] = {
          inputPerMTok: num(`${id}: input price ($ per million tokens)`, p.inputPerMTok, 0, 1000),
          outputPerMTok: num(
            `${id}: output price ($ per million tokens)`,
            p.outputPerMTok,
            0,
            1000,
          ),
        };
      }
      return {
        spendLimitUsd:
          v.spendLimitUsd === null || (v.spendLimitUsd as unknown) === ''
            ? null
            : num('Spending limit ($)', v.spendLimitUsd, 0, 10000),
        modes,
        batchStallMinutes: num(
          'Cancel a batch with no answers after (min; 0 = never)',
          v.batchStallMinutes,
          0,
          1440,
          true,
        ),
        connectAttemptMs: num(
          'Wait for each address when connecting (ms)',
          v.connectAttemptMs ?? 5000,
          250,
          60000,
          true,
        ),
        batchTurnaroundMinutes: num(
          'Expected batch time before one is measured (min)',
          v.batchTurnaroundMinutes ?? 3,
          0.1,
          1440,
        ),
        directWorkers: num('Calls at the same time', v.directWorkers, 1, 100, true),
        batchSize: num('Requests per batch', v.batchSize, 1, 10000, true),
        batchPollSeconds: num('Batch check every (s)', v.batchPollSeconds, 5, 3600, true),
        maxTokens: num('Claude max_tokens (thinking included)', v.maxTokens, 1000, 64000, true),
        requestTimeoutSeconds: num(
          'Time limit per call (s)',
          v.requestTimeoutSeconds,
          10,
          900,
          true,
        ),
        attempts: num('Tries per call', v.attempts, 1, 10, true),
        batchPriceFactor: num('Batch price (share of the list price)', v.batchPriceFactor, 0, 1),
        prices,
        structuredOutputs: v.structuredOutputs === true,
        labeledOnly: v.labeledOnly === true,
        arrivalsDesign:
          v.arrivalsDesign === 'E' || v.arrivalsDesign === 'F' || v.arrivalsDesign === 'J'
            ? v.arrivalsDesign
            : (() => {
                throw new SettingsError('The new arrivals’ AI setup must be E, F or J');
              })(),
        upgradeIncludeDecided: v.upgradeIncludeDecided === true,
      };
    }
    case 'fetch': {
      const v = group('Online sources', value, current.fetch);
      if (!isObj(v.sites)) throw new SettingsError('Online sources: sites must be an object');
      const sites: Record<string, FetchSiteSettings> = {};
      for (const site of FETCH_SITES) {
        const got = (v.sites as Record<string, unknown>)[site];
        const cur = current.fetch.sites[site];
        const o = got === undefined ? cur : group(`Site ${site}`, got, cur);
        if (typeof o.enabled !== 'boolean')
          throw new SettingsError(`${site}: on/off must be true or false`);
        sites[site] = {
          enabled: o.enabled,
          intervalSeconds: num(
            `${site}: seconds between requests`,
            o.intervalSeconds,
            site === 'sudachi' ? 0 : MIN_INTERVAL_SECONDS,
            3600,
          ),
          inFlight: num(`${site}: requests at once`, o.inFlight ?? 1, 1, MAX_IN_FLIGHT, true),
        };
      }
      for (const k of Object.keys(v.sites as object)) {
        if (!(FETCH_SITES as readonly string[]).includes(k))
          throw new SettingsError(`Unknown site: ${k}`);
      }
      if (!['shared', 'separate', 'trial'].includes(v.amazonPace as string)) {
        throw new SettingsError('Amazon pace must be shared, separate or trial');
      }
      if (
        typeof v.ndlOutageStartJst !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.ndlOutageStartJst)
      ) {
        throw new SettingsError('NDL outage start must be a time like 03:55');
      }
      const out: FetchSettings = {
        sites,
        amazonPace: v.amazonPace as FetchSettings['amazonPace'],
        challengeBackoffSeconds: num(
          'First wait after Amazon refuses (s)',
          v.challengeBackoffSeconds,
          10,
          86400,
          true,
        ),
        challengeBackoffMaxSeconds: num(
          'Longest back-off (s)',
          v.challengeBackoffMaxSeconds,
          10,
          86400,
          true,
        ),
        challengePauseAfter: num(
          'Pause after refusals in a row',
          v.challengePauseAfter,
          1,
          1000,
          true,
        ),
        slowDownPercent: num(
          'Slow Amazon down above this share of refusals (%)',
          v.slowDownPercent,
          0,
          100,
        ),
        slowDownWindow: num(
          'Refusal share over the last (requests)',
          v.slowDownWindow,
          10,
          10000,
          true,
        ),
        retrySeconds: num('Ask a failed request again after (s)', v.retrySeconds, 1, 86400, true),
        maxAttempts: num('Give a request up after (attempts)', v.maxAttempts, 1, 100, true),
        leaseSeconds: num('Fetcher answer time (s)', v.leaseSeconds, 30, 3600, true),
        requestTimeoutSeconds: num(
          'Time limit for one request (s)',
          v.requestTimeoutSeconds,
          5,
          600,
          true,
        ),
        maxPageMb: num('Largest answer kept (MB)', v.maxPageMb, 1, 64),
        ndlNamesPerQuery: num('Names per NDL query', v.ndlNamesPerQuery, 1, 200, true),
        ndlOutageStartJst: v.ndlOutageStartJst,
        ndlOutageMinutes: num('NDL outage length (minutes)', v.ndlOutageMinutes, 0, 240, true),
        nativelyRereadDays: num(
          'Read Natively again after (days)',
          v.nativelyRereadDays,
          1,
          3650,
          true,
        ),
        smallCoverPx: num('Small cover below (px)', v.smallCoverPx, 100, 5000, true),
        offlineSeconds: num('Fetcher offline after (s)', v.offlineSeconds, 30, 3600, true),
      };
      if (out.challengeBackoffMaxSeconds < out.challengeBackoffSeconds) {
        throw new SettingsError('The longest back-off must not be shorter than the first');
      }
      return out;
    }
    case 'calibreLibraryId': {
      const v = text('Calibre library id', value, 200);
      if (/[#/\s]/.test(v))
        throw new SettingsError('Calibre library id must not contain #, / or spaces');
      return v;
    }
    case 'calibreUsername':
      return text('Calibre user name', value, 200);
    case 'targetLibraryId':
      if (value === null) return null;
      return text('Library', value, 100);
    case 'models': {
      if (!isObj(value)) throw new SettingsError('Models must be an object');
      const out: Record<string, string> = { ...current.models };
      for (const [task, model] of Object.entries(value)) {
        if (!(MODEL_TASKS as readonly string[]).includes(task)) {
          throw new SettingsError(`Unknown model task: ${task}`);
        }
        out[task] = text(`Model for ${task}`, model, 100);
      }
      return out;
    }
    case 'pacing': {
      const v = group('Pacing', value, current.pacing);
      return {
        readMbPerSecond: num('Reading speed (MB/s)', v.readMbPerSecond, 0, 2000),
        itemDelaySeconds: num('Pause between items (s)', v.itemDelaySeconds, 0, 600),
        batchSize: num('Batch size', v.batchSize, 1, MAX_BATCH_SIZE, true),
        maxBatchPercent: num(
          'Largest batch (% of the library)',
          v.maxBatchPercent,
          0.1,
          MAX_BATCH_PERCENT,
        ),
        lookupChunk: num('Books per Calibre look-up', v.lookupChunk, 1, 100, true),
      };
    }
    case 'customTags': {
      if (!Array.isArray(value) || value.length > 100) {
        throw new SettingsError('Custom tags must be a list of at most 100 tags');
      }
      const tags = value.map((t) => text('Custom tag', t, 200)).filter((t) => t !== '');
      return [...new Set(tags)];
    }
    case 'gate': {
      const v = group('Gate', value, current.gate);
      if (!isObj(v.fieldPercent)) throw new SettingsError('Field bars must be an object');
      const fieldPercent: Record<string, number> = {};
      for (const [f, p] of Object.entries(v.fieldPercent)) {
        if (!(GATE_FIELDS as readonly string[]).includes(f))
          throw new SettingsError(`No such field: ${f}`);
        fieldPercent[f] = num(`Bar for ${f} (%)`, p, 50, 100);
      }
      if (!isObj(v.stage4Percent)) throw new SettingsError('Stage 4 field bars must be an object');
      const stage4Percent: Record<string, number> = {};
      for (const [f, p] of Object.entries(v.stage4Percent)) {
        if (!(GATE_FIELDS as readonly string[]).includes(f))
          throw new SettingsError(`No such field: ${f}`);
        stage4Percent[f] = num(`Stage 4 bar for ${f} (%)`, p, 50, 100);
      }
      return {
        defaultPercent: num('Bar for every field (%)', v.defaultPercent, 50, 100),
        fieldPercent,
        stage4Percent,
        marginPoints: num('Better than Calibre by (points)', v.marginPoints, 0, 100),
        minBooks: num('Smallest group checked (books)', v.minBooks, 1, 800, true),
        labeledBooksFile: text('Labeled books file', v.labeledBooksFile, 1000),
        duplicatePairsFile: text('Measured duplicate pairs file', v.duplicatePairsFile, 1000),
        audiobookPairsFile: text('Labeled audiobook pairs file', v.audiobookPairsFile, 1000),
        audiobookMetaPercent: num(
          'Audiobook metadata: bar per field (%)',
          v.audiobookMetaPercent,
          50,
          100,
        ),
        genreLabelsFile: text('Genre labels file', v.genreLabelsFile ?? '', 1000),
        stage5: stage5Bars(v.stage5 ?? current.gate.stage5),
      };
    }
    case 'reviewAlarmPercent':
      return num('Review alarm (points)', value, 0, 100);
    case 'libraryChangedPausePercent':
      return num('Pause when items changed in Calibre (%)', value, 0, 100);
    case 'failedPausePercent':
      return num('Pause when items of a batch failed (%)', value, 0, 100);
    case 'covers': {
      const v = group('Covers', value, current.covers);
      return {
        maxMb: num('Covers passed on unchanged up to (MB)', v.maxMb, 1, 32),
        maxSide: num('Longest cover side (px)', v.maxSide, 500, 20000, true),
        sameDistance: num('Same cover picture up to (hash distance)', v.sameDistance, 0, 32, true),
        largerPercent: num('A cover is larger by (%)', v.largerPercent, 0, 500),
      };
    }
    case 'duplicates': {
      const v = group('Duplicates', value, current.duplicates);
      const share = (name: string, x: unknown) => num(name, x, 0, 1);
      const optional = (name: string, x: unknown) => (x === null ? null : share(name, x));
      const out: DuplicateSettings = {
        bothWays: share('Same text both ways from', v.bothWays),
        superset: share('One copy holds the other from', v.superset),
        reviewFloor: share('Different books below', v.reviewFloor),
        spreadKeepBoth: optional(
          'Keep both copies from (extra text inside the chapters)',
          v.spreadKeepBoth,
        ),
        spreadIgnore: optional('Extra text inside the chapters ignored below', v.spreadIgnore),
        imageOnlyMaxChars: num(
          'Image-only books: fewer characters than',
          v.imageOnlyMaxChars,
          0,
          100_000,
          true,
        ),
        imageMatchDistance: num(
          'Same picture up to (hash distance)',
          v.imageMatchDistance,
          0,
          32,
          true,
        ),
        commonWindowBooks: num(
          'Text shared by more books than this is ignored',
          v.commonWindowBooks,
          2,
          10_000,
          true,
        ),
        textTimeoutSeconds: num(
          'Time limit to read one book (s)',
          v.textTimeoutSeconds,
          10,
          3600,
          true,
        ),
        textWorkers: num('Books read at the same time', v.textWorkers, 1, 8, true),
      };
      if (out.reviewFloor > out.bothWays || out.bothWays > out.superset) {
        throw new SettingsError(
          'The limits must go up: different books below ≤ same text both ways ≤ one copy holds the other',
        );
      }
      if ((out.spreadKeepBoth === null) !== (out.spreadIgnore === null)) {
        throw new SettingsError('Set both limits for extra text inside the chapters, or neither');
      }
      if (out.spreadKeepBoth !== null && out.spreadIgnore! > out.spreadKeepBoth) {
        throw new SettingsError('"Ignored below" must not be above "keep both copies from"');
      }
      return out;
    }
    case 'backup': {
      const v = group('Backup', value, current.backup);
      const confirmedAt = v.confirmedAt;
      if (
        confirmedAt !== null &&
        (typeof confirmedAt !== 'number' || !Number.isFinite(confirmedAt))
      ) {
        throw new SettingsError('Backup confirmation must be a time or null');
      }
      return {
        path: text('Backup folder', v.path),
        verifiedOn: text('Backup verified on', v.verifiedOn, 50),
        confirmedAt,
      };
    }
  }
}

/** The bar a stage-2 field must reach on the labeled books (its own, else the shared one). */
export function gateBar(s: CleanupSettings, field: string): number {
  return s.gate.fieldPercent[field] ?? s.gate.defaultPercent;
}

/** The bar a stage-4 field must reach on the labeled books (its own, else the shared one). */
export function stage4Bar(s: CleanupSettings, field: string): number {
  return s.gate.stage4Percent[field] ?? s.gate.defaultPercent;
}

/** Saves the given keys (each validated against the current values). Returns the new settings. */
export function updateSettings(
  db: Database.Database,
  changes: Record<string, unknown>,
  now = Date.now(),
): CleanupSettings {
  const current = getSettings(db);
  const next: Partial<Record<Key, unknown>> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in DEFAULT_SETTINGS)) throw new SettingsError(`Unknown setting: ${key}`);
    next[key as Key] = validate(key as Key, value, current);
  }
  const put = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    // The earlier per-stage shape goes once today's shape is stored (everything carried over).
    const raw = readRaw(db);
    if (
      LEGACY_KEYS.some((k) => raw.has(k)) ||
      (isObj(raw.get('pacing')) && 'hashMbPerSecond' in (raw.get('pacing') as Obj))
    ) {
      for (const k of ['pacing', 'gate', 'covers'] as const)
        put.run(k, JSON.stringify(current[k]), now);
      for (const k of LEGACY_KEYS) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
    }
    for (const [key, value] of Object.entries(next)) put.run(key, JSON.stringify(value), now);
  })();
  return getSettings(db);
}

/**
 * Matches a tag against the user's custom-tag patterns (a trailing * = any ending).
 * Case-insensitive, like Calibre's tag names.
 */
export function isCustomTag(tag: string, patterns: string[]): boolean {
  const t = tag.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.endsWith('*') ? t.startsWith(p.slice(0, -1)) : t === p;
  });
}
