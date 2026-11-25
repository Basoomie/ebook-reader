/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  CatalogBookDetail,
  CatalogGroupPage,
  CatalogLibrary,
  CatalogBook,
  CatalogPage,
  CollectionCardData,
  GroupBy,
  StagedUpload,
  UploadInfo
} from '$lib/library/types';
import type { ServerSort } from '$lib/library/sort';
import type { NameCount, NameField } from '$lib/library/query/suggest';
import type { DownloadKind, DownloadPlan, ZipStatus } from '$lib/library/bulk-download';
import type {
  QuoteFilter,
  SpeakerCharacter,
  SpeakerModel,
  SpeakerOverview,
  SpeakerQuoteItem
} from '$lib/audio/speakers/speaker-types';
import type { ServerIllustrationList } from '$lib/library/illustrations/types';
import type {
  AudioCandidates,
  AudioFolderDetail,
  AudioFolderSummary,
  AudioMergeJob,
  AudioLink,
  AudioLinkChange,
  AudioLinkListEntry,
  AudioStatus,
  GpuWorkerStatus,
  SubtitleFileSummary,
  SubtitleJob
} from '$lib/audio/audio-types';
import type {
  AudiobookJob,
  AudiobookRequest,
  BookChapters,
  BookVoiceChoices,
  ReadAloudSentence,
  ReadAloudSession,
  SentenceClip,
  SentencePc,
  TtsModel,
  TtsPauses,
  VoiceChoice,
  VoiceList,
  VoicePreset
} from '$lib/audio/tts-types';
import type {
  FixInput,
  FixList,
  PronunciationCheck,
  PronunciationFix
} from '$lib/audio/pronunciation/fix-types';

/** Client for the storage server's /api/v1 catalog (WP6). */

export type LibraryApiErrorKind =
  /** No answer: offline, server down, wrong address, or blocked by CORS. */
  | 'unreachable'
  | 'timeout'
  | 'aborted'
  /** Token missing, unknown or revoked. */
  | 'unauthorized'
  /** Any other error answer; see `code`. */
  | 'server';

export class LibraryApiError extends Error {
  constructor(
    readonly kind: LibraryApiErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    /** invalid_query: the character span of the problem in the search text. */
    readonly span?: { start: number; end: number },
    /** Season 2 Phase 12 session 3: why a read-aloud session ended (410 ended). */
    readonly why?: string
  ) {
    super(message);
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** 0 = no limit. */
  timeoutSeconds?: number;
}

/** GET /natively/level/:bookId (the Natively level, 2026-11-24). */
export interface NativelyLevelAnswer {
  /** Null when the book has no direct Natively link. */
  nativelyId: string | null;
  level: number | null;
  temporary: boolean;
  state: 'ok' | 'none' | 'gone' | 'error' | null;
  checkedAt: number | null;
}

export interface NativelySettings {
  maxAgeDays: number;
  requestSeconds: number;
  maxBackoffMinutes: number;
}

export interface NativelyProgressAnswer {
  pass: { running: boolean; total: number; done: number; left: number; secondsLeft: number };
  saved: number;
  waitingUntil: number | null;
  lastError: string | null;
  settings: NativelySettings;
}

/** Store ratings (2026-11-25): one site's saved figures. */
export interface RatingFigure {
  /** Stars out of 5 (null on 読書メーター). */
  avg: number | null;
  /** Ratings, or 読書メーター's 登録数. */
  count: number | null;
  /** 読書メーター's 感想 count. */
  reviews: number | null;
  state: 'ok' | 'none' | 'gone' | 'error';
  checkedAt: number;
}

/** GET /ratings/book/:bookId. */
export interface BookRatingsAnswer {
  pooled: { avg: number; count: number } | null;
  readers: number | null;
  /** By identifier type: amazon_jp, bookwalker, bookmeter (when on), natively. */
  sites: Partial<Record<'amazon_jp' | 'bookwalker' | 'bookmeter' | 'natively', RatingFigure>>;
  /** Old figures were asked for again; read again later for the answer. */
  refreshing: boolean;
}

export interface RatingSettings {
  refresh: boolean;
  bookmeter: boolean;
  newDays: number;
  recentDays: number;
  oldDays: number;
  openMaxAgeDays: number;
  scoreRatings: number;
  queuedPerSite: number;
  /** Hours a book new to the reader waits for the cleanup's stage 4 before its first fetch. */
  newBookWaitHours: number;
}

export interface RatingsProgressAnswer {
  fill: { running: boolean; total: number; done: number; found: number; secondsLeft: number };
  refresh: {
    on: boolean;
    available: boolean;
    waiting: number;
    due: Record<string, number>;
    /** Answers read since fetching was switched on (or the server started). */
    read: number;
    /** Time left for what is due now at the measured pace; null while it is being measured. */
    secondsLeft: number | null;
  };
  saved: Record<string, number>;
  lastError: string | null;
  settings: RatingSettings;
  score: { m: number; c: number };
}

export interface DownloadResult {
  blob: Blob;
  etag: string | null;
}

/** Normalizes what the user typed: adds http:// when missing and drops paths and trailing slashes. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter the server address');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  return url.origin;
}

export async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  { signal, timeoutSeconds = 0 }: RequestOptions
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) controller.abort();
  const timer =
    timeoutSeconds > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutSeconds * 1000)
      : undefined;
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new LibraryApiError('timeout', 'The library server did not answer in time');
    if (signal?.aborted) throw new LibraryApiError('aborted', 'Cancelled');
    throw new LibraryApiError(
      'unreachable',
      `Could not reach the library server (${(error as Error).message || 'network error'})`
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function errorFrom(response: Response): Promise<LibraryApiError> {
  let code: string | undefined;
  let message = `The library server answered ${response.status}`;
  let span: { start: number; end: number } | undefined;
  let why: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; start?: unknown; end?: unknown };
    };
    code = body.error?.code;
    if (body.error?.message) message = body.error.message;
    if (typeof body.error?.start === 'number' && typeof body.error?.end === 'number') {
      span = { start: body.error.start, end: body.error.end };
    }
    const w = (body.error as { why?: unknown } | undefined)?.why;
    if (typeof w === 'string') why = w;
  } catch {
    // not JSON
  }
  if (response.status === 401 && code !== 'invalid_code') {
    return new LibraryApiError('unauthorized', message, 401, code);
  }
  return new LibraryApiError('server', message, response.status, code, span, why);
}

/** Trades a pairing code (from `cli token pair`) for this device's token. */
export async function pairDevice(
  serverUrl: string,
  code: string,
  options: RequestOptions = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ token: string; label: string }> {
  const response = await send(
    fetchImpl,
    `${serverUrl}/api/v1/pair`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    },
    options
  );
  if (!response.ok) throw await errorFrom(response);
  return response.json();
}

