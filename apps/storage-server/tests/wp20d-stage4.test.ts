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
import { createApplyToken } from '../src/cleanup/apply-tokens';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
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
    if (u.startsWith('https://bookwalker.jp/search/?word=')) {
      const q = decodeURIComponent(u.split('word=')[1]);
      if (!q.startsWith('魔法使いの旅')) return html('', 404);
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
    // A second fetcher is not active while the first one is.
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
    expect((second as unknown as { active: boolean }).active).toBe(false);

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
    expect(Object.keys(ev.requests)).toEqual(
      expect.arrayContaining([
        'amazon-dp',
        'ranobedb-book',
        'bookwalker-detail',
        'bookmeter-stores',
        'cover',
      ]),
    );
  }, 120_000);
});
