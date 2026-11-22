/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Book summaries session 2: the accuracy test's server calls (/api/v1/summaries-test/*, only on
 * the PC's test copy of the app).
 */
import { getLibraryStore } from '$lib/library/library-db';
import type { ItemMark, Summary } from './summary-types';

export interface TestRun {
  id: string;
  bookKey: string;
  setup: string;
  background: boolean;
  state: 'running' | 'done' | 'refused' | 'failed';
  phase: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  metrics: Record<string, unknown> | null;
  progress: { done: number; secondsLeft: number | null };
  languages: string[];
}

export interface TestBook {
  key: string;
  title: string;
  characters: number;
  readerId: string | null;
  series: string | null;
  volume: number | null;
}

export interface TestOverview {
  setups: Record<string, string>;
  books: TestBook[];
  runs: TestRun[];
  budget: { spentUsd: number; reservedUsd: number; limitUsd: number | null } | null;
  wait: { kind: string } | null;
}

export interface Claim {
  id: number;
  run_id: string;
  ref: string;
  text: string;
  section: string;
  quote: string | null;
  position: number | null;
  group_id: number;
  /** This version's own mark (overrides the group's), or null. */
  mark: 'right' | 'wrong' | 'unsure' | null;
}

export interface ClaimGroup {
  id: number;
  text: string;
  made_by: string;
  mark: 'right' | 'wrong' | 'unsure' | null;
  note: string | null;
  claims: Claim[];
}

export interface Score {
  runId: string;
  label: string;
  claims: number;
  right: number;
  wrong: number;
  unsure: number;
  unmarked: number;
  missed: number;
  missedFoundByOthers: number;
  missedByAll: number;
  metrics: Record<string, unknown> | null;
}

export interface Judging {
  book: TestBook;
  groups: ClaimGroup[];
  missing: { id: number; text: string }[];
  scores: Score[];
  runs: { id: string; setup: string; background: boolean; label: string; state: string }[];
}

export interface ItemRun {
  id: string;
  setup: string;
  background: boolean;
  label: string;
  summary: Summary;
  marks: Record<string, ItemMark>;
  /** Items whose mark was copied from the same item in another summary: ref → that summary's label. */
  copied: Record<string, string>;
  score: {
    items: number;
    right: number;
    mistake: number;
    notNeeded: number;
    unsure: number;
    unmarked: number;
    notes: number;
    copied: number;
  };
  /** The user's notes on this summary. */
  notes: { id: number; text: string; section: string | null }[];
  metrics: Record<string, unknown> | null;
}

export interface ItemJudging {
  book: TestBook;
  runs: ItemRun[];
  missing: { id: number; text: string }[];
  chapters: { index: number; title: string; start: number }[];
  characters: number;
}

export interface SummaryPage {
  run: TestRun & { label: string };
  book: TestBook;
  summary: Summary;
  languages: string[];
  chapters: { index: number; title: string; start: number }[];
  characters: number;
}

export class SummaryTestApi {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string
  ) {}

  static async connect(): Promise<SummaryTestApi | null> {
    const c = await getLibraryStore().getConnection();
    return c ? new SummaryTestApi(c.serverUrl, c.token) : null;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.serverUrl}/api/v1/summaries-test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!r.ok) {
      let message = `HTTP ${r.status}`;
      try {
        message = ((await r.json()) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // not JSON
      }
      throw new Error(r.status === 404 ? 'The accuracy test is not on this server.' : message);
    }
    return (await r.json()) as T;
  }

  overview() {
    return this.call<TestOverview>('GET', '');
  }
  judging(book: string, scope: string) {
    return this.call<Judging>(
      'GET',
      `/judging?book=${encodeURIComponent(book)}&scope=${encodeURIComponent(scope)}`
    );
  }
  items(book: string, scope = 'round1') {
    return this.call<ItemJudging>(
      'GET',
      `/items?book=${encodeURIComponent(book)}&scope=${encodeURIComponent(scope)}`
    );
  }
  markItem(run: string, ref: string, mark: ItemMark | null) {
    return this.call('PUT', '/items/mark', { run, ref, mark });
  }
  mark(group: number, mark: ClaimGroup['mark'], note: string | null = null) {
    return this.call('PUT', `/marks/${group}`, { mark, note });
  }
  markClaim(claim: number, mark: Claim['mark']) {
    return this.call('PUT', `/claims/${claim}/mark`, { mark });
  }
  moveClaim(claim: number, to: number | 'new') {
    return this.call<{ group: number }>('POST', `/claims/${claim}/move`, { to });
  }
  merge(from: number, into: number) {
    return this.call('POST', '/groups/merge', { from, into });
  }
  addMissing(
    book: string,
    scope: string,
    text: string,
    run: string | null = null,
    section: string | null = null
  ) {
    return this.call<{ id: number }>('POST', '/missing', { book, scope, text, run, section });
  }
  updateMissing(id: number, text: string) {
    return this.call('PUT', `/missing/${id}`, { text });
  }
  removeMissing(id: number) {
    return this.call('DELETE', `/missing/${id}`);
  }
  summary(run: string, lang: string) {
    return this.call<SummaryPage>(
      'GET',
      `/summary?run=${encodeURIComponent(run)}&lang=${encodeURIComponent(lang)}`
    );
  }
}