/** The parts of XMLHttpRequest an upload uses (tests pass a stand-in). */
export type UploadXhr = Pick<
  XMLHttpRequest,
  'open' | 'setRequestHeader' | 'send' | 'abort' | 'status' | 'responseText' | 'upload'
> & {
  onload: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onabort: ((ev: unknown) => void) | null;
};

/** A custom font on the server (WP13); the same data as its "font" sync record. */
export interface ServerFontInfo {
  id: string;
  name: string;
  fileName: string;
  format: 'woff2' | 'woff' | 'ttf' | 'otf';
  size: number;
  sha256: string;
  createdAt: number;
  /** Phase 10: a font added from Google Fonts, with its license and other weights. */
  source?: 'google';
  copyright?: string | null;
  licenseUrl?: string | null;
  faces?: { weight: number; format: string; size: number; sha256: string }[];
}

/** A Japanese family on Google Fonts, as the storage server lists it (Phase 10). */
export interface GoogleFontFamily {
  family: string;
  /** Google's category: Serif, Sans Serif, Display, Handwriting, Monospace. */
  category: string;
  /** The weights the reader would store: [400] or [400, 700]. */
  weights: number[];
  /**
   * available: can be added. added: already added from Google Fonts. built_in: the reader
   * has it built in. name_taken: an uploaded font has this name.
   */
  status: 'available' | 'added' | 'built_in' | 'name_taken';
}

/** GET /logs/recent (WP18): lines since the server started, oldest first. */
export interface RecentServerLogs {
  serverVersion: string;
  startedAt: number;
  maxLines: number;
  dropped: number;
  lines: { time: number; level: 'log' | 'info' | 'warn' | 'error'; text: string }[];
}

/** The filters of a book list (books() and count()). */
export interface BookListQuery {
  q?: string;
  /** A second search that must also match (a saved search or built-in collection). */
  scope?: string;
  library?: string;
  group?: { by: GroupBy; name: string | null };
  /** WP19a: one of your manual collections (for sorts other than its own order). */
  collection?: string;
}

/** The filters of a group list (groups()). */
export interface GroupListQuery {
  by: GroupBy;
  q?: string;
  /**
   * A collection's books only (2026-11-24): a smart or built-in collection's search, or
   * a manual collection's id. The cards then count and show only those books.
   */
  scope?: string;
  collection?: string;
  library?: string;
  cursor?: string;
  limit?: number;
  /** WP19a; absent = recently added first. */
  sort?: ServerSort<string>;
}

/** The search box's name suggestions (names()). */
export interface NameListQuery {
  field: NameField;
  text: string;
  library?: string;
  limit?: number;
}

function listParams(query: BookListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.scope) params.set('scope', query.scope);
  if (query.library) params.set('library', query.library);
  if (query.collection) params.set('collection', query.collection);
  if (query.group) {
    params.set('by', query.group.by);
    if (query.group.name === null) params.set('none', '1');
    else params.set('group', query.group.name);
  }
  return params;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

