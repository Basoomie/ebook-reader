/**
 * TEMPORARY (2026-11-19, removed with stage4/fetch-slots.ts): parallel fetchers, each on its own
 * VPN address. Each fetcher (slot) paces and backs off on its own keys, takes the next due
 * request from the whole queue, and no request is ever handed to two fetchers. Slot 0 (the
 * usual fetcher) keeps the bare keys, so it runs exactly as before.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { brotliCompressSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplyToken } from '../src/cleanup/apply-tokens';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { slotStateRow } from '../src/cleanup/stage4/fetch-slots';
import { FetchQueue, type ClaimedRequest } from '../src/cleanup/stage4/queue';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import { AMAZON_404, AMAZON_CHALLENGE } from './helpers/stage4-fixture';

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const page = (s: string) => ({
  status: 200,
  ms: 10,
  error: null,
  body: brotliCompressSync(Buffer.from(s)),
  encoding: 'br' as const,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only Amazon (one shared 8 s slot, as live) and RanobeDB (1 s) are open. */
function openSites(db: Database.Database) {
  const s = getSettings(db).fetch;
  const sites = Object.fromEntries(
    Object.keys(s.sites).map((k) => [k, { ...s.sites[k], enabled: false }]),
  );
  sites['amazon-dp'] = { enabled: true, intervalSeconds: 8, inFlight: 1 };
  sites['amazon-search'] = { enabled: true, intervalSeconds: 8, inFlight: 1 };
  sites.ranobedb = { enabled: true, intervalSeconds: 1, inFlight: 1 };
  updateSettings(db, { fetch: { ...s, sites, amazonPace: 'shared' } });
  db.prepare("UPDATE fetcher_status SET version = '1.4.0' WHERE id = 1").run();
}

function enqueueMany(q: FetchQueue, n: number) {
  for (let i = 0; i < n; i++) {
    q.enqueue(
      { site: 'amazon-dp', key: `B${i}`, url: `https://www.amazon.co.jp/dp/B${i}` },
      null,
      T0,
    );
    q.enqueue(
      {
        site: 'amazon-search',
        key: `k${i}`,
        url: `https://www.amazon.co.jp/s?k=k${i}&i=digital-text`,
      },
      null,
      T0,
    );
    q.enqueue(
      { site: 'ranobedb', key: `r${i}`, url: `https://ranobedb.org/api/v0/book/${i}` },
      null,
      T0,
    );
  }
}

const answer = (c: ClaimedRequest) =>
  c.site === 'ranobedb' ? page('{"book":{}}') : page(AMAZON_404);

