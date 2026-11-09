/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CatalogBookDetail, CatalogLibrary, CatalogPage } from '$lib/library/types';

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
    readonly code?: string
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

async function send(
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

async function errorFrom(response: Response): Promise<LibraryApiError> {
  let code: string | undefined;
  let message = `The library server answered ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // not JSON
  }
  if (response.status === 401 && code !== 'invalid_code') {
    return new LibraryApiError('unauthorized', message, 401, code);
  }
  return new LibraryApiError('server', message, response.status, code);
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

export class LibraryApi {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 0,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

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

  async libraries(
    options?: RequestOptions
  ): Promise<{ indexer: { enabled: boolean; error: string | null }; libraries: CatalogLibrary[] }> {
    return (await this.get('/libraries', options)).json();
  }

  async books(
    query: { q?: string; library?: string; cursor?: string; limit?: number },
    options?: RequestOptions
  ): Promise<CatalogPage> {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.library) params.set('library', query.library);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return (await this.get(`/books${qs ? `?${qs}` : ''}`, options)).json();
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

  /** Absolute URL for a relative API path such as a book's thumbnail. */
  absolute(relative: string): string {
    return `${this.serverUrl}${relative}`;
  }
}
