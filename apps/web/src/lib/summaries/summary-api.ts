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
  /** The last automatic or requested run: made, failed (every setup) or no text. */
  outcome: 'made' | 'failed' | 'no_text' | null;
  /** "No text to summarize", or why every setup failed. */
  note: string | null;
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
    if (response.status === 204 || response.status === 202) return undefined as T;
    return response.json() as Promise<T>;
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
}
