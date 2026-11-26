/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Bookmeter sync on the device (2026-11-25, docs/design/bookmeter-sync.md): reads the server's
 * "bookmeter-entry" records from the sync mirror (works offline), plans the status changes
 * (plan.ts) and applies them with the reader's own book-state rules, the same as "Mark
 * completed" and the first page turn. Every imported completion writes a "summary-skip" first
 * (an imported completion never makes a paid summary), is a non-manual read-through (counts as a
 * finished book; no time and no characters) and is noted in a "bookmeter-applied" record.
 *
 * Applied without asking only when the account was reviewed once and there are at most
 * `askAbove` changes (both from the server); otherwise the changes wait for Review.
 * Never throws into the page that calls it: failures are logged.
 */

import { writable, type Readable } from 'svelte/store';
import type { SyncEngine } from '$lib/sync/sync-engine';
import type { LocalRecord } from '$lib/sync/sync-db';
import {
  BOOK_STATUS_KIND,
  bookStateFrom,
  planFirstPageTurn,
  planMarkCompleted,
  type BookStateWrite
} from '$lib/sync/book-state';
import { SUMMARY_SKIP_KIND } from '$lib/summaries/summary-cache';
import {
  BOOKMETER_APPLIED_KIND,
  BOOKMETER_ENTRY_KIND,
  appliedFrom,
  entryFrom,
  mayApplyQuietly,
  planChanges,
  type AppliedRecord,
  type BookmeterEntry,
  type PlannedChange,
  type StatusInfo
} from './plan';

export interface BookmeterDeps {
  getEngine(): Promise<SyncEngine>;
  /** The server's status (reviewed accounts and askAbove); null offline or without a server. */
  serverState(): Promise<{ reviewed: Set<string>; askAbove: number } | null>;
  /** Tells the server the account's first changes were applied or skipped. */
  markReviewed(accountId: string): Promise<void>;
  dayOf(ms: number): string;
  warn(message: string): void;
  now?(): number;
}

function message(error: unknown) {
  return (error as Error)?.message ?? String(error);
}

export interface BookmeterView {
  entries: BookmeterEntry[];
  /** Changes waiting (not applied quietly): shown on Home and in Settings › Library. */
  pending: PlannedChange[];
  applied: Map<string, AppliedRecord>;
}

const empty: BookmeterView = { entries: [], pending: [], applied: new Map() };
const view = writable<BookmeterView>(empty);
export const bookmeterView: Readable<BookmeterView> = view;

async function readAll(engine: SyncEngine) {
  const [entryRecords, appliedRecords, statusRecords] = await Promise.all([
    engine.getAll(BOOKMETER_ENTRY_KIND),
    engine.getAll(BOOKMETER_APPLIED_KIND),
    engine.getAll(BOOK_STATUS_KIND)
  ]);
  const entries = entryRecords.map(entryFrom).filter((e): e is BookmeterEntry => e !== null);
  const applied = new Map<string, AppliedRecord>();
  for (const r of appliedRecords) {
    const a = appliedFrom(r);
    if (a) applied.set(a.bookId, a);
  }
  const statusInfo = new Map<string, StatusInfo>();
  for (const r of statusRecords) {
    if (r.deletedAt !== null) continue;
    statusInfo.set(r.id, { updatedAt: r.updatedAt, auto: r.data?.auto === true });
  }
  return { entries, applied, statusInfo };
}

/** The books the plan touches, with their state records. */
async function statesOf(engine: SyncEngine, bookIds: Iterable<string>) {
  const states = new Map<string, ReturnType<typeof bookStateFrom>>();
  for (const id of new Set(bookIds)) {
    states.set(id, bookStateFrom(id, await engine.getForBook(id)));
  }
  return states;
}

/** Reads the records and plans the changes. Never throws (empty on failure). */
export async function loadBookmeter(deps: BookmeterDeps): Promise<BookmeterView> {
  try {
    const engine = await deps.getEngine();
    const { entries, applied, statusInfo } = await readAll(engine);
    const targets = entries.map((e) => e.target).filter((t): t is string => !!t);
    const states = await statesOf(engine, targets);
    const pending = planChanges({ entries, states, statusInfo, applied, dayOf: deps.dayOf });
    const next = { entries, pending, applied };
    view.set(next);
    return next;
  } catch (error) {
    deps.warn(`Bookmeter: ${message(error)}`);
    return empty;
  }
}

async function put(engine: SyncEngine, w: BookStateWrite): Promise<void> {
  const ok =
    'deleted' in w
      ? await engine.remove(w.kind, w.id)
      : await engine.put(w.kind, w.id, w.data, { bookId: w.bookId });
  if (!ok) throw new Error(`could not save ${w.kind}`);
}