describe('parallel fetchers (temporary)', () => {
  let dir: string;
  let db: Database.Database;
  let q: FetchQueue;

  beforeEach(() => {
    dir = makeTempDir('fetch-slots-');
    db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
    openSites(db);
    q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Claims every 250 ms for `secs` seconds on the given slots, answering each claim at once. */
  function run(slots: number[], secs: number) {
    const claims: { slot: number; at: number; c: ClaimedRequest }[] = [];
    for (let t = T0; t <= T0 + secs * 1000; t += 250) {
      for (const slot of slots) {
        const got = q.claim(t, slot, slot ? '1.4.0' : undefined).requests;
        for (const c of got) {
          claims.push({ slot, at: t, c });
          expect(q.report(c.id, c.leaseToken, answer(c), t + 100)).toMatchObject({
            accepted: true,
          });
        }
      }
    }
    return claims;
  }

  it('two fetchers on slots 0 and 1 claim disjoint requests, each on its own clocks', () => {
    enqueueMany(q, 40);
    const claims = run([0, 1], 120);
    // Never one request to two fetchers, and none asked twice.
    const ids = claims.map((x) => x.c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const by = (slot: number) => new Set(claims.filter((x) => x.slot === slot).map((x) => x.c.id));
    const s0 = by(0);
    const s1 = by(1);
    expect(s0.size).toBeGreaterThan(0);
    expect(s1.size).toBeGreaterThan(0);
    expect([...s0].filter((id) => s1.has(id))).toEqual([]);
    // Slot 0's leases are plain UUIDs as before; slot 1's carry its slot.
    for (const x of claims) {
      if (x.slot === 0) expect(x.c.leaseToken).toMatch(UUID);
      else expect(x.c.leaseToken.startsWith('s1:')).toBe(true);
    }
    // Each slot keeps Amazon's shared 8 s pace on its own clock...
    for (const slot of [0, 1]) {
      const at = claims
        .filter((x) => x.slot === slot && x.c.site.startsWith('amazon'))
        .map((x) => x.at);
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(8000);
      expect(at.length).toBe(16); // 0, 8, ..., 120 s
    }
    // ...and the two don't wait for each other: both asked Amazon at the start.
    expect(
      claims.filter((x) => x.at === T0 && x.c.site.startsWith('amazon')).map((x) => x.slot),
    ).toEqual([0, 1]);
    // Different pace keys: slot 0 the bare ones, slot 1 its own.
    const stamp = (key: string) =>
      (
        db.prepare('SELECT last_claim_at AS t FROM fetch_sites WHERE site = ?').get(key) as
          | { t: number | null }
          | undefined
      )?.t ?? null;
    expect(stamp('amazon')).not.toBeNull();
    expect(stamp('amazon-1')).not.toBeNull();
    expect(stamp('ranobedb')).not.toBeNull();
    expect(stamp('ranobedb-1')).not.toBeNull();
    // fetch_attempts (what the time left reads) keep the real site names.
    const attemptSites = (
      db.prepare('SELECT DISTINCT site FROM fetch_attempts ORDER BY site').all() as {
        site: string;
      }[]
    ).map((r) => r.site);
    expect(attemptSites).toEqual(['amazon-dp', 'amazon-search', 'ranobedb']);
    // Product pages and searches still take turns within each slot.
    for (const slot of [0, 1]) {
      const sites = claims
        .filter((x) => x.slot === slot && x.c.site.startsWith('amazon'))
        .map((x) => x.c.site);
      expect(sites.filter((s) => s === 'amazon-dp').length).toBe(8);
    }
  });

  it('three fetchers ask every request exactly once', () => {
    enqueueMany(q, 30);
    const claims = run([0, 1, 2], 400);
    const ids = claims.map((x) => x.c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(90);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM fetch_requests WHERE state <> 'done'").get(),
    ).toEqual({ n: 0 });
    for (const slot of [0, 1, 2]) expect(claims.some((x) => x.slot === slot)).toBe(true);
  });

  it('slot 0 alone runs as before: bare keys only, plain lease tokens', () => {
    enqueueMany(q, 5);
    const claims = run([0], 60);
    expect(claims.length).toBeGreaterThan(0);
    for (const x of claims) expect(x.c.leaseToken).toMatch(UUID);
    expect(db.prepare("SELECT site FROM fetch_sites WHERE site GLOB '*-[0-9]'").all()).toEqual([]);
  });

  it('a refusal backs off only the fetcher that got it; Resume clears every fetcher', () => {
    updateSettings(db, { fetch: { ...getSettings(db).fetch, challengePauseAfter: 2 } });
    enqueueMany(q, 3);
    const a0 = q.claim(T0, 0).requests.find((c) => c.site.startsWith('amazon'))!;
    const a1 = q.claim(T0, 1, '1.4.0').requests.find((c) => c.site.startsWith('amazon'))!;
    expect(a0.id).not.toBe(a1.id);
    expect(q.report(a1.id, a1.leaseToken, page(AMAZON_CHALLENGE), T0 + 500)).toMatchObject({
      outcome: 'challenge',
    });
    q.report(a0.id, a0.leaseToken, page(AMAZON_404), T0 + 500);
    expect(q.blocked('amazon-dp', T0 + 9000, 1)?.reason).toMatch(/refused/);
    expect(q.blocked('amazon-dp', T0 + 9000, 0)).toBeNull();
    // The page shows slot 0's state, or another fetcher's wait named by its number.
    expect(slotStateRow(db, 'amazon', T0 + 9000)?.backoff_reason).toMatch(/^fetcher 2: refused/);
    // A second refusal in a row pauses fetcher 2 only.
    const again = q
      .claim(T0 + 70_000, 1, '1.4.0')
      .requests.find((c) => c.site.startsWith('amazon'))!;
    q.report(again.id, again.leaseToken, page(AMAZON_CHALLENGE), T0 + 70_500);
    expect(q.blocked('amazon-search', T0 + 10 * 60_000, 1)?.reason).toBe('2 refusals in a row');
    expect(q.blocked('amazon-search', T0 + 10 * 60_000, 0)).toBeNull();
    expect(slotStateRow(db, 'amazon', T0 + 10 * 60_000)?.paused_reason).toBe(
      'fetcher 2: 2 refusals in a row',
    );
    q.resume('amazon-dp', T0 + 10 * 60_000);
    expect(q.blocked('amazon-search', T0 + 10 * 60_000, 1)).toBeNull();
    expect(slotStateRow(db, 'amazon', T0 + 10 * 60_000)?.paused_reason).toBeNull();
  });

  it('counts requests in flight per fetcher, and a restart releases only its own', () => {
    enqueueMany(q, 3);
    const r0 = q.claim(T0, 0).requests.find((c) => c.site === 'ranobedb')!;
    const r1 = q.claim(T0, 1, '1.4.0').requests.find((c) => c.site === 'ranobedb')!;
    expect(r0).toBeDefined();
    expect(r1).toBeDefined();
    // One each in flight (RanobeDB allows one): no more for either until answered.
    expect(q.claim(T0 + 2000, 0).requests.some((c) => c.site === 'ranobedb')).toBe(false);
    expect(q.claim(T0 + 2000, 1, '1.4.0').requests.some((c) => c.site === 'ranobedb')).toBe(false);
    expect(q.releaseLeases(T0 + 3000, 1)).toBeGreaterThanOrEqual(1);
    const state = (id: number) =>
      (db.prepare('SELECT state FROM fetch_requests WHERE id = ?').get(id) as { state: string })
        .state;
    expect(state(r1.id)).toBe('queued');
    expect(state(r0.id)).toBe('leased');
    expect(q.report(r0.id, r0.leaseToken, answer(r0), T0 + 3100)).toMatchObject({
      accepted: true,
    });
  });
});

describe('parallel fetchers through the routes (temporary)', () => {
  let env: CleanupEnv;
  let token: string;

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    await made.setup();
    openSites(env.cleanupDb);
    token = createApplyToken(env.cleanupDb, 'fetch', Date.now(), 'fetch').token;
    enqueueMany(env.service.fetchQueue, 10);
  });
  afterEach(async () => {
    await env.close();
  });

  const beat = (fetcherId: string, runId: string) =>
    request(env.app)
      .post('/api/v1/cleanup-fetch/heartbeat')
      .set({ Authorization: `Bearer ${token}` })
      .send({ fetcherId, runId, version: '1.4.0' })
      .expect(200);
  const claim = async (fetcherId: string) =>
    (
      await request(env.app)
        .post('/api/v1/cleanup-fetch/claim')
        .set({ Authorization: `Bearer ${token}` })
        .send({ fetcherId })
        .expect(200)
    ).body as { requests: ClaimedRequest[]; wait?: string };

  it('gives up to three fetchers a slot each, disjoint claims, and restarts release only their own', async () => {
    expect((await beat('fetch1', 'a')).body.active).toBe(true);
    expect((await beat('fetch2', 'b')).body.active).toBe(true);
    expect((await beat('fetch3', 'c')).body.active).toBe(true);
    expect((await beat('fetch4', 'd')).body.active).toBe(false);
    expect(env.logs.join('\n')).toMatch(/fetch2 joined as fetcher 2/);
    expect(env.logs.join('\n')).toMatch(/fetch3 joined as fetcher 3/);

    const c1 = await claim('fetch1');
    const c2 = await claim('fetch2');
    const c3 = await claim('fetch3');
    const c4 = await claim('fetch4');
    expect(c4.requests).toEqual([]);
    expect(c4.wait).toMatch(/Another fetcher/);
    // Each asks Amazon and RanobeDB at once, on its own clocks, never the same request.
    for (const c of [c1, c2, c3]) expect(c.requests).toHaveLength(2);
    const ids = [c1, c2, c3].flatMap((c) => c.requests.map((r) => r.id));
    expect(new Set(ids).size).toBe(6);
    expect(c1.requests.every((r) => UUID.test(r.leaseToken))).toBe(true);
    expect(c2.requests.every((r) => r.leaseToken.startsWith('s1:'))).toBe(true);
    expect(c3.requests.every((r) => r.leaseToken.startsWith('s2:'))).toBe(true);

    const leased = () =>
      (
        env.cleanupDb
          .prepare("SELECT id FROM fetch_requests WHERE state = 'leased' ORDER BY id")
          .all() as { id: number }[]
      ).map((r) => r.id);
    // fetch2 restarts (new run): only its two go back.
    await beat('fetch2', 'b2');
    expect(leased()).toEqual(
      [...c1.requests, ...c3.requests].map((r) => r.id).sort((a, b) => a - b),
    );
    // fetch1 restarts: only its own go back; fetch3 can still post its answers.
    await beat('fetch1', 'a2');
    expect(leased()).toEqual(c3.requests.map((r) => r.id).sort((a, b) => a - b));
    for (const r of c3.requests) {
      const res = await request(env.app)
        .post(`/api/v1/cleanup-fetch/answers/${r.id}`)
        .set({
          Authorization: `Bearer ${token}`,
          'x-lease-token': r.leaseToken,
          'x-status': '200',
          'x-encoding': 'br',
          'content-type': 'application/octet-stream',
        })
        .send(answer(r).body)
        .expect(200);
      expect(res.body.accepted).toBe(true);
    }
  });

  it('keeps a slot while its fetcher is online, and hands a gone fetcher’s slot on', () => {
    const svc = env.service;
    const hb = (fetcherId: string, runId: string) => ({
      fetcherId,
      runId,
      version: '1.4.0',
      problem: null,
      sudachi: null,
    });
    const now = Date.now();
    expect(svc.fetchHeartbeat(hb('fetch1', 'a'), now)).toBe(true);
    expect(svc.fetchHeartbeat(hb('fetch2', 'b'), now)).toBe(true);
    expect(svc.fetchHeartbeat(hb('fetch3', 'c'), now)).toBe(true);
    expect(svc.fetcherSlot('fetch1', now)).toEqual({ slot: 0 });
    expect(svc.fetcherSlot('fetch2', now)?.slot).toBe(1);
    expect(svc.fetcherSlot('fetch3', now)?.slot).toBe(2);
    const offline = getSettings(env.cleanupDb).fetch.offlineSeconds * 1000;
    const later = now + offline + 1000;
    // fetch2 and fetch3 kept beating; fetch1 went away: fetch2 takes slot 0, fetch4 slot 1.
    expect(svc.fetchHeartbeat(hb('fetch3', 'c'), later - 2000)).toBe(true);
    expect(svc.fetchHeartbeat(hb('fetch2', 'b'), later)).toBe(true);
    expect(svc.fetcherSlot('fetch2', later)).toEqual({ slot: 0 });
    expect(svc.fetcherSlot('fetch1', later)).toBeNull();
    expect(svc.fetchHeartbeat(hb('fetch4', 'd'), later)).toBe(true);
    expect(svc.fetcherSlot('fetch4', later)?.slot).toBe(1);
    expect(svc.fetcherSlot('fetch3', later)?.slot).toBe(2);
  });
});
