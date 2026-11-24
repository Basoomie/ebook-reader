/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { errorFrom, send } from '$lib/library/api';

/**
 * Book summaries (session 3): the server's /api/v1/summaries routes. Session 4's book page uses
 * them; session 3 uses the estimate (bulk "Mark completed") and the current summary (kept on the
 * device for offline use).
 */

export type SummarySectionKey =
  | 'overview'
  | 'chapters'
  | 'characters'
  | 'relationships'
  | 'terms'
  | 'threads';

export interface RubyPiece {
  t: string;
  r?: string;
}

export interface SummaryItemView {
  id: number;
  ref: string;
  section: SummarySectionKey;
  chapter: number | null;
  chapterTitle: string | null;
  text: string;
  heading?: string;
  between?: [string, string];
  /** Relationships: one or two words naming it (the diagram's line label; session 4). */
  label?: string;
  ruby?: RubyPiece[];
  betweenRuby?: [RubyPiece[] | null, RubyPiece[] | null];
  cites: string[];
  quote: string | null;
  position: number | null;
  showQuote: boolean;
  /** Changed or added by the user ("edited by you"). */
  editedByUser: boolean;
  addedByUser: boolean;
}

export interface SummaryView {
  id: number;
  bookId: string;
  state: 'current' | 'earlier';
  origin: 'ai' | 'user' | 'import';
  setup: string | null;
  models: string[];
  background: boolean;
  /** The book's language. */
  lang: string;
  /** This view's language (a translation when it differs from `lang`). */
  viewLang: string;
  bookTitle: string;
  madeAt: number;
  createdAt: number;
  replacedAt: number | null;
  editedAt: number | null;
  note: string | null;
  sections: {
    key: SummarySectionKey;
    groups: { chapter?: number; title?: string; items: SummaryItemView[] }[];
  }[];
  alsoMentioned: string[];
  /** Items of a translation still waiting (shown in the original). */
  untranslated: string[];
  /** The languages saved for the book (its own first). */
  languages: string[];
}

/** What every device knows of a book's summary (the "book-summary" record). */
export interface BookSummaryRecord {
  summary: {
    id: number;
    origin: 'ai' | 'user' | 'import';
    setup: string | null;
    models: string[];
    lang: string;
    madeAt: number;
    editedAt: number | null;
    background: boolean;
    /** Each saved language with a digest of its current text. */
    langs: Record<string, string>;
  } | null;
  /** A summary being made now (queued or running). */
  making: 'queued' | 'running' | null;
  /** A running job's step (session 4's progress); null when not running or an older server. */
  phase?: SummaryPhase | null;
  /** When the running job started. */
  since?: number | null;
  /** The last automatic or requested run: made, failed (every setup) or no text. */
  outcome: 'made' | 'failed' | 'no_text' | null;
  /** "No text to summarize", or why every setup failed. */
  note: string | null;
}

export type SummaryPhase = 'reading' | 'checking' | 'writing' | 'translating';

/** One version of a book's summary (Earlier versions; the current one included). */
export interface SummaryMeta {
  id: number;
  bookId: string;
  state: 'current' | 'earlier';
  origin: 'ai' | 'user' | 'import';
  setup: string | null;
  models: string[];
  background: boolean;
  lang: string;
  bookTitle: string;
  madeAt: number;
  createdAt: number;
  replacedAt: number | null;
  editedAt: number | null;
  note: string | null;
}

