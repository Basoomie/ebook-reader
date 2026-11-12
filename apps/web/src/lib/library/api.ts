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
import type {
  AudioCandidates,
  AudioFolderSummary,
  AudioLink,
  AudioLinkChange,
  AudioLinkListEntry,
  AudioStatus,
  SubtitleFileSummary
} from '$lib/audio/audio-types';

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
    readonly span?: { start: number; end: number }
  ) {
    super(message);
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** 0 = no limit. */
  timeoutSeconds?: number;
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
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; start?: unknown; end?: unknown };
    };
    code = body.error?.code;
    if (body.error?.message) message = body.error.message;
    if (typeof body.error?.start === 'number' && typeof body.error?.end === 'number') {
      span = { start: body.error.start, end: body.error.end };
    }
  } catch {
    // not JSON
  }
  if (response.status === 401 && code !== 'invalid_code') {
    return new LibraryApiError('unauthorized', message, 401, code);
  }
  return new LibraryApiError('server', message, response.status, code, span);
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
  ): Promise<{ maxBytes: number; fonts: ServerFontInfo[] } | null> {
    try {
      return await (await this.get('/fonts', options)).json();
    } catch (error) {
      if (error instanceof LibraryApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** A font file (WP13). */
  async downloadFont(id: string, options: RequestOptions = {}): Promise<Blob> {
    const response = await this.get(`/fonts/${encodeURIComponent(id)}/file`, {
      timeoutSeconds: 0,
      ...options
    });
    return response.blob();
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
    method: 'PUT' | 'DELETE',
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

  /** Browse tabs (WP7a): one card per series, author or tag with a matching book. */
  async groups(
    query: {
      by: GroupBy;
      q?: string;
      library?: string;
      cursor?: string;
      limit?: number;
      /** WP19a; absent = recently added first. */
      sort?: ServerSort<string>;
    },
    options?: RequestOptions
  ): Promise<CatalogGroupPage> {
    const params = new URLSearchParams({ by: query.by });
    if (query.q) params.set('q', query.q);
    if (query.library) params.set('library', query.library);
    if (query.sort) {
      params.set('sort', query.sort.key);
      params.set('dir', query.sort.dir);
    }
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    return (await this.get(`/groups?${params.toString()}`, options)).json();
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

  /** Count and collage tiles of every collection (WP8b). */
  async collectionCards(options?: RequestOptions): Promise<{ cards: CollectionCardData[] }> {
    return (await this.get('/collections/cards', options)).json();
  }

  async book(id: string, options?: RequestOptions): Promise<CatalogBookDetail> {
    return (await this.get(`/books/${encodeURIComponent(id)}`, options)).json();
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

  /** Every link of this user, problems first. */
  async audioLinks(options?: RequestOptions): Promise<AudioLinkListEntry[]> {
    const body: { links: AudioLinkListEntry[] } = await (
      await this.get('/audio/links', options)
    ).json();
    return body.links;
  }

  /** Absolute URL for a relative API path such as a book's thumbnail. */
  absolute(relative: string): string {
    return `${this.serverUrl}${relative}`;
  }
}
