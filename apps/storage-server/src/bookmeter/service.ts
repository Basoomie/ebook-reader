/**
 * Bookmeter sync (2026-11-25, docs/design/bookmeter-sync.md): the user's 読書メーター lists in the
 * reader.
 *
 * - **Reading the lists.** Each account's four public lists (read, reading, stacked, wish) come
 *   through the cleanup's fetch queue (its container and VPN, site `bookmeter` at its pace).
 *   A *quick* check every `quickMinutes` reads page 1 of each list (newest first); a *full* check
 *   every `fullHours` reads every page (removals and changed dates). A check is a round: its
 *   pages are kept until every one is in, then applied at once. A page Bookmeter refuses or that
 *   doesn't read as a list fails the round: nothing is applied, it is tried again at the next
 *   check (a refusal is never read as an empty list).
 * - **Matching.** Each entry is matched to reader books (match.ts) and the links kept in
 *   `bookmeter_links`; matched again when the catalog changes.
 * - **Telling the devices.** One server-written record per entry (kind "bookmeter-entry", id
 *   `<account>:<listing>`) with the matched books and the copy a status goes on. The devices
 *   apply the status changes with their own book-state rules (web `lib/bookmeter/`) and note
 *   each in a "bookmeter-applied" record; the server never writes book state.
 * - **Wanted books that arrive**: told once (Settings › Notifications), and a digest line.
 *
 * Nothing is ever written to Bookmeter.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FetchQueue } from '../cleanup/stage4/queue';
import type { SyncChange, SyncStore } from '../sync/store';
import {
  BOOKMETER_LISTS,
  PAGE_SIZE,
  bookUrl,
  listUrl,
  parseListPage,
  parseProfile,
  profileUrl,
  type BookmeterList,
  type ListEntry,
} from './parse';
import {
  addAccount,
  readBookmeterSettings,
  removeAccount,
  updateAccount,
  type BookmeterAccount,
  type BookmeterSettings,
} from './settings';
import {
  libraryIndex,
  matchEntry,
  nearBooks,
  searchBooks,
  targetBook,
  type BookActivity,
  type NearBook,
} from './match';
import { BOOKMETER_ARRIVED_EVENT } from './events';

export const BOOKMETER_ENTRY_KIND = 'bookmeter-entry';
export const BOOKMETER_APPLIED_KIND = 'bookmeter-applied';
/** The pseudo-device that writes the "bookmeter-entry" records (user_seeds). */
export const BOOKMETER_DEVICE_SEED = 'bookmeter-device';
export const WISH_QUERY = 'bookmeter:wish';

/** A routine check waits behind every cleanup request; "Check now" and new accounts less. */
export const ROUTINE_PRIORITY = -5;
export const NOW_PRIORITY = -2;

const MINUTE = 60_000;
/** A round that hasn't finished after this long is dropped (its pages asked again next time). */
const ROUND_TIMEOUT_MS = 6 * 3_600_000;

type RoundKind = 'quick' | 'full';
/** `profile` pages are the account check (name and counts), asked with each full round. */
type PageList = BookmeterList | 'profile';

export interface Notifier {
  notify(m: { event: string; lines: string[]; link: string | null }): void;
  addDigestLine(event: string, text: string, link?: string | null): void;
  poke?(): void;
}

interface Options {
  db: Database.Database;
  /** The cleanup's fetch queue; null when the cleanup is off (nothing is fetched). */
  queue: () => FetchQueue | null;
  notifications?: Notifier | null;
  now?: () => number;
  log?: (line: string) => void;
  /** How often the service looks (ms; default 1 min). */
  tickMs?: number;
}

export interface AccountStatus {
  account: BookmeterAccount;
  name: string | null;
  /** The profile's counts (null until checked). */
  counts: Record<BookmeterList, number | null> | null;
  /** What the reader has of each list. */
  entries: Record<BookmeterList, number>;
  matched: number;
  unmatched: number;
  quickAt: number | null;
  fullAt: number | null;
  /** The check running now: pages answered of pages known. */
  checking: { kind: RoundKind; done: number; total: number; startedAt: number } | null;
  result: { at: number; kind: RoundKind; changed: number; removed: number } | null;
  error: string | null;
  errorAt: number | null;
}

export interface UnmatchedEntry {
  listingId: string;
  list: BookmeterList;
  date: string | null;
  title: string;
  authors: string[];
  cover: string | null;
  url: string;
  near: NearBook[];
}

interface EntryRow {
  account_id: string;
  listing_id: string;
  list: BookmeterList;
  date: string | null;
  title: string;
  authors: string;
  cover: string | null;
  pages: number | null;
  rank: number;
  first_seen_at: number;
  seen_at: number;
}