/**
 * Applies changes (Review's Apply, or quietly). Each book is planned again from its current
 * state first, so a change another device made meanwhile isn't made twice. Returns the ids
 * that failed.
 */
export async function applyChanges(
  changes: readonly PlannedChange[],
  deps: BookmeterDeps
): Promise<string[]> {
  const failed: string[] = [];
  let engine: SyncEngine;
  try {
    engine = await deps.getEngine();
  } catch (error) {
    deps.warn(`Bookmeter: ${message(error)}`);
    return changes.map((c) => c.bookId);
  }
  const now = (deps.now ?? Date.now)();
  for (const c of changes) {
    try {
      const state = bookStateFrom(c.bookId, await engine.getForBook(c.bookId));
      if (c.kind === 'complete') {
        if (state.status !== 'completed') {
          // Never a paid summary for a book completed on Bookmeter (sent in the same push, first).
          await engine.put(SUMMARY_SKIP_KIND, c.bookId, {}, { bookId: c.bookId });
          for (const w of planMarkCompleted(state, {
            finishedOn: c.date,
            manual: false,
            charCount: null
          }))
            await put(engine, w);
        }
      } else {
        for (const w of planFirstPageTurn(state)) await put(engine, w);
      }
      await engine.put(BOOKMETER_APPLIED_KIND, c.bookId, appliedData(c, 'applied', now), {
        bookId: c.bookId
      });
    } catch (error) {
      deps.warn(`Bookmeter: ${c.entry.title}: ${message(error)}`);
      failed.push(c.bookId);
    }
  }
  await markAccountsReviewed(changes, deps);
  await loadBookmeter(deps);
  return failed;
}

/** Skip these: never asked again for the same entry and date. */
export function skipChanges(changes: readonly PlannedChange[], deps: BookmeterDeps) {
  return note(changes, 'skipped', deps);
}

/** Left unticked in Review: still waiting there, never applied without asking. */
export function holdChanges(changes: readonly PlannedChange[], deps: BookmeterDeps) {
  return note(changes, 'held', deps);
}

async function note(
  changes: readonly PlannedChange[],
  outcome: 'skipped' | 'held',
  deps: BookmeterDeps
): Promise<void> {
  try {
    const engine = await deps.getEngine();
    const now = (deps.now ?? Date.now)();
    for (const c of changes) {
      if (outcome === 'held' && c.held) continue;
      await engine.put(BOOKMETER_APPLIED_KIND, c.bookId, appliedData(c, outcome, now), {
        bookId: c.bookId
      });
    }
    if (outcome === 'skipped') await markAccountsReviewed(changes, deps);
  } catch (error) {
    deps.warn(`Bookmeter: ${message(error)}`);
  }
  await loadBookmeter(deps);
}

function appliedData(c: PlannedChange, outcome: 'applied' | 'skipped' | 'held', at: number) {
  return {
    account: c.entry.account,
    listing: c.entry.listing,
    list: c.entry.list === 'read' ? 'read' : 'reading',
    date: c.date,
    outcome,
    at
  };
}

async function markAccountsReviewed(changes: readonly PlannedChange[], deps: BookmeterDeps) {
  for (const account of new Set(changes.map((c) => c.entry.account))) {
    try {
      await deps.markReviewed(account);
    } catch (error) {
      deps.warn(`Bookmeter: ${message(error)}`);
    }
  }
}

let running: Promise<void> | null = null;

/**
 * Plans and, when allowed, applies quietly (after the account was reviewed once, at most
 * `askAbove` changes); otherwise the changes wait for Review. One run at a time.
 */
export function syncBookmeter(deps: BookmeterDeps): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      const v = await loadBookmeter(deps);
      if (v.pending.length === 0) return;
      const server = await deps.serverState();
      if (!server) return;
      // Changes left unticked in Review wait there; the others may go quietly.
      const fresh = v.pending.filter((c) => !c.held);
      if (mayApplyQuietly(fresh, server.reviewed, server.askAbove)) {
        await applyChanges(fresh, deps);
      }
    } catch (error) {
      deps.warn(`Bookmeter: ${message(error)}`);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Calls back after pulls of Bookmeter records (this device's own writes reload by themselves). */
export function onBookmeterRecords(engine: SyncEngine, callback: () => void): () => void {
  const relevant = (r: LocalRecord) =>
    r.kind === BOOKMETER_ENTRY_KIND || r.kind === BOOKMETER_APPLIED_KIND;
  return engine.onRemoteChange((records) => {
    if (records.some(relevant)) callback();
  });
}
