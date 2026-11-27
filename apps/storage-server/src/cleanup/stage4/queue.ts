/**
 * The fetch queue (WP20d, plan section 6): owned by the server, kept in cleanup.db, so it
 * survives every restart of the server and of the fetch container.
 *
 * - One row per distinct request (site + key); a book that needs an answer another book already
 *   has gets it at once (fetch_waiters).
 * - Pacing is enforced here, when a request is claimed: a site gets its next request only when
 *   its interval has passed since its last claim and it isn't backing off or paused. Claims are
 *   given to one fetcher at a time (the active one), so only one fetcher talks to a site.
 * - A claim is a lease; an unanswered lease puts the request back (same attempt count).
 * - Answers are classified (challenge.ts). A challenge page backs off every Amazon queue (start,
 *   doubling to the longest) and is asked again; many in a row pause the site. Busy answers and
 *   network errors are asked again later; a request is given up after the set attempts.
 * - Amazon's share of challenge pages over the last N requests slows Amazon down (x1.5) while it
 *   is above the setting; nothing ever speeds up beyond the set pace.
 * - The answer goes to the cache (brotli, as the fetcher sent it) before its row says done.
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { brotliCompressSync, brotliDecompress, brotliDecompressSync, constants as zc } from 'zlib';
import { promisify } from 'util';
import type { FetchSettings, FetchSite } from '../settings';
import { classifyResponse, type ResponseClass } from './challenge';
import { LEASE_SLOT_SQL, MAX_FETCHERS, slotKey, slotToken, tokenSlot } from './fetch-slots';

/** Refused pages kept per site, and the most kept of each (bot checks and 503s are a few KB). */
const REFUSED_KEEP = 500;
const REFUSED_MAX_BYTES = 256 * 1024;

export const LABELED_PRIORITY = 10;

/** The first fetcher that handles several requests of one site at once. */
export const MULTI_IN_FLIGHT_VERSION = '1.4.0';