interface StateRow {
  account_id: string;
  round: string | null;
  round_kind: RoundKind | null;
  round_started: number | null;
  quick_at: number | null;
  full_at: number | null;
  profile_at: number | null;
  name: string | null;
  counts: string | null;
  result: string | null;
  error: string | null;
  error_at: number | null;
}

export class BookmeterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class BookmeterSync {
  readonly db: Database.Database;
  private readonly queue: () => FetchQueue | null;
  private readonly notifications: Notifier | null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly tickMs: number;
  private sync: SyncStore | null = null;
  private timer: NodeJS.Timeout | null = null;
  private collectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private matchedVersion: string | null = null;

  constructor(opts: Options) {
    this.db = opts.db;
    this.queue = opts.queue;
    this.notifications = opts.notifications ?? null;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(l));
    this.tickMs = opts.tickMs ?? MINUTE;
  }

  /** The sync store the records are written through (built by the API router). */
  attachSync(sync: SyncStore): void {
    this.sync = sync;
  }

  settings(): BookmeterSettings {
    return readBookmeterSettings(this.db);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.collectTimer) clearTimeout(this.collectTimer);
    this.collectTimer = null;
  }

  /** An answer arrived in the fetch queue: collect ours soon (at most once a second). */
  answerArrived(): void {
    if (this.stopped || this.collectTimer) return;
    this.collectTimer = setTimeout(() => {
      this.collectTimer = null;
      void this.tick();
    }, 1000);
    this.collectTimer.unref?.();
  }

  // ------------------------------------------------------------------ the loop

  /** One round of work: collect answers, start due checks, match again after catalog changes. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const s = this.settings();
      const q = this.queue();
      if (q) this.collect(q, s);
      if (s.enabled && q) {
        for (const a of s.accounts) this.startDue(q, s, a);
      }
      // Books added or removed: match again (cheap when nothing changed).
      const version = libraryIndex(this.db).version;
      if (version !== this.matchedVersion) {
        this.matchedVersion = version;
        for (const a of s.accounts) this.rematch(a, s);
        this.publish();
      }
    } catch (err) {
      console.error('Bookmeter: a round failed:', err);
    } finally {
      this.ticking = false;
    }
  }

  private state(accountId: string): StateRow {
    let r = this.db.prepare('SELECT * FROM bookmeter_state WHERE account_id = ?').get(accountId) as
      | StateRow
      | undefined;
    if (!r) {
      this.db.prepare('INSERT INTO bookmeter_state (account_id) VALUES (?)').run(accountId);
      r = this.db
        .prepare('SELECT * FROM bookmeter_state WHERE account_id = ?')
        .get(accountId) as StateRow;
    }
    return r;
  }

  private startDue(q: FetchQueue, s: BookmeterSettings, a: BookmeterAccount): void {
    const st = this.state(a.id);
    const now = this.now();
    if (st.round) {
      if (now - (st.round_started ?? now) < ROUND_TIMEOUT_MS) return;
      this.failRound(a.id, 'The check took too long; it is tried again');
    }
    const fullDue = st.full_at === null || now - st.full_at >= s.fullHours * 3_600_000;
    const quickDue = st.quick_at === null || now - st.quick_at >= s.quickMinutes * MINUTE;
    // After a failed check, the next one waits the quick interval too.
    if (st.error_at !== null && now - st.error_at < s.quickMinutes * MINUTE) return;
    if (fullDue) this.startRound(q, a, 'full', ROUTINE_PRIORITY);
    else if (quickDue) this.startRound(q, a, 'quick', ROUTINE_PRIORITY);
  }

  private startRound(q: FetchQueue, a: BookmeterAccount, kind: RoundKind, priority: number): void {
    const round = randomUUID();
    const now = this.now();
    this.db.transaction(() => {
      this.state(a.id);
      this.db
        .prepare(
          'UPDATE bookmeter_state SET round = ?, round_kind = ?, round_started = ? WHERE account_id = ?',
        )
        .run(round, kind, now, a.id);
      this.db.prepare('DELETE FROM bookmeter_pages WHERE account_id = ?').run(a.id);
      this.db.prepare('DELETE FROM bookmeter_requests WHERE account_id = ?').run(a.id);
      if (kind === 'full') this.ask(q, a, round, 'profile', 1, priority);
      for (const list of BOOKMETER_LISTS) this.ask(q, a, round, list, 1, priority);
    })();
  }

  /** Puts one page in the fetch queue (a known request is put back in line). */
  private ask(
    q: FetchQueue,
    a: BookmeterAccount,
    round: string,
    list: PageList,
    page: number,
    priority: number,
  ): void {
    const now = this.now();
    const url = list === 'profile' ? profileUrl(a.userId) : listUrl(a.userId, list, page);
    const row = q.enqueue(
      { site: 'bookmeter', key: `bookmeter-sync:${a.userId}:${list}:${page}`, url, priority },
      null,
      now,
    );
    if (row.state !== 'queued' && row.state !== 'leased') q.requeue(row.id, priority, now);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO bookmeter_requests (account_id, round, list, page, request_id, asked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, round, list, page, row.id, now);
  }

  private failRound(accountId: string, why: string): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE bookmeter_state SET round = NULL, round_kind = NULL, round_started = NULL,
             error = ?, error_at = ? WHERE account_id = ?`,
        )
        .run(why, now, accountId);
      this.db.prepare('DELETE FROM bookmeter_pages WHERE account_id = ?').run(accountId);
      this.db.prepare('DELETE FROM bookmeter_requests WHERE account_id = ?').run(accountId);
    })();
    this.log(`Bookmeter: a check failed: ${why}`);
  }

  /** Reads every answered page; finishes rounds whose pages are all in. */
  private collect(q: FetchQueue, s: BookmeterSettings): void {
    const waiting = this.db.prepare('SELECT * FROM bookmeter_requests').all() as {
      account_id: string;
      round: string;
      list: PageList;
      page: number;
      request_id: number;
    }[];
    const touched = new Set<string>();
    for (const w of waiting) {
      const state = q.requestState(w.request_id);
      if (state === 'queued' || state === 'leased') continue;
      const a = s.accounts.find((x) => x.id === w.account_id);
      const st = this.state(w.account_id);
      if (!a || st.round !== w.round) {
        this.db
          .prepare('DELETE FROM bookmeter_requests WHERE account_id = ? AND round = ?')
          .run(w.account_id, w.round);
        continue;
      }
      const body = state === 'done' ? q.readAnswer(w.request_id) : null;
      q.forgetAnswer(w.request_id);
      this.db
        .prepare(
          'DELETE FROM bookmeter_requests WHERE account_id = ? AND round = ? AND list = ? AND page = ?',
        )
        .run(w.account_id, w.round, w.list, w.page);
      if (state === 'gone') {
        this.failRound(
          a.id,
          w.list === 'profile' || w.page === 1
            ? `Bookmeter has no user ${a.userId} (or the page is private)`
            : `Page ${w.page} of ${w.list} was gone; tried again at the next check`,
        );
        continue;
      }
      if (state !== 'done' || !body) {
        this.failRound(a.id, `Bookmeter didn't answer page ${w.page} of ${w.list}`);
        continue;
      }
      const html = body.toString('utf8');
      if (w.list === 'profile') {
        const p = parseProfile(html, a.userId);
        if (!p) {
          this.failRound(a.id, "Bookmeter's profile page didn't read as a profile");
          continue;
        }
        this.db
          .prepare(
            'UPDATE bookmeter_state SET name = ?, counts = ?, profile_at = ? WHERE account_id = ?',
          )
          .run(p.name, JSON.stringify(p.counts), this.now(), a.id);
        touched.add(a.id);
        continue;
      }
      const parsed = parseListPage(html);
      if (!parsed) {
        this.failRound(a.id, `Page ${w.page} of ${w.list} didn't read as a Bookmeter list`);
        continue;
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO bookmeter_pages (account_id, round, list, page, total, entries)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(a.id, w.round, w.list, w.page, parsed.total, JSON.stringify(parsed.entries));
      // A full round asks the rest of a list once page 1 tells its size.
      if (st.round_kind === 'full' && w.page === 1 && parsed.total !== null) {
        const pages = Math.ceil(parsed.total / PAGE_SIZE);
        for (let p = 2; p <= pages; p++) this.ask(q, a, w.round, w.list, p, ROUTINE_PRIORITY);
      }
      touched.add(a.id);
    }
    for (const id of touched) {
      const a = s.accounts.find((x) => x.id === id);
      if (a) this.maybeFinish(a, s);
    }
  }

  private maybeFinish(a: BookmeterAccount, s: BookmeterSettings): void {
    const st = this.state(a.id);
    if (!st.round || !st.round_kind) return;
    const open = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM bookmeter_requests WHERE account_id = ? AND round = ?')
        .get(a.id, st.round) as { n: number }
    ).n;
    if (open > 0) return;
    const pages = this.db
      .prepare(
        'SELECT list, page, total, entries FROM bookmeter_pages WHERE account_id = ? AND round = ?',
      )
      .all(a.id, st.round) as {
      list: BookmeterList;
      page: number;
      total: number | null;
      entries: string;
    }[];
    // Every list's page 1 must be in (a full round: every page).
    for (const list of BOOKMETER_LISTS) {
      if (!pages.some((p) => p.list === list && p.page === 1)) return;
    }
    this.applyRound(a, st.round_kind, pages);
    this.rematch(a, s);
    this.publish();
  }

  /** Applies a finished round's pages to the account's entries (one transaction). */
  private applyRound(
    a: BookmeterAccount,
    kind: RoundKind,
    pages: { list: BookmeterList; page: number; total: number | null; entries: string }[],
  ): void {
    const now = this.now();
    let changed = 0;
    let removed = 0;
    this.db.transaction(() => {
      const before = new Map(
        (
          this.db
            .prepare('SELECT * FROM bookmeter_entries WHERE account_id = ?')
            .all(a.id) as EntryRow[]
        ).map((r) => [r.listing_id, r]),
      );
      const seen = new Map<string, { list: BookmeterList; e: ListEntry; rank: number }>();
      // A whole list is known when every page was read (a full round, or a list of one page).
      const whole = new Set<BookmeterList>();
      for (const list of BOOKMETER_LISTS) {
        const own = pages.filter((p) => p.list === list).sort((x, y) => x.page - y.page);
        const total = own[0]?.total ?? null;
        const count =
          total ?? own.reduce((n, p) => n + (JSON.parse(p.entries) as unknown[]).length, 0);
        if (kind === 'full' || (total !== null && total <= PAGE_SIZE)) whole.add(list);
        for (const p of own) {
          const entries = JSON.parse(p.entries) as ListEntry[];
          entries.forEach((e, i) => {
            const pos = (p.page - 1) * PAGE_SIZE + i;
            // An entry that moved lists while the pages were read: the later list wins (read).
            // A book read twice is on 読んだ本 twice (the same listing): the latest read stays,
            // a dated read before one with no date (日付不明, listed last).
            const prev = seen.get(e.id);
            if (prev) {
              const order = BOOKMETER_LISTS.indexOf(prev.list) - BOOKMETER_LISTS.indexOf(list);
              if (order < 0) return;
              if (order === 0 && (prev.e.date ?? '') >= (e.date ?? '')) return;
            }
            seen.set(e.id, { list, e, rank: count - pos });
          });
        }
      }
      const upsert = this.db.prepare(
        `INSERT INTO bookmeter_entries (account_id, listing_id, list, date, title, authors, cover, pages, rank, first_seen_at, seen_at)
         VALUES (@account, @listing, @list, @date, @title, @authors, @cover, @pages, @rank, @now, @now)
         ON CONFLICT(account_id, listing_id) DO UPDATE SET list = excluded.list, date = excluded.date,
           title = excluded.title, authors = excluded.authors, cover = excluded.cover,
           pages = excluded.pages, rank = excluded.rank, seen_at = excluded.seen_at`,
      );
      for (const [listing, { list, e, rank }] of seen) {
        const prev = before.get(listing);
        if (!prev || prev.list !== list || prev.date !== e.date) changed += 1;
        upsert.run({
          account: a.id,
          listing,
          list,
          date: e.date,
          title: e.title,
          authors: JSON.stringify(e.authors),
          cover: e.cover,
          pages: e.pages,
          rank,
          now,
        });
      }
      // Removed from Bookmeter: only from lists read whole (a quick check sees only page 1).
      for (const [listing, prev] of before) {
        if (seen.has(listing) || !whole.has(prev.list)) continue;
        this.db
          .prepare('DELETE FROM bookmeter_entries WHERE account_id = ? AND listing_id = ?')
          .run(a.id, listing);
        removed += 1;
      }
      const result = JSON.stringify({ at: now, kind, changed, removed });
      this.db
        .prepare(
          `UPDATE bookmeter_state SET round = NULL, round_kind = NULL, round_started = NULL,
             ${kind === 'full' ? 'full_at = @now, quick_at = @now' : 'quick_at = @now'},
             result = @result, error = NULL, error_at = NULL WHERE account_id = @account`,
        )
        .run({ now, result, account: a.id });
      this.db.prepare('DELETE FROM bookmeter_pages WHERE account_id = ?').run(a.id);
    })();
    if (changed || removed)
      this.log(
        `Bookmeter: ${a.userId} ${kind} check: ${changed} new or changed, ${removed} removed`,
      );
  }

  // ------------------------------------------------------------------ matching

  private rematch(a: BookmeterAccount, s: BookmeterSettings): void {
    const index = libraryIndex(this.db);
    const entries = this.db
      .prepare('SELECT * FROM bookmeter_entries WHERE account_id = ?')
      .all(a.id) as EntryRow[];
    const choices = new Map(
      (
        this.db
          .prepare('SELECT listing_id, book_id FROM bookmeter_choices WHERE account_id = ?')
          .all(a.id) as { listing_id: string; book_id: string | null }[]
      ).map((r) => [r.listing_id, r.book_id]),
    );
    const arrived: { e: EntryRow; bookId: string }[] = [];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM bookmeter_links WHERE account_id = ?').run(a.id);
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO bookmeter_links (account_id, listing_id, book_id, how) VALUES (?, ?, ?, ?)',
      );
      for (const e of entries) {
        const m = matchEntry(
          index,
          { listingId: e.listing_id, title: e.title, authors: JSON.parse(e.authors) as string[] },
          a.libraries,
          choices.has(e.listing_id) ? choices.get(e.listing_id)! : undefined,
        );
        for (const l of m.links) {
          ins.run(a.id, e.listing_id, l.bookId, l.how);
          const b = index.books.get(l.bookId);
          // Wanted, and the book came after the entry was first seen: it arrived.
          if (e.list === 'wish' && b && b.createdAt > e.first_seen_at)
            arrived.push({ e, bookId: b.id });
        }
      }
    })();
    if (a.wish) this.tellArrivals(a, s, arrived);
  }

  private tellArrivals(
    a: BookmeterAccount,
    s: BookmeterSettings,
    arrived: { e: EntryRow; bookId: string }[],
  ): void {
    for (const { e, bookId } of arrived) {
      const told = this.db
        .prepare(
          'SELECT 1 FROM bookmeter_arrivals WHERE account_id = ? AND listing_id = ? AND book_id = ?',
        )
        .get(a.id, e.listing_id, bookId);
      if (told) continue;
      // One copy is told once; another copy of the same wanted book isn't told again.
      const any = this.db
        .prepare('SELECT 1 FROM bookmeter_arrivals WHERE account_id = ? AND listing_id = ?')
        .get(a.id, e.listing_id);
      this.db
        .prepare(
          'INSERT INTO bookmeter_arrivals (account_id, listing_id, book_id, told_at) VALUES (?, ?, ?, ?)',
        )
        .run(a.id, e.listing_id, bookId, this.now());
      if (any || !s.notifyArrived || !this.notifications) continue;
      try {
        const link = `/library/book?id=${encodeURIComponent(bookId)}`;
        const text = `A book on your 読みたい本 is in the library: ${e.title}`;
        this.notifications.notify({ event: BOOKMETER_ARRIVED_EVENT, lines: [text], link });
        this.notifications.addDigestLine(BOOKMETER_ARRIVED_EVENT, text, link);
        this.notifications.poke?.();
      } catch (err) {
        console.error('Bookmeter: could not tell an arrival:', err);
      }
    }
  }

  // ------------------------------------------------------------------ records

  private users(): string[] {
    return (
      this.db.prepare('SELECT id FROM users ORDER BY created_at').all() as { id: string }[]
    ).map((r) => r.id);
  }

  private serverDevice(userId: string): string {
    const row = this.db
      .prepare('SELECT device_id FROM user_seeds WHERE user_id = ? AND name = ?')
      .get(userId, BOOKMETER_DEVICE_SEED) as { device_id: string | null } | undefined;
    if (row?.device_id) return row.device_id;
    const id = randomUUID();
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, ?)')
        .run(id, userId, now);
      this.sync!.writeAs(
        userId,
        id,
        {
          kind: 'device',
          id,
          updatedAt: now,
          data: { name: 'Server (読書メーター)' },
        },
        now,
      );
      this.db
        .prepare('INSERT INTO user_seeds (user_id, name, device_id, done_at) VALUES (?, ?, ?, ?)')
        .run(userId, BOOKMETER_DEVICE_SEED, id, now);
    })();
    return id;
  }

  /** The user's reading activity on the given books (which copy a status goes on). */
  private activity(userId: string, bookIds: string[]): Map<string, BookActivity> {
    const out = new Map<string, BookActivity>();
    if (bookIds.length === 0) return out;
    for (let i = 0; i < bookIds.length; i += 500) {
      const chunk = bookIds.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT kind, book_id FROM sync_records
           WHERE user_id = ? AND deleted_at IS NULL AND kind IN ('book-status', 'read-through', 'position')
             AND book_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(userId, ...chunk) as { kind: string; book_id: string }[];
      for (const r of rows) {
        const a = out.get(r.book_id) ?? { state: false, position: false };
        if (r.kind === 'position') a.position = true;
        else a.state = true;
        out.set(r.book_id, a);
      }
    }
    return out;
  }

  /** The records every device reads; written only when they changed. */
  publish(): void {
    if (!this.sync) return;
    try {
      const s = this.settings();
      const index = libraryIndex(this.db);
      const entries = this.db.prepare('SELECT * FROM bookmeter_entries').all() as EntryRow[];
      const links = this.db
        .prepare('SELECT account_id, listing_id, book_id, how FROM bookmeter_links')
        .all() as { account_id: string; listing_id: string; book_id: string; how: string }[];
      const byEntry = new Map<string, { book_id: string; how: string }[]>();
      for (const l of links) {
        const k = `${l.account_id}:${l.listing_id}`;
        const a = byEntry.get(k);
        if (a) a.push(l);
        else byEntry.set(k, [l]);
      }
      const accounts = new Map(s.accounts.map((a) => [a.id, a]));
      for (const userId of this.users()) {
        const device = this.serverDevice(userId);
        const act = this.activity(userId, [...new Set(links.map((l) => l.book_id))]);
        const want = new Map<string, Record<string, unknown>>();
        for (const e of entries) {
          const a = accounts.get(e.account_id);
          if (!a) continue;
          const id = `${e.account_id}:${e.listing_id}`;
          const ls = byEntry.get(id) ?? [];
          const books = ls
            .map((l) => index.books.get(l.book_id))
            .filter((b): b is NonNullable<typeof b> => !!b);
          want.set(id, {
            account: e.account_id,
            listing: e.listing_id,
            list: e.list,
            date: e.date,
            title: e.title,
            authors: JSON.parse(e.authors) as string[],
            cover: e.cover,
            rank: e.rank,
            books: books.map((b) => b.id),
            target: targetBook(books, e.listing_id, act),
            how: ls[0]?.how ?? null,
            statuses: a.statuses,
            wish: a.wish,
          });
        }
        const existing = this.db
          .prepare(
            'SELECT id FROM sync_records WHERE user_id = ? AND kind = ? AND deleted_at IS NULL',
          )
          .all(userId, BOOKMETER_ENTRY_KIND) as { id: string }[];
        for (const { id } of existing) {
          if (!want.has(id)) this.write(userId, device, id, null);
        }
        for (const [id, data] of want) this.write(userId, device, id, data);
      }
    } catch (err) {
      console.error('Bookmeter: the records could not be written:', err);
    }
  }

  private write(
    userId: string,
    device: string,
    id: string,
    data: Record<string, unknown> | null,
  ): void {
    const prev = this.sync!.getRecord(userId, BOOKMETER_ENTRY_KIND, id);
    if (data === null) {
      if (!prev || prev.deletedAt !== null) return;
    } else if (
      prev &&
      prev.deletedAt === null &&
      JSON.stringify(prev.data) === JSON.stringify(data)
    ) {
      return;
    }
    const at = Math.max(this.now(), (prev?.updatedAt ?? 0) + 1);
    const change: SyncChange =
      data === null
        ? { kind: BOOKMETER_ENTRY_KIND, id, updatedAt: at, deletedAt: at }
        : { kind: BOOKMETER_ENTRY_KIND, id, updatedAt: at, data };
    const r = this.sync!.writeAs(userId, device, change, at);
    if (r.status !== 'applied' && r.status !== 'duplicate')
      this.log(`Bookmeter: the record ${id}: ${JSON.stringify(r)}`);
  }

  /** The 読みたい本 smart collection of an account, for every user (made once). */
  private makeCollection(a: BookmeterAccount, name: string): string {
    const id = a.collectionId ?? randomUUID();
    if (!this.sync) return id;
    const now = this.now();
    for (const userId of this.users()) {
      if (this.sync.getRecord(userId, 'collection', id)) continue;
      const r = this.sync.writeAs(
        userId,
        this.serverDevice(userId),
        {
          kind: 'collection',
          id,
          updatedAt: now,
          data: { name, type: 'smart', query: WISH_QUERY },
        },
        now,
      );
      if (r.status !== 'applied' && r.status !== 'duplicate')
        this.log(`Bookmeter: the 読みたい本 collection: ${JSON.stringify(r)}`);
    }
    return id;
  }

  // ------------------------------------------------------------------ the user's actions

  status(): { settings: BookmeterSettings; accounts: AccountStatus[]; available: boolean } {
    const s = this.settings();
    const accounts = s.accounts.map((a): AccountStatus => {
      const st = this.state(a.id);
      const counts = Object.fromEntries(BOOKMETER_LISTS.map((l) => [l, 0])) as Record<
        BookmeterList,
        number
      >;
      for (const r of this.db
        .prepare(
          'SELECT list, COUNT(*) AS n FROM bookmeter_entries WHERE account_id = ? GROUP BY list',
        )
        .all(a.id) as { list: BookmeterList; n: number }[])
        counts[r.list] = r.n;
      const matched = (
        this.db
          .prepare(
            'SELECT COUNT(DISTINCT listing_id) AS n FROM bookmeter_links WHERE account_id = ?',
          )
          .get(a.id) as { n: number }
      ).n;
      const total = Object.values(counts).reduce((x, y) => x + y, 0);
      let checking: AccountStatus['checking'] = null;
      if (st.round && st.round_kind) {
        const open = (
          this.db
            .prepare('SELECT COUNT(*) AS n FROM bookmeter_requests WHERE account_id = ?')
            .get(a.id) as { n: number }
        ).n;
        const done =
          (
            this.db
              .prepare('SELECT COUNT(*) AS n FROM bookmeter_pages WHERE account_id = ?')
              .get(a.id) as { n: number }
          ).n + (st.profile_at !== null && st.profile_at >= (st.round_started ?? 0) ? 1 : 0);
        checking = {
          kind: st.round_kind,
          done,
          total: done + open,
          startedAt: st.round_started ?? this.now(),
        };
      }
      return {
        account: a,
        name: st.name,
        counts: st.counts ? (JSON.parse(st.counts) as AccountStatus['counts']) : null,
        entries: counts,
        matched,
        unmatched: total - matched - this.notInLibraryCount(a.id),
        quickAt: st.quick_at,
        fullAt: st.full_at,
        checking,
        result: st.result ? (JSON.parse(st.result) as AccountStatus['result']) : null,
        error: st.error,
        errorAt: st.error_at,
      };
    });
    return { settings: s, accounts, available: this.queue() !== null };
  }

  private notInLibraryCount(accountId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_choices c
           JOIN bookmeter_entries e ON e.account_id = c.account_id AND e.listing_id = c.listing_id
           WHERE c.account_id = ? AND c.book_id IS NULL`,
        )
        .get(accountId) as { n: number }
    ).n;
  }

  private account(id: string): BookmeterAccount {
    const a = this.settings().accounts.find((x) => x.id === id);
    if (!a) throw new BookmeterError(404, 'no_account', 'No such Bookmeter account');
    return a;
  }

  addAccount(input: { userId: string; libraries?: unknown; statuses?: unknown; wish?: unknown }) {
    const { account } = addAccount(this.db, input, this.now());
    this.state(account.id);
    if (account.wish) {
      const collectionId = this.makeCollection(account, '読みたい本 (読書メーター)');
      updateAccount(this.db, account.id, { collectionId });
    }
    const q = this.queue();
    if (q) this.startRound(q, this.account(account.id), 'full', NOW_PRIORITY);
    return this.account(account.id);
  }

  updateAccount(id: string, patch: Record<string, unknown>): BookmeterAccount {
    const allowed: Record<string, unknown> = {};
    for (const k of ['libraries', 'statuses', 'wish'] as const)
      if (k in patch) allowed[k] = patch[k];
    updateAccount(this.db, id, allowed);
    let a = this.account(id);
    if (a.wish && !a.collectionId) {
      updateAccount(this.db, id, {
        collectionId: this.makeCollection(a, '読みたい本 (読書メーター)'),
      });
      a = this.account(id);
    }
    this.rematch(a, this.settings());
    this.publish();
    return a;
  }

  /** Removes an account: its entries and records go; what was applied in the reader stays. */
  removeAccount(id: string): void {
    const a = this.account(id);
    removeAccount(this.db, id);
    this.db.transaction(() => {
      for (const t of [
        'bookmeter_entries',
        'bookmeter_links',
        'bookmeter_choices',
        'bookmeter_pages',
        'bookmeter_requests',
        'bookmeter_state',
        'bookmeter_arrivals',
      ])
        this.db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(id);
    })();
    // Its 読みたい本 collection would match nothing: it goes too.
    if (a.collectionId && this.sync) {
      const now = this.now();
      for (const userId of this.users()) {
        const prev = this.sync.getRecord(userId, 'collection', a.collectionId);
        if (!prev || prev.deletedAt !== null) continue;
        const at = Math.max(now, prev.updatedAt + 1);
        this.sync.writeAs(
          userId,
          this.serverDevice(userId),
          { kind: 'collection', id: a.collectionId, updatedAt: at, deletedAt: at },
          at,
        );
      }
    }
    this.publish();
  }

  /** "Check now": a full check of every account (or one) ahead of the routine. */
  checkNow(accountId?: string): void {
    const q = this.queue();
    if (!q) throw new BookmeterError(503, 'no_queue', 'The fetch queue is off on this server');
    const s = this.settings();
    if (!s.enabled) throw new BookmeterError(409, 'off', 'Bookmeter sync is off');
    for (const a of s.accounts) {
      if (accountId && a.id !== accountId) continue;
      if (this.state(a.id).round) continue;
      this.startRound(q, a, 'full', NOW_PRIORITY);
    }
  }

  /** The user applied or skipped an account's changes once: later ones follow `askAbove`. */
  markReviewed(accountId: string): BookmeterAccount {
    const a = this.account(accountId);
    if (a.reviewedAt === null) updateAccount(this.db, accountId, { reviewedAt: this.now() });
    return this.account(accountId);
  }

  unmatched(accountId: string): { unmatched: UnmatchedEntry[]; notInLibrary: UnmatchedEntry[] } {
    const a = this.account(accountId);
    const index = libraryIndex(this.db);
    const rows = this.db
      .prepare(
        `SELECT e.*, c.listing_id AS chosen FROM bookmeter_entries e
         LEFT JOIN bookmeter_choices c ON c.account_id = e.account_id AND c.listing_id = e.listing_id
         WHERE e.account_id = ?
           AND NOT EXISTS (SELECT 1 FROM bookmeter_links l
                           WHERE l.account_id = e.account_id AND l.listing_id = e.listing_id)
         ORDER BY CASE e.list WHEN 'read' THEN 0 WHEN 'reading' THEN 1 WHEN 'stacked' THEN 2 ELSE 3 END,
                  e.rank DESC`,
      )
      .all(a.id) as (EntryRow & { chosen: string | null })[];
    const unmatched: UnmatchedEntry[] = [];
    const notInLibrary: UnmatchedEntry[] = [];
    for (const r of rows) {
      const authors = JSON.parse(r.authors) as string[];
      const item: UnmatchedEntry = {
        listingId: r.listing_id,
        list: r.list,
        date: r.date,
        title: r.title,
        authors,
        cover: r.cover,
        url: bookUrl(r.listing_id),
        near: [],
      };
      if (r.chosen !== null) notInLibrary.push(item);
      else {
        item.near = nearBooks(
          index,
          { listingId: r.listing_id, title: r.title, authors },
          a.libraries,
        );
        unmatched.push(item);
      }
    }
    return { unmatched, notInLibrary };
  }

  searchBooks(accountId: string, q: string): NearBook[] {
    const a = this.account(accountId);
    return searchBooks(libraryIndex(this.db), q, a.libraries);
  }

  /** Link (a book id), Not in my library (null), or Forget my choice (undefined). */
  choose(accountId: string, listingId: string, bookId: string | null | undefined): void {
    const a = this.account(accountId);
    const entry = this.db
      .prepare('SELECT 1 FROM bookmeter_entries WHERE account_id = ? AND listing_id = ?')
      .get(a.id, listingId);
    if (!entry)
      throw new BookmeterError(404, 'no_entry', 'That book is not on the account’s lists');
    if (bookId === undefined) {
      this.db
        .prepare('DELETE FROM bookmeter_choices WHERE account_id = ? AND listing_id = ?')
        .run(a.id, listingId);
    } else {
      if (bookId !== null) {
        const b = libraryIndex(this.db).books.get(bookId);
        if (!b) throw new BookmeterError(404, 'no_book', 'No such book in the library');
        if (a.libraries.length && !a.libraries.includes(b.libraryId))
          throw new BookmeterError(
            400,
            'wrong_library',
            'That book is in a library this account doesn’t cover',
          );
      }
      this.db
        .prepare(
          `INSERT INTO bookmeter_choices (account_id, listing_id, book_id, decided_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, listing_id) DO UPDATE SET book_id = excluded.book_id, decided_at = excluded.decided_at`,
        )
        .run(a.id, listingId, bookId, this.now());
    }
    this.rematch(a, this.settings());
    this.publish();
  }

  /**
   * Books Completed in the reader with no matching 読んだ本 entry (the "Log on 読書メーター" list),
   * with the listing to open: one the user has on another list, else the saved id's.
   */
  finishedHere(userId: string): {
    bookId: string;
    title: string;
    authors: string[];
    finishedOn: string | null;
    listingId: string | null;
  }[] {
    const s = this.settings();
    if (s.accounts.length === 0) return [];
    const index = libraryIndex(this.db);
    const rows = this.db
      .prepare(
        `SELECT r.book_id AS bookId,
                (SELECT MAX(json_extract(t.data, '$.finishedOn')) FROM sync_records t
                 WHERE t.user_id = r.user_id AND t.kind = 'read-through' AND t.book_id = r.book_id
                   AND t.deleted_at IS NULL AND json_extract(t.data, '$.finished') = 1) AS finishedOn
         FROM sync_records r
         WHERE r.user_id = ? AND r.kind = 'book-status' AND r.deleted_at IS NULL
           AND json_extract(r.data, '$.status') = 'completed' AND r.book_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM bookmeter_links l JOIN bookmeter_entries e
                             ON e.account_id = l.account_id AND e.listing_id = l.listing_id
                           WHERE l.book_id = r.book_id AND e.list = 'read')`,
      )
      .all(userId) as { bookId: string; finishedOn: string | null }[];
    const out = [];
    for (const r of rows) {
      const b = index.books.get(r.bookId);
      if (!b) continue;
      const covered = s.accounts.some(
        (a) => a.statuses && (a.libraries.length === 0 || a.libraries.includes(b.libraryId)),
      );
      if (!covered) continue;
      const other = this.db
        .prepare('SELECT listing_id FROM bookmeter_links WHERE book_id = ? LIMIT 1')
        .get(b.id) as { listing_id: string } | undefined;
      out.push({
        bookId: b.id,
        title: b.title,
        authors: b.authors,
        finishedOn: r.finishedOn,
        listingId: other?.listing_id ?? b.savedId,
      });
    }
    return out.sort((x, y) => (y.finishedOn ?? '').localeCompare(x.finishedOn ?? ''));
  }
}