export interface SummaryJob {
  id: number;
  bookId: string;
  kind: 'auto' | 'regenerate' | 'translate';
  lang: string | null;
  state: 'queued' | 'running' | 'done' | 'failed' | 'no_text' | 'cancelled';
  setup: string | null;
  phase?: SummaryPhase | null;
  attempts: { setup: string; reason: string; at: number }[];
  waiting: string | null;
  afterVolume: boolean;
  error: string | null;
  costUsd: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** The summaries' settings on the server (Settings › Library › Summaries). */
export interface SummaryRouteSetup {
  finders: string[];
  writer: string;
}
export interface SummaryServerSettings {
  route: SummaryRouteSetup[];
  translator: string;
  fallbackAfterMinutes: number;
  parallelBooks: number;
  costPer100kChars: number;
}

/** What the user types for an item (Edit, Add, Write my own). */
export interface SummaryItemInput {
  text: string;
  heading?: string | null;
  between?: [string, string] | null;
  label?: string | null;
  chapter?: number | null;
  chapterTitle?: string | null;
}

/** Write my own: the whole summary at once. */
export interface OwnSummaryInput {
  overview?: string;
  sections?: { key: SummarySectionKey; items: SummaryItemInput[] }[];
  alsoMentioned?: string[];
}

export interface SummaryEstimate {
  /** The books that would get a summary (never completed before, no summary, with text). */
  books: string[];
  characters: number;
  usd: number;
  per100k: number;
}

export class SummaryApi {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 0,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutSeconds = this.timeoutSeconds
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    if (response.status === 204) return undefined as T;
    // A 202 may carry a body (Regenerate's job id) or none (a translation asked for).
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private book(bookId: string): string {
    return `/summaries/${encodeURIComponent(bookId)}`;
  }

  /** The current summary in a language (the book's when not given). */
  get(
    bookId: string,
    lang?: string
  ): Promise<{ summary: SummaryView | null; state: BookSummaryRecord }> {
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : '';
    return this.request('GET', `/summaries/${encodeURIComponent(bookId)}${q}`);
  }

  estimate(bookIds: string[]): Promise<SummaryEstimate> {
    return this.request('POST', '/summaries/estimate', { bookIds });
  }

  regenerate(bookId: string): Promise<{ job: number }> {
    return this.request('POST', `/summaries/${encodeURIComponent(bookId)}/regenerate`);
  }

  translate(bookId: string, lang: string): Promise<void> {
    return this.request('POST', `/summaries/${encodeURIComponent(bookId)}/translate`, { lang });
  }

  // ---- session 4: the book page's actions ----

  writeOwn(bookId: string, body: OwnSummaryInput): Promise<{ summary: SummaryView }> {
    return this.request('PUT', `${this.book(bookId)}/own`, body);
  }

  editOverview(bookId: string, text: string): Promise<{ item: SummaryItemView }> {
    return this.request('PUT', `${this.book(bookId)}/overview`, { text });
  }

  addItem(
    bookId: string,
    section: SummarySectionKey,
    input: SummaryItemInput
  ): Promise<{ item: SummaryItemView }> {
    return this.request('POST', `${this.book(bookId)}/items`, { section, ...input });
  }

  editItem(
    bookId: string,
    itemId: number,
    input: Partial<SummaryItemInput> & { text: string }
  ): Promise<{ item: SummaryItemView }> {
    return this.request('PUT', `${this.book(bookId)}/items/${itemId}`, input);
  }

  deleteItem(bookId: string, itemId: number): Promise<void> {
    return this.request('DELETE', `${this.book(bookId)}/items/${itemId}`);
  }

  /** The current summary becomes an earlier version (it can be restored). */
  deleteCurrent(bookId: string): Promise<void> {
    return this.request('DELETE', this.book(bookId));
  }

  versions(bookId: string): Promise<{ versions: SummaryMeta[] }> {
    return this.request('GET', `${this.book(bookId)}/versions`);
  }

  version(bookId: string, id: number, lang?: string): Promise<{ summary: SummaryView }> {
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : '';
    return this.request('GET', `${this.book(bookId)}/versions/${id}${q}`);
  }

  restore(bookId: string, id: number): Promise<void> {
    return this.request('POST', `${this.book(bookId)}/versions/${id}/restore`);
  }

  deleteVersion(bookId: string, id: number): Promise<void> {
    return this.request('DELETE', `${this.book(bookId)}/versions/${id}`);
  }

  jobs(bookId: string): Promise<{ jobs: SummaryJob[] }> {
    return this.request('GET', `${this.book(bookId)}/jobs`);
  }

  settings(): Promise<{ settings: SummaryServerSettings; costPer100kChars: number }> {
    return this.request('GET', '/summaries/settings');
  }

  saveSettings(
    changes: Partial<SummaryServerSettings>
  ): Promise<{ settings: SummaryServerSettings }> {
    return this.request('PUT', '/summaries/settings', changes);
  }
}