export class LibraryApi {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 0,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly xhrFactory: () => UploadXhr = () => new XMLHttpRequest() as UploadXhr
  ) {}

  /**
   * Sends an EPUB to the server for the chosen library (WP7b). Resolves to the staged
   * upload and its duplicates.
   */
  uploadEpub(
    file: Blob,
    fileName: string,
    libraryId: string,
    options: UploadOptions = {}
  ): Promise<StagedUpload> {
    const qs = new URLSearchParams({ library: libraryId, name: fileName });
    return this.sendWithProgress(`/uploads?${qs}`, file, 'application/epub+zip', options);
  }

  /**
   * Sends a font file to the server (WP13). Resolves to the stored font; `existing` when
   * the server already had the same file (under its first name).
   */
  uploadFont(
    file: Blob,
    name: string,
    fileName: string,
    options: UploadOptions = {}
  ): Promise<{ font: ServerFontInfo; existing: boolean }> {
    const qs = new URLSearchParams({ name, fileName });
    return this.sendWithProgress(`/fonts?${qs}`, file, 'application/octet-stream', options);
  }

  /** The server's font size limit and its fonts; null when the server takes no fonts. */
  async fontInfo(
    options?: RequestOptions
  ): Promise<{ maxBytes: number; google?: boolean; fonts: ServerFontInfo[] } | null> {
    try {
      return await (await this.get('/fonts', options)).json();
    } catch (error) {
      if (error instanceof LibraryApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** A font file (WP13); with `weight`, a Google font's other weight (Phase 10). */
  async downloadFont(
    id: string,
    { weight, ...options }: RequestOptions & { weight?: number } = {}
  ): Promise<Blob> {
    const query = weight === undefined ? '' : `?weight=${encodeURIComponent(String(weight))}`;
    const response = await this.get(`/fonts/${encodeURIComponent(id)}/file${query}`, {
      timeoutSeconds: 0,
      ...options
    });
    return response.blob();
  }

  /**
   * Google's Japanese families (Phase 10). The server asks Google on each call, so no
   * timeout of its own here (the server's GOOGLE_FONTS_TIMEOUT_SECONDS bounds it); the
   * caller can cancel.
   */
  async googleFonts(options: RequestOptions = {}): Promise<GoogleFontFamily[]> {
    const response = await this.get('/fonts/google', { timeoutSeconds: 0, ...options });
    return ((await response.json()) as { families: GoogleFontFamily[] }).families;
  }

  /**
   * The server downloads a family from Google Fonts and adds it as a font for every device
   * (Phase 10). Its record reaches this device with the next sync. No timeout; the caller
   * can cancel (the server still finishes).
   */
  async addGoogleFont(family: string, options: RequestOptions = {}): Promise<ServerFontInfo> {
    const response = await this.post(
      '/fonts/google',
      { family },
      { timeoutSeconds: 0, ...options }
    );
    return ((await response.json()) as { font: ServerFontInfo }).font;
  }

  /**
   * "Export my data" (WP18): everything synced for this user, as the server's JSON text.
   * No timeout by default (a large account takes a while); the caller can cancel.
   */
  async exportMyData(options: RequestOptions = {}): Promise<string> {
    const response = await this.get('/export', { timeoutSeconds: 0, ...options });
    return response.text();
  }

  /** The server's recent log lines for the bug report (WP18), secrets already removed. */
  async recentServerLogs(options?: RequestOptions): Promise<RecentServerLogs> {
    return (await this.get('/logs/recent', options)).json();
  }

  /**
   * POSTs a file with XMLHttpRequest, because fetch reports no upload progress. No
   * timeout (a big file on a slow link takes time); the caller can cancel with `signal`.
   */
  private sendWithProgress<T>(
    path: string,
    file: Blob,
    contentType: string,
    { signal, onProgress }: UploadOptions
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const xhr = this.xhrFactory();
      const onAbort = () => xhr.abort();
      const done = () => signal?.removeEventListener('abort', onAbort);
      xhr.open('POST', `${this.serverUrl}/api/v1${path}`);
      xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.setRequestHeader('Content-Type', contentType);
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (ev: ProgressEvent) => onProgress(ev.loaded, ev.total);
      }
      xhr.onload = async () => {
        done();
        const response = new Response(xhr.responseText || null, { status: xhr.status });
        if (xhr.status >= 200 && xhr.status < 300) resolve(await response.json());
        else reject(await errorFrom(response));
      };
      xhr.onerror = () => {
        done();
        reject(new LibraryApiError('unreachable', 'Could not reach the library server'));
      };
      xhr.onabort = () => {
        done();
        reject(new LibraryApiError('aborted', 'Cancelled'));
      };
      if (signal?.aborted) {
        reject(new LibraryApiError('aborted', 'Cancelled'));
        return;
      }
      signal?.addEventListener('abort', onAbort);
      xhr.send(file);
    });
  }

  /** Adds a staged upload as its own book ("Add as a separate book", or no duplicate). */
  async addUpload(uploadId: string, options?: RequestOptions): Promise<{ book: CatalogBook }> {
    return (await this.post(`/uploads/${encodeURIComponent(uploadId)}/add`, {}, options)).json();
  }

  /** Drops a staged upload ("Use the library copy", "Cancel"). */
  async discardUpload(uploadId: string, options: RequestOptions = {}): Promise<void> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/uploads/${encodeURIComponent(uploadId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (!response.ok) throw await errorFrom(response);
  }

  private async post(path: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  private async sendJson(
    method: 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    options: RequestOptions = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    const raw = body instanceof Blob;
    if (body !== undefined) headers['Content-Type'] = raw ? body.type : 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
      },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  private async get(path: string, options: RequestOptions = {}): Promise<Response> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  /** Checks the token; returns the label it was made for. */
  async me(options?: RequestOptions): Promise<{ token: { label: string } }> {
    return (await this.get('/me', options)).json();
  }

  async libraries(options?: RequestOptions): Promise<{
    indexer: { enabled: boolean; error: string | null };
    libraries: CatalogLibrary[];
    /** WP7b; missing from older servers (no uploads). */
    uploads?: UploadInfo;
  }> {
    return (await this.get('/libraries', options)).json();
  }

  /**
   * Books newest first, or one group's books (`group`: a series in series order; a
   * series name of null is "No series").
   */
  async books(
    query: BookListQuery & {
      cursor?: string;
      limit?: number;
      /** WP19a; absent = newest first (in a series: series order). */
      sort?: ServerSort<string>;
    },
    options?: RequestOptions
  ): Promise<CatalogPage> {
    const params = listParams(query);
    if (query.sort) {
      params.set('sort', query.sort.key);
      params.set('dir', query.sort.dir);
    }
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return (await this.get(`/books${qs ? `?${qs}` : ''}`, options)).json();
  }

  /** How many books a list has (WP19a, the same filters as books()). */
  async count(query: BookListQuery, options?: RequestOptions): Promise<number> {
    const qs = listParams(query).toString();
    const body = (await (await this.get(`/books/count${qs ? `?${qs}` : ''}`, options)).json()) as {
      count: number;
    };
    return body.count;
  }

  /** Every book id of a list (select mode's Select All: also the books not loaded yet). */
  async bookIds(query: BookListQuery, options?: RequestOptions): Promise<string[]> {
    const qs = listParams(query).toString();
    const body = (await (await this.get(`/books/ids${qs ? `?${qs}` : ''}`, options)).json()) as {
      ids: string[];
    };
    return body.ids;
  }

  /**
   * Select mode's Download menu: what these books offer per kind, with the sizes the server
   * has stored (no disk reads). `items` adds each book's files (for "Separate files").
   */
  async downloadPlan(
    ids: readonly string[],
    opts: { items?: boolean } = {},
    options?: RequestOptions
  ): Promise<DownloadPlan> {
    return (
      await this.post(
        '/books/download-plan',
        { ids, ...(opts.items ? { items: true } : {}) },
        options
      )
    ).json();
  }

  /**
   * Starts preparing one ZIP of one kind of these books on the server (every file is looked
   * up, so its exact size is known). Ask `zipStatus` how far it is; once ready, its `url`
   * is fetched by the browser itself.
   */
  async startZip(
    ids: readonly string[],
    kind: DownloadKind,
    signal?: AbortSignal
  ): Promise<string> {
    const body = (await (
      await this.post('/books/download-zip', { ids, kind }, { signal })
    ).json()) as { token: string };
    return body.token;
  }

  async zipStatus(token: string, options?: RequestOptions): Promise<ZipStatus> {
    return (await this.get(`/books/download-zip/${encodeURIComponent(token)}`, options)).json();
  }

  /** Stops preparing a ZIP (or ends its address). */
  async cancelZip(token: string): Promise<void> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/books/download-zip/${encodeURIComponent(token)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok && response.status !== 404) throw await errorFrom(response);
  }

  /** Browse tabs (WP7a): one card per series, author or tag with a matching book. */
  async groups(query: GroupListQuery, options?: RequestOptions): Promise<CatalogGroupPage> {
    const params = new URLSearchParams({ by: query.by });
    if (query.q) params.set('q', query.q);
    if (query.scope) params.set('scope', query.scope);
    if (query.collection) params.set('collection', query.collection);
    if (query.library) params.set('library', query.library);
    if (query.sort) {
      params.set('sort', query.sort.key);
      params.set('dir', query.sort.dir);
    }
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    return (await this.get(`/groups?${params.toString()}`, options)).json();
  }

  /** Search suggestions (search palette step 1): names containing `text`, with book counts. */
  async names(query: NameListQuery, options?: RequestOptions): Promise<NameCount[]> {
    const params = new URLSearchParams({ field: query.field, text: query.text });
    if (query.library) params.set('library', query.library);
    if (query.limit) params.set('limit', String(query.limit));
    return (
      (await this.get(`/names?${params.toString()}`, options)).json() as Promise<{
        names: NameCount[];
      }>
    ).then((r) => r.names);
  }

  /**
   * The given books in the given order (at most 200), without hidden ones and the ones
   * that don't match `q` (WP8b: a list collection, in its own order).
   */
  async lookup(
    ids: readonly string[],
    q?: string,
    options?: RequestOptions
  ): Promise<{ books: CatalogBook[] }> {
    return (await this.post('/books/lookup', { ids, ...(q ? { q } : {}) }, options)).json();
  }

  /**
   * WP12 stats: the given books including ones removed from Calibre (`missing: true`),
   * for titles and libraries of books that still have reading statistics.
   */
  async lookupIncludingMissing(
    ids: readonly string[],
    options?: RequestOptions
  ): Promise<{ books: CatalogBook[] }> {
    return (await this.post('/books/lookup', { ids, includeMissing: true }, options)).json();
  }

  /**
   * Season 2: the SHA-256 of each book's current file and the ETag its download sends now
   * (at most 200 ids); null for a missing book or a file that can't be found.
   */
  async fileHashes(
    ids: readonly string[],
    options?: RequestOptions
  ): Promise<{ books: { id: string; sha256: string | null; etag: string | null }[] }> {
    return (await this.post('/books/file-hashes', { ids }, options)).json();
  }

  /** Count and collage tiles of every collection (WP8b). */
  async collectionCards(options?: RequestOptions): Promise<{ cards: CollectionCardData[] }> {
    return (await this.get('/collections/cards', options)).json();
  }

  async book(id: string, options?: RequestOptions): Promise<CatalogBookDetail> {
    return (await this.get(`/books/${encodeURIComponent(id)}`, options)).json();
  }

  /**
   * The book's Natively level (2026-11-24). `fresh`: the server reads it again first when the
   * saved one is older than its setting (it waits up to 20 s for Natively).
   */
  async nativelyLevel(
    bookId: string,
    fresh: boolean,
    options?: RequestOptions
  ): Promise<NativelyLevelAnswer> {
    const qs = fresh ? '?fresh=1' : '';
    return (await this.get(`/natively/level/${encodeURIComponent(bookId)}${qs}`, options)).json();
  }

  /** Store ratings of a book (2026-11-25); `fresh` asks old figures again (answered later). */
  async bookRatings(
    bookId: string,
    fresh: boolean,
    options?: RequestOptions
  ): Promise<BookRatingsAnswer> {
    const qs = fresh ? '?fresh=1' : '';
    return (await this.get(`/ratings/book/${encodeURIComponent(bookId)}${qs}`, options)).json();
  }

  /** What the pages show of store ratings (読書メーター only once switched on). */
  async ratingFeatures(options?: RequestOptions): Promise<{ bookmeter: boolean }> {
    return (await this.get('/ratings/features', options)).json();
  }

  async ratingsProgress(options?: RequestOptions): Promise<RatingsProgressAnswer> {
    return (await this.get('/ratings/progress', options)).json();
  }

  async saveRatingSettings(
    patch: Partial<RatingSettings>,
    options?: RequestOptions
  ): Promise<{ settings: RatingSettings; score: { m: number; c: number } }> {
    return (await this.sendJson('PUT', '/ratings/settings', patch, options)).json();
  }

  /** The first pass over the linked books, and the settings (Settings › Library). */
  async nativelyProgress(options?: RequestOptions): Promise<NativelyProgressAnswer> {
    return (await this.get('/natively/progress', options)).json();
  }

  async saveNativelySettings(
    patch: Partial<NativelySettings>,
    options?: RequestOptions
  ): Promise<{ settings: NativelySettings }> {
    return (await this.sendJson('PUT', '/natively/settings', patch, options)).json();
  }

  /**
   * Season 2 §6: the book's illustrations as the server reads them from its file. A list
   * still being made answers `preparing` (ask again shortly). Picture URLs are signed and
   * relative (`absolute()` them).
   */
  async illustrations(id: string, options?: RequestOptions): Promise<ServerIllustrationList> {
    return (await this.get(`/books/${encodeURIComponent(id)}/illustrations`, options)).json();
  }

  /** The book's full-size cover image as stored (not the thumbnail), for the Download menu. */
  async coverImage(id: string, signal: AbortSignal): Promise<Blob> {
    const response = await this.get(`/books/${encodeURIComponent(id)}/cover`, {
      signal,
      timeoutSeconds: 0
    });
    return response.blob();
  }

  /**
   * The full-size cover's size in bytes (a HEAD request: the image isn't sent), or null
   * when the server doesn't say.
   */
  async coverSize(id: string, options: RequestOptions = {}): Promise<number | null> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/books/${encodeURIComponent(id)}/cover`,
      { method: 'HEAD', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (!response.ok) return null;
    const size = Number(response.headers.get('Content-Length'));
    return Number.isFinite(size) && size > 0 ? size : null;
  }

  /**
   * Downloads the EPUB. No timeout (large books on slow Wi-Fi); the caller
   * cancels through `signal`. Reports progress when the size is known.
   */
  async downloadFile(
    id: string,
    signal: AbortSignal,
    onProgress?: (loaded: number, total: number | null) => void
  ): Promise<DownloadResult> {
    const response = await this.get(`/books/${encodeURIComponent(id)}/file`, {
      signal,
      timeoutSeconds: 0
    });
    const totalHeader = Number(response.headers.get('Content-Length'));
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
    const etag = response.headers.get('ETag');
    if (!response.body || !onProgress) {
      return { blob: await response.blob(), etag };
    }
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, total);
      }
    } catch (error) {
      if (signal.aborted) throw new LibraryApiError('aborted', 'Cancelled');
      throw new LibraryApiError(
        'unreachable',
        `The download stopped (${(error as Error).message || 'network error'})`
      );
    }
    return { blob: new Blob(chunks, { type: 'application/epub+zip' }), etag };
  }

  // ---- Audiobooks (WP15a index, WP15b links)

  /** The audiobook index per library; `enabled` false when the server has no audiobooks folder. */
  async audioStatus(options?: RequestOptions): Promise<AudioStatus> {
    return (await this.get('/audio/status', options)).json();
  }

  /** Asks the server to scan its audiobook and subtitle folders again. */
  async requestAudioScan(options?: RequestOptions): Promise<{ requested: string[] }> {
    return (await this.post('/audio/scan', {}, options)).json();
  }

  /** Ranked suggestions for a book. Suggestions only: nothing is linked. */
  async audioCandidates(
    bookId: string,
    limit = 10,
    options?: RequestOptions
  ): Promise<AudioCandidates> {
    const qs = new URLSearchParams({ limit: String(limit) });
    const path = `/books/${encodeURIComponent(bookId)}/audio/candidates?${qs}`;
    return (await this.get(path, options)).json();
  }

  async searchAudiobooks(q: string, options?: RequestOptions): Promise<AudioFolderSummary[]> {
    const qs = new URLSearchParams({ q, kind: 'audio' });
    const body: { audio: AudioFolderSummary[] } = await (
      await this.get(`/audio/search?${qs}`, options)
    ).json();
    return body.audio;
  }

  async searchSubtitles(q: string, options?: RequestOptions): Promise<SubtitleFileSummary[]> {
    const qs = new URLSearchParams({ q, kind: 'subtitle' });
    const body: { subtitles: SubtitleFileSummary[] } = await (
      await this.get(`/audio/search?${qs}`, options)
    ).json();
    return body.subtitles;
  }

  /** The book's confirmed audiobook link, or null when none was chosen yet. */
  async audioLink(bookId: string, options?: RequestOptions): Promise<AudioLink | null> {
    const body: { link: AudioLink | null } = await (
      await this.get(`/books/${encodeURIComponent(bookId)}/audio-link`, options)
    ).json();
    return body.link;
  }

  /** Changes the link with what the user chose; omitted parts are kept. */
  async putAudioLink(
    bookId: string,
    change: AudioLinkChange,
    options?: RequestOptions
  ): Promise<AudioLink> {
    const response = await this.sendJson(
      'PUT',
      `/books/${encodeURIComponent(bookId)}/audio-link`,
      change,
      options
    );
    const body: { link: AudioLink } = await response.json();
    return body.link;
  }

  /** Removes the link (or the "No audiobook" mark): suggestions come back. */
  async deleteAudioLink(bookId: string, options?: RequestOptions): Promise<void> {
    const path = `/books/${encodeURIComponent(bookId)}/audio-link`;
    await this.sendJson('DELETE', path, undefined, options);
  }

  /**
   * WP15c: uploads a book attachment (whispersync's saved subtitles or match). 'stale'
   * when the server already holds newer data. No time limit (a matched book can be
   * large); the caller cancels through `signal`.
   */
  async uploadAttachment(
    bookId: string,
    name: string,
    body: string,
    modifiedAt: number,
    options: RequestOptions = {}
  ): Promise<'ok' | 'stale'> {
    const qs = new URLSearchParams({ modifiedAt: String(Math.round(modifiedAt)) });
    try {
      await this.sendJson(
        'PUT',
        `/books/${encodeURIComponent(bookId)}/attachments/${encodeURIComponent(name)}?${qs}`,
        new Blob([body], { type: 'application/octet-stream' }),
        { timeoutSeconds: 0, ...options }
      );
      return 'ok';
    } catch (error) {
      if (error instanceof LibraryApiError && error.code === 'stale') return 'stale';
      throw error;
    }
  }

  /** A book attachment's text and hash (ETag); null when the server has none. */
  async downloadAttachment(
    bookId: string,
    name: string,
    options: RequestOptions = {}
  ): Promise<{ text: string; sha256: string | null } | null> {
    try {
      const response = await this.get(
        `/books/${encodeURIComponent(bookId)}/attachments/${encodeURIComponent(name)}`,
        { timeoutSeconds: 0, ...options }
      );
      const etag = response.headers.get('ETag');
      return { text: await response.text(), sha256: etag ? etag.replace(/^W\/|"/g, '') : null };
    } catch (error) {
      if (error instanceof LibraryApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** WP15c: the book's confirmed subtitle file, or null when none is linked or it is gone. */
  async linkedSubtitleFile(bookId: string, options?: RequestOptions): Promise<File | null> {
    try {
      const response = await this.get(
        `/books/${encodeURIComponent(bookId)}/subtitle-file`,
        options
      );
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const name = encoded ? decodeURIComponent(encoded) : 'subtitles.srt';
      return new File([await response.blob()], name, {
        type: response.headers.get('Content-Type') ?? 'text/plain'
      });
    } catch (error) {
      if (error instanceof LibraryApiError && (error.status === 404 || error.status === 410)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * WP14: the MP3 of [start, end) seconds of the book's linked audiobook file (sentence
   * audio for Anki), cut on the server.
   */
  async audioClip(
    bookId: string,
    start: number,
    end: number,
    options?: RequestOptions
  ): Promise<ArrayBuffer> {
    const qs = new URLSearchParams({ start: start.toFixed(3), end: end.toFixed(3) });
    const response = await this.get(
      `/books/${encodeURIComponent(bookId)}/audio-clip?${qs}`,
      options
    );
    return response.arrayBuffer();
  }

  /** WP15f: a folder with its files and the copies hint. */
  async audioFolder(folderId: number, options?: RequestOptions): Promise<AudioFolderDetail> {
    return (await this.get(`/audio/folders/${folderId}`, options)).json();
  }

  /** WP15f: asks the server to merge `files` (in this order) of a folder into one file. */
  async startAudioMerge(
    bookId: string,
    folderId: number,
    files: string[],
    options?: RequestOptions
  ): Promise<AudioMergeJob> {
    const response = await this.post(
      `/books/${encodeURIComponent(bookId)}/audio-merge`,
      { folderId, files },
      options
    );
    return ((await response.json()) as { job: AudioMergeJob }).job;
  }

  /** WP15f: the book's latest merge, or null. */
  async audioMerge(bookId: string, options?: RequestOptions): Promise<AudioMergeJob | null> {
    const body: { job: AudioMergeJob | null } = await (
      await this.get(`/books/${encodeURIComponent(bookId)}/audio-merge`, options)
    ).json();
    return body.job;
  }

  /** WP15f: stops a waiting or running merge. */
  async cancelAudioMerge(jobId: number, options?: RequestOptions): Promise<AudioMergeJob> {
    const response = await this.post(`/audio/merges/${jobId}/cancel`, {}, options);
    return ((await response.json()) as { job: AudioMergeJob }).job;
  }

  /**
   * WP16: "Make subtitles on the PC". Returns the queued job, or the archive's subtitle
   * files that look like this book's (nothing queued) unless `force`.
   */
  async startSubtitleJob(
    bookId: string,
    force: boolean,
    options: RequestOptions = {}
  ): Promise<{ job: SubtitleJob } | { archiveMatches: SubtitleFileSummary[] }> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1/books/${encodeURIComponent(bookId)}/subtitle-job`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (response.status === 409) {
      try {
        const body = (await response.clone().json()) as {
          error?: { code?: string; candidates?: SubtitleFileSummary[] };
        };
        if (body.error?.code === 'archive_match') {
          return { archiveMatches: body.error.candidates ?? [] };
        }
      } catch {
        // not JSON
      }
    }
    if (!response.ok) throw await errorFrom(response);
    return { job: ((await response.json()) as { job: SubtitleJob }).job };
  }

  /** WP16: the book's latest subtitle job, or null. */
  async subtitleJob(bookId: string, options?: RequestOptions): Promise<SubtitleJob | null> {
    const body: { job: SubtitleJob | null } = await (
      await this.get(`/books/${encodeURIComponent(bookId)}/subtitle-job`, options)
    ).json();
    return body.job;
  }

  /** WP16: stops a waiting or running subtitle job. */
  async cancelSubtitleJob(jobId: number, options?: RequestOptions): Promise<SubtitleJob> {
    const response = await this.post(`/audio/subtitle-jobs/${jobId}/cancel`, {}, options);
    return ((await response.json()) as { job: SubtitleJob }).job;
  }

  /** WP16: the PC worker's status and the user's waiting/running jobs. */
  async gpuWorker(options?: RequestOptions): Promise<GpuWorkerStatus> {
    return (await this.get('/gpu-worker', options)).json();
  }

  /** WP16: the pause switch (stored on the server). */
  async setGpuWorkerPaused(paused: boolean, options?: RequestOptions): Promise<boolean> {
    const response = await this.sendJson('PUT', '/gpu-worker/paused', { paused }, options);
    return ((await response.json()) as { paused: boolean }).paused;
  }

  // ---- WP17: audiobooks made on the PC, previews, voices, models

  /** The book's chapters as an audiobook would read them (the server reads the EPUB). */
  async audiobookChapters(bookId: string, options: RequestOptions = {}): Promise<BookChapters> {
    return (
      await this.get(`/books/${encodeURIComponent(bookId)}/audiobook-chapters`, {
        timeoutSeconds: 120,
        ...options
      })
    ).json();
  }

  /** "Make an audiobook on the PC": the whole book, as a new version. */
  async startAudiobookJob(
    bookId: string,
    body: AudiobookRequest,
    options: RequestOptions = {}
  ): Promise<AudiobookJob> {
    const response = await this.post(`/books/${encodeURIComponent(bookId)}/audiobook-job`, body, {
      timeoutSeconds: 120,
      ...options
    });
    return ((await response.json()) as { job: AudiobookJob }).job;
  }

  async audiobookJob(bookId: string, options?: RequestOptions): Promise<AudiobookJob | null> {
    const body: { job: AudiobookJob | null } = await (
      await this.get(`/books/${encodeURIComponent(bookId)}/audiobook-job`, options)
    ).json();
    return body.job;
  }

  /** "Preview": about a minute of one chapter. */
  async startAudiobookPreview(
    bookId: string,
    body: AudiobookRequest,
    options: RequestOptions = {}
  ): Promise<AudiobookJob> {
    const response = await this.post(
      `/books/${encodeURIComponent(bookId)}/audiobook-preview`,
      body,
      { timeoutSeconds: 120, ...options }
    );
    return ((await response.json()) as { job: AudiobookJob }).job;
  }

  async audiobookPreview(bookId: string, options?: RequestOptions): Promise<AudiobookJob | null> {
    const body: { job: AudiobookJob | null } = await (
      await this.get(`/books/${encodeURIComponent(bookId)}/audiobook-preview`, options)
    ).json();
    return body.job;
  }

  /** The audio of a finished preview or voice sample. */
  async ttsJobAudio(jobId: number, options: RequestOptions = {}): Promise<Blob> {
    return (
      await this.get(`/audio/tts-jobs/${jobId}/audio`, { timeoutSeconds: 0, ...options })
    ).blob();
  }

  async voices(options?: RequestOptions): Promise<VoiceList> {
    try {
      return await (await this.get('/voices', options)).json();
    } catch (error) {
      if (error instanceof LibraryApiError && error.status === 404) {
        return { available: false, voices: [], limits: null };
      }
      throw error;
    }
  }

  /** Uploads a recording as a voice; the consent confirmation is required by the server. */
  uploadVoice(
    file: Blob,
    name: string,
    consent: boolean,
    options: UploadOptions = {}
  ): Promise<{ voice: VoicePreset }> {
    const qs = new URLSearchParams({ name, consent: consent ? '1' : '0' });
    return this.sendWithProgress(`/voices?${qs}`, file, 'application/octet-stream', options);
  }

  async deleteVoice(id: string, options?: RequestOptions): Promise<void> {
    await this.sendJson('DELETE', `/voices/${encodeURIComponent(id)}`, undefined, options);
  }

  async voiceClip(id: string, options: RequestOptions = {}): Promise<Blob> {
    return (
      await this.get(`/voices/${encodeURIComponent(id)}/clip`, { timeoutSeconds: 0, ...options })
    ).blob();
  }

  /** "Describe a voice": the PC makes a sample from the description. */
  async startVoiceSample(
    body: { name: string; description: string; modelId?: number },
    options?: RequestOptions
  ): Promise<AudiobookJob> {
    const response = await this.post('/voices/samples', body, options);
    return ((await response.json()) as { job: AudiobookJob }).job;
  }

  async latestVoiceSample(options?: RequestOptions): Promise<AudiobookJob | null> {
    const body: { job: AudiobookJob | null } = await (
      await this.get('/voices/samples/latest', options)
    ).json();
    return body.job;
  }

  async keepVoiceSample(jobId: number, options?: RequestOptions): Promise<VoicePreset> {
    const response = await this.post(`/voices/samples/${jobId}/keep`, {}, options);
    return ((await response.json()) as { voice: VoicePreset }).voice;
  }

  async ttsModels(options?: RequestOptions): Promise<{ available: boolean; models: TtsModel[] }> {
    try {
      return await (await this.get('/tts/models', options)).json();
    } catch (error) {
      if (error instanceof LibraryApiError && error.status === 404) {
        return { available: false, models: [] };
      }
      throw error;
    }
  }

  async addTtsModel(source: string, options: RequestOptions = {}): Promise<TtsModel> {
    const response = await this.post('/tts/models', { source }, { timeoutSeconds: 60, ...options });
    return ((await response.json()) as { model: TtsModel }).model;
  }

  async removeTtsModel(id: number, options?: RequestOptions): Promise<void> {
    await this.sendJson('DELETE', `/tts/models/${id}`, undefined, options);
  }

  async setDefaultTtsModel(id: number, options?: RequestOptions): Promise<TtsModel[]> {
    const response = await this.sendJson('PUT', `/tts/models/${id}/default`, {}, options);
    return ((await response.json()) as { models: TtsModel[] }).models;
  }

  // ---- Season 2 Phase 12 session 5: per-character voices

  /** The book's speakers: characters, the latest job, counts. Null: an older server. */
  async speakers(
    bookId: string,
    below: number,
    options?: RequestOptions
  ): Promise<SpeakerOverview | null> {
    try {
      return await (
        await this.get(`/books/${encodeURIComponent(bookId)}/speakers?below=${below}`, options)
      ).json();
    } catch (error) {
      if (error instanceof LibraryApiError && (error.status === 404 || error.status === 503)) {
        return null;
      }
      throw error;
    }
  }

  /** "Find who speaks each quote": queues a run on the PC with the chosen model. */
  async runSpeakers(bookId: string, modelId: number | null, options?: RequestOptions) {
    const response = await this.post(
      `/books/${encodeURIComponent(bookId)}/speakers/run`,
      modelId === null ? {} : { modelId },
      { timeoutSeconds: 120, ...options }
    );
    return ((await response.json()) as { job: SubtitleJob }).job;
  }

  async speakerQuotes(
    bookId: string,
    q: { filter: QuoteFilter; character?: number; below: number; offset: number; limit: number },
    options?: RequestOptions
  ): Promise<{ items: SpeakerQuoteItem[]; total: number }> {
    const params = new URLSearchParams({
      filter: q.filter,
      below: String(q.below),
      offset: String(q.offset),
      limit: String(q.limit)
    });
    if (q.character !== undefined) params.set('character', String(q.character));
    return (
      await this.get(`/books/${encodeURIComponent(bookId)}/speakers/quotes?${params}`, {
        timeoutSeconds: 120,
        ...options
      })
    ).json();
  }

  /** The user's speaker for a quote (null: no speaker), or back to the model's (reset). */
  async setQuoteSpeaker(
    bookId: string,
    quote: number,
    body: { character: number | null } | { reset: true },
    options?: RequestOptions
  ) {
    const response = await this.sendJson(
      'PATCH',
      `/books/${encodeURIComponent(bookId)}/speakers/quotes/${quote}`,
      body,
      options
    );
    return ((await response.json()) as { quote: unknown }).quote;
  }

  async addCharacter(bookId: string, name: string, options?: RequestOptions) {
    const response = await this.post(
      `/books/${encodeURIComponent(bookId)}/speakers/characters`,
      { name },
      options
    );
    return ((await response.json()) as { character: SpeakerCharacter }).character;
  }

  /** Renames, sets the voice (null: the dialogue voice) or hides ("not a character"). */
  async editCharacter(
    bookId: string,
    id: number,
    body: { name?: string; voiceId?: string | null; hidden?: boolean },
    options?: RequestOptions
  ) {
    const response = await this.sendJson(
      'PATCH',
      `/books/${encodeURIComponent(bookId)}/speakers/characters/${id}`,
      body,
      options
    );
    return ((await response.json()) as { character: SpeakerCharacter }).character;
  }

  async mergeCharacter(bookId: string, id: number, into: number, options?: RequestOptions) {
    const response = await this.post(
      `/books/${encodeURIComponent(bookId)}/speakers/characters/${id}/merge`,
      { into },
      options
    );
    return ((await response.json()) as { character: SpeakerCharacter }).character;
  }

  async setNarrationBy(bookId: string, by: 'narration' | 'narrator', options?: RequestOptions) {
    await this.sendJson(
      'PUT',
      `/books/${encodeURIComponent(bookId)}/speakers/narration`,
      { by },
      options
    );
  }

  /** Settings > Audiobooks: the speaker model list (available false: an older server). */
  async speakerModels(
    options?: RequestOptions
  ): Promise<{ available: boolean; models: SpeakerModel[] }> {
    try {
      const body = (await (await this.get('/speaker-models', options)).json()) as {
        models: SpeakerModel[];
      };
      return { available: true, models: body.models };
    } catch (error) {
      if (error instanceof LibraryApiError && (error.status === 404 || error.status === 503)) {
        return { available: false, models: [] };
      }
      throw error;
    }
  }

  async addSpeakerModel(repo: string, file: string, options: RequestOptions = {}) {
    const response = await this.post(
      '/speaker-models',
      { repo, file },
      { timeoutSeconds: 60, ...options }
    );
    return ((await response.json()) as { model: SpeakerModel }).model;
  }

  async removeSpeakerModel(id: number, options?: RequestOptions): Promise<void> {
    await this.sendJson('DELETE', `/speaker-models/${id}`, undefined, options);
  }

  async setDefaultSpeakerModel(id: number, options?: RequestOptions): Promise<void> {
    await this.sendJson('PUT', `/speaker-models/${id}/default`, {}, options);
  }

  // ---- Season 2 Phase 12: Enrich's sentence audio read by the PC, and the PC voice

  /** The PC voice for every book (Settings > Anki); null = sentence audio from the PC is off. */
  async voiceChoice(options?: RequestOptions): Promise<VoiceChoice | null> {
    return (
      (await (await this.get('/tts/voice-choice', options)).json()) as {
        choice: VoiceChoice | null;
      }
    ).choice;
  }

  async setVoiceChoice(
    choice: { voiceId: string; dialogueVoiceId?: string | null; modelId: number } | null,
    options?: RequestOptions
  ): Promise<VoiceChoice | null> {
    if (!choice) {
      await this.sendJson('DELETE', '/tts/voice-choice', undefined, options);
      return null;
    }
    const response = await this.sendJson('PUT', '/tts/voice-choice', choice, options);
    return ((await response.json()) as { choice: VoiceChoice | null }).choice;
  }

  /** The book's own PC voice, the one for every book, and which one is used. */
  async bookVoiceChoice(bookId: string, options?: RequestOptions): Promise<BookVoiceChoices> {
    return (
      await this.get(`/books/${encodeURIComponent(bookId)}/tts-voice-choice`, options)
    ).json();
  }

  /** Sets the book's own PC voice, or (null) uses the one for every book again. */
  async setBookVoiceChoice(
    bookId: string,
    choice: { voiceId: string; dialogueVoiceId?: string | null; modelId: number } | null,
    options?: RequestOptions
  ): Promise<BookVoiceChoices> {
    const path = `/books/${encodeURIComponent(bookId)}/tts-voice-choice`;
    const response = choice
      ? await this.sendJson('PUT', path, choice, options)
      : await this.sendJson('DELETE', path, undefined, options);
    return response.json();
  }

  /** Asks the PC to read an Enrich sentence for a book without an audiobook. */
  async queueSentenceAudio(
    bookId: string,
    body: { text: string; position: number; pauses: TtsPauses },
    options: RequestOptions = {}
  ): Promise<SentenceClip> {
    const response = await this.post(
      `/books/${encodeURIComponent(bookId)}/sentence-audio`,
      body,
      // The server reads the book's text first (a large book takes a few seconds).
      { timeoutSeconds: this.timeoutSeconds && Math.max(this.timeoutSeconds, 120), ...options }
    );
    return ((await response.json()) as { clip: SentenceClip }).clip;
  }

  async sentenceAudioStatus(
    clipId: string,
    options?: RequestOptions
  ): Promise<{ clip: SentenceClip; pc: SentencePc }> {
    return (await this.get(`/sentence-audio/${encodeURIComponent(clipId)}`, options)).json();
  }

  /** The finished clip (MP3). */
  async sentenceAudioFile(clipId: string, options: RequestOptions = {}): Promise<ArrayBuffer> {
    return (
      await this.get(`/sentence-audio/${encodeURIComponent(clipId)}/audio`, {
        timeoutSeconds: 0,
        ...options
      })
    ).arrayBuffer();
  }

  /** The device has the clip (or doesn't want it any more): the server lets it go. */
  async dropSentenceAudio(clipId: string, options?: RequestOptions): Promise<void> {
    await this.sendJson(
      'DELETE',
      `/sentence-audio/${encodeURIComponent(clipId)}`,
      undefined,
      options
    );
  }

  // ---- Season 2 Phase 12 session 3: live read-aloud with the PC voice

  /** Starts read-aloud for a library book (null: a book outside the library). */
  async startReadAloud(
    bookId: string | null,
    pauses: TtsPauses,
    options?: RequestOptions
  ): Promise<ReadAloudSession> {
    const response = await this.post('/read-aloud/sessions', { bookId, pauses }, options);
    return ((await response.json()) as { session: ReadAloudSession }).session;
  }

  /** Sentences to read next (`replace`: the waiting ones are dropped first). */
  async readAloudBatch(
    sessionId: string,
    sentences: ReadAloudSentence[],
    replace: boolean,
    options?: RequestOptions
  ): Promise<number> {
    const response = await this.post(
      `/read-aloud/sessions/${encodeURIComponent(sessionId)}/batches`,
      { sentences, replace },
      // The server applies the pronunciation fixes first (a pattern may take a while).
      { timeoutSeconds: this.timeoutSeconds && Math.max(this.timeoutSeconds, 30), ...options }
    );
    return ((await response.json()) as { seq: number }).seq;
  }

  /** The session, held open up to `wait` seconds until something changes. */
  async readAloudPoll(
    sessionId: string,
    { after, wait, playing }: { after: number; wait: number; playing: boolean },
    options: RequestOptions = {}
  ): Promise<ReadAloudSession> {
    const qs = `?after=${after}&wait=${wait}&playing=${playing ? 1 : 0}`;
    const response = await this.get(`/read-aloud/sessions/${encodeURIComponent(sessionId)}${qs}`, {
      timeoutSeconds: (this.timeoutSeconds || 20) + wait,
      ...options
    });
    return ((await response.json()) as { session: ReadAloudSession }).session;
  }

  /** A batch's MP3. */
  async readAloudAudio(
    sessionId: string,
    seq: number,
    options: RequestOptions = {}
  ): Promise<ArrayBuffer> {
    return (
      await this.get(`/read-aloud/sessions/${encodeURIComponent(sessionId)}/batches/${seq}/audio`, {
        timeoutSeconds: 0,
        ...options
      })
    ).arrayBuffer();
  }

  /** Stop: the session ends (the PC keeps the voice for the keep time). */
  async stopReadAloud(sessionId: string, options?: RequestOptions): Promise<void> {
    await this.sendJson(
      'DELETE',
      `/read-aloud/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      options
    );
  }

  /** Settings > Audiobooks: how long the PC keeps its voice loaded after the last use. */
  async setKeepLoaded(minutes: number, options?: RequestOptions): Promise<number> {
    const response = await this.sendJson('PUT', '/gpu-worker/keep-loaded', { minutes }, options);
    return ((await response.json()) as { keepLoadedMinutes: number }).keepLoadedMinutes;
  }

  // ---- Season 2 Phase 12: pronunciation fixes for the PC voices

  /** A book's list (bookId), or the global one (null). */
  async pronunciationFixes(bookId: string | null, options?: RequestOptions): Promise<FixList> {
    const qs = bookId ? `?bookId=${encodeURIComponent(bookId)}` : '';
    try {
      return await (await this.get(`/pronunciation-fixes${qs}`, options)).json();
    } catch (error) {
      if (error instanceof LibraryApiError && error.status === 404 && !bookId) {
        // An older server without pronunciation fixes.
        return {
          available: false,
          entries: [],
          limits: {
            wordMax: 0,
            patternMax: 0,
            readingMax: 0,
            entriesPerList: 0,
            timeoutSeconds: null
          }
        };
      }
      throw error;
    }
  }

  /** Adds a fix; a pattern for a book's list is tried on the book first (can take a while). */
  async addPronunciationFix(
    bookId: string | null,
    fix: FixInput,
    options: RequestOptions = {}
  ): Promise<PronunciationFix> {
    const response = await this.post(
      '/pronunciation-fixes',
      { ...fix, ...(bookId ? { bookId } : {}) },
      { timeoutSeconds: 120, ...options }
    );
    return ((await response.json()) as { entry: PronunciationFix }).entry;
  }

  async updatePronunciationFix(
    id: number,
    fix: FixInput,
    options: RequestOptions = {}
  ): Promise<PronunciationFix> {
    const response = await this.sendJson('PATCH', `/pronunciation-fixes/${id}`, fix, {
      timeoutSeconds: 120,
      ...options
    });
    return ((await response.json()) as { entry: PronunciationFix }).entry;
  }

  async removePronunciationFix(id: number, options?: RequestOptions): Promise<void> {
    await this.sendJson('DELETE', `/pronunciation-fixes/${id}`, undefined, options);
  }

  /** The text check: each fix's places in the book (the server reads the EPUB). */
  async pronunciationCheck(
    bookId: string,
    options: RequestOptions = {}
  ): Promise<PronunciationCheck> {
    return (
      await this.get(`/books/${encodeURIComponent(bookId)}/pronunciation-check`, {
        timeoutSeconds: 120,
        ...options
      })
    ).json();
  }

  /** Every link of this user, problems first. */
  async audioLinks(options?: RequestOptions): Promise<AudioLinkListEntry[]> {
    const body: { links: AudioLinkListEntry[] } = await (
      await this.get('/audio/links', options)
    ).json();
    return body.links;
  }

  /**
   * Absolute URL for a relative API path such as a book's thumbnail. A `blob:` or `data:`
   * URL (the offline Library's stored covers) is already absolute and passes through.
   */
  absolute(relative: string): string {
    if (/^(blob|data):/.test(relative)) return relative;
    return `${this.serverUrl}${relative}`;
  }
}
