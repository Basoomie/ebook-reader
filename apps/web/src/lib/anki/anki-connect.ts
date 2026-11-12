/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP14: a small AnkiConnect client (desktop AnkiConnect or AnkiConnect Android), with a
 * timeout on every request. Separate from whispersync's own client, which is unchanged.
 *
 * AnkiConnect Android answers requestPermission with a JSON parse error from its server
 * library; that is how it is told apart (the same signal whispersync uses). It has no
 * `gui*` actions.
 */

export type AnkiErrorKind = 'unreachable' | 'timeout' | 'denied' | 'anki';

export class AnkiConnectError extends Error {
  constructor(
    readonly kind: AnkiErrorKind,
    message: string
  ) {
    super(message);
  }
}

export interface NoteInfo {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AnkiConnectOptions {
  url: string;
  key?: string;
  timeoutSeconds: number;
  fetchImpl?: FetchLike;
}

const ANDROID_SIGNAL = 'MalformedJsonException';

export class AnkiConnect {
  readonly url: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private android: boolean | null = null;

  constructor(options: AnkiConnectOptions) {
    this.url = options.url.trim().replace(/\/+$/, '');
    this.key = options.key?.trim() ?? '';
    this.timeoutMs = Math.max(1, options.timeoutSeconds) * 1000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Whether this is AnkiConnect Android (known after `connect`). */
  get isAndroid(): boolean {
    return this.android === true;
  }

  async invoke<T>(action: string, params?: Record<string, unknown>): Promise<T> {
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, this.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          version: 6,
          ...(params ? { params } : {}),
          ...(this.key ? { key: this.key } : {})
        }),
        signal: controller?.signal
      });
    } catch {
      throw timedOut
        ? new AnkiConnectError('timeout', `Anki didn't answer in time at ${this.url}.`)
        : new AnkiConnectError(
            'unreachable',
            `Anki didn't answer at ${this.url}. Is Anki open with AnkiConnect?`
          );
    } finally {
      clearTimeout(timer);
    }

    let body: { result?: T; error?: string | null };

    try {
      body = await response.json();
    } catch {
      throw new AnkiConnectError(
        'anki',
        `AnkiConnect sent an unexpected answer (${response.status}).`
      );
    }

    if (body && typeof body === 'object' && 'error' in body && body.error) {
      throw new AnkiConnectError('anki', String(body.error));
    }

    if (!response.ok) {
      throw new AnkiConnectError('anki', `AnkiConnect answered ${response.status}.`);
    }

    return (body && typeof body === 'object' && 'result' in body ? body.result : body) as T;
  }

  /** Asks for permission once and finds out whether this is AnkiConnect Android. */
  async connect(): Promise<void> {
    if (this.android !== null) {
      return;
    }

    try {
      const result = await this.invoke<{ permission?: string }>('requestPermission');

      if (result?.permission === 'denied') {
        throw new AnkiConnectError(
          'denied',
          'AnkiConnect refused this page. Allow it in the AnkiConnect permission prompt.'
        );
      }

      this.android = false;
    } catch (error) {
      if (error instanceof AnkiConnectError && error.message.includes(ANDROID_SIGNAL)) {
        this.android = true;
        return;
      }

      throw error;
    }
  }

  async noteTypes(): Promise<string[]> {
    await this.connect();
    const names = await this.invoke<string[]>('modelNames');
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  async fieldNames(noteType: string): Promise<string[]> {
    await this.connect();
    return this.invoke<string[]>('modelFieldNames', { modelName: noteType });
  }

  /** The most recently added note in the last `days` days (highest note id), or null. */
  async newestNote(days: number): Promise<NoteInfo | null> {
    await this.connect();
    const ids = await this.invoke<number[]>('findNotes', {
      query: `added:${Math.max(1, Math.round(days))}`
    });

    if (!ids?.length) {
      return null;
    }

    const newest = ids.reduce((a, b) => (b > a ? b : a));
    const [info] = await this.invoke<NoteInfo[]>('notesInfo', { notes: [newest] });

    return info && info.noteId ? info : null;
  }

  async storeMedia(fileName: string, base64: string): Promise<string> {
    const stored = await this.invoke<string | null>('storeMediaFile', {
      filename: fileName,
      data: base64
    });

    return typeof stored === 'string' && stored ? stored : fileName;
  }

  async updateFields(noteId: number, fields: Record<string, string>): Promise<void> {
    await this.invoke('updateNoteFields', { note: { id: noteId, fields } });
  }

  async addTags(noteId: number, tags: string): Promise<void> {
    await this.invoke('addTags', { notes: [noteId], tags });
  }

  /**
   * Desktop only: Anki's editor can drop an update to the note it is showing, so a
   * Browse window that has it selected is moved off it first (as whispersync does).
   * Returns the selection to put back, or null.
   */
  async releaseNote(noteId: number): Promise<number[] | null> {
    if (this.android) return null;

    try {
      const selected = await this.invoke<number[]>('guiSelectedNotes');

      if (!selected?.includes(noteId)) {
        return null;
      }

      await this.invoke('guiSelectNote', { note: 1 });
      return selected;
    } catch {
      return null;
    }
  }

  async restoreSelection(selected: number[] | null): Promise<void> {
    if (!selected?.length || this.android) return;

    try {
      await this.invoke('guiSelectNote', { note: selected[selected.length - 1] });
    } catch {
      // Only the Browse window's selection is lost.
    }
  }
}