/** True when version a.b.c is at least min (an unknown version counts as older). */
export function versionAtLeast(v: string | null, min: string): boolean {
  if (!v) return false;
  const a = v.split('.').map((x) => parseInt(x, 10));
  const b = min.split('.').map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

export interface RequestSpec {
  site: FetchSite;
  /** What makes two requests the same (the canonical URL, or the query). */
  key: string;
  url: string;
  method?: 'GET' | 'POST' | 'LOCAL';
  body?: string | null;
  accept?: string | null;
  priority?: number;
}

export interface Waiter {
  libraryId: string;
  uuid: string;
  step: string;
}

export interface ClaimedRequest {
  id: number;
  leaseToken: string;
  site: string;
  method: string;
  url: string;
  body: string | null;
  accept: string | null;
}

export interface Answer {
  status: number | null;
  ms: number | null;
  error: string | null;
  /** The answer as the fetcher sent it. */
  body: Buffer | null;
  /** 'br' when the fetcher compressed it (it always does), else the raw bytes. */
  encoding: 'br' | 'identity';
}

export type ReportResult =
  | { accepted: true; outcome: ResponseClass; state: string }
  | { accepted: false; reason: string };

interface SiteRow {
  site: string;
  last_claim_at: number | null;
  backoff_until: number | null;
  backoff_reason: string | null;
  backoff_seconds: number;
  failures_in_row: number;
  challenges_in_row: number;
  paused_reason: string | null;
  paused_at: number | null;
  slow_factor: number;
  mode: string | null;
}

const AMAZON = new Set(['amazon-dp', 'amazon-search', 'amazon-img']);
/** The key a site backs off under (every Amazon queue together). */
export const backoffKey = (site: string) => (AMAZON.has(site) ? 'amazon' : site);

/** Minutes of the day in Japan (UTC+9, no daylight saving). */
function jstMinutes(now: number): number {
  const d = new Date(now + 9 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Inside NDL's daily outage window (setting). */
export function inNdlOutage(s: FetchSettings, now: number): boolean {
  if (s.ndlOutageMinutes <= 0) return false;
  const [h, m] = s.ndlOutageStartJst.split(':').map((x) => parseInt(x, 10));
  const start = h * 60 + m;
  const t = jstMinutes(now);
  const end = start + s.ndlOutageMinutes;
  return end <= 1440 ? t >= start && t < end : t >= start || t < end - 1440;
}

const unbrotli = promisify(brotliDecompress);
/** Request ids per slice of answeredSinceAsync. */
const ANSWERED_IDS_PER_SLICE = 10_000;

export class FetchQueue {
  /** The Amazon pace of the trial, decided at most every 30 s. */
  private trialAt = 0;
  private trialMode: 'shared' | 'separate' = 'shared';
  /**
   * New requests made per waiter step since the server started (a request another book already
   * made isn't counted): the analysis counts each answer's follow-ups from it (stage4/eta.ts).
   */
  readonly created: Record<string, number> = {};

  constructor(
    private readonly db: Database.Database,
    private readonly cacheDir: string,
    private readonly settings: () => FetchSettings,
    private readonly log: (m: string) => void = () => {},
  ) {}

  // ------------------------------------------------------------ enqueue

  /**
   * Adds a request (or finds the same one) and the book waiting on it. A request that already
   * has its answer makes the waiter ready at once.
   */
  enqueue(
    spec: RequestSpec,
    waiter: Waiter | null,
    now = Date.now(),
  ): { id: number; state: string } {
    const prio = spec.priority ?? 0;
    const existed =
      waiter !== null &&
      this.db
        .prepare('SELECT 1 FROM fetch_requests WHERE site = ? AND key = ?')
        .get(spec.site, spec.key) !== undefined;
    this.db
      .prepare(
        `INSERT INTO fetch_requests (site, key, method, url, body, accept, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site, key) DO UPDATE SET priority = MAX(priority, excluded.priority)`,
      )
      .run(
        spec.site,
        spec.key,
        spec.method ?? 'GET',
        spec.url,
        spec.body ?? null,
        spec.accept ?? null,
        prio,
        now,
        now,
      );
    const row = this.db
      .prepare('SELECT id, state FROM fetch_requests WHERE site = ? AND key = ?')
      .get(spec.site, spec.key) as { id: number; state: string };
    if (waiter) {
      const ready = row.state === 'done' || row.state === 'gone' || row.state === 'failed' ? 1 : 0;
      this.db
        .prepare(
          `INSERT INTO fetch_waiters (request_id, library_id, calibre_uuid, step, ready)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET ready = excluded.ready`,
        )
        .run(row.id, waiter.libraryId, waiter.uuid, waiter.step, ready);
      if (!existed) this.created[waiter.step] = (this.created[waiter.step] ?? 0) + 1;
    }
    return row;
  }

  // -------------------------------------------- requests asked again (store ratings)

  /** True while a request for this site and key waits or is being fetched (uses the due index). */
  isOpen(site: string, key: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM fetch_requests WHERE site = ? AND state IN ('queued', 'leased') AND key = ?",
      )
      .get(site, key);
  }

  /**
   * Answered requests of a site whose address starts with `urlPrefix`, finished at or after
   * `since`, oldest first (store ratings read 読書メーター's 登録数 from the saved searches).
   */
  answeredSince(
    site: string,
    urlPrefix: string,
    since: number,
  ): { id: number; finishedAt: number }[] {
    return this.db
      .prepare(
        `SELECT id, finished_at AS finishedAt FROM fetch_requests
         WHERE site = ? AND state = 'done' AND cache_file IS NOT NULL
           AND substr(url, 1, ?) = ? AND finished_at >= ?
         ORDER BY finished_at`,
      )
      .all(site, urlPrefix.length, urlPrefix, since) as { id: number; finishedAt: number }[];
  }

  /**
   * answeredSince read in slices of request ids, a turn of the event loop between them, in id
   * order (not by finish time): 2026-11-26, the one query read all 200,000 answered 読書メーター
   * requests at once (0.2-0.3 s on the PC) even when none had finished since.
   */
  async answeredSinceAsync(
    site: string,
    urlPrefix: string,
    since: number,
  ): Promise<{ id: number; finishedAt: number }[]> {
    const max =
      (this.db.prepare('SELECT MAX(id) AS m FROM fetch_requests').get() as { m: number | null })
        .m ?? 0;
    const slice = this.db.prepare(
      `SELECT id, finished_at AS finishedAt FROM fetch_requests
       WHERE id > ? AND id <= ? AND site = ? AND state = 'done' AND cache_file IS NOT NULL
         AND substr(url, 1, ?) = ? AND finished_at >= ?`,
    );
    const out: { id: number; finishedAt: number }[] = [];
    for (let from = 0; from < max; from += ANSWERED_IDS_PER_SLICE) {
      for (const r of slice.all(
        from,
        from + ANSWERED_IDS_PER_SLICE,
        site,
        urlPrefix.length,
        urlPrefix,
        since,
      ) as { id: number; finishedAt: number }[])
        out.push(r);
      await new Promise<void>((res) => setImmediate(res));
    }
    return out;
  }

  /** A request's state ('queued', 'leased', 'done', 'gone', 'failed'), or null when unknown. */
  requestState(id: number): string | null {
    const r = this.db.prepare('SELECT state FROM fetch_requests WHERE id = ?').get(id) as
      | { state: string }
      | undefined;
    return r?.state ?? null;
  }

  /**
   * Puts an answered request back in line to be asked again (store ratings read a page again
   * when its figures are old). A request still waiting keeps its place (its priority raised).
   */
  requeue(id: number, priority: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE fetch_requests SET state = 'queued', attempts = 0, next_at = 0, priority = ?,
           status = NULL, outcome = NULL, error = NULL, lease_token = NULL, lease_until = NULL,
           updated_at = ?
         WHERE id = ? AND state IN ('done', 'gone', 'failed')`,
      )
      .run(priority, now, id);
    this.db
      .prepare(
        `UPDATE fetch_requests SET priority = MAX(priority, ?), updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(priority, now, id);
  }

  /** Deletes a read answer's cached file (the request row stays, to be asked again). */
  forgetAnswer(id: number): void {
    const r = this.db.prepare('SELECT cache_file FROM fetch_requests WHERE id = ?').get(id) as
      | { cache_file: string | null }
      | undefined;
    if (!r?.cache_file) return;
    try {
      fs.rmSync(path.join(this.cacheDir, r.cache_file), { force: true });
    } catch {
      // A file that can't be removed is overwritten by the next answer.
    }
    this.db.prepare('UPDATE fetch_requests SET cache_file = NULL WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------ pacing

  private site(key: string, now: number): SiteRow {
    const r = this.db.prepare('SELECT * FROM fetch_sites WHERE site = ?').get(key) as
      | SiteRow
      | undefined;
    if (r) return r;
    this.db
      .prepare('INSERT OR IGNORE INTO fetch_sites (site, updated_at) VALUES (?, ?)')
      .run(key, now);
    return this.db.prepare('SELECT * FROM fetch_sites WHERE site = ?').get(key) as SiteRow;
  }

  /** The Amazon pace now: shared slot or separate queues (the trial switches once, mid-way). */
  amazonPace(now = Date.now()): 'shared' | 'separate' {
    const s = this.settings();
    if (s.amazonPace !== 'trial') return s.amazonPace;
    if (now - this.trialAt < 30_000) return this.trialMode;
    this.trialAt = now;
    const row = this.site('amazon', now);
    if (row.mode === 'separate') return (this.trialMode = 'separate');
    const c = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(state IN ('done', 'gone', 'failed')) AS finished
         FROM fetch_requests WHERE site IN ('amazon-dp', 'amazon-search') AND priority >= ?`,
      )
      .get(LABELED_PRIORITY) as { total: number; finished: number | null };
    if (c.total > 0 && (c.finished ?? 0) * 2 >= c.total) {
      this.db
        .prepare("UPDATE fetch_sites SET mode = 'separate', updated_at = ? WHERE site = 'amazon'")
        .run(now);
      this.log(
        `fetch: Amazon pace trial: ${c.finished} of ${c.total} labeled requests answered, now separate queues`,
      );
      return (this.trialMode = 'separate');
    }
    return (this.trialMode = 'shared');
  }

  /** The key a site is paced under. */
  paceKey(site: string, now = Date.now()): string {
    if ((site === 'amazon-dp' || site === 'amazon-search') && this.amazonPace(now) === 'shared')
      return 'amazon';
    return site;
  }

  /** Why a site can't have a request now (null = it can), and when it can at the earliest. */
  blocked(
    site: FetchSite,
    now = Date.now(),
    slot = 0,
  ): { reason: string; until: number | null } | null {
    const s = this.settings();
    const conf = s.sites[site];
    if (!conf?.enabled) return { reason: 'switched off', until: null };
    const back = this.site(slotKey(backoffKey(site), slot), now);
    if (back.paused_reason) return { reason: back.paused_reason, until: null };
    if (back.backoff_until && back.backoff_until > now) {
      return { reason: back.backoff_reason ?? 'backing off', until: back.backoff_until };
    }
    if (site === 'ndl' && inNdlOutage(s, now))
      return { reason: "NDL's daily outage", until: now + 60_000 };
    const pace = this.site(slotKey(this.paceKey(site, now), slot), now);
    // Amazon's slow-down is one for every fetcher (kept on slot 0's row).
    const slow = slot ? this.site(backoffKey(site), now).slow_factor : back.slow_factor;
    const interval = conf.intervalSeconds * 1000 * (AMAZON.has(site) ? slow : 1);
    if (pace.last_claim_at && pace.last_claim_at + interval > now) {
      return { reason: 'pace', until: pace.last_claim_at + interval };
    }
    return null;
  }

  // ------------------------------------------------------------ claims

  /**
   * Gives the fetcher one due request per site whose pace and in-flight limit allow it. `slot`
   * and `version`: a parallel fetcher's (stage4/fetch-slots.ts, temporary); slot 0 is as before.
   */
  claim(
    now = Date.now(),
    slot = 0,
    version?: string | null,
  ): { requests: ClaimedRequest[]; waitSeconds: number; waitMs: number } {
    const s = this.settings();
    this.expireLeases(now);
    const out: ClaimedRequest[] = [];
    let soonest = now + 30_000;
    const pick = this.db.prepare(
      `SELECT id, site, method, url, body, accept FROM fetch_requests
       WHERE site = ? AND state = 'queued' AND next_at <= ?
       ORDER BY priority DESC, next_at LIMIT 1`,
    );
    const next = this.db.prepare(
      `SELECT MIN(next_at) AS t FROM fetch_requests WHERE site = ? AND state = 'queued'`,
    );
    const take = this.db.prepare(
      `UPDATE fetch_requests SET state = 'leased', lease_token = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND state = 'queued'`,
    );
    const stamp = this.db.prepare(
      'UPDATE fetch_sites SET last_claim_at = ?, updated_at = ? WHERE site = ?',
    );
    const leasedOf = this.db.prepare(
      `SELECT COUNT(*) AS n FROM fetch_requests WHERE site = ? AND state = 'leased' AND ${LEASE_SLOT_SQL} = ?`,
    );
    const fv = this.db.prepare('SELECT version FROM fetcher_status WHERE id = 1').get() as
      | { version: string | null }
      | undefined;
    const multi = versionAtLeast(
      version !== undefined ? version : (fv?.version ?? null),
      MULTI_IN_FLIGHT_VERSION,
    );
    // Sites whose own last claim is oldest go first: where two share one slot (Amazon's product
    // pages and searches), they take turns. In a fixed order the product pages always won it
    // (found live 2026-11-18: 50 searches answered in a day, 30,103 waiting).
    const lastOwn = this.db.prepare('SELECT last_claim_at FROM fetch_sites WHERE site = ?');
    const order = (Object.keys(s.sites) as FetchSite[])
      .map((site, i) => ({
        site,
        i,
        last:
          (lastOwn.get(slotKey(site, slot)) as { last_claim_at: number | null } | undefined)
            ?.last_claim_at ?? 0,
      }))
      .sort((a, b) => a.last - b.last || a.i - b.i)
      .map((x) => x.site);
    for (const site of order) {
      const b = this.blocked(site, now, slot);
      if (b) {
        if (b.until) soonest = Math.min(soonest, b.until);
        continue;
      }
      // A site waits while it has as many requests in flight as it may: its setting, for a
      // fetcher that handles several per site (1.4.0+); one for older fetchers, which skip a
      // second request of a site they are already asking (it would wait out its lease).
      const limit = multi ? Math.max(1, s.sites[site]?.inFlight ?? 1) : 1;
      const open = (leasedOf.get(site, slot) as { n: number }).n;
      if (open >= limit) continue;
      const r = pick.get(site, now) as Omit<ClaimedRequest, 'leaseToken'> | undefined;
      if (!r) {
        const t = (next.get(site) as { t: number | null }).t;
        if (t !== null) soonest = Math.min(soonest, Math.max(t, now + 20));
        continue;
      }
      const token = slotToken(randomUUID(), slot);
      const paceKey = slotKey(this.paceKey(site, now), slot);
      const own = slotKey(site, slot);
      const ok = this.db.transaction(() => {
        if (take.run(token, now + s.leaseSeconds * 1000, now, r.id).changes !== 1) return false;
        this.site(paceKey, now);
        stamp.run(now, now, paceKey);
        // The site's own last claim too (its turn in a shared slot).
        if (paceKey !== own) {
          this.site(own, now);
          stamp.run(now, now, own);
        }
        return true;
      })();
      if (ok) out.push({ ...r, leaseToken: token });
    }
    return {
      requests: out,
      waitSeconds: Math.max(1, Math.min(30, Math.ceil((soonest - now) / 1000))),
      // Exact, so a site is asked again when its pace allows, not up to a second later (1.1.0
      // fetchers; waitSeconds stays for 1.0.0). A site with a request in flight isn't counted:
      // the fetcher asks again as soon as it has posted that answer.
      waitMs: Math.max(20, Math.min(30_000, soonest - now)),
    };
  }

  /**
   * Every open lease goes back to the queue now (their attempt count unchanged): the fetcher that
   * held them restarted and can't answer them. The site's pace still applies at the next claim.
   */
  releaseLeases(now = Date.now(), slot?: number): number {
    if (slot !== undefined)
      return this.db
        .prepare(
          `UPDATE fetch_requests SET state = 'queued', lease_token = NULL, lease_until = NULL, updated_at = ?
           WHERE state = 'leased' AND ${LEASE_SLOT_SQL} = ?`,
        )
        .run(now, slot).changes;
    return this.db
      .prepare(
        `UPDATE fetch_requests SET state = 'queued', lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE state = 'leased'`,
      )
      .run(now).changes;
  }

  /** Leases nobody answered go back to the queue (their attempt count unchanged). */
  expireLeases(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE fetch_requests SET state = 'queued', lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE state = 'leased' AND lease_until < ?`,
      )
      .run(now, now).changes;
  }

  // ------------------------------------------------------------ answers

  cacheFile(site: string, key: string): string {
    const h = createHash('sha256').update(`${site}\n${key}`).digest('hex');
    return path.join('fetch', site, h.slice(0, 2), `${h}.br`);
  }

  /** The decompressed answer of a request, or null. */
  readAnswer(id: number): Buffer | null {
    const r = this.db.prepare('SELECT cache_file FROM fetch_requests WHERE id = ?').get(id) as
      | { cache_file: string | null }
      | undefined;
    if (!r?.cache_file) return null;
    try {
      return brotliDecompressSync(fs.readFileSync(path.join(this.cacheDir, r.cache_file)));
    } catch {
      return null;
    }
  }

  /**
   * The same, read and decompressed off the event loop (store ratings read thousands of saved
   * searches in a row: read here, 2026-11-26, they held the server for seconds at a time).
   */
  async readAnswerAsync(id: number): Promise<Buffer | null> {
    const r = this.db.prepare('SELECT cache_file FROM fetch_requests WHERE id = ?').get(id) as
      | { cache_file: string | null }
      | undefined;
    if (!r?.cache_file) return null;
    try {
      return await unbrotli(await fs.promises.readFile(path.join(this.cacheDir, r.cache_file)));
    } catch {
      return null;
    }
  }

  /** The fetcher's answer to a claimed request. A second report of the same lease is accepted once. */
  report(id: number, leaseToken: string, answer: Answer, now = Date.now()): ReportResult {
    const s = this.settings();
    const req = this.db.prepare('SELECT * FROM fetch_requests WHERE id = ?').get(id) as
      | {
          id: number;
          site: string;
          key: string;
          state: string;
          lease_token: string | null;
          attempts: number;
          priority: number;
        }
      | undefined;
    if (!req) return { accepted: false, reason: 'no such request' };
    if (req.state !== 'leased' || req.lease_token !== leaseToken) {
      return {
        accepted: false,
        reason: 'not leased with this token (answered already or expired)',
      };
    }
    let raw: Buffer | null = null;
    try {
      raw = answer.body
        ? answer.encoding === 'br'
          ? brotliDecompressSync(answer.body)
          : answer.body
        : null;
    } catch {
      raw = null;
      answer = {
        ...answer,
        error: answer.error ?? 'answer could not be decompressed',
        status: null,
      };
    }
    if (raw && raw.length > s.maxPageMb * 1024 * 1024) {
      answer = { ...answer, error: `answer larger than ${s.maxPageMb} MB`, status: null };
      raw = null;
    }
    const outcome =
      answer.error && answer.status === null
        ? 'error'
        : classifyResponse(req.site, answer.status, raw);
    // Back-off and pauses go to the fetcher (slot) that asked.
    const bkey = slotKey(backoffKey(req.site), tokenSlot(leaseToken));
    const pace = AMAZON.has(req.site) ? this.amazonPace(now) : null;
    if (outcome !== 'ok' && outcome !== 'gone' && raw)
      this.keepRefused(req.site, id, answer.status, raw, now);
    let cacheFile: string | null = null;
    if ((outcome === 'ok' || outcome === 'gone') && raw) {
      cacheFile = this.cacheFile(req.site, req.key);
      const full = path.join(this.cacheDir, cacheFile);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const tmp = `${full}.${process.pid}.tmp`;
      const stored =
        answer.encoding === 'br' && answer.body
          ? answer.body
          : brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } });
      fs.writeFileSync(tmp, stored);
      fs.renameSync(tmp, full);
    }
    const state = this.db.transaction(() => {
      this.site(bkey, now);
      this.site(req.site, now);
      this.db
        .prepare(
          `UPDATE fetch_sites SET attempts = attempts + 1, challenges = challenges + ?, errors = errors + ?,
             busy = busy + ? WHERE site = ?`,
        )
        .run(
          outcome === 'challenge' ? 1 : 0,
          outcome === 'error' ? 1 : 0,
          outcome === 'busy' ? 1 : 0,
          req.site,
        );
      this.db
        .prepare(
          `INSERT INTO fetch_attempts (request_id, site, at, ms, status, bytes, outcome, pace, labeled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          req.site,
          now,
          answer.ms,
          answer.status,
          raw?.length ?? null,
          outcome,
          pace,
          req.priority >= LABELED_PRIORITY ? 1 : 0,
        );
      let next: { state: string; nextAt: number; attempts: number };
      if (outcome === 'ok' || outcome === 'gone') {
        next = { state: outcome === 'ok' ? 'done' : 'gone', nextAt: 0, attempts: req.attempts + 1 };
        this.db
          .prepare(
            `UPDATE fetch_sites SET failures_in_row = 0, challenges_in_row = 0, backoff_seconds = 0,
               backoff_reason = NULL, updated_at = ? WHERE site = ?`,
          )
          .run(now, bkey);
      } else if (outcome === 'challenge') {
        const row = this.site(bkey, now);
        const secs = Math.min(
          s.challengeBackoffMaxSeconds,
          row.backoff_seconds > 0 ? row.backoff_seconds * 2 : s.challengeBackoffSeconds,
        );
        const inRow = row.challenges_in_row + 1;
        this.db
          .prepare(
            `UPDATE fetch_sites SET backoff_until = ?, backoff_seconds = ?, backoff_reason = ?,
               challenges_in_row = ?, paused_reason = ?, paused_at = ?, updated_at = ? WHERE site = ?`,
          )
          .run(
            now + secs * 1000,
            secs,
            `refused (${answer.status === 200 ? 'bot check page' : `HTTP ${answer.status}`}): waiting ${secs} s`,
            inRow,
            inRow >= s.challengePauseAfter ? `${inRow} refusals in a row` : row.paused_reason,
            inRow >= s.challengePauseAfter ? now : row.paused_at,
            now,
            bkey,
          );
        // WP20 lessons 4: a pause tells someone (the log here, the notifications' alert).
        if (inRow >= s.challengePauseAfter && !row.paused_reason)
          this.log(`fetch: ${bkey} paused after ${inRow} refusals in a row`);
        // A challenge is asked again; it doesn't count toward giving up.
        next = { state: 'queued', nextAt: now + secs * 1000, attempts: req.attempts };
      } else {
        const attempts = req.attempts + 1;
        const wait = s.retrySeconds * 1000 * 2 ** Math.min(attempts - 1, 8);
        if (outcome === 'busy') {
          const row = this.site(bkey, now);
          this.db
            .prepare(
              `UPDATE fetch_sites SET backoff_until = ?, backoff_reason = ?, failures_in_row = ?, updated_at = ?
               WHERE site = ?`,
            )
            .run(
              now + wait,
              `busy (HTTP ${answer.status}): waiting ${Math.round(wait / 1000)} s`,
              row.failures_in_row + 1,
              now,
              bkey,
            );
        } else {
          this.db
            .prepare(
              'UPDATE fetch_sites SET failures_in_row = failures_in_row + 1, updated_at = ? WHERE site = ?',
            )
            .run(now, bkey);
        }
        next =
          attempts >= s.maxAttempts
            ? { state: 'failed', nextAt: 0, attempts }
            : { state: 'queued', nextAt: now + wait, attempts };
      }
      this.db
        .prepare(
          `UPDATE fetch_requests SET state = ?, next_at = ?, attempts = ?, lease_token = NULL, lease_until = NULL,
             status = ?, bytes = ?, outcome = ?, error = ?, ms = ?, cache_file = COALESCE(?, cache_file),
             finished_at = CASE WHEN ? IN ('done', 'gone', 'failed') THEN ? ELSE finished_at END, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.state,
          next.nextAt,
          next.attempts,
          answer.status,
          raw?.length ?? null,
          outcome,
          answer.error ? answer.error.slice(0, 300) : null,
          answer.ms,
          cacheFile,
          next.state,
          now,
          now,
          id,
        );
      if (next.state !== 'queued') {
        this.db.prepare('UPDATE fetch_waiters SET ready = 1 WHERE request_id = ?').run(id);
        // The audiobook cleanup's lookups (WP21c) wait in their own table.
        this.db.prepare('UPDATE audio_fetch_waiters SET ready = 1 WHERE request_id = ?').run(id);
        // More Bookmeter coverage (stage4/bookmeter-more.ts) waits in its own table too.
        this.db.prepare('UPDATE bookmeter_more_waiters SET ready = 1 WHERE request_id = ?').run(id);
        // So does the Bookmeter links pass (stage4/bookmeter-listing.ts).
        this.db
          .prepare('UPDATE bookmeter_listing_waiters SET ready = 1 WHERE request_id = ?')
          .run(id);
      }
      return next.state;
    })();
    if (AMAZON.has(req.site)) this.updateSlowDown(now);
    return { accepted: true, outcome, state };
  }

  /**
   * A refused answer's page (a bot check, a 503, an error page), kept for a look at what the
   * site said: cache/cleanup/fetch-refused/<site>/<time>-<request>-<status>.br, at most
   * REFUSED_KEEP per site (the cache isn't backed up). Never read by the analysis.
   */
  private keepRefused(
    site: string,
    id: number,
    status: number | null,
    raw: Buffer,
    now: number,
  ): void {
    try {
      const dir = path.join(this.cacheDir, 'fetch-refused', site);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.readdirSync(dir).length >= REFUSED_KEEP) return;
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const body = raw.subarray(0, REFUSED_MAX_BYTES);
      fs.writeFileSync(
        path.join(dir, `${stamp}-${id}-${status ?? 'none'}.br`),
        brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }),
      );
    } catch {
      // Only for a look later: never in the way of the answer.
    }
  }

  /** Amazon slows down (x1.5) while its recent refusal share is above the setting. */
  private updateSlowDown(now: number): void {
    const s = this.settings();
    const rows = this.db
      .prepare(
        `SELECT outcome FROM fetch_attempts WHERE site IN ('amazon-dp', 'amazon-search', 'amazon-img')
         ORDER BY at DESC LIMIT ?`,
      )
      .all(s.slowDownWindow) as { outcome: string }[];
    if (rows.length < Math.min(20, s.slowDownWindow)) return;
    const share = (100 * rows.filter((r) => r.outcome === 'challenge').length) / rows.length;
    const factor = share > s.slowDownPercent ? 1.5 : 1;
    const cur = this.site('amazon', now).slow_factor;
    if (cur !== factor) {
      this.db
        .prepare('UPDATE fetch_sites SET slow_factor = ?, updated_at = ? WHERE site = ?')
        .run(factor, now, 'amazon');
      this.log(
        `fetch: Amazon ${factor > 1 ? 'slowed down' : 'back to its pace'} (refused ${share.toFixed(1)} % of the last ${rows.length})`,
      );
    }
  }

  /** Resumes a paused site (from the page). */
  resume(site: string, now = Date.now()): void {
    // Every fetcher's slot of the site (stage4/fetch-slots.ts).
    for (let k = 0; k < MAX_FETCHERS; k++)
      this.db
        .prepare(
          `UPDATE fetch_sites SET paused_reason = NULL, paused_at = NULL, challenges_in_row = 0, backoff_until = NULL,
           backoff_seconds = 0, backoff_reason = NULL, updated_at = ? WHERE site = ?`,
        )
        .run(now, slotKey(backoffKey(site), k));
  }

  /**
   * Gives up the queued requests of a switched-off site (at most `limit`), so whoever waits on
   * them goes on without that source; returns their ids. "Ask again" re-asks them later.
   */
  giveUpQueued(site: string, limit = 1000, now = Date.now()): number[] {
    const ids = (
      this.db
        .prepare(`SELECT id FROM fetch_requests WHERE site = ? AND state = 'queued' LIMIT ?`)
        .all(site, limit) as { id: number }[]
    ).map((r) => r.id);
    if (!ids.length) return ids;
    this.db.transaction(() => {
      const fail = this.db.prepare(
        `UPDATE fetch_requests SET state = 'failed', error = 'The site is switched off', finished_at = ?, updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      );
      const ready = this.db.prepare(
        'UPDATE audio_fetch_waiters SET ready = 1 WHERE request_id = ?',
      );
      const readyBm = this.db.prepare(
        'UPDATE bookmeter_more_waiters SET ready = 1 WHERE request_id = ?',
      );
      const readyBl = this.db.prepare(
        'UPDATE bookmeter_listing_waiters SET ready = 1 WHERE request_id = ?',
      );
      for (const id of ids) {
        fail.run(now, now, id);
        ready.run(id);
        readyBm.run(id);
        readyBl.run(id);
      }
    })();
    return ids;
  }

  /** Puts given-up requests of a site back in the queue (from the page). */
  retryFailed(site: string, now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE fetch_requests SET state = 'queued', attempts = 0, next_at = 0, updated_at = ?
         WHERE site = ? AND state = 'failed'`,
      )
      .run(now, site).changes;
  }
}
