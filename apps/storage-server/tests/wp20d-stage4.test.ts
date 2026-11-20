/**
 * WP20d: stage 4 end to end on a synthetic library. A real storage server, the real fetch
 * container code (apps/cleanup-fetch) talking to it over HTTP, and a stand-in internet that
 * answers the store requests: Preview reads the files, runs the lookups through the queue,
 * proposes every field with its source, reads Natively and the readings, grades the labeled
 * books, writes nothing to Calibre, and refuses On. Token scopes are kept apart.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FetchConfig } from '../../cleanup-fetch/src/config';
import { Fetcher, type FetchResult } from '../../cleanup-fetch/src/fetcher';
import { noteCatalogWrite } from '../src/catalog/catalog-version';
import { createApplyToken } from '../src/cleanup/apply-tokens';
import { presentBookCount } from '../src/cleanup/handoff';
import { getSettings } from '../src/cleanup/settings';
import { getStage, updateStage } from '../src/cleanup/stages';
import { makeJpeg } from './helpers/calibre-fixture';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import { addStage2Tables, makeMetaEpub } from './helpers/stage2-fixture';
import {
  amazonDp,
  amazonSearch,
  bookmeterPartial,
  bookmeterStores,
  bookwalkerDetail,
  bookwalkerList,
  nativelyBook,
  nativelySitemap,
  ndlAnswer,
} from './helpers/stage4-fixture';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const listen = (s: http.Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const longText = '<p>' + '魔法使いは旅をする。'.repeat(700) + '</p>';
const DESC = '旅に出る魔法使いの物語。\n重版出来！';

/** The fetch container with Sudachi answered in the test (no Python here). */
class TestFetcher extends Fetcher {
  async runSudachi(c: { body: string | null }): Promise<FetchResult> {
    const names = (JSON.parse(c.body ?? '{}') as { names?: string[] }).names ?? [];
    const readings: Record<string, string> = {};
    for (const n of names) if (n === '鈴木一郎') readings[n] = 'スズキ, イチロウ';
    return { status: 200, ms: 1, error: null, body: Buffer.from(JSON.stringify({ readings })) };
  }
}

