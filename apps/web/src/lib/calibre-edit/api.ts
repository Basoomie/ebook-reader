/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { LibraryApiError, send, type RequestOptions } from '$lib/library/api';
import type {
  CoverStore,
  EarlierCovers,
  StoreCover,
  EditForm,
  FieldStatus,
  HistoryEntry,
  SaveResult,
  SeriesView,
  TagGroupId,
  TagList
} from './types';

/** An answer the server refused, with its details (the byte count, the shared names). */
export class EditApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** Calibre metadata editing (the server's /books/:id/calibre-edit, /history, /calibre-*). */
export class CalibreEditApi {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 30,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const raw = body instanceof Blob;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined)
      headers['Content-Type'] = raw
        ? (body as Blob).type || 'application/octet-stream'
        : 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : raw ? (body as Blob) : JSON.stringify(body)
      },
      { timeoutSeconds: this.timeoutSeconds, ...options }
    );
    if (!response.ok) {
      let code = 'http_error';
      let message = `The library server answered ${response.status}`;
      let details: Record<string, unknown> = {};
      try {
        const j = (await response.json()) as { error?: Record<string, unknown> };
        if (j.error) {
          const { code: c, message: m, ...rest } = j.error;
          if (typeof c === 'string') code = c;
          if (typeof m === 'string') message = m;
          details = rest;
        }
      } catch {
        // not JSON
      }
      throw new EditApiError(response.status, code, message, details);
    }
    return (await response.json()) as T;
  }

  form(bookId: string, options?: RequestOptions): Promise<EditForm> {
    return this.call(
      'GET',
      `/books/${encodeURIComponent(bookId)}/calibre-edit`,
      undefined,
      options
    );
  }

  save(
    bookId: string,
    body: {
      base?: Record<string, unknown>;
      values?: Record<string, unknown>;
      coverToken?: string | null;
      confirm?: string[];
      acceptRenames?: boolean;
    }
  ): Promise<SaveResult> {
    return this.call('POST', `/books/${encodeURIComponent(bookId)}/calibre-edit`, body);
  }

  status(
    bookId: string,
    options?: RequestOptions
  ): Promise<{ status: FieldStatus[]; writer: { ready: boolean; wait: string | null } }> {
    return this.call(
      'GET',
      `/books/${encodeURIComponent(bookId)}/calibre-edit/status`,
      undefined,
      options
    );
  }

  /** A picture for the next save (uploaded, dropped, or an illustration's own bytes). */
  cover(bookId: string, picture: Blob): Promise<{ token: string; sha256: string }> {
    return this.call('POST', `/books/${encodeURIComponent(bookId)}/calibre-edit/cover`, picture, {
      timeoutSeconds: 0
    });
  }

  /** A picture behind the login (the form shows it from a blob). */
  private async picture(path: string): Promise<Blob> {
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
      { timeoutSeconds: 0 }
    );
    if (!response.ok)
      throw new EditApiError(response.status, 'picture', 'The picture could not be read');
    return response.blob();
  }

  /** Book covers: every picture the book's cover has had that the server keeps. */
  earlierCovers(bookId: string, options?: RequestOptions): Promise<EarlierCovers> {
    return this.call(
      'GET',
      `/books/${encodeURIComponent(bookId)}/calibre-edit/covers`,
      undefined,
      options
    );
  }

  earlierCoverPicture(bookId: string, sha256: string): Promise<Blob> {
    return this.picture(
      `/books/${encodeURIComponent(bookId)}/calibre-edit/covers/${encodeURIComponent(sha256)}`
    );
  }

  /** An earlier cover, kept for the next save like an upload. */
  useEarlierCover(bookId: string, sha256: string): Promise<{ token: string; sha256: string }> {
    return this.call(
      'POST',
      `/books/${encodeURIComponent(bookId)}/calibre-edit/covers/${encodeURIComponent(sha256)}/use`,
      {}
    );
  }

  /** Book covers: the stores' pictures (asked through the server; `again` asks a failed one again). */
  storeCovers(
    bookId: string,
    again = false,
    options?: RequestOptions
  ): Promise<{ stores: StoreCover[]; fetcher: boolean }> {
    return this.call(
      'GET',
      `/books/${encodeURIComponent(bookId)}/calibre-edit/store-covers${again ? '?again=1' : ''}`,
      undefined,
      options
    );
  }

  storeCoverPicture(bookId: string, store: CoverStore): Promise<Blob> {
    return this.picture(
      `/books/${encodeURIComponent(bookId)}/calibre-edit/store-covers/${store}/picture`
    );
  }

  /** A store's picture, kept for the next save like an upload. */
  useStoreCover(bookId: string, store: CoverStore): Promise<{ token: string; sha256: string }> {
    return this.call(
      'POST',
      `/books/${encodeURIComponent(bookId)}/calibre-edit/store-covers/${store}/use`,
      {}
    );
  }

  history(bookId: string, options?: RequestOptions): Promise<{ entries: HistoryEntry[] }> {
    return this.call('GET', `/books/${encodeURIComponent(bookId)}/history`, undefined, options);
  }

  undo(bookId: string, entryId: string): Promise<SaveResult> {
    return this.call(
      'POST',
      `/books/${encodeURIComponent(bookId)}/history/${encodeURIComponent(entryId)}/undo`,
      {}
    );
  }

  series(name: string, libraryId?: string, options?: RequestOptions): Promise<SeriesView> {
    const q = new URLSearchParams({ name, ...(libraryId ? { library: libraryId } : {}) });
    return this.call('GET', `/calibre-series?${q.toString()}`, undefined, options);
  }

  saveSeries(body: {
    libraryId?: string;
    name: string;
    rename?: string | null;
    books?: {
      bookId: string;
      base?: { title?: string; index?: number | null };
      title?: string;
      index?: number | null;
    }[];
    confirm?: string[];
    merge?: string | null;
    acceptRenames?: boolean;
  }): Promise<{ batchId: string | null; books: number }> {
    return this.call('POST', '/calibre-series', body);
  }

  notSameSeries(body: { libraryId?: string; name: string; other: string }): Promise<unknown> {
    return this.call('POST', '/calibre-series/not-same', body);
  }

  tags(options?: RequestOptions): Promise<TagList> {
    return this.call('GET', '/calibre-tags', undefined, options);
  }

  changeTags(change: { group: TagGroupId; add?: string; remove?: string }): Promise<TagList> {
    return this.call('PUT', '/calibre-tags', change);
  }

  resetTags(): Promise<TagList> {
    return this.call('PUT', '/calibre-tags', { reset: true });
  }
}

/** Whether an error means the server can't be reached (the page greys editing out). */
export function editUnreachable(err: unknown): boolean {
  return err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout');
}
