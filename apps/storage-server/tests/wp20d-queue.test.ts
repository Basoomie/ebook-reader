/**
 * WP20d: the fetch queue in cleanup.db: pacing at claim time, one request in flight per site,
 * Amazon's shared slot and its trial, challenge pages backing off every Amazon queue, the pause
 * after many in a row, gone pages, retries and giving up, leases, the slow-down, NDL's outage.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { brotliCompressSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { FetchQueue, LABELED_PRIORITY, inNdlOutage } from '../src/cleanup/stage4/queue';
import { classifyResponse } from '../src/cleanup/stage4/challenge';
import { makeTempDir } from './helpers/spawn-server';
import { AMAZON_404, AMAZON_CHALLENGE, amazonDp } from './helpers/stage4-fixture';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const page = (s: string) => ({
  status: 200,
  ms: 10,
  error: null,
  body: brotliCompressSync(Buffer.from(s)),
  encoding: 'br' as const,
});

describe('WP20d fetch queue', () => {
  let dir: string;
  let db: Database.Database;
  let q: FetchQueue;

  beforeEach(() => {
    dir = makeTempDir('wp20d-queue-');
    db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
    // Only Amazon's two queues and RanobeDB are open in these tests.
    const s = getSettings(db).fetch;
    const sites = Object.fromEntries(
      Object.keys(s.sites).map((k) => [k, { ...s.sites[k], enabled: false }]),
    );
    sites['amazon-dp'] = { enabled: true, intervalSeconds: 8 };
    sites['amazon-search'] = { enabled: true, intervalSeconds: 8 };
    sites.ranobedb = { enabled: true, intervalSeconds: 1 };
    updateSettings(db, { fetch: { ...s, sites, amazonPace: 'separate' } });
    q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const dp = (asin: string, prio = 0) => ({
    site: 'amazon-dp' as const,
    key: asin,
    url: `https://www.amazon.co.jp/dp/${asin}`,
    priority: prio,
  });

  it('asks each distinct request once and makes every waiter ready with its answer', () => {
    const a = q.enqueue(dp('B000000001'), { libraryId: 'L', uuid: 'u1', step: 'amazon-dp' }, T0);
    const b = q.enqueue(dp('B000000001'), { libraryId: 'L', uuid: 'u2', step: 'amazon-dp' }, T0);
    expect(b.id).toBe(a.id);
    const [c] = q.claim(T0).requests;
    expect(c.id).toBe(a.id);
    expect(
      q.report(
        c.id,
        c.leaseToken,
        page(amazonDp({ asin: 'B000000001', title: 'x', authors: [] })),
        T0 + 2000,
      ),
    ).toMatchObject({ accepted: true, outcome: 'ok', state: 'done' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fetch_waiters WHERE ready = 1').get()).toEqual({
      n: 2,
    });
    // A later book gets the cached answer at once.
    q.enqueue(dp('B000000001'), { libraryId: 'L', uuid: 'u3', step: 'amazon-dp' }, T0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fetch_waiters WHERE ready = 1').get()).toEqual({
      n: 3,
    });
    expect(q.readAnswer(c.id)?.toString()).toContain('B000000001');
    // The second report of the same lease is refused (the first counted).
    expect(q.report(c.id, c.leaseToken, page('again'), T0 + 3000).accepted).toBe(false);
  });

  it("keeps each site's pace at claim time, one request in flight, across a restart of the queue", () => {
    for (const a of ['B000000001', 'B000000002', 'B000000003']) q.enqueue(dp(a), null, T0);
    const first = q.claim(T0).requests;
    expect(first.map((r) => r.site)).toEqual(['amazon-dp']);
    // Still in flight: nothing more for Amazon.
    expect(q.claim(T0 + 9000).requests).toEqual([]);
    q.report(first[0].id, first[0].leaseToken, page('<html>' + 'x'.repeat(30000)), T0 + 1000);
    // Answered, but its 8 s since the last claim haven't passed.
    expect(q.claim(T0 + 5000).requests).toEqual([]);
    // A new queue object (the server restarted) keeps the pace from cleanup.db.
    const q2 = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
    expect(q2.claim(T0 + 7999).requests).toEqual([]);
    expect(q2.claim(T0 + 8000).requests.map((r) => r.site)).toEqual(['amazon-dp']);
  });

  it('product pages and searches take turns in their shared slot', () => {
    // Found live 2026-11-18: in a fixed order the product pages always took the slot.
    updateSettings(db, { fetch: { ...getSettings(db).fetch, amazonPace: 'shared' } });
    for (let i = 0; i < 4; i++) {
      q.enqueue(dp(`B00000000${i}`), null, T0);
      q.enqueue(
        {
          site: 'amazon-search',
          key: `k${i}`,
          url: `https://www.amazon.co.jp/s?k=k${i}&i=digital-text`,
        },
        null,
        T0,
      );
    }
    const sites: string[] = [];
    let t = T0;
    for (let i = 0; i < 6; i++) {
      const got = q.claim(t).requests.filter((r) => r.site.startsWith('amazon'));
      // One request per slot, never both queues at once.
      expect(got).toHaveLength(1);
      sites.push(got[0].site);
      q.report(got[0].id, got[0].leaseToken, page('<html>' + 'x'.repeat(30000)), t + 500);
      t += 8000;
    }
    expect(sites).toEqual([
      'amazon-dp',
      'amazon-search',
      'amazon-dp',
      'amazon-search',
      'amazon-dp',
      'amazon-search',
    ]);
  });

  it('labeled books go first', () => {
    q.enqueue(dp('B000000001'), null, T0);
    q.enqueue(dp('B000000002', LABELED_PRIORITY), null, T0);
    const [c] = q.claim(T0).requests;
    expect(c.url).toContain('B000000002');
  });

  it('a challenge page backs off every Amazon queue, is asked again, and pauses after many in a row', () => {
    updateSettings(db, { fetch: { ...getSettings(db).fetch, challengePauseAfter: 2 } });
    q.enqueue(dp('B000000001'), null, T0);
    q.enqueue(
      { site: 'amazon-search', key: 'k', url: 'https://www.amazon.co.jp/s?k=k&i=digital-text' },
      null,
      T0,
    );
    const claims = q.claim(T0).requests;
    expect(claims.map((c) => c.site).sort()).toEqual(['amazon-dp', 'amazon-search']);
    const search = claims.find((c) => c.site === 'amazon-search')!;
    expect(q.report(search.id, search.leaseToken, page(AMAZON_CHALLENGE), T0 + 1000)).toMatchObject(
      { outcome: 'challenge', state: 'queued' },
    );
    expect(q.blocked('amazon-dp', T0 + 30_000)?.reason).toMatch(
      /refused \(bot check page\): waiting 60 s/,
    );
    expect(q.blocked('amazon-search', T0 + 61_001)).toBeNull();
    // The second challenge in a row doubles the wait and pauses Amazon.
    const dpc = claims.find((c) => c.site === 'amazon-dp')!;
    q.report(dpc.id, dpc.leaseToken, page(AMAZON_CHALLENGE), T0 + 2000);
    const row = db
      .prepare("SELECT backoff_seconds, paused_reason FROM fetch_sites WHERE site = 'amazon'")
      .get() as { backoff_seconds: number; paused_reason: string };
    expect(row.backoff_seconds).toBe(120);
    expect(row.paused_reason).toBe('2 refusals in a row');
    expect(q.blocked('amazon-dp', T0 + 10 * 60_000)?.reason).toBe('2 refusals in a row');
    q.resume('amazon-dp', T0 + 10 * 60_000);
    expect(q.blocked('amazon-dp', T0 + 10 * 60_000)).toBeNull();
    // Challenges never count toward giving up.
    expect(db.prepare('SELECT MAX(attempts) AS a FROM fetch_requests').get()).toEqual({ a: 0 });
  });

  it("Amazon's 503 is a refusal like the bot check: doubling wait, slow-down, page kept, never given up", () => {
    // Seen live 2026-11-17: a 320-byte 503 for 64 of 381 Amazon requests at the 8 s pace.
    updateSettings(db, {
      fetch: {
        ...getSettings(db).fetch,
        challengePauseAfter: 1000,
        slowDownWindow: 20,
        slowDownPercent: 10,
      },
    });
    const refused = {
      status: 503,
      ms: 300,
      error: null,
      body: brotliCompressSync(Buffer.from('<html><body>' + 'x'.repeat(290) + '</body></html>')),
      encoding: 'br' as const,
    };
    expect(classifyResponse('amazon-dp', 503, Buffer.alloc(320))).toBe('challenge');
    expect(classifyResponse('amazon-search', 429, null)).toBe('challenge');
    // Other sites' 503 stays "busy" (Bookmeter's congestion).
    expect(classifyResponse('bookmeter', 503, Buffer.alloc(320))).toBe('busy');
    let t = T0;
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      q.enqueue(dp('B0000000AA'), null, t);
      const [c] = q.claim(t).requests.filter((r) => r.site === 'amazon-dp');
      expect(q.report(c.id, c.leaseToken, refused, t + 300)).toMatchObject({
        outcome: 'challenge',
        state: 'queued',
      });
      const row = db
        .prepare("SELECT backoff_until, backoff_reason FROM fetch_sites WHERE site = 'amazon'")
        .get() as { backoff_until: number; backoff_reason: string };
      expect(row.backoff_reason).toMatch(/^refused \(HTTP 503\): waiting \d+ s$/);
      waits.push(Math.round((row.backoff_until - (t + 300)) / 1000));
      t = row.backoff_until + 1;
    }
    // 60 s doubling up to 15 min (the settings' defaults).
    expect(waits).toEqual([60, 120, 240, 480, 900, 900, 900]);
    // Refusals never count toward giving up.
    expect(
      db.prepare("SELECT state, attempts FROM fetch_requests WHERE key = 'B0000000AA'").get(),
    ).toEqual({ state: 'queued', attempts: 0 });
    // The page of each refusal is kept for a look.
    const kept = fs.readdirSync(path.join(dir, 'cache', 'fetch-refused', 'amazon-dp'));
    expect(kept).toHaveLength(7);
    expect(kept.every((f) => /-503\.br$/.test(f))).toBe(true);
    // And the refusals count toward the automatic slow-down.
    for (let i = 0; i < 13; i++) {
      q.enqueue(dp(`B00000${String(i).padStart(4, '0')}`), null, t);
      const [c] = q.claim(t).requests.filter((r) => r.site === 'amazon-dp');
      q.report(c.id, c.leaseToken, page('<html>' + 'x'.repeat(30000)), t + 500);
      t += 20_000;
    }
    expect(db.prepare("SELECT slow_factor FROM fetch_sites WHERE site = 'amazon'").get()).toEqual({
      slow_factor: 1.5,
    });
  });

  it("Amazon's not-found page is gone, not a challenge; network errors are asked again and given up", () => {
    expect(classifyResponse('amazon-dp', 404, Buffer.from(AMAZON_404))).toBe('gone');
    expect(classifyResponse('amazon-dp', 200, Buffer.from(AMAZON_404))).toBe('ok');
    expect(classifyResponse('amazon-search', 200, Buffer.from(AMAZON_CHALLENGE))).toBe('challenge');
    expect(classifyResponse('ranobedb', 200, Buffer.from(AMAZON_CHALLENGE))).toBe('ok');
    updateSettings(db, { fetch: { ...getSettings(db).fetch, maxAttempts: 2, retrySeconds: 30 } });
    q.enqueue(dp('B000000404'), { libraryId: 'L', uuid: 'u', step: 'amazon-dp' }, T0);
    let [c] = q.claim(T0).requests;
    expect(
      q.report(
        c.id,
        c.leaseToken,
        {
          status: 404,
          ms: 5,
          error: null,
          body: brotliCompressSync(Buffer.from(AMAZON_404)),
          encoding: 'br',
        },
        T0 + 1000,
      ),
    ).toMatchObject({ outcome: 'gone', state: 'gone' });
    q.enqueue(
      { site: 'ranobedb', key: 'x', url: 'https://ranobedb.org/api/v0/books?q=x' },
      { libraryId: 'L', uuid: 'u', step: 'ranobedb-search' },
      T0,
    );
    [c] = q.claim(T0 + 2000).requests.filter((r) => r.site === 'ranobedb');
    expect(
      q.report(
        c.id,
        c.leaseToken,
        { status: null, ms: 5, error: 'getaddrinfo EAI_AGAIN', body: null, encoding: 'br' },
        T0 + 2500,
      ),
    ).toMatchObject({ outcome: 'error', state: 'queued' });
    expect(q.claim(T0 + 20_000).requests.filter((r) => r.site === 'ranobedb')).toEqual([]);
    [c] = q.claim(T0 + 33_000).requests.filter((r) => r.site === 'ranobedb');
    expect(
      q.report(
        c.id,
        c.leaseToken,
        { status: null, ms: 5, error: 'timeout', body: null, encoding: 'br' },
        T0 + 34_000,
      ),
    ).toMatchObject({ state: 'failed' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM fetch_waiters WHERE ready = 1').get()).toEqual({
      n: 2,
    });
    expect(q.retryFailed('ranobedb', T0 + 40_000)).toBe(1);
  });

  it('an unanswered lease goes back to the queue', () => {
    q.enqueue(dp('B000000001'), null, T0);
    const [c] = q.claim(T0).requests;
    expect(q.expireLeases(T0 + 119_000)).toBe(0);
    expect(q.expireLeases(T0 + 121_000)).toBe(1);
    expect(q.report(c.id, c.leaseToken, page('late'), T0 + 122_000).accepted).toBe(false);
    expect(q.claim(T0 + 122_000).requests.map((r) => r.id)).toEqual([c.id]);
  });

  it('the trial shares one Amazon slot until half the labeled requests are answered', () => {
    updateSettings(db, { fetch: { ...getSettings(db).fetch, amazonPace: 'trial' } });
    q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
    q.enqueue(dp('B000000001', LABELED_PRIORITY), null, T0);
    q.enqueue(
      {
        site: 'amazon-search',
        key: 's1',
        url: 'https://www.amazon.co.jp/s?k=s1',
        priority: LABELED_PRIORITY,
      },
      null,
      T0,
    );
    // Shared: one claim for Amazon in total.
    const first = q.claim(T0).requests;
    expect(first).toHaveLength(1);
    q.report(first[0].id, first[0].leaseToken, page('<html>' + 'x'.repeat(30000)), T0 + 1000);
    expect(q.claim(T0 + 4000).requests).toEqual([]);
    // Half answered: separate queues from now on (decided at most every 30 s).
    expect(q.amazonPace(T0 + 31_000)).toBe('separate');
    expect(q.paceKey('amazon-search', T0 + 31_000)).toBe('amazon-search');
    const row = db.prepare('SELECT pace FROM fetch_attempts').get() as { pace: string };
    expect(row.pace).toBe('shared');
  });

  it('slows Amazon down while its recent challenge share is above the setting', () => {
    updateSettings(db, {
      fetch: {
        ...getSettings(db).fetch,
        slowDownWindow: 20,
        slowDownPercent: 10,
        challengePauseAfter: 1000,
        challengeBackoffSeconds: 10,
        challengeBackoffMaxSeconds: 10,
      },
    });
    let t = T0;
    for (let i = 0; i < 20; i++) {
      q.enqueue(dp(`B00000${String(i).padStart(4, '0')}`), null, t);
      const [c] = q.claim(t).requests.filter((r) => r.site === 'amazon-dp');
      q.report(
        c.id,
        c.leaseToken,
        page(i % 5 === 0 ? AMAZON_CHALLENGE : '<html>' + 'x'.repeat(30000)),
        t + 500,
      );
      t += 20_000;
    }
    expect(db.prepare("SELECT slow_factor FROM fetch_sites WHERE site = 'amazon'").get()).toEqual({
      slow_factor: 1.5,
    });
  });

  it("knows NDL's daily outage window in Japan's time", () => {
    const s = getSettings(db).fetch;
    // 03:55-04:15 JST = 18:55-19:15 UTC.
    expect(inNdlOutage(s, Date.UTC(2026, 10, 18, 18, 54))).toBe(false);
    expect(inNdlOutage(s, Date.UTC(2026, 10, 18, 18, 55))).toBe(true);
    expect(inNdlOutage(s, Date.UTC(2026, 10, 18, 19, 14))).toBe(true);
    expect(inNdlOutage(s, Date.UTC(2026, 10, 18, 19, 15))).toBe(false);
  });
});