describe('stage 4: online sources (Preview)', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let url: string;
  let user: string;
  let ids: Record<string, number>;
  let goldFile: string;
  let smallCover: Buffer;
  let bigCover: Buffer;
  const seen: string[] = [];

  /** The stand-in internet. */
  function internet(u: string, init?: RequestInit): Response {
    seen.push(u);
    const html = (s: string, status = 200) =>
      new Response(s, { status, headers: { 'content-type': 'text/html' } });
    const json = (v: unknown) =>
      new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
    if (u === 'https://www.amazon.co.jp/dp/B0TESTAAA1') {
      return html(
        amazonDp({
          asin: 'B0TESTAAA1',
          title: '魔法使いの旅 1 (テスト文庫)',
          authors: [
            { name: '山田太郎', role: '著' },
            { name: '絵師花子', role: 'イラスト' },
          ],
          description: DESC,
          series: '全3冊中1番目の本 魔法使いの旅',
          cover: 'https://m.media-amazon.com/images/I/AAA1.jpg',
        }),
      );
    }
    if (u === 'https://m.media-amazon.com/images/I/AAA1.jpg')
      return new Response(new Uint8Array(bigCover), { status: 200 });
    if (u.startsWith('https://www.amazon.co.jp/s?k=')) {
      return html(
        amazonSearch([
          ['B0TESTBBX9', 'ふしぎな本 1 (コミック)'],
          ['B0TESTBBB2', 'ふしぎな本 (テスト文庫)'],
        ]),
      );
    }
    if (u === 'https://www.amazon.co.jp/dp/B0TESTBBB2') {
      return html(
        amazonDp({
          asin: 'B0TESTBBB2',
          title: 'ふしぎな本 (テスト文庫)',
          authors: [{ name: '鈴木一郎', role: '著' }],
          description: '不思議な本の話。',
          breadcrumbs: ['Kindleストア', 'Kindle本', '小説・文芸'],
          rank: ['Kindleストアの売れ筋ランキングを見る', '日本文学 (Kindleストア)'],
        }),
      );
    }
    if (u === 'https://www.amazon.co.jp/dp/B0TESTCCC3') {
      return html(
        amazonDp({
          asin: 'B0TESTCCC3',
          title: '漫画の巻 (コミック)',
          authors: [{ name: '漫画家', role: '著' }],
          breadcrumbs: ['Kindleストア', 'Kindle本', 'マンガ'],
          rank: ['Kindleストアの売れ筋ランキングを見る', '少年マンガ (Kindleストア)'],
        }),
      );
    }
    if (u.startsWith('https://ranobedb.org/api/v0/books?q=')) {
      const q = decodeURIComponent(u.split('q=')[1].split('&')[0]);
      return json({
        books: q.startsWith('魔法使いの旅') ? [{ id: 501, title_orig: '魔法使いの旅 1' }] : [],
      });
    }
    if (u === 'https://ranobedb.org/api/v0/book/501') {
      return json({
        book: {
          id: 501,
          title_orig: '魔法使いの旅 1',
          description_ja: '旅の話。',
          series: { id: 9, title_orig: '魔法使いの旅' },
          editions: [
            {
              staff: [
                { name: '山田太郎', role_type: 'author' },
                { name: '絵師花子', role_type: 'artist' },
              ],
            },
          ],
          releases: [{ isbn13: '9784000000001' }],
        },
      });
    }
    if (u === 'https://ranobedb.org/api/v0/series/9') {
      return json({
        series: {
          title_orig: '魔法使いの旅',
          tags: [{ name: 'fantasy', ttype: 'genre' }],
          books: [
            { id: 501, sort_order: 1, book_type: 'main', title_orig: '魔法使いの旅 1' },
            { id: 502, sort_order: 2, book_type: 'main', title_orig: '魔法使いの旅 2' },
          ],
          bookwalker_id: null,
        },
      });
    }
    if (
      u.startsWith('https://bookwalker.jp/search/?word=') &&
      decodeURIComponent(u).includes('星降る')
    ) {
      return html(
        bookwalkerList([['https://bookwalker.jp/series/4242/list/', '星降る街の物語 2']]),
      );
    }
    if (u === 'https://bookwalker.jp/series/4242/list/') {
      return html(
        bookwalkerList([
          ['https://bookwalker.jp/de42000000-0000-0000-0000-000000000001/', '星降る街の物語 1'],
          ['https://bookwalker.jp/de42000000-0000-0000-0000-000000000002/', '星降る街の物語 2'],
          ['https://bookwalker.jp/de42000000-0000-0000-0000-000000000003/', '星降る街の物語 3'],
        ]),
      );
    }
    if (u === 'https://bookwalker.jp/de42000000-0000-0000-0000-000000000002/') {
      return html(
        bookwalkerDetail(
          '星降る街の物語 2',
          '星の降る街の話。',
          '星降る街の物語 2,ホシフルマチノモノガタリ02,星野一郎,挿絵次郎,テスト文庫,ライトノベル,電子書籍',
        ),
      );
    }
    if (u.startsWith('https://bookwalker.jp/search/?word=')) {
      const q = decodeURIComponent(u.split('word=')[1]);
      // Like the real search, it misses the title with its volume number and finds the series
      // name (live 2026-11-19: "鋼鉄の白兎騎士団10" 404, "鋼鉄の白兎騎士団" found).
      if (!q.startsWith('魔法使いの旅') || q === '魔法使いの旅 1') return html('', 404);
      return html(
        bookwalkerList([
          ['https://bookwalker.jp/de11111111-2222-3333-4444-555555555555/', '魔法使いの旅 1'],
        ]),
      );
    }
    if (u === 'https://bookwalker.jp/de11111111-2222-3333-4444-555555555555/') {
      return html(
        bookwalkerDetail(
          '魔法使いの旅 1',
          DESC,
          '魔法使いの旅 1,マホウツカイノタビ,山田太郎,絵師花子,テスト文庫,ライトノベル,電子書籍',
        ),
      );
    }
    if (u.startsWith('https://bookmeter.com/search?')) {
      // Bookmeter's v2 index misses books its plain one finds (live 2026-11-19).
      if (new URL(u).searchParams.get('type') === 'japanese_v2') return html(bookmeterPartial([]));
      const q = decodeURIComponent(new URL(u).searchParams.get('keyword') ?? '');
      return html(
        q.startsWith('魔法使いの旅')
          ? bookmeterPartial([
              { id: '777', title: '魔法使いの旅 1 (テスト文庫)', authors: ['山田太郎'] },
            ])
          : bookmeterPartial([]),
      );
    }
    if (u === 'https://bookmeter.com/api/v1/books/777/external_book_stores.json')
      return json(bookmeterStores('9784000000001', '123'));
    if (u === 'https://learnnatively.com/sitemap.xml')
      return html(nativelySitemap(['nat0000001', 'nat0000002']));
    if (u === 'https://learnnatively.com/book/nat0000001/')
      return html(nativelyBook('魔法使いの旅 1', '9784000000001', 'B0TESTAAA1'));
    if (u === 'https://learnnatively.com/book/nat0000002/')
      return html(nativelyBook('別の本', '9784999999999', 'B0OTHERXXX'));
    if (u === 'https://id.ndl.go.jp/auth/ndla/sparql') {
      const q = decodeURIComponent(String(init?.body ?? '').replace(/^query=/, ''));
      return json(
        ndlAnswer(
          q.includes('"山田太郎"') ? [{ name: '山田太郎', yomi: 'ヤマダ, タロウ, 1980-' }] : [],
        ),
      );
    }
    return html('not found', 404);
  }

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    addStage2Tables(env.lib);
    smallCover = await makeJpeg(40, 300, 450);
    bigCover = await makeJpeg(40, 1000, 1500);
    const coverSpec = { data: smallCover };
    ids = {
      // Labeled; the file has its ASIN; a small cover the store has larger.
      A: await env.lib.addBook({
        title: 'a-scan',
        authors: ['Unknown'],
        cover: 'none',
        epub: makeMetaEpub({
          title: '魔法使いの旅 1',
          creators: [{ name: '山田 太郎', role: 'aut' }],
          identifiers: [{ value: 'urn:uuid:a' }, { value: 'B0TESTAAA1', scheme: 'ASIN' }],
          cover: coverSpec,
          pages: [longText, '<p>著者 山田太郎 イラスト：絵師花子</p>'],
        }),
      }),
      // No ASIN: the Kindle search (the comic edition is passed over); a Google-era description.
      B: await env.lib.addBook({
        title: 'Google title',
        authors: ['Google Author'],
        tags: ['metadata-processed'],
        comments: 'Google Books description',
        cover: 'none',
        epub: makeMetaEpub({
          title: 'ふしぎな本',
          creators: [{ name: '鈴木 一郎', role: 'aut' }],
          pages: [longText],
        }),
      }),
      // A light novel BookWalker settles (series list, large cover): Amazon is never asked.
      D: await env.lib.addBook({
        title: 'd-scan',
        authors: ['Unknown'],
        cover: 'none',
        epub: makeMetaEpub({
          title: '星降る街の物語 2',
          creators: [
            { name: '星野 一郎', role: 'aut' },
            { name: '挿絵 次郎', role: 'aut' },
          ],
          cover: { data: bigCover },
          pages: [longText],
        }),
      }),
      // A text book whose ASIN Amazon lists as manga: Amazon is set aside.
      C: await env.lib.addBook({
        title: 'c-scan',
        authors: ['Unknown'],
        cover: 'none',
        epub: makeMetaEpub({
          title: '文字の本',
          creators: [{ name: '作者三', role: 'aut' }],
          identifiers: [{ value: 'B0TESTCCC3', scheme: 'ASIN' }],
          pages: [longText],
        }),
      }),
    };
    await made.setup();
    goldFile = path.join(makeTempDir('gold4'), 'gold800.json');
    fs.writeFileSync(
      goldFile,
      JSON.stringify({
        [ids.A]: {
          t: '魔法使いの旅 1',
          au: ['山田太郎'],
          il: ['絵師花子'],
          se: '魔法使いの旅',
          ix: 1,
          fmt: 'light novel',
          kind: 'full',
          sample: 'A',
        },
        [ids.C]: {
          t: '文字の本',
          au: ['作者三'],
          il: [],
          se: null,
          ix: null,
          fmt: 'novel',
          kind: 'full',
          sample: 'D',
        },
      }),
    );
    server = http.createServer(env.app);
    url = `http://127.0.0.1:${await listen(server)}`;
    user = env.userToken();
    const s = getSettings(env.cleanupDb).fetch;
    const sites = Object.fromEntries(
      Object.keys(s.sites).map((k) => [
        k,
        { enabled: true, intervalSeconds: k === 'sudachi' ? 0 : 1 },
      ]),
    );
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        pacing: {
          readMbPerSecond: 0,
          itemDelaySeconds: 0,
          batchSize: 500,
          maxBatchPercent: 10,
          lookupChunk: 25,
        },
        gate: { minBooks: 1, labeledBooksFile: goldFile },
        fetch: { ...s, sites, amazonPace: 'separate' },
      })
      .expect(200);
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await env.close();
  });

  const metadataDbHash = () =>
    createHash('sha256')
      .update(fs.readFileSync(path.join(env.lib.dir, 'metadata.db')))
      .digest('hex');

  it('runs the lookups through the fetch container and proposes every field with its source', async () => {
    const fetchToken = createApplyToken(env.cleanupDb, 'fetch', Date.now(), 'fetch').token;
    const applyToken = env.applyToken();
    // Token scopes: neither reaches the other's routes, a user token neither.
    await request(env.app)
      .post('/api/v1/cleanup-fetch/claim')
      .set(auth(applyToken))
      .send({ fetcherId: 'x' })
      .expect(401);
    await request(env.app)
      .post('/api/v1/cleanup-fetch/claim')
      .set(auth(user))
      .send({ fetcherId: 'x' })
      .expect(401);
    await request(env.app).post('/api/v1/cleanup-apply/claim').set(auth(fetchToken)).expect(401);
    // Stage 4 is Preview only.
    const on = await request(env.app)
      .put('/api/v1/cleanup/stages/4')
      .set(auth(user))
      .send({ mode: 'on' });
    expect(on.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(on.body)).toMatch(/Preview only/);
    const old = env.service.fetchQueue.enqueue(
      {
        site: 'amazon-search',
        key: 'old plan',
        url: 'https://www.amazon.co.jp/s?k=old&i=digital-text',
      },
      { libraryId: env.libraryId(), uuid: 'not-a-book', step: 'amazon-search' },
    );
    // Not due for an hour: only the sweep can take it out of the queue.
    env.cleanupDb
      .prepare('UPDATE fetch_requests SET next_at = ? WHERE id = ?')
      .run(Date.now() + 3_600_000, old.id);
    await request(env.app)
      .put('/api/v1/cleanup/stages/4')
      .set(auth(user))
      .send({ mode: 'analyse' })
      .expect(200);

    const before = metadataDbHash();
    const config: FetchConfig = {
      serverUrl: url,
      token: fetchToken,
      serverTimeoutSeconds: 10,
      sudachiPython: 'stand-in',
      sudachiScript: '',
    };
    const fetcher = new TestFetcher(
      config,
      () => {},
      (input, init) => {
        const u = String(input);
        return u.startsWith(url) ? fetch(input, init) : Promise.resolve(internet(u, init));
      },
    );
    // A second fetcher is active beside the first (temporary: parallel fetchers on their own
    // VPN addresses, tests/wp20d-fetch-slots.test.ts); it only beats here, never claims.
    const second = new TestFetcher(
      config,
      () => {},
      (input, init) => fetch(input, init),
    );
    // The server must stay responsive: the longest event-loop block over the whole run.
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const running = fetcher.run();
    await sleep(300);
    await second.heartbeat();
    expect((second as unknown as { active: boolean }).active).toBe(true);

    const deadline = Date.now() + 90_000;
    let phase = '';
    while (Date.now() < deadline) {
      await env.service.tick();
      phase = String((getStage(env.cleanupDb, 4).progress as { phase?: string }).phase);
      if (phase === 'done') break;
      await sleep(200);
    }
    fetcher.stop();
    await running;
    delay.disable();
    expect(phase).toBe('done');
    // Each book is counted once (the labeled books were counted twice: read first, then again
    // when the library pass skipped them), and the page's numbers come from the database.
    const prog = getStage(env.cleanupDb, 4).progress as { readDone: number; readTotal: number };
    expect(prog.readDone).toBe(prog.readTotal);
    const st4 = env.service.stage4Status(env.libraryId(), Date.now() + 60_000) as {
      read: { done: number; total: number };
      timeLeft: { read: number | null; basis: string } | null;
    };
    expect(st4.read.done).toBe(st4.read.total);
    // Done: nothing left to show.
    expect(st4.timeLeft).toBeNull();
    expect(delay.max / 1e6).toBeLessThan(500);
    expect(metadataDbHash()).toBe(before);

    // Every store host the fetcher asked is on its list; Natively's search was never used.
    expect(
      seen.every((u) =>
        /^https:\/\/(www\.amazon\.co\.jp|m\.media-amazon\.com|bookwalker\.jp|ranobedb\.org|id\.ndl\.go\.jp|bookmeter\.com|learnnatively\.com)\//.test(
          u,
        ),
      ),
    ).toBe(true);
    expect(seen.some((u) => u.includes('learnnatively.com/search'))).toBe(false);
    expect(seen.filter((u) => u === 'https://ranobedb.org/api/v0/series/9')).toHaveLength(1);

    const props = (uuidOf: number) =>
      Object.fromEntries(
        (
          env.cleanupDb
            .prepare(
              `SELECT field, new_json, class, source, review_reason, evidence_json FROM proposed_changes WHERE stage = 4 AND calibre_id = ?`,
            )
            .all(uuidOf) as {
            field: string;
            new_json: string;
            class: string;
            source: string;
            review_reason: string | null;
            evidence_json: string;
          }[]
        ).map((r) => [
          r.field,
          {
            value: JSON.parse(r.new_json) as unknown,
            class: r.class,
            source: r.source,
            reason: r.review_reason,
            evidence: JSON.parse(r.evidence_json) as Record<string, unknown>,
          },
        ]),
      );
    const a = props(ids.A);
    expect(a.title).toMatchObject({
      value: '魔法使いの旅 1',
      class: 'auto',
      source: 'amazon-asin',
    });
    expect(a.authors).toMatchObject({ value: ['山田太郎'], class: 'auto' });
    expect(a.illustrator).toMatchObject({ value: ['絵師花子'], class: 'auto', source: 'ranobedb' });
    expect(a.series).toMatchObject({ value: { name: '魔法使いの旅', index: 1 }, class: 'auto' });
    expect(a.format).toMatchObject({ value: 'light novel', class: 'auto' });
    // BookWalker's copy of the same text, the promotional line removed.
    expect(a.description).toMatchObject({
      value: '旅に出る魔法使いの物語。',
      source: 'bookwalker(=amazon)',
    });
    expect(a.description.evidence.removed).toEqual([{ kind: 'cross-promo', line: '重版出来！' }]);
    expect(a.cover).toMatchObject({ class: 'auto', value: { side: 1500 } });
    expect(a.identifiers.value).toMatchObject({
      amazon_jp: 'B0TESTAAA1',
      ranobedb: '501',
      bookwalker: '11111111-2222-3333-4444-555555555555',
      bookmeter: '777',
      isbn: '9784000000001',
      honto: '123',
      natively: 'nat0000001',
    });
    expect(a.author_sort).toMatchObject({ value: 'ヤマダ, タロウ', source: 'ndl' });

    const b = props(ids.B);
    expect(b.title).toMatchObject({ value: 'ふしぎな本', source: 'amazon-search' });
    expect(b.format.value).toBe('novel');
    expect(b.description).toMatchObject({ value: '不思議な本の話。', source: 'amazon(search)' });
    // NDL doesn't know the name: a generated reading, marked for spot checks.
    expect(b.author_sort).toMatchObject({
      value: 'スズキ, イチロウ',
      source: 'generated',
      reason: 'Generated reading: listed for spot checks',
    });
    // The searched Amazon match passed acceptance (title, author, format; no series): its ASIN is kept.
    expect(b.identifiers).toMatchObject({ value: { amazon_jp: 'B0TESTBBB2' }, class: 'auto' });

    const c = props(ids.C);
    expect(c.format).toMatchObject({
      class: 'review',
      reason: 'Amazon lists it as manga, but the file has text',
    });
    expect(c.title.value).toBe('文字の本');

    // The gate on the labeled books, the 600 and check D apart.
    const gate = (
      getStage(env.cleanupDb, 4).precision as {
        gate: {
          books: number;
          fields: Record<string, { percent: number | null; the600: unknown; checkD: unknown }>;
        };
      }
    ).gate;
    expect(gate.books).toBe(2);
    expect(gate.fields.title.percent).toBe(100);
    expect(gate.fields.format.the600).toMatchObject({ measured: 97.4 });

    // The page's status: per site counts and the fetcher.
    const st = await request(env.app).get('/api/v1/cleanup/status').set(auth(user)).expect(200);
    const s4 = st.body.stage4 as {
      fetcher: { online: boolean };
      sites: { site: string; done: number }[];
    };
    expect(s4.fetcher.online).toBe(true);
    expect(s4.sites.find((x) => x.site === 'amazon-dp')!.done).toBe(3);
    // The evidence record keeps every source's answer for WP20e.
    let uuidA = '';
    env.lib.exec((db) => {
      uuidA = (db.prepare('SELECT uuid FROM books WHERE id = ?').get(ids.A) as { uuid: string })
        .uuid;
    });
    const ev = env.service.analysis4!.loadOnline(env.libraryId(), uuidA)!;
    expect(ev.amazon.product?.asin).toBe('B0TESTAAA1');
    expect(ev.bookmeter.accepted?.id).toBe('777');
    // BookWalker missed "魔法使いの旅 1" and was asked once more by the series name.
    expect(ev.bookwalker.retried).toBe('魔法使いの旅');
    expect(seen).toContain(
      `https://bookwalker.jp/search/?word=${encodeURIComponent('魔法使いの旅')}`,
    );
    expect(ev.bookwalker.detail?.title).toBe('魔法使いの旅 1');
    expect(Object.keys(ev.requests)).toEqual(
      expect.arrayContaining([
        'amazon-dp',
        'ranobedb-book',
        'bookwalker-detail',
        'bookmeter-stores',
        'cover',
      ]),
    );

    // Amazon where needed: BookWalker settled the light novel, Amazon was never asked for it.
    let uuidD = '';
    env.lib.exec((db) => {
      uuidD = (db.prepare('SELECT uuid FROM books WHERE id = ?').get(ids.D) as { uuid: string })
        .uuid;
    });
    const evD = env.service.analysis4!.loadOnline(env.libraryId(), uuidD)!;
    expect(evD.amazon.standin).toBe('bookwalker');
    expect(evD.amazon.asked).toBeUndefined();
    expect(seen.some((u) => u.includes('amazon') && decodeURIComponent(u).includes('星降る'))).toBe(
      false,
    );
    const d = props(ids.D);
    expect(d.series).toMatchObject({
      value: { name: '星降る街の物語', index: 2 },
      class: 'auto',
      source: 'bookwalker',
    });
    expect(d.illustrator).toMatchObject({
      value: ['挿絵次郎'],
      class: 'auto',
      source: 'bookwalker',
    });
    expect(d.authors).toMatchObject({ value: ['星野一郎'], class: 'auto', source: 'bookwalker' });
    expect(d.format).toMatchObject({ value: 'light novel', class: 'auto' });
    expect(JSON.stringify(d)).not.toMatch(/amazon/);
    // The non-light novel asked Amazon only once BookWalker and RanobeDB had answered.
    const at = (site: string, key: string) =>
      env.cleanupDb
        .prepare('SELECT created_at, finished_at FROM fetch_requests WHERE site = ? AND key = ?')
        .get(site, key) as { created_at: number; finished_at: number };
    const searchB = env.cleanupDb
      .prepare(
        "SELECT created_at FROM fetch_requests WHERE site = 'amazon-search' AND key LIKE 'ふしぎな本%'",
      )
      .get() as { created_at: number };
    expect(searchB.created_at).toBeGreaterThanOrEqual(
      at('bookwalker', 'search:ふしぎな本').finished_at,
    );
    expect(searchB.created_at).toBeGreaterThanOrEqual(
      at('ranobedb', 'search:ふしぎな本').finished_at,
    );
    // The request queued the old way left the queue with its waiter; the sweep finished.
    expect(
      env.cleanupDb.prepare('SELECT 1 FROM fetch_requests WHERE id = ?').get(old.id),
    ).toBeUndefined();
    expect(
      (getStage(env.cleanupDb, 4).progress as { amazonSweep?: { phase: string } }).amazonSweep
        ?.phase,
    ).toBe('done');
  }, 120_000);

  it('asks Bookmeter’s plain index, and asks again for books the v2 index found nothing for', async () => {
    const fetchToken = createApplyToken(env.cleanupDb, 'fetch', Date.now(), 'fetch').token;
    await request(env.app)
      .put('/api/v1/cleanup/stages/4')
      .set(auth(user))
      .send({ mode: 'analyse' })
      .expect(200);
    const fetcher = new TestFetcher(
      {
        serverUrl: url,
        token: fetchToken,
        serverTimeoutSeconds: 10,
        sudachiPython: 'stand-in',
        sudachiScript: '',
      },
      () => {},
      (input, init) => {
        const u = String(input);
        return u.startsWith(url) ? fetch(input, init) : Promise.resolve(internet(u, init));
      },
    );
    const phase = () => String((getStage(env.cleanupDb, 4).progress as { phase?: string }).phase);
    const running = fetcher.run();
    let deadline = Date.now() + 90_000;
    while (Date.now() < deadline && phase() !== 'done') {
      await env.service.tick();
      await sleep(200);
    }
    fetcher.stop();
    await running;
    expect(phase()).toBe('done');
    // Every search went to the plain index, and it found book A.
    const searches = seen.filter((u) => u.startsWith('https://bookmeter.com/search?'));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((u) => new URL(u).searchParams.get('type') === 'japanese')).toBe(true);
    let uuidA = '';
    env.lib.exec((db) => {
      uuidA = (db.prepare('SELECT uuid FROM books WHERE id = ?').get(ids.A) as { uuid: string })
        .uuid;
    });
    const a4 = env.service.analysis4! as unknown as {
      loadOnline: (
        l: string,
        u: string,
      ) => { bookmeter: Record<string, unknown>; requests: Record<string, number> } | null;
      saveEvidence: (l: string, u: string, kind: string, v: unknown) => void;
    };
    expect(a4.loadOnline(env.libraryId(), uuidA)!.bookmeter.accepted).toMatchObject({ id: '777' });

    // Book A as the v2 index left it (no results, so no Bookmeter id), and a search still queued
    // the old way.
    const q = env.service.fetchQueue;
    const v2 = (k: string) =>
      `https://bookmeter.com/search?author=&keyword=${encodeURIComponent(k)}&partial=true&sort=recommended&type=japanese_v2`;
    const oldA = q.enqueue(
      { site: 'bookmeter', key: 'search:魔法使いの旅 1', url: v2('魔法使いの旅 1') },
      null,
    );
    env.cleanupDb
      .prepare(
        "UPDATE fetch_requests SET state = 'done', outcome = 'ok', finished_at = ? WHERE id = ?",
      )
      .run(Date.now(), oldA.id);
    const queuedOld = q.enqueue({ site: 'bookmeter', key: 'search:まだ', url: v2('まだ') }, null);
    env.cleanupDb
      .prepare('UPDATE fetch_requests SET next_at = ? WHERE id = ?')
      .run(Date.now() + 3_600_000, queuedOld.id);
    const evA = a4.loadOnline(env.libraryId(), uuidA)!;
    evA.bookmeter = { hits: [], accepted: null, reason: 'no results' };
    evA.requests['bookmeter-search'] = oldA.id;
    // …and BookWalker's search as it ended before the retry existed: "not found", nothing else.
    const bwFirst = env.cleanupDb
      .prepare(
        "SELECT id FROM fetch_requests WHERE site = 'bookwalker' AND key = 'search:魔法使いの旅 1'",
      )
      .get() as { id: number };
    (evA as unknown as { bookwalker: Record<string, unknown> }).bookwalker = {};
    evA.requests['bookwalker-search'] = bwFirst.id;
    a4.saveEvidence(env.libraryId(), uuidA, 'online', evA);
    env.cleanupDb
      .prepare(
        "DELETE FROM proposed_changes WHERE stage = 4 AND calibre_id = ? AND field = 'identifiers'",
      )
      .run(ids.A);
    const prog = getStage(env.cleanupDb, 4).progress as Record<string, unknown>;
    delete prog.bookmeterRedo;
    delete prog.bookwalkerRetry;
    prog.phase = 'lookups';
    updateStage(env.cleanupDb, 4, { progress: prog, state: 'analysing' });

    // The pass: the queued search points at the plain index, book A asks it again (answered
    // from the cache: no new request to Bookmeter) and is proposed again with its Bookmeter id.
    const asked = seen.length;
    const checks = () =>
      env.logs.filter((m) => m.startsWith('Stage 4: labeled books checked')).length;
    const firstChecks = checks();
    expect(firstChecks).toBe(1);
    deadline = Date.now() + 30_000;
    while (Date.now() < deadline && phase() !== 'done') {
      await env.service.tick();
      await sleep(100);
    }
    expect(phase()).toBe('done');
    expect(seen.length).toBe(asked);
    // The labeled book was reopened, so the labeled books were checked again in the lookups.
    expect(env.logs.some((m) => m.includes('labeled books were reopened'))).toBe(true);
    expect(checks()).toBe(2);
    expect(
      (
        env.cleanupDb.prepare('SELECT url FROM fetch_requests WHERE id = ?').get(queuedOld.id) as {
          url: string;
        }
      ).url,
    ).toMatch(/[?&]type=japanese$/);
    expect(a4.loadOnline(env.libraryId(), uuidA)!.bookmeter.accepted).toMatchObject({ id: '777' });
    const ident = env.cleanupDb
      .prepare(
        "SELECT new_json FROM proposed_changes WHERE stage = 4 AND calibre_id = ? AND field = 'identifiers'",
      )
      .get(ids.A) as { new_json: string } | undefined;
    expect(JSON.parse(ident!.new_json)).toMatchObject({ bookmeter: '777', isbn: '9784000000001' });
    expect(
      (getStage(env.cleanupDb, 4).progress as { bookmeterRedo?: { phase: string; books: number } })
        .bookmeterRedo,
    ).toMatchObject({ phase: 'done', books: 1 });
    // The BookWalker pass asked the series name again (from the cache) and found the book.
    const evA2 = a4.loadOnline(env.libraryId(), uuidA)! as unknown as {
      bookwalker: { retried?: string; detail?: { title?: string } };
    };
    expect(evA2.bookwalker.retried).toBe('魔法使いの旅');
    expect(evA2.bookwalker.detail?.title).toBe('魔法使いの旅 1');
    expect(
      (
        getStage(env.cleanupDb, 4).progress as {
          bookwalkerRetry?: { phase: string; books: number };
        }
      ).bookwalkerRetry,
    ).toMatchObject({ phase: 'done', books: 1 });
  }, 120_000);

  it("asks each site again as soon as its pace allows, and an answer runs no other stage's round", async () => {
    // Found live 2026-11-17: every site ran 1.3-2 s over its pace (a claim once a second, and a
    // whole cleanup round per answer that froze the server ~1.2 s on the NAS).
    const fetchToken = createApplyToken(env.cleanupDb, 'fetch', Date.now(), 'fetch').token;
    const q = env.service.fetchQueue;
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      q.enqueue(
        { site: 'ranobedb', key: `r${i}`, url: `https://ranobedb.org/api/v0/book/${i}` },
        null,
        now,
      );
    }
    for (let i = 0; i < 4; i++) {
      q.enqueue(
        { site: 'bookwalker', key: `b${i}`, url: `https://bookwalker.jp/de${i}/` },
        null,
        now,
      );
    }
    const svc = env.service as unknown as Record<string, (...a: unknown[]) => unknown>;
    let otherRounds = 0;
    for (const name of ['round1', 'round2', 'round3']) {
      const orig = svc[name].bind(env.service);
      svc[name] = (...a: unknown[]) => {
        otherRounds += 1;
        return orig(...a);
      };
    }
    const starts: Record<string, number[]> = {};
    const fetcher = new TestFetcher(
      {
        serverUrl: url,
        token: fetchToken,
        serverTimeoutSeconds: 10,
        sudachiPython: '',
        sudachiScript: '',
      },
      () => {},
      async (input, init) => {
        const u = String(input);
        if (u.startsWith(url)) return fetch(input, init);
        const site = u.includes('ranobedb') ? 'ranobedb' : 'bookwalker';
        (starts[site] ??= []).push(Date.now());
        await sleep(50);
        return new Response(
          site === 'ranobedb' ? '{"book":{}}' : `<html>${'x'.repeat(30000)}</html>`,
          { status: 200 },
        );
      },
    );
    const running = fetcher.run();
    const open = () =>
      (
        env.cleanupDb
          .prepare("SELECT COUNT(*) AS n FROM fetch_requests WHERE state IN ('queued', 'leased')")
          .get() as { n: number }
      ).n;
    const deadline = Date.now() + 30_000;
    while (open() > 0 && Date.now() < deadline) await sleep(100);
    // A request that appears while the fetcher has nothing to do (a book's next step) is
    // asked within about a second, not after a long wait.
    await sleep(2500);
    const queuedAt = Date.now();
    q.enqueue(
      { site: 'ranobedb', key: 'late', url: 'https://ranobedb.org/api/v0/book/late' },
      null,
      queuedAt,
    );
    while (open() > 0 && Date.now() < deadline + 10_000) await sleep(100);
    fetcher.stop();
    await running;
    expect(open()).toBe(0);
    const late = starts.ranobedb.pop()!;
    expect(late - queuedAt).toBeLessThan(1300);
    expect(starts.ranobedb).toHaveLength(6);
    expect(starts.bookwalker).toHaveLength(4);
    for (const site of ['ranobedb', 'bookwalker']) {
      const t = starts[site];
      const gaps = t.slice(1).map((x, i) => x - t[i]);
      // The pace (1 s start to start) is kept, and nothing waits much beyond it.
      for (const g of gaps) {
        expect(g).toBeGreaterThanOrEqual(990);
        expect(g).toBeLessThan(1250);
      }
    }
    // The 10 answers woke stage 4 only: stages 1-3 ran in no round (no timer in the test).
    expect(otherRounds).toBe(0);
  }, 60_000);

  it('asks a slow site two at a time at its pace when set to, never more', async () => {
    // Found 2026-11-19: Bookmeter answers in about a second, so one request at a time ran at
    // 1.3 s whatever its interval. Two at once at 0.5 s: about 0.75 s each here.
    const fetchToken = createApplyToken(env.cleanupDb, 'fetch', Date.now(), 'fetch').token;
    const s0 = getSettings(env.cleanupDb).fetch;
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        fetch: {
          ...s0,
          sites: { ...s0.sites, ranobedb: { enabled: true, intervalSeconds: 0.5, inFlight: 2 } },
        },
      })
      .expect(200);
    const q = env.service.fetchQueue;
    for (let i = 0; i < 10; i++)
      q.enqueue(
        { site: 'ranobedb', key: `slow${i}`, url: `https://ranobedb.org/api/v0/book/s${i}` },
        null,
        Date.now(),
      );
    const starts: number[] = [];
    let inFlight = 0;
    let most = 0;
    const fetcher = new TestFetcher(
      {
        serverUrl: url,
        token: fetchToken,
        serverTimeoutSeconds: 10,
        sudachiPython: '',
        sudachiScript: '',
      },
      () => {},
      async (input, init) => {
        const u = String(input);
        if (u.startsWith(url)) return fetch(input, init);
        starts.push(Date.now());
        inFlight++;
        most = Math.max(most, inFlight);
        await sleep(1500);
        inFlight--;
        return new Response('{"book":{}}', { status: 200 });
      },
    );
    const running = fetcher.run();
    const open = () =>
      (
        env.cleanupDb
          .prepare(
            "SELECT COUNT(*) AS n FROM fetch_requests WHERE site = 'ranobedb' AND state IN ('queued', 'leased')",
          )
          .get() as { n: number }
      ).n;
    const deadline = Date.now() + 30_000;
    while (open() > 0 && Date.now() < deadline) await sleep(100);
    fetcher.stop();
    await running;
    expect(open()).toBe(0);
    expect(starts).toHaveLength(10);
    expect(most).toBe(2);
    const gaps = starts.slice(1).map((x, i) => x - starts[i]);
    // The pace holds between starts, and two at once beat one at a time (1.5 s each).
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(490);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeLessThan(1000);
  }, 60_000);

  it('asks a restarted fetcher’s requests again at once, not after their leases', async () => {
    // Found live 2026-11-18: a VPN switch every 15 minutes restarts the fetch container; every
    // site with a request in flight then stood still for its 2-minute lease.
    const fetchToken = createApplyToken(env.cleanupDb, 'fetch', Date.now(), 'fetch').token;
    const q = env.service.fetchQueue;
    q.enqueue(
      { site: 'ranobedb', key: 'stuck', url: 'https://ranobedb.org/api/v0/book/stuck' },
      null,
      Date.now(),
    );
    const config = {
      serverUrl: url,
      token: fetchToken,
      serverTimeoutSeconds: 10,
      sudachiPython: '',
      sudachiScript: '',
    };
    // FETCHER_ID is set in the compose file: a restarted container keeps its id.
    const savedId = process.env.FETCHER_ID;
    process.env.FETCHER_ID = 'ttsu-cleanup-fetch';
    const asked: number[] = [];
    // The first process: its request never comes back (the container is stopped mid-request).
    const first = new TestFetcher(
      config,
      () => {},
      async (input, init) => {
        const u = String(input);
        if (u.startsWith(url)) return fetch(input, init);
        asked.push(Date.now());
        return new Promise<Response>(() => {});
      },
    );
    const firstRun = first.run();
    const leased = () =>
      (
        env.cleanupDb
          .prepare("SELECT COUNT(*) AS n FROM fetch_requests WHERE state = 'leased'")
          .get() as { n: number }
      ).n;
    let deadline = Date.now() + 10_000;
    while (asked.length === 0 && Date.now() < deadline) await sleep(50);
    expect(leased()).toBe(1);
    first.stop();
    await firstRun;
    // The restarted process (same fetcher id, new run) asks it again within seconds.
    const restartedAt = Date.now();
    const second = new TestFetcher(
      config,
      () => {},
      async (input, init) => {
        const u = String(input);
        if (u.startsWith(url)) return fetch(input, init);
        asked.push(Date.now());
        return new Response('{"book":{}}', { status: 200 });
      },
    );
    expect(second.id).toBe(first.id);
    expect(second.runId).not.toBe(first.runId);
    const secondRun = second.run();
    deadline = Date.now() + 10_000;
    while (asked.length < 2 && Date.now() < deadline) await sleep(50);
    second.stop();
    await secondRun;
    if (savedId === undefined) delete process.env.FETCHER_ID;
    else process.env.FETCHER_ID = savedId;
    expect(asked).toHaveLength(2);
    expect(asked[1] - restartedAt).toBeLessThan(3000);
    const row = env.cleanupDb
      .prepare("SELECT state, attempts FROM fetch_requests WHERE key = 'stuck'")
      .get() as { state: string; attempts: number };
    expect(row.state).toBe('done');
  }, 60_000);

  it("counts the library's present books once until the catalog changes", () => {
    const lib = env.libraryId();
    const main = env.db;
    let counts = 0;
    const origPrepare = main.prepare.bind(main);
    (main as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/COUNT\(\*\) AS n FROM book_sources/.test(sql)) counts += 1;
      return origPrepare(sql);
    };
    try {
      const n = presentBookCount(main, lib);
      expect(presentBookCount(main, lib)).toBe(n);
      expect(presentBookCount(main, lib)).toBe(n);
      expect(counts).toBe(1);
      // A book goes missing in the reader's index: its writer notes the catalog write.
      const src = origPrepare(
        "SELECT id FROM book_sources WHERE library_id = ? AND kind = 'calibre' AND missing_at IS NULL LIMIT 1",
      ).get(lib) as { id: string };
      origPrepare('UPDATE book_sources SET missing_at = ? WHERE id = ?').run(Date.now(), src.id);
      noteCatalogWrite(main);
      expect(presentBookCount(main, lib)).toBe(n - 1);
      expect(counts).toBe(2);
    } finally {
      (main as unknown as { prepare: unknown }).prepare = origPrepare;
    }
  });
});
