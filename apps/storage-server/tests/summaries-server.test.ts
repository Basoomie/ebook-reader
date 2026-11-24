/**
 * Book summaries session 3: summaries on the server. The first completion through a real sync
 * push (baseline, rereads, undo, "summary-skip", no text), the route of setups (a refusal, the
 * wait rule, the spending limit only queues, every setup failed: the note and one alert), a
 * series made in order with the earlier volumes as background, storage as items with versions,
 * edits, translations made item by item and only changed items again, the record every device
 * pulls, a restart resuming without asking twice, the estimate; and the shared layer's Flex mode
 * and per-provider stall limit.
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiCore } from '../src/ai/core';
import {
  FlexUnavailableError,
  type CallInput,
  type CallResult,
  type ProviderClient,
} from '../src/ai/providers';
import { AiRunner } from '../src/ai/runner';
import { stallMinutesOf, validateAiSettings, DEFAULT_AI_SETTINGS } from '../src/ai/settings';
import { createApp } from '../src/app';
import type { BookScript } from '../src/audio/book-script';
import { initDatabase } from '../src/db/database';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import { isCountedChar } from '../src/summaries/book-text';
import { importSummaries, type ImportEntry } from '../src/summaries/import';
import {
  LABELS_REQUESTED,
  labelPlan,
  NoTextError,
  phaseOfStage,
  SummaryService,
} from '../src/summaries/service';
import { itemDigest } from '../src/summaries/store';
import { OPUS, SOL, SONNET } from '../src/summaries/settings';
import { modelForTask } from '../src/summaries/specs';
import { openSummariesDb } from '../src/summaries/summaries-db';
import { TRANSLATE_SPEC } from '../src/summaries/specs';
import { SyncStore } from '../src/sync/store';
import { makeAiCore } from './helpers/ai-env';
import { makeTempDir } from './helpers/spawn-server';
import { testConfig } from './helpers/test-app';

// ---------------------------------------------------------------------------------------------
// a small book (positions as the reader counts them)

function scriptOf(chapters: { title: string; paragraphs: string[][] }[]): BookScript {
  let pos = 0;
  const out: BookScript = { version: 3, characters: 0, chapters: [] };
  chapters.forEach((c, i) => {
    const start = pos;
    const sentences = [];
    for (const p of c.paragraphs)
      for (let k = 0; k < p.length; k++) {
        sentences.push({
          text: p[k],
          reading: p[k],
          position: pos,
          paragraphEnd: k === p.length - 1,
        });
        for (const ch of p[k]) if (isCountedChar(ch)) pos++;
      }
    out.chapters.push({
      index: i,
      title: c.title,
      startCharacter: start,
      characters: pos - start,
      sentences,
    });
  });
  out.characters = pos;
  return out;
}

const BOOK = scriptOf([
  {
    title: '第一章　出会い',
    paragraphs: [
      ['汐見ナギは港町に住む少女だった。', '「潮呪（ちょうじゅ）なんて信じない」とナギは言った。'],
      ['ある夜、カイトという少年が浜に倒れていた。'],
    ],
  },
  {
    title: '第二章　秘密',
    paragraphs: [
      ['カイトは自分が潮呪を受けた一族の最後の一人だと明かした。'],
      ['ナギはカイトを守ると決めた。', '二人は灯台へ向かった。'],
    ],
  },
]);

// ---------------------------------------------------------------------------------------------
// the stand-in models

interface Call {
  model: string;
  schema: string;
  user: string;
  tier?: string;
}

interface StandIn {
  calls: Call[];
  /** "<model>|<schema>" (schema "*": every step) answered with a refusal. */
  refuse: Set<string>;
  /** Models whose list the provider no longer offers (a wait: model missing). */
  missing: Set<string>;
  /** Description translations answered with a line left out (session 4b), counted down. */
  descBad?: number;
  /** Session 5: recap points (refs) the checkers answer not_supported. */
  rejectPoints?: Set<string>;
  /** Session 5: check answers that leave out their last verdict, counted down. */
  dropVerdict?: number;
  /** Session 5: added to the recap's overview (a rebuild that writes one point differently). */
  recapOverview?: string;
}

/**
 * Session 5: the story so far from the evidence: an overview citing everything, one plot item
 * per volume, カイト (first in the earliest volume), the relationship, a thread from the last
 * volume, an invented name and a cite of nothing (both left out by the checks).
 */
function recapAnswer(input: CallInput, s: StandIn): unknown {
  const ids = [...input.user.matchAll(/^(v(\d+):\S+) \[/gm)].map((m) => ({
    id: m[1],
    v: Number(m[2]),
  }));
  const vols = [...new Set(ids.map((x) => x.v))];
  const first = ids[0].id;
  const last = ids[ids.length - 1].id;
  return {
    overview: {
      text: `これまでの物語（${input.model}）。${s.recapOverview ?? ''}`,
      cites: ids.map((x) => x.id),
    },
    volumes: vols.map((v) => ({
      volume: `v${v}`,
      items: [{ text: `第${v}巻の出来事`, cites: [ids.find((x) => x.v === v)!.id] }],
    })),
    characters: [
      { name: 'カイト', text: '一族の最後の一人。', cites: [last, first] },
      { name: 'ゼロ', text: '謎の男。', cites: [first] },
    ],
    also_mentioned: ['汐見ナギ', '謎の人'],
    relationships: [
      { a: '汐見ナギ', b: 'カイト', label: '守り手', text: 'ナギはカイトを守る。', cites: [last] },
    ],
    terms: [{ term: '潮呪', text: '一族の呪い。', cites: ['v9:none'] }],
    threads: [{ text: 'カイトの一族の行方。', cites: [last] }],
  };
}

function recapVerdicts(input: CallInput, s: StandIn): unknown {
  const ids = [...input.user.matchAll(/^POINT (\S+):/gm)].map((m) => m[1]);
  const out = ids.map((id) => ({
    id,
    verdict: s.rejectPoints?.has(id) ? 'not_supported' : 'supported',
  }));
  if (s.dropVerdict && out.length > 1) {
    s.dropVerdict--;
    out.pop();
  }
  return { verdicts: out };
}

function answer(input: CallInput): unknown {
  const name = input.schema?.name ?? '';
  const u = input.user;
  if (name === 'chapter_items' && u.includes('=== Chapter 0'))
    return {
      chapters: [
        {
          chapter: 0,
          not_story: false,
          items: [
            {
              kind: 'event',
              text: 'カイトが浜に倒れていた',
              quote: 'カイトという少年が浜に倒れていた',
              names: ['カイト'],
            },
          ],
        },
        {
          chapter: 1,
          not_story: false,
          items: [
            {
              kind: 'reveal',
              text: 'カイトは一族の最後の一人',
              quote: '潮呪を受けた一族の最後の一人',
              names: ['カイト'],
            },
          ],
        },
      ],
    };
  if (name === 'chapter_items') return { not_story: true, items: [] };
  if (name === 'pairs') {
    const [a, b] = u.split('LIST B:');
    const id = (s: string, ch: number) => new RegExp(`^(\\S+) \\[ch ${ch}\\]`, 'm').exec(s)?.[1];
    return { pairs: [0, 1].map((ch) => ({ a: id(a, ch), b: id(b, ch) })) };
  }
  if (name === 'verdicts') {
    const ids = [...u.matchAll(/^CLAIM (\S+):/gm)].map((m) => m[1]);
    return { verdicts: ids.map((id) => ({ id, verdict: 'supported' })) };
  }
  if (name === 'summary') {
    const ids = [...u.matchAll(/^(\S+) \[ch (\d+)/gm)].map((m) => ({ id: m[1], ch: Number(m[2]) }));
    return {
      overview: { text: `ナギとカイトの物語（${input.model}）。`, cites: ids.map((x) => x.id) },
      chapters: [0, 1].map((c) => ({
        chapter: c,
        items: ids
          .filter((x) => x.ch === c)
          .slice(0, 1)
          .map((x) => ({
            text: `第${c}章の出来事`,
            cites: [x.id],
            quote_from: x.id,
            show_quote: c === 1,
          })),
      })),
      characters: [
        {
          name: 'カイト',
          text: '浜に倒れていた少年。',
          cites: [ids[0].id],
          quote_from: ids[0].id,
          show_quote: false,
        },
      ],
      also_mentioned: ['汐見ナギ'],
      relationships: [
        {
          a: '汐見ナギ',
          b: 'カイト',
          label: '守り手',
          text: 'ナギはカイトを守る。',
          cites: [ids[0].id],
          quote_from: '',
          show_quote: false,
        },
      ],
      terms: [],
      threads: [],
    };
  }
  if (name === 'translation') {
    const refs = u
      .split('\n\n')
      .slice(1)
      .flatMap((b) => {
        const m = /^(\S+)(?: HEADING: (.*))?(?:\nLABEL: (.*))?\nTEXT: ([\s\S]*)$/.exec(b);
        return m ? [m] : [];
      });
    return {
      items: refs.map((m) => ({
        ref: m[1],
        heading: m[2] ? `EN ${m[2]}` : '',
        label: m[3] ? `EN ${m[3]}` : '',
        text: `EN ${m[4]}`,
      })),
    };
  }
  if (name === 'labels') {
    const refs = [...u.matchAll(/^(\S+) BETWEEN: (.*)$/gm)].map((m) => m[1]);
    return { items: refs.map((ref) => ({ ref, label: '仲間' })) };
  }
  throw new Error(`unexpected ${name}`);
}

/** The description's paragraphs and lines, each line as "EN <line>" (session 4b). */
function describeAnswer(input: CallInput, s: StandIn): unknown {
  const paragraphs = input.user
    .split(/^PARAGRAPH \d+ \(\d+ lines?\):\n/m)
    .slice(1)
    .map((b) => b.replace(/\n+$/, '').split('\n'));
  const out = paragraphs.map((p) => ({ lines: p.map((l) => `EN ${l}`) }));
  if (s.descBad) {
    s.descBad--;
    out[out.length - 1].lines.pop();
  }
  return { paragraphs: out };
}

function standIn(s: StandIn): (p: 'anthropic' | 'openai') => ProviderClient {
  return (provider) => ({
    provider,
    listModels: async () => [SONNET, SOL, OPUS].filter((m) => !s.missing.has(m)),
    call: async (input): Promise<CallResult> => {
      const schema = input.schema?.name ?? '';
      s.calls.push({ model: input.model, schema, user: input.user, tier: input.serviceTier });
      const usage = { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 };
      if (s.refuse.has(`${input.model}|${schema}`) || s.refuse.has(`${input.model}|*`))
        return { kind: 'blocked', detail: 'refusal', text: null, usage };
      const json =
        schema === 'description'
          ? describeAnswer(input, s)
          : schema === 'story_so_far'
            ? recapAnswer(input, s)
            : schema === 'verdicts' && input.user.includes('\nPOINT ')
              ? recapVerdicts(input, s)
              : answer(input);
      return { kind: 'answered', text: JSON.stringify(json), json, usage };
    },
    submitBatch: async () => {
      throw new Error('no batches');
    },
    batchStatus: async () => {
      throw new Error('no batches');
    },
    batchResults: async () => [],
    cancelBatch: async () => {},
  });
}

// ---------------------------------------------------------------------------------------------
// the server with summaries

const services: SummaryService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
});

interface Env {
  app: ReturnType<typeof createApp>;
  main: Database.Database;
  sdb: Database.Database;
  svc: SummaryService;
  core: AiCore;
  stand: StandIn;
  clock: { t: number };
  alerts: { key: string; lines: string[] }[];
  auth: { Authorization: string };
  sync: SyncStore;
  books: Record<string, string>;
  scripts: Map<string, BookScript | 'none'>;
  /** API keys taken away (a wait that needs the user). */
  keysOff: Set<string>;
  restart(): SummaryService;
}

function setup(
  o: {
    limit?: number;
    route?: unknown;
    before?: (main: Database.Database, ids: Record<string, string>) => void;
  } = {},
): Env {
  const config = testConfig();
  const database = initDatabase(config.dbDir, config.dataRoot);
  if (!database.ok) throw new Error('no database');
  const main = database.db;
  const clock = { t: Date.UTC(2026, 10, 23, 12) };
  const now = () => clock.t;
  const stand: StandIn = { calls: [], refuse: new Set(), missing: new Set() };
  const keysOff = new Set<string>();
  const { core } = makeAiCore({
    db: main,
    dir: config.dbDir,
    keys: { read: (name) => (keysOff.has(name) ? null : 'key') },
    providers: standIn(stand),
    now,
  });
  core.updateSettings({
    spendLimitUsd: o.limit ?? 30,
    modes: { [SONNET]: 'direct', [SOL]: 'direct', [OPUS]: 'direct' },
  });
  // A library with a series of two volumes, a standalone book and a book of pictures.
  const t0 = now();
  main
    .prepare(
      `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at) VALUES ('lib1', 'lib', 'Lib', 'ja', 1, ?, ?)`,
    )
    .run(t0, t0);
  main.prepare(`INSERT INTO series (id, name) VALUES (1, '潮騒')`).run();
  const books: Record<string, string> = {};
  const scripts = new Map<string, BookScript | 'none'>();
  for (const [key, title, series, idx, chars] of [
    ['v1', '潮騒のナギ 1', 1, 1, BOOK.characters],
    ['v2', '潮騒のナギ 2', 1, 2, BOOK.characters],
    ['solo', '灯台の夜', null, null, BOOK.characters],
    ['pics', '画集', null, null, 0],
  ] as const) {
    const id = randomUUID();
    books[key] = id;
    main
      .prepare(
        `INSERT INTO books (id, library_id, title, series_id, series_index, char_count, added_at, created_at, updated_at)
         VALUES (?, 'lib1', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, title, series, idx, chars, t0, t0, t0);
    scripts.set(id, chars ? BOOK : 'none');
  }
  o.before?.(main, books);
  const dir = makeTempDir('sum-server');
  const sdbPath = path.join(dir, 'summaries.db');
  const alerts: { key: string; lines: string[] }[] = [];
  const seen = new Set<string>();
  const sync = new SyncStore(main, { maxClockSkewMs: 1e12 });
  let sdb = openSummariesDb(sdbPath);
  const make = () => {
    const runner = new AiRunner({
      db: sdb,
      core,
      source: 'summaries',
      featureOf: () => 'summaries',
      modelFor: modelForTask,
      now,
      sleep: async () => {},
    });
    const svc = new SummaryService({
      db: sdb,
      main,
      core,
      runner,
      now,
      intervalMs: 3_600_000,
      readScript: async (id) => {
        const s = scripts.get(id);
        if (!s) throw new Error('no epub');
        if (s === 'none') throw new NoTextError('no text');
        return s;
      },
      notifications: {
        observe: (key) => {
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        },
        notify: (m) => alerts.push({ key: m.event, lines: m.lines }),
        clear: (key) => seen.delete(key),
        poke: () => {},
      },
    });
    if (o.route) svc.updateSettings({ route: o.route });
    svc.attachSync(sync);
    svc.start();
    services.push(svc);
    return svc;
  };
  const svc = make();
  const app = createApp({ config, database, version: 't', ai: core, summaries: svc });
  const [owner] = listUsers(main);
  const auth = { Authorization: `Bearer ${createToken(main, owner.id, 'phone').token}` };
  const env: Env = {
    app,
    main,
    sdb,
    svc,
    core,
    stand,
    clock,
    alerts,
    auth,
    sync,
    books,
    scripts,
    keysOff,
    restart: () => {
      const old = env.svc;
      void old.stop();
      sdb = openSummariesDb(sdbPath);
      env.sdb = sdb;
      env.svc = make();
      return env.svc;
    },
  };
  return env;
}

async function register(e: Env) {
  const res = await request(e.app)
    .post('/api/v1/devices/register')
    .set(e.auth)
    .send({ deviceId: randomUUID() });
  expect(res.status).toBe(200);
}

const finished = (n: number) => ({
  number: n,
  origin: 'completion',
  startedOn: null,
  finished: true,
  finishedOn: '2026-11-23',
  manual: true,
  charCount: null,
});

async function push(
  e: Env,
  changes: { kind: string; id: string; data?: unknown; deletedAt?: number }[],
) {
  e.clock.t += 1000;
  const res = await request(e.app)
    .post('/api/v1/sync')
    .set(e.auth)
    .send({ changes: changes.map((c) => ({ updatedAt: e.clock.t, ...c })) });
  expect(res.status).toBe(200);
  return res.body.results as { status: string; error?: { code: string } }[];
}

const complete = (bookId: string, n = 1) => [
  { kind: 'book-status', id: bookId, data: { status: 'completed', auto: false } },
  { kind: 'read-through', id: `${bookId}:${n}`, data: finished(n) },
];

/** Runs passes until no job is open (or `max` passes). */
async function drain(e: Env, max = 400) {
  for (let i = 0; i < max; i++) {
    await e.svc.pass();
    await new Promise((r) => setTimeout(r, 10));
    const open = e.sdb
      .prepare(`SELECT COUNT(*) AS n FROM summary_jobs WHERE state IN ('queued', 'running')`)
      .get() as { n: number };
    if (!open.n) return;
  }
}

const jobs = (e: Env) =>
  e.sdb
    .prepare(
      'SELECT id, book_id, kind, state, step, attempts_json, error FROM summary_jobs ORDER BY id',
    )
    .all() as {
    id: number;
    book_id: string;
    kind: string;
    state: string;
    step: number;
    attempts_json: string;
    error: string | null;
  }[];

// ---------------------------------------------------------------------------------------------

describe('the first completion', () => {
  it('makes the summary with the mixed setup; the device gets the record and the summary over REST', async () => {
    const e = setup();
    await register(e);
    await push(e, complete(e.books.solo));
    expect(jobs(e)).toMatchObject([{ book_id: e.books.solo, kind: 'auto', state: 'queued' }]);
    await drain(e);
    expect(jobs(e)[0].state).toBe('done');
    const writer = e.stand.calls.find((c) => c.schema === 'summary');
    expect(writer?.model).toBe(OPUS);
    expect(
      new Set(e.stand.calls.filter((c) => c.schema === 'chapter_items').map((c) => c.model)),
    ).toEqual(new Set([SONNET, SOL]));
    // The record on the device.
    const pulled = (await request(e.app).get('/api/v1/sync').set(e.auth)).body.records as {
      kind: string;
      id: string;
      data: {
        summary: { setup: string; models: string[]; langs: Record<string, string> } | null;
        making: string | null;
      };
    }[];
    const rec = pulled.find((r) => r.kind === 'book-summary' && r.id === e.books.solo)!;
    expect(rec.data.summary).toMatchObject({ setup: 'mixed', models: [SONNET, SOL, OPUS] });
    expect(Object.keys(rec.data.summary!.langs)).toEqual(['ja']);
    expect(rec.data.making).toBeNull();
    // The summary as items, each with its quote, position and shown flag.
    const got = (await request(e.app).get(`/api/v1/summaries/${e.books.solo}`).set(e.auth)).body;
    expect(got.summary.sections.map((s: { key: string }) => s.key)).toEqual([
      'overview',
      'chapters',
      'characters',
      'relationships',
    ]);
    const ch1 = got.summary.sections[1].groups[1].items[0];
    expect(ch1).toMatchObject({ showQuote: true, editedByUser: false });
    expect(ch1.quote).toBeTruthy();
    expect(typeof ch1.position).toBe('number');
    expect(got.summary.alsoMentioned).toEqual(['汐見ナギ']);
    // A device can't write the record itself.
    const r = await push(e, [{ kind: 'book-summary', id: e.books.solo, data: { summary: null } }]);
    expect(r[0]).toMatchObject({ status: 'rejected', error: { code: 'read_only' } });
  });

  it('a reread, an undone completion and a later completion never make another one', async () => {
    const e = setup();
    await register(e);
    await push(e, complete(e.books.solo));
    await drain(e);
    const calls = e.stand.calls.length;
    // Start over and finish again.
    await push(e, [{ kind: 'read-through', id: `${e.books.solo}:2`, data: finished(2) }]);
    // Undo the first, complete again.
    await push(e, [{ kind: 'read-through', id: `${e.books.solo}:1`, deletedAt: e.clock.t + 1000 }]);
    await push(e, complete(e.books.solo));
    await drain(e);
    expect(jobs(e)).toHaveLength(1);
    expect(e.stand.calls.length).toBe(calls);
  });

  it('books completed before summaries existed never get one; a skip record or no text neither', async () => {
    const e = setup({
      before: (main, ids) => {
        const user = listUsers(main)[0];
        const dev = randomUUID();
        main
          .prepare('INSERT INTO devices (id, user_id, created_at) VALUES (?, ?, 0)')
          .run(dev, user.id);
        new SyncStore(main, { maxClockSkewMs: 1e12 }).push(user.id, dev, [
          { kind: 'read-through', id: `${ids.v1}:1`, updatedAt: 1, data: finished(1) },
        ]);
      },
    });
    await register(e);
    // v1 was completed before: the baseline. A new status change makes nothing.
    await push(e, complete(e.books.v1, 2));
    // The bulk dialog's unchecked line: the skip record in the same push, before the completion.
    await push(e, [{ kind: 'summary-skip', id: e.books.v2, data: {} }, ...complete(e.books.v2)]);
    // A book of pictures: "No text to summarize", no model asked.
    await push(e, complete(e.books.pics));
    await drain(e);
    expect(jobs(e)).toHaveLength(0);
    expect(e.stand.calls).toHaveLength(0);
    const marks = e.sdb
      .prepare('SELECT book_id, first_completion, outcome, note FROM summary_books')
      .all();
    expect(marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ book_id: e.books.v1, first_completion: 'baseline' }),
        expect.objectContaining({ book_id: e.books.v2, first_completion: 'skipped' }),
        expect.objectContaining({
          book_id: e.books.pics,
          first_completion: 'no_text',
          outcome: 'no_text',
          note: 'No text to summarize',
        }),
      ]),
    );
    // The estimate leaves out what wouldn't get one.
    const est = (
      await request(e.app)
        .post('/api/v1/summaries/estimate')
        .set(e.auth)
        .send({ bookIds: Object.values(e.books) })
    ).body;
    expect(est.books).toEqual([e.books.solo]);
    expect(est.usd).toBeCloseTo((BOOK.characters / 100_000) * 1.3, 6);
  });
});

describe('the route of setups', () => {
  it('a writer that refuses: Sonnet + Sol written by Sonnet, the finders not asked again', async () => {
    const e = setup();
    e.stand.refuse.add(`${OPUS}|summary`);
    await register(e);
    await push(e, complete(e.books.solo));
    await drain(e);
    const extracts = e.stand.calls.filter((c) => c.schema === 'chapter_items').length;
    expect(extracts).toBe(2);
    const j = jobs(e)[0];
    expect(j).toMatchObject({ state: 'done', step: 1 });
    expect(JSON.parse(j.attempts_json)).toMatchObject([
      { setup: 'mixed', reason: expect.stringContaining('refused') },
    ]);
    const m = e.svc.store.currentMeta(e.books.solo)!;
    expect(m.setup).toBe('two');
    expect(e.svc.store.view(m.id)!.sections[0].groups[0].items[0].text).toContain(SONNET);
  });

  it('every setup failing: no summary, the note on the book and one alert', async () => {
    const e = setup();
    for (const m of [SONNET, SOL, OPUS]) e.stand.refuse.add(`${m}|*`);
    await register(e);
    await push(e, complete(e.books.solo));
    await drain(e);
    expect(jobs(e)[0].state).toBe('failed');
    expect(e.svc.store.currentMeta(e.books.solo)).toBeNull();
    const st = e.svc.get(e.books.solo).state as { outcome: string; note: string };
    expect(st.outcome).toBe('failed');
    // In plain words, one line per setup (review of the states, 2026-11-24).
    // Each failure once, each model named once (2026-11-24).
    expect(st.note).toBe(
      [
        'Every setup failed.',
        'Claude Sonnet 5.5, GPT-6.1 Sol and Claude Opus 5.5 refused to read the book.',
      ].join('\n'),
    );
    expect(e.alerts).toHaveLength(1);
    expect(e.alerts[0].lines.slice(1)).toEqual(st.note.split('\n'));
    expect(e.alerts[0]).toMatchObject({ key: 'summary_failed' });
    // A later completion never retries; Regenerate fails again without a second alert.
    await push(e, complete(e.books.solo, 2));
    await request(e.app)
      .post(`/api/v1/summaries/${e.books.solo}/regenerate`)
      .set(e.auth)
      .expect(202);
    await drain(e);
    expect(jobs(e).map((j) => j.state)).toEqual(['failed', 'failed']);
    expect(e.alerts).toHaveLength(1);
  });

  it('a wait other than the limit moves on after the set time; the spending limit only queues', async () => {
    const e = setup({ limit: 0.000001 });
    await register(e);
    await push(e, complete(e.books.solo));
    for (let i = 0; i < 5; i++) {
      await e.svc.pass();
      e.clock.t += 2 * 3_600_000;
    }
    // Two hours a time: still waiting (the limit), nothing failed.
    expect(jobs(e)[0]).toMatchObject({ state: 'running', step: 0 });
    // The OpenAI key goes (a wait that needs the user), the limit is raised.
    e.keysOff.add('openaiApiKey');
    e.core.updateSettings({ spendLimitUsd: 30 });
    for (let i = 0; i < 40; i++) {
      await e.svc.pass();
      e.clock.t += 20 * 60_000;
      if (jobs(e)[0].state !== 'running') break;
    }
    const j = jobs(e)[0];
    expect(j.state).toBe('done');
    // Both setups with Sol were left after 60 min each; Opus alone made it.
    expect(
      JSON.parse(j.attempts_json).map((a: { setup: string; reason: string }) => [
        a.setup,
        a.reason,
      ]),
    ).toEqual([
      ['mixed', 'nothing could be sent for 60 min: The OpenAI API key is missing (Settings > AI)'],
      ['two', 'nothing could be sent for 60 min: The OpenAI API key is missing (Settings > AI)'],
    ]);
    expect(e.svc.store.currentMeta(e.books.solo)!.setup).toBe('opus');
  });
});

describe('a series', () => {
  it('volumes in order, the earlier ones as background (without their chapters)', async () => {
    const e = setup();
    await register(e);
    await push(e, [...complete(e.books.v2), ...complete(e.books.v1)]);
    await e.svc.pass();
    // v2 waits for v1 even though its job is older.
    const j = e.svc.jobs();
    expect(j.find((x) => x.bookId === e.books.v2)).toMatchObject({
      state: 'queued',
      afterVolume: true,
    });
    await drain(e);
    const v2Extract = e.stand.calls.filter((c) => c.schema === 'chapter_items').slice(-1)[0];
    expect(v2Extract.user).toContain('BACKGROUND');
    expect(v2Extract.user).toContain('## 潮騒のナギ 1');
    expect(v2Extract.user).toContain('(overview)');
    expect(v2Extract.user).not.toContain('(chapters)');
    expect(e.svc.store.currentMeta(e.books.v2)!.background).toBe(true);
    expect(e.svc.store.currentMeta(e.books.v1)!.background).toBe(false);
  });
});

describe('the user’s actions', () => {
  async function made(e: Env) {
    await register(e);
    await push(e, complete(e.books.solo));
    await drain(e);
    return e.svc.store.currentMeta(e.books.solo)!;
  }

  it('edits mark items; translations are made item by item and again only for changed items', async () => {
    const e = setup();
    const m = await made(e);
    const id = e.books.solo;
    await request(e.app)
      .post(`/api/v1/summaries/${id}/translate`)
      .set(e.auth)
      .send({ lang: 'en' })
      .expect(202);
    await drain(e);
    const en = (await request(e.app).get(`/api/v1/summaries/${id}?lang=en`).set(e.auth)).body
      .summary;
    expect(en.untranslated).toEqual([]);
    const char = en.sections.find((s: { key: string }) => s.key === 'characters').groups[0]
      .items[0];
    // The original spelling in brackets in Characters' headings; quotes stay in Japanese.
    expect(char.heading).toBe('EN カイト (カイト)');
    expect(char.text).toBe('EN 浜に倒れていた少年。');
    const chItem = en.sections[1].groups[1].items[0];
    expect(chItem.quote).toBe('潮呪を受けた一族の最後の一人');
    expect(en.alsoMentioned).toEqual(['EN 汐見ナギ']);
    const translations = () => e.stand.calls.filter((c) => c.schema === 'translation');
    expect(translations()).toHaveLength(1);
    // Edit one item: only it is translated again.
    const items = e.svc.store.items(m.id);
    const ov = items.find((i) => i.section === 'overview')!;
    await request(e.app)
      .put(`/api/v1/summaries/${id}/items/${ov.id}`)
      .set(e.auth)
      .send({ text: '書き直した概要。' })
      .expect(200);
    // Delete one, add one.
    const rel = items.find((i) => i.section === 'relationships')!;
    await request(e.app).delete(`/api/v1/summaries/${id}/items/${rel.id}`).set(e.auth).expect(204);
    const added = (
      await request(e.app)
        .post(`/api/v1/summaries/${id}/items`)
        .set(e.auth)
        .send({ section: 'threads', text: '灯台の秘密はまだ分からない。' })
        .expect(201)
    ).body.item;
    expect(added).toMatchObject({ addedByUser: true, section: 'threads' });
    await drain(e);
    const again = translations().slice(1);
    const asked = again
      .map((c) => [...c.user.matchAll(/^(\S+)(?: HEADING: .*)?\nTEXT:/gm)].map((x) => x[1]))
      .flat();
    expect(asked.sort()).toEqual(['overview', added.ref].sort());
    const view = e.svc.store.view(m.id, 'en')!;
    expect(view.untranslated).toEqual([]);
    expect(view.sections.find((s) => s.key === 'relationships')).toBeUndefined();
    const edited = e.svc.store.view(m.id)!.sections[0].groups[0].items[0];
    expect(edited).toMatchObject({ text: '書き直した概要。', editedByUser: true });
    // The record names both languages.
    const rec = e.sync.getRecord(listUsers(e.main)[0].id, 'book-summary', id)!;
    expect(Object.keys((rec.data as { summary: { langs: object } }).summary.langs)).toEqual([
      'ja',
      'en',
    ]);
  });

  it('Regenerate keeps the old one as an earlier version; Restore, Delete and earlier versions', async () => {
    const e = setup();
    const first = await made(e);
    const id = e.books.solo;
    const extracts = () => e.stand.calls.filter((c) => c.schema === 'chapter_items').length;
    const before = extracts();
    await request(e.app).post(`/api/v1/summaries/${id}/regenerate`).set(e.auth).expect(202);
    await drain(e);
    // A new generation: asked again, not read from the stored answers.
    expect(extracts()).toBe(before + 2);
    const versions = (await request(e.app).get(`/api/v1/summaries/${id}/versions`).set(e.auth)).body
      .versions;
    expect(versions.map((v: { state: string }) => v.state)).toEqual(['current', 'earlier']);
    expect(versions[1].id).toBe(first.id);
    await request(e.app)
      .post(`/api/v1/summaries/${id}/versions/${first.id}/restore`)
      .set(e.auth)
      .expect(204);
    expect(e.svc.store.currentMeta(id)!.id).toBe(first.id);
    // Delete: no current summary; it stays as an earlier version.
    await request(e.app).delete(`/api/v1/summaries/${id}`).set(e.auth).expect(204);
    expect(
      (await request(e.app).get(`/api/v1/summaries/${id}`).set(e.auth)).body.summary,
    ).toBeNull();
    const rec = e.sync.getRecord(listUsers(e.main)[0].id, 'book-summary', id)!;
    expect((rec.data as { summary: unknown }).summary).toBeNull();
    expect(e.svc.store.versions(id).every((v) => v.state === 'earlier')).toBe(true);
    await request(e.app)
      .delete(`/api/v1/summaries/${id}/versions/${first.id}`)
      .set(e.auth)
      .expect(204);
    expect(e.svc.store.versions(id)).toHaveLength(1);
  });

  it('Write my own; an automatic run finishing later keeps the user’s as current', async () => {
    const e = setup();
    await register(e);
    await push(e, complete(e.books.solo));
    // Written before the automatic job ran.
    const own = await request(e.app)
      .put(`/api/v1/summaries/${e.books.solo}/own`)
      .set(e.auth)
      .send({
        overview: '自分で書いた要約。',
        sections: [{ key: 'characters', items: [{ heading: 'ナギ', text: '港町の少女。' }] }],
      })
      .expect(200);
    expect(own.body.summary.origin).toBe('user');
    await drain(e);
    const v = e.svc.store.versions(e.books.solo);
    expect(v.map((x) => `${x.state}/${x.origin}`).sort()).toEqual(['current/user', 'earlier/ai']);
    expect(e.svc.store.currentMeta(e.books.solo)!.origin).toBe('user');
  });
});

describe('session 4: relationship labels and the job’s step', () => {
  async function made(e: Env) {
    await register(e);
    await push(e, complete(e.books.solo));
    await drain(e);
    return e.svc.store.currentMeta(e.books.solo)!;
  }
  const rels = (e: Env, id: number, lang?: string) =>
    e.svc.store.view(id, lang)!.sections.find((s) => s.key === 'relationships')!.groups[0].items;

  it('the writer’s label is stored, translated, edited by the user and given to added items', async () => {
    const e = setup();
    const m = await made(e);
    const id = e.books.solo;
    expect(rels(e, m.id)[0]).toMatchObject({ between: ['汐見ナギ', 'カイト'], label: '守り手' });
    expect(e.stand.calls.find((c) => c.schema === 'summary')).toBeTruthy();
    await request(e.app)
      .post(`/api/v1/summaries/${id}/translate`)
      .set(e.auth)
      .send({ lang: 'en' })
      .expect(202);
    await drain(e);
    const tr = e.stand.calls.filter((c) => c.schema === 'translation');
    expect(tr[0].user).toContain('LABEL: 守り手');
    expect(rels(e, m.id, 'en')[0]).toMatchObject({ label: 'EN 守り手' });
    // The user changes the label: their edit, translated again.
    const rel = e.svc.store.items(m.id).find((i) => i.section === 'relationships')!;
    const put = await request(e.app)
      .put(`/api/v1/summaries/${id}/items/${rel.id}`)
      .set(e.auth)
      .send({ text: rel.text, label: '  幼なじみ  ' })
      .expect(200);
    expect(put.body.item).toMatchObject({ label: '幼なじみ', editedByUser: true });
    await drain(e);
    expect(rels(e, m.id, 'en')[0]).toMatchObject({ label: 'EN 幼なじみ' });
    // Added with and without a label.
    const a = await request(e.app)
      .post(`/api/v1/summaries/${id}/items`)
      .set(e.auth)
      .send({ section: 'relationships', between: ['A', 'B'], label: '敵対', text: '争う。' })
      .expect(201);
    expect(a.body.item).toMatchObject({ label: '敵対', addedByUser: true });
    const b = await request(e.app)
      .post(`/api/v1/summaries/${id}/items`)
      .set(e.auth)
      .send({ section: 'relationships', between: ['C', 'D'], text: '話す。' })
      .expect(201);
    expect(b.body.item.label).toBeUndefined();
    // Write my own keeps labels too.
    const own = await request(e.app)
      .put(`/api/v1/summaries/${id}/own`)
      .set(e.auth)
      .send({
        overview: '自分の要約。',
        sections: [
          {
            key: 'relationships',
            items: [{ between: ['X', 'Y'], label: '師弟', text: '教える。' }],
          },
        ],
      })
      .expect(200);
    expect(own.body.summary.sections[1].groups[0].items[0]).toMatchObject({ label: '師弟' });
  });

  it('translations made before labels stay valid: the digest is unchanged without a label', () => {
    const old = (x: { heading?: string; between?: [string, string]; text: string }) =>
      createHash('sha1')
        .update(
          [x.heading ?? '', x.between ? x.between.join(String.fromCharCode(2)) : '', x.text].join(
            String.fromCharCode(1),
          ),
        )
        .digest('hex')
        .slice(0, 16);
    const it1 = { between: ['A', 'B'] as [string, string], text: 'こんにちは' };
    expect(itemDigest(it1)).toBe(old(it1));
    expect(itemDigest({ heading: 'カイト', text: '少年' })).toBe(
      old({ heading: 'カイト', text: '少年' }),
    );
    expect(itemDigest({ ...it1, label: '師弟' })).not.toBe(old(it1));
  });

  it('cli summaries label: the plan, then the server labels the old relationships once', async () => {
    const e = setup();
    const m = await made(e);
    const id = e.books.solo;
    await request(e.app)
      .post(`/api/v1/summaries/${id}/translate`)
      .set(e.auth)
      .send({ lang: 'en' })
      .expect(202);
    await drain(e);
    // A summary written before labels existed.
    e.sdb.prepare('UPDATE summary_items SET label = NULL WHERE summary_id = ?').run(m.id);
    e.sdb.prepare('UPDATE summary_translations SET label = NULL WHERE summary_id = ?').run(m.id);
    // Its translation was made from the item without a label.
    for (const it of e.svc.store.items(m.id))
      e.sdb
        .prepare(
          'UPDATE summary_translations SET source_digest = ? WHERE summary_id = ? AND ref = ?',
        )
        .run(itemDigest(it), m.id, it.ref);
    expect(e.svc.store.view(m.id, 'en')!.untranslated).toEqual([]);
    const plan = labelPlan(e.svc.store, { inputPerMTok: 2, outputPerMTok: 10 });
    expect(plan.summaries).toMatchObject([{ summaryId: m.id, bookId: id, items: 1 }]);
    expect(plan.usd).toBeGreaterThan(0);
    expect(plan.usd).toBeLessThan(0.01);
    // Nothing happens until asked.
    await e.svc.pass();
    expect(e.stand.calls.filter((c) => c.schema === 'labels')).toHaveLength(0);
    e.sdb
      .prepare('INSERT INTO summary_state (key, value) VALUES (?, ?)')
      .run(LABELS_REQUESTED, '1');
    const before = e.stand.calls.filter((c) => c.schema === 'translation').length;
    for (let i = 0; i < 20; i++) {
      await e.svc.pass();
      await new Promise((r) => setTimeout(r, 10));
    }
    await drain(e);
    const labels = e.stand.calls.filter((c) => c.schema === 'labels');
    expect(labels).toHaveLength(1);
    expect(labels[0].model).toBe(SONNET);
    const rel = e.svc.store.items(m.id).find((i) => i.section === 'relationships')!;
    expect(rel).toMatchObject({ label: '仲間', editedByUser: false });
    expect(e.svc.store.metaById(m.id)!.editedAt).toBeNull();
    // Only that item is translated again.
    const again = e.stand.calls.filter((c) => c.schema === 'translation').slice(before);
    expect(again).toHaveLength(1);
    expect([...again[0].user.matchAll(/^(\S+) HEADING/gm)].map((x) => x[1])).toEqual([rel.ref]);
    expect(rels(e, m.id, 'en')[0]).toMatchObject({ label: 'EN 仲間' });
    expect(
      e.sdb.prepare('SELECT value FROM summary_state WHERE key = ?').get(LABELS_REQUESTED),
    ).toBeUndefined();
    expect(labelPlan(e.svc.store, null).summaries).toEqual([]);
  });

  it('the record and the jobs list name the running job’s step', async () => {
    const e = setup();
    await register(e);
    await push(e, complete(e.books.solo));
    const user = listUsers(e.main)[0].id;
    const seen: string[] = [];
    for (let i = 0; i < 400; i++) {
      await e.svc.pass();
      await new Promise((r) => setTimeout(r, 5));
      const d = e.sync.getRecord(user, 'book-summary', e.books.solo)?.data as
        | { making: string | null; phase: string | null; since: number | null }
        | undefined;
      if (d?.phase && seen[seen.length - 1] !== d.phase) seen.push(d.phase);
      if (d?.making === 'running') expect(d.since).toBeTypeOf('number');
      if (jobs(e)[0]?.state === 'done') break;
    }
    expect(seen).toEqual(['reading', 'checking', 'writing']);
    const d = e.sync.getRecord(user, 'book-summary', e.books.solo)!.data as { phase: unknown };
    expect(d.phase).toBeNull();
    expect(phaseOfStage('sum.support-chapter')).toBe('checking');
    expect(phaseOfStage('sum.claims')).toBeNull();
    const list = (await request(e.app).get(`/api/v1/summaries/${e.books.solo}/jobs`).set(e.auth))
      .body.jobs;
    expect(list[0]).toMatchObject({ state: 'done', phase: null });
  });
});

describe('the one-time import of the accuracy test', () => {
  const entry = (o: Partial<ImportEntry> = {}): ImportEntry => ({
    key: 'v1',
    run: 'v1|mixed|bg0|v4',
    title: '潮騒のナギ　１',
    series: '潮騒',
    volume: 1,
    characters: BOOK.characters,
    background: false,
    round: 'v4',
    madeAt: Date.UTC(2026, 10, 23, 17),
    summary: {
      lang: 'ja',
      bookTitle: '潮騒のナギ 1',
      models: [SONNET, SOL, OPUS],
      madeAt: Date.UTC(2026, 10, 23, 17),
      alsoMentioned: [],
      sections: [
        {
          key: 'overview',
          groups: [
            {
              items: [
                {
                  ref: 'overview',
                  text: '概要。',
                  cites: [],
                  quote: null,
                  position: null,
                  showQuote: false,
                },
              ],
            },
          ],
        },
        {
          key: 'chapters',
          groups: [
            {
              chapter: 1,
              items: [
                {
                  ref: 'ch1.0',
                  text: '明かす。',
                  cites: [],
                  quote: '潮呪を受けた一族の最後の一人',
                  position: 999,
                  showQuote: true,
                },
              ],
            },
          ],
        },
      ],
    },
    ...o,
  });

  it('matches the library’s book (not a removed copy), finds the quotes again and stores it as an import', async () => {
    const e = setup();
    const t = e.clock.t;
    // The kept copy has a file; a removed copy with the same title and text is marked missing.
    const removed = randomUUID();
    e.main
      .prepare(
        `INSERT INTO books (id, library_id, title, series_id, series_index, char_count, added_at, created_at, updated_at)
         VALUES (?, 'lib1', '潮騒のナギ 1', 1, 1, ?, ?, ?, ?)`,
      )
      .run(removed, BOOK.characters, t, t, t);
    const src = e.main.prepare(
      `INSERT INTO book_sources (id, book_id, library_id, kind, calibre_uuid, file_path, missing_at, created_at, updated_at)
       VALUES (?, ?, 'lib1', 'calibre', ?, ?, ?, ?, ?)`,
    );
    src.run(randomUUID(), e.books.v1, randomUUID(), 'a/v1.epub', null, t, t);
    src.run(randomUUID(), removed, randomUUID(), 'b/v1.epub', t, t, t);
    const run = (apply: boolean, file = { version: 1 as const, summaries: [entry()] }) =>
      importSummaries({ main: e.main, sdb: e.sdb, file, apply, readScript: async () => BOOK });
    const dry = await run(false);
    expect(dry.ok).toBe(true);
    expect(dry.lines[0]).toMatchObject({
      bookId: e.books.v1,
      how: 'title',
      quotes: 1,
      moved: 1,
      problem: null,
    });
    expect(e.svc.store.currentMeta(e.books.v1)).toBeNull();
    const done = await run(true);
    expect(done.stored).toBe(1);
    const m = e.svc.store.currentMeta(e.books.v1)!;
    expect(m).toMatchObject({
      origin: 'import',
      setup: 'mixed',
      background: false,
      madeAt: Date.UTC(2026, 10, 23, 17),
    });
    expect(m.note).toBe('accuracy test v4 (v1|mixed|bg0|v4)');
    const item = e.svc.store.view(m.id)!.sections[1].groups[0].items[0];
    expect(item).toMatchObject({
      editedByUser: false,
      position: BOOK.chapters[1].sentences[0].position + 'カイトは自分が'.length,
    });
    // The server's sweep tells the devices.
    e.svc.publishStale();
    const rec = e.sync.getRecord(listUsers(e.main)[0].id, 'book-summary', e.books.v1)!;
    expect((rec.data as { summary: { origin: string } }).summary.origin).toBe('import');
  });

  it('stores nothing when a book is not found, its text differs or a quote is missing', async () => {
    const e = setup();
    const t = e.clock.t;
    e.main
      .prepare(
        `INSERT INTO book_sources (id, book_id, library_id, kind, calibre_uuid, file_path, created_at, updated_at)
         VALUES (?, ?, 'lib1', 'calibre', ?, 'x.epub', ?, ?)`,
      )
      .run(randomUUID(), e.books.v1, randomUUID(), t, t);
    const bad = entry();
    bad.summary.sections[1].groups[0].items[0].quote = 'この文は本のどこにもない文章です';
    const r = await importSummaries({
      main: e.main,
      sdb: e.sdb,
      file: {
        version: 1,
        summaries: [
          entry({ key: 'gone', title: '無い本', series: null, volume: null }),
          entry({ key: 'other', characters: 5 }),
          bad,
        ],
      },
      apply: true,
      readScript: async () => BOOK,
    });
    expect(r.ok).toBe(false);
    expect(r.stored).toBe(0);
    expect(r.lines.map((l) => l.problem)).toEqual([
      'no book with this title (or series and volume) and text',
      expect.stringContaining('the title matches but not the text'),
      '1 quotes not found in the book',
    ]);
    expect(e.svc.store.currentMeta(e.books.v1)).toBeNull();
  });
});

describe('a restart', () => {
  it('resumes a job from its stored answers and asks nothing twice', async () => {
    const e = setup();
    await register(e);
    await push(e, complete(e.books.solo));
    // Two passes: the extraction is answered, the job is mid-way.
    await e.svc.pass();
    await e.svc.pass();
    await e.svc.pass();
    const sofar = e.stand.calls.map((c) => `${c.model}|${c.schema}|${c.user.length}`);
    const svc = e.restart();
    expect(svc).not.toBe(null);
    await drain(e);
    expect(jobs(e)[0].state).toBe('done');
    const all = e.stand.calls.map((c) => `${c.model}|${c.schema}|${c.user.length}`);
    expect(new Set(all).size).toBe(all.length);
    expect(all.slice(0, sofar.length)).toEqual(sofar);
  });
});

// ---------------------------------------------------------------------------------------------
// the shared layer

describe('Flex and the stall limit per provider (shared AI layer)', () => {
  it('flex is a mode only for the models that offer it; the stall limit is per provider', () => {
    expect(() => validateAiSettings({ modes: { [SONNET]: 'flex' } }, DEFAULT_AI_SETTINGS)).toThrow(
      /flex/,
    );
    expect(validateAiSettings({ modes: { [SOL]: 'flex' } }, DEFAULT_AI_SETTINGS).modes[SOL]).toBe(
      'flex',
    );
    const s = validateAiSettings({}, DEFAULT_AI_SETTINGS);
    expect(stallMinutesOf(s, 'anthropic')).toBe(30);
    expect(stallMinutesOf(s, 'openai')).toBe(180);
    expect(s.flexRetries).toBe(3);
  });

  it('a flex call: refusals for capacity tried again, then the normal price; cost by the tier charged', async () => {
    const calls: { tier?: string }[] = [];
    let refusals = 0;
    const { core, db } = makeAiCore({
      keys: { read: () => 'key' },
      providers: (provider) => ({
        provider,
        listModels: async () => [SOL],
        call: async (input): Promise<CallResult> => {
          calls.push({ tier: input.serviceTier });
          if (input.serviceTier === 'flex' && refusals-- > 0)
            throw new FlexUnavailableError('429 Resource Unavailable', null, false);
          const json = { items: [{ ref: 'a', heading: '', text: 'A' }] };
          return {
            kind: 'answered',
            text: JSON.stringify(json),
            json,
            usage: { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            tier: input.serviceTier === 'flex' ? 'flex' : 'default',
          };
        },
        submitBatch: async () => ({ id: 'x', inputFileId: null }),
        batchStatus: async () => {
          throw new Error('none');
        },
        batchResults: async () => [],
        cancelBatch: async () => {},
      }),
    });
    core.updateSettings({ spendLimitUsd: 100, modes: { [SOL]: 'flex' }, flexRetries: 2 });
    const sdb = openSummariesDb(path.join(makeTempDir('sum-flex'), 'summaries.db'));
    const runner = new AiRunner({
      db: sdb,
      core,
      source: 'summaries',
      featureOf: () => 'summaries',
      modelFor: modelForTask,
      sleep: async () => {},
    });
    const ev = {
      from: 'ja',
      to: 'en',
      title: 't',
      items: [{ ref: 'a', heading: null, text: 'あ' }],
    };
    const ask = async (key: string) => {
      runner.putItems(
        TRANSLATE_SPEC as never,
        [{ key, evidence: { ...ev, title: key }, labeled: false }],
        1,
      );
      runner.enqueue(TRANSLATE_SPEC, SOL, [key], 'r');
      for (let i = 0; i < 20 && !runner.answerOf(TRANSLATE_SPEC, SOL, key); i++) {
        await runner.step(TRANSLATE_SPEC as never, 'r', () => false);
        await runner.settle();
      }
      return sdb.prepare('SELECT cost_usd FROM ai_requests WHERE item_key = ?').get(key) as {
        cost_usd: number;
      };
    };
    // Answered with flex at once: the batch price ($1 per million input tokens).
    refusals = 0;
    expect((await ask('one')).cost_usd).toBeCloseTo(0.1, 6);
    expect(calls.map((c) => c.tier)).toEqual(['flex']);
    // Refused twice for capacity: tried again with flex; answered on the third.
    calls.length = 0;
    refusals = 2;
    expect((await ask('two')).cost_usd).toBeCloseTo(0.1, 6);
    expect(calls.map((c) => c.tier)).toEqual(['flex', 'flex', 'flex']);
    // Refused more than flexRetries times: the call goes at the normal price ($2).
    calls.length = 0;
    refusals = 5;
    expect((await ask('three')).cost_usd).toBeCloseTo(0.2, 6);
    expect(calls.map((c) => c.tier)).toEqual(['flex', 'flex', 'flex', undefined]);
    const modes = db
      .prepare(
        `SELECT mode, ROUND(cost_usd, 4) AS usd FROM ai_spend WHERE source = 'summaries' ORDER BY id`,
      )
      .all();
    expect(modes).toEqual([
      { mode: 'flex', usd: 0.1 },
      { mode: 'flex', usd: 0.1 },
      { mode: 'direct', usd: 0.2 },
    ]);
    // Refusals for capacity don't use up the question's tries.
    const tries = sdb
      .prepare(`SELECT attempts FROM ai_requests WHERE item_key = 'three'`)
      .get() as { attempts: number };
    expect(tries.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// session 4b

const autoSetting = (on: boolean) => ({
  kind: 'setting',
  id: 'global:summaryAutoOnFirstCompletion',
  data: { value: on ? '1' : '0' },
});

describe('session 4b: "Make a summary when a book is first completed"', () => {
  it('off: a first completion is marked and never makes one, not after switching on again or a restart', async () => {
    const e = setup();
    await register(e);
    await push(e, [autoSetting(false)]);
    await push(e, complete(e.books.solo));
    await drain(e);
    expect(jobs(e)).toHaveLength(0);
    expect(
      e.sdb
        .prepare('SELECT first_completion FROM summary_books WHERE book_id = ?')
        .get(e.books.solo),
    ).toEqual({ first_completion: 'skipped' });
    // Switched on again: the same book read again and completed, then a restart.
    await push(e, [autoSetting(true)]);
    await push(e, [{ kind: 'read-through', id: `${e.books.solo}:2`, data: finished(2) }]);
    await push(e, complete(e.books.solo, 3));
    e.restart();
    await drain(e);
    expect(jobs(e)).toHaveLength(0);
    expect(e.stand.calls).toHaveLength(0);
    // A book first completed while it is on gets one, as before.
    await push(e, complete(e.books.v1));
    expect(jobs(e)).toMatchObject([{ book_id: e.books.v1, kind: 'auto' }]);
    // By hand from the book page while it is off: still made.
    await push(e, [autoSetting(false)]);
    const r = await request(e.app).post(`/api/v1/summaries/${e.books.solo}/regenerate`).set(e.auth);
    expect(r.status).toBe(202);
    expect(jobs(e).map((j) => j.kind)).toEqual(['auto', 'regenerate']);
  });

  it('a completion made offline while it was off and undone in the same push stays without one', async () => {
    const e = setup();
    await register(e);
    // The device wrote the skip record when it completed the book (the switch off there), then
    // undid it; the server's switch is on.
    await push(e, [
      { kind: 'summary-skip', id: e.books.solo, data: {} },
      ...complete(e.books.solo),
      { kind: 'book-status', id: e.books.solo, data: { status: 'reading', auto: false } },
      { kind: 'read-through', id: `${e.books.solo}:1`, deletedAt: e.clock.t + 1000 },
    ]);
    // Later completed with the switch on: the skip record still holds.
    await push(e, complete(e.books.solo, 2));
    await drain(e);
    expect(jobs(e)).toHaveLength(0);
  });
});

const DESC = '<div><p>港町の灯台守。<br/>第三巻。</p><p>書き下ろし短編を収録。</p></div>';

async function drainDescriptions(e: Env, max = 200) {
  for (let i = 0; i < max; i++) {
    await e.svc.pass();
    await new Promise((r) => setTimeout(r, 5));
    const open = e.sdb
      .prepare(`SELECT COUNT(*) AS n FROM description_translations WHERE state = 'queued'`)
      .get() as { n: number };
    if (!open.n) return;
  }
}

describe('session 4b: book descriptions translated like summaries', () => {
  const descEnv = () => {
    const e = setup({
      before: (main, ids) =>
        main.prepare('UPDATE books SET description = ? WHERE id = ?').run(DESC, ids.solo),
    });
    // The translator is set to batches: a description is still one direct call.
    e.core.updateSettings({ modes: { [SONNET]: 'batch', [SOL]: 'direct', [OPUS]: 'direct' } });
    return e;
  };
  const descCalls = (e: Env) => e.stand.calls.filter((c) => c.schema === 'description');
  const record = (e: Env) =>
    e.sync.getRecord(listUsers(e.main)[0].id, 'book-summary', e.books.solo)?.data as
      | { descriptions?: Record<string, string> }
      | undefined;

  it('translated on first choice, paragraphs and lines kept, one direct call charged to summaries', async () => {
    const e = descEnv();
    await register(e);
    const url = `/api/v1/summaries/${e.books.solo}/description`;
    let r = await request(e.app).get(`${url}?lang=en`).set(e.auth);
    expect(r.body).toMatchObject({ bookLang: 'ja', source: DESC, lang: 'en', state: 'none' });
    r = await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'en' });
    expect(r.status).toBe(202);
    expect(r.body.state).toBe('queued');
    await drainDescriptions(e);
    r = await request(e.app).get(`${url}?lang=en`).set(e.auth);
    expect(r.body.state).toBe('done');
    expect(r.body.translation.paragraphs).toEqual([
      'EN 港町の灯台守。\nEN 第三巻。',
      'EN 書き下ろし短編を収録。',
    ]);
    expect(descCalls(e)).toHaveLength(1);
    expect(descCalls(e)[0].model).toBe(SONNET);
    const spend = e.main
      .prepare(`SELECT feature, stage, mode FROM ai_spend WHERE stage = 'sum.translate-desc'`)
      .all();
    expect(spend).toEqual([{ feature: 'summaries', stage: 'sum.translate-desc', mode: 'direct' }]);
    // Every device's record names it, so devices keep a copy.
    expect(Object.keys(record(e)?.descriptions ?? {})).toEqual(['en']);
    // Chosen again (another device): nothing asked.
    r = await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'en' });
    expect(r.status).toBe(200);
    expect(descCalls(e)).toHaveLength(1);
    // The original language, a bad code, a book without a description.
    r = await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'ja' });
    expect(r.body.error.code).toBe('original');
    r = await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'x y' });
    expect(r.status).toBe(400);
    r = await request(e.app)
      .post(`/api/v1/summaries/${e.books.v1}/description/translate`)
      .set(e.auth)
      .send({ lang: 'en' });
    expect(r.body.error.code).toBe('no_description');
  });

  it('a changed description: the old translation is never given, and it is translated again', async () => {
    const e = descEnv();
    await register(e);
    const url = `/api/v1/summaries/${e.books.solo}/description`;
    await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'en' });
    await drainDescriptions(e);
    // The cleanup changed it in Calibre; the ingest updated the catalog.
    e.main
      .prepare('UPDATE books SET description = ? WHERE id = ?')
      .run('<p>新しい紹介文。</p>', e.books.solo);
    let r = await request(e.app).get(`${url}?lang=en`).set(e.auth);
    expect(r.body).toMatchObject({ state: 'none', translation: null });
    // The sweep drops it from the record (devices drop their copy).
    e.svc.publishStale();
    expect(record(e)?.descriptions).toBeUndefined();
    r = await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'en' });
    expect(r.status).toBe(202);
    await drainDescriptions(e);
    r = await request(e.app).get(`${url}?lang=en`).set(e.auth);
    expect(r.body.translation.paragraphs).toEqual(['EN 新しい紹介文。']);
    expect(descCalls(e)).toHaveLength(2);
    expect(Object.keys(record(e)?.descriptions ?? {})).toEqual(['en']);
  });

  it('an answer that loses a line is asked once more, then fails with the reason', async () => {
    const e = descEnv();
    await register(e);
    const url = `/api/v1/summaries/${e.books.solo}/description`;
    e.stand.descBad = 1;
    await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'en' });
    await drainDescriptions(e);
    let r = await request(e.app).get(`${url}?lang=en`).set(e.auth);
    expect(r.body.state).toBe('done');
    expect(descCalls(e)).toHaveLength(2);
    // Into French: both answers lose a line.
    e.stand.descBad = 2;
    await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'fr' });
    await drainDescriptions(e);
    r = await request(e.app).get(`${url}?lang=fr`).set(e.auth);
    expect(r.body).toMatchObject({
      state: 'failed',
      error: 'the translation did not keep the paragraphs and lines',
      translation: null,
    });
    expect(Object.keys(record(e)?.descriptions ?? {})).toEqual(['en']);
    expect(descCalls(e)).toHaveLength(4);
  });

  it('a restart before the answer: asked once', async () => {
    const e = descEnv();
    await register(e);
    const url = `/api/v1/summaries/${e.books.solo}/description`;
    await request(e.app).post(`${url}/translate`).set(e.auth).send({ lang: 'en' });
    e.restart();
    await drainDescriptions(e);
    e.restart();
    await drainDescriptions(e);
    const r = await request(e.app).get(`${url}?lang=en`).set(e.auth);
    expect(r.body.state).toBe('done');
    expect(descCalls(e)).toHaveLength(1);
  });

  it('the server splits a description into paragraphs and lines as the book page does', async () => {
    // The same code as the web app's (its file can't be imported here without SvelteKit's
    // generated config): compared as text from the first line of code.
    const fs = await import('fs');
    const code = (p: string) => {
      const s = fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
      // The two packages' formatters differ only in trailing commas and line breaks.
      return s
        .slice(s.indexOf('const NAMED'))
        .replace(/,(\s*[)\]}])/g, '$1')
        .replace(/\s+/g, '');
    };
    expect(code('../src/summaries/description.ts')).toBe(
      code('../../web/src/lib/library/description.ts'),
    );
    const server = await import('../src/summaries/description');
    expect(server.descriptionParagraphs(DESC)).toEqual([
      '港町の灯台守。\n第三巻。',
      '書き下ろし短編を収録。',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// session 5: the series recap, "story so far"

/** The series 潮騒 with a third volume, every book with a catalog source (the series page's). */
function recapSetup(o: { route?: unknown } = {}): Env {
  return setup({
    ...o,
    before: (main, ids) => {
      const t0 = Date.UTC(2026, 10, 23, 12);
      const v3 = randomUUID();
      ids.v3 = v3;
      main
        .prepare(
          `INSERT INTO books (id, library_id, title, series_id, series_index, char_count, added_at, created_at, updated_at)
           VALUES (?, 'lib1', '潮騒のナギ 3', 1, 3, ?, ?, ?, ?)`,
        )
        .run(v3, BOOK.characters, t0, t0, t0);
      for (const id of Object.values(ids))
        main
          .prepare(
            `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, created_at, updated_at)
             VALUES (?, ?, 'calibre', 'lib1', ?, ?, ?)`,
          )
          .run(randomUUID(), id, randomUUID(), t0, t0);
    },
  });
}

const recapAuto = (on: boolean) => ({
  kind: 'setting',
  id: 'global:summaryRecapAuto',
  data: { value: on ? '1' : '0' },
});

const recapJobs = (e: Env) =>
  e.sdb
    .prepare('SELECT id, kind, state, reason, due_at, error FROM series_recap_jobs ORDER BY id')
    .all() as {
    id: number;
    kind: string;
    state: string;
    reason: string | null;
    due_at: number;
    error: string | null;
  }[];

/** Runs passes until no summary or recap job is open (or `max` passes). */
async function drainAll(e: Env, max = 400) {
  for (let i = 0; i < max; i++) {
    await e.svc.pass();
    await new Promise((r) => setTimeout(r, 10));
    const a = e.sdb
      .prepare(`SELECT COUNT(*) AS n FROM summary_jobs WHERE state IN ('queued', 'running')`)
      .get() as { n: number };
    const b = e.sdb
      .prepare(
        `SELECT COUNT(*) AS n FROM series_recap_jobs WHERE state = 'running' OR (state = 'queued' AND due_at <= ?)`,
      )
      .get(e.clock.t) as { n: number };
    if (!a.n && !b.n) return;
  }
}

const recapCalls = (e: Env) => e.stand.calls.filter((c) => c.schema === 'story_so_far');
const checkCalls = (e: Env) =>
  e.stand.calls.filter((c) => c.schema === 'verdicts' && c.user.includes('\nPOINT '));
const getRecap = async (e: Env, lang?: string) =>
  (
    await request(e.app)
      .get('/api/v1/summaries/series-recap')
      .query({ series: '潮騒', ...(lang ? { lang } : {}) })
      .set(e.auth)
      .expect(200)
  ).body;
const regenerate = (e: Env) =>
  request(e.app)
    .post('/api/v1/summaries/series-recap/regenerate')
    .set(e.auth)
    .send({ series: '潮騒' });

/** Volumes 1 and 2 completed and summarized; the recap after the quiet wait. */
async function twoVolumes(e: Env) {
  await register(e);
  await push(e, [...complete(e.books.v1), ...complete(e.books.v2)]);
  await drainAll(e);
  e.clock.t += 10 * 60_000;
  await drainAll(e);
}

describe('session 5: the series recap ("story so far")', () => {
  it('made after the quiet wait once two volumes have a summary; checked; the device record', async () => {
    const e = recapSetup();
    await register(e);
    await push(e, complete(e.books.v1));
    await drainAll(e);
    // One volume with a summary: nothing is made (at least two, user 2026-11-23).
    expect(recapJobs(e)).toHaveLength(0);
    await push(e, complete(e.books.v2));
    await drainAll(e);
    // The quiet wait: queued, not started.
    expect(recapJobs(e)).toMatchObject([{ kind: 'auto', state: 'queued', reason: 'summary made' }]);
    expect(recapCalls(e)).toHaveLength(0);
    e.clock.t += 10 * 60_000;
    await drainAll(e);
    expect(recapJobs(e)).toMatchObject([{ state: 'done' }]);
    // Written by the first setup's writer, checked by both of its reading models.
    expect(recapCalls(e).map((c) => c.model)).toEqual([OPUS]);
    expect(new Set(checkCalls(e).map((c) => c.model))).toEqual(new Set([SONNET, SOL]));
    const evidence = recapCalls(e)[0].user;
    expect(evidence).toContain('=== v1: Vol. 1 潮騒のナギ 1 ===');
    expect(evidence).toContain('v2:char0 [characters] カイト:');
    const body = await getRecap(e);
    const recap = body.recap;
    expect(recap.volumes.map((v: { label: string }) => v.label)).toEqual(['1', '2']);
    const sec = (k: string) =>
      recap.sections.find((s: { key: string }) => s.key === k)?.groups as
        | {
            volume?: { label: string };
            items: { heading?: string; text: string; since?: unknown }[];
          }[]
        | undefined;
    expect(sec('volumes')!.map((g) => [g.volume!.label, g.items.map((i) => i.text)])).toEqual([
      ['1', ['第1巻の出来事']],
      ['2', ['第2巻の出来事']],
    ]);
    // The invented name, the unknown cite and the unknown also-mentioned are left out.
    expect(sec('characters')![0].items.map((i) => i.heading)).toEqual(['カイト']);
    expect(sec('characters')![0].items[0].since).toEqual({
      label: '1',
      title: '潮騒のナギ 1',
      gap: false,
    });
    expect(sec('threads')![0].items[0].since).toMatchObject({ label: '2' });
    expect(sec('terms')).toBeUndefined();
    expect(recap.alsoMentioned).toEqual(['汐見ナギ']);
    expect(body.coverage).toMatchObject({ withSummary: 2, enough: true, stale: [] });
    // The sources of each point: the volume items it rests on.
    const char = e.sdb
      .prepare(`SELECT sources_json FROM series_recap_items WHERE section = 'characters'`)
      .get() as { sources_json: string };
    expect(JSON.parse(char.sources_json).map((s: { bookId: string }) => s.bookId)).toEqual([
      e.books.v2,
      e.books.v1,
    ]);
    // The device's record (written by the server; a device can't write it).
    const user = listUsers(e.main)[0].id;
    const rec = e.sync.getRecord(user, 'series-recap', '潮騒')!.data as {
      recap: { id: number; langs: Record<string, string> };
      making: unknown;
    };
    expect(rec.recap.id).toBe(recap.id);
    expect(Object.keys(rec.recap.langs)).toEqual(['ja']);
    expect(rec.making).toBeNull();
    const own = await push(e, [{ kind: 'series-recap', id: '潮騒', data: {} }]);
    expect(own[0]).toMatchObject({ status: 'rejected', error: { code: 'read_only' } });
    // Spending goes to the summaries feature.
    const spend = e.main
      .prepare(
        `SELECT DISTINCT feature FROM ai_spend WHERE stage IN ('sum.recap', 'sum.recap-check')`,
      )
      .all();
    expect(spend).toEqual([{ feature: 'summaries' }]);
  });

  it('edits: one rebuild after the quiet wait; nothing asked when nothing changed; Start over never', async () => {
    const e = recapSetup();
    await twoVolumes(e);
    const writes = recapCalls(e).length;
    const m = e.svc.store.currentMeta(e.books.v1)!;
    const items = e.svc.store.items(m.id).filter((i) => i.section === 'chapters');
    // Two edits a minute apart: the wait moves on with each.
    for (const [i, it] of items.slice(0, 2).entries()) {
      await request(e.app)
        .put(`/api/v1/summaries/${e.books.v1}/items/${it.id}`)
        .set(e.auth)
        .send({ text: `直した ${i}` })
        .expect(200);
      e.clock.t += 60_000;
      await drainAll(e);
    }
    expect(recapCalls(e)).toHaveLength(writes);
    e.clock.t += 10 * 60_000;
    await drainAll(e);
    expect(recapCalls(e)).toHaveLength(writes + 1);
    expect(recapJobs(e).filter((j) => j.state === 'done')).toHaveLength(2);
    // A Start over of volume 2 (a new open read-through, status unread): nothing.
    await push(e, [
      { kind: 'book-status', id: e.books.v2, data: { status: 'unread', auto: false } },
      {
        kind: 'read-through',
        id: `${e.books.v2}:2`,
        data: { ...finished(2), origin: 'start-over', finished: false, finishedOn: null },
      },
    ]);
    e.clock.t += 20 * 60_000;
    await drainAll(e);
    expect(recapJobs(e)).toHaveLength(2);
    expect(e.svc.recaps.coverage('潮騒').volumes).toHaveLength(2);
    // A job whose inputs didn't change asks nothing.
    e.svc.recaps.schedule('潮騒', 'test');
    e.clock.t += 20 * 60_000;
    await drainAll(e);
    expect(recapJobs(e)[2]).toMatchObject({ state: 'done' });
    expect(recapCalls(e)).toHaveLength(writes + 1);
  });

  it('automatic updates off: no trigger rebuilds, the note says what is not in it yet; Regenerate does', async () => {
    const e = recapSetup();
    await twoVolumes(e);
    const writes = recapCalls(e).length;
    await push(e, [recapAuto(false), autoSetting(false)]);
    // An edit, and volume 3 completed (no summary: automatic summaries are off too).
    const m = e.svc.store.currentMeta(e.books.v2)!;
    const it = e.svc.store.items(m.id).find((i) => i.section === 'chapters')!;
    await request(e.app)
      .put(`/api/v1/summaries/${e.books.v2}/items/${it.id}`)
      .set(e.auth)
      .send({ text: '直した' })
      .expect(200);
    await push(e, complete(e.books.v3));
    e.clock.t += 30 * 60_000;
    await drainAll(e);
    e.svc.publishStale();
    await drainAll(e);
    expect(recapCalls(e)).toHaveLength(writes);
    const got = await getRecap(e);
    expect(got.auto).toBe(false);
    expect(got.coverage.volumes.map((v: { hasSummary: boolean }) => v.hasSummary)).toEqual([
      true,
      true,
      false,
    ]);
    expect(got.coverage.stale).toEqual([
      { bookId: e.books.v2, label: '2', title: '潮騒のナギ 2', why: 'changed' },
      { bookId: e.books.v3, label: '3', title: '潮騒のナギ 3', why: 'not_in_recap' },
    ]);
    // Switching on again rebuilds nothing by itself.
    await push(e, [recapAuto(true)]);
    await drainAll(e);
    expect(recapJobs(e).filter((j) => j.state === 'queued')).toHaveLength(0);
    await push(e, [recapAuto(false)]);
    // Regenerate: at once, also while off; volume 3 named as having no summary.
    expect((await regenerate(e)).status).toBe(202);
    await drainAll(e);
    expect(recapCalls(e)).toHaveLength(writes + 1);
    expect(recapCalls(e).at(-1)!.user).toContain('VOLUMES WITHOUT A SUMMARY');
    expect(recapCalls(e).at(-1)!.user).toContain('v3: Vol. 3 潮騒のナギ 3');
    const after = await getRecap(e);
    expect(after.coverage.stale).toEqual([]);
    const vols = after.recap.sections.find((s: { key: string }) => s.key === 'volumes').groups;
    expect(vols.map((g: { volume: { missing: boolean } }) => g.volume.missing)).toEqual([
      false,
      false,
      true,
    ]);
    // Regenerate again with nothing changed: asked again (a new generation).
    expect((await regenerate(e)).status).toBe(202);
    await drainAll(e);
    expect(recapCalls(e)).toHaveLength(writes + 2);
  });

  it('Regenerate needs two volumes with a summary; a deleted summary takes the recap away', async () => {
    const e = recapSetup();
    await register(e);
    await push(e, complete(e.books.v1));
    await drainAll(e);
    const r = await regenerate(e);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('too_few');
    await push(e, complete(e.books.v2));
    await drainAll(e);
    e.clock.t += 10 * 60_000;
    await drainAll(e);
    expect(e.svc.recaps.store.current('潮騒')).not.toBeNull();
    await request(e.app).delete(`/api/v1/summaries/${e.books.v1}`).set(e.auth).expect(204);
    e.clock.t += 10 * 60_000;
    await drainAll(e);
    expect(e.svc.recaps.store.current('潮騒')).toBeNull();
    expect(recapJobs(e).at(-1)).toMatchObject({ state: 'cancelled' });
  });

  it('the route: a refusing writer moves on; a rejected point is left out; every setup failing alerts once', async () => {
    const e = recapSetup();
    e.stand.refuse.add(`${OPUS}|story_so_far`);
    e.stand.rejectPoints = new Set(['thread0']);
    e.stand.dropVerdict = 1;
    await twoVolumes(e);
    expect(recapCalls(e).map((c) => c.model)).toEqual([OPUS, SONNET]);
    const m = e.svc.recaps.store.current('潮騒')!;
    expect(m.setup).toBe('two');
    const v = e.svc.recaps.store.view(m.id)!;
    expect(v.sections.find((s) => s.key === 'threads')).toBeUndefined();
    expect(v.sections.find((s) => s.key === 'overview')).toBeDefined();
    // The verdict left out was asked again on its own.
    const again = checkCalls(e).filter((c) => (c.user.match(/^POINT /gm) ?? []).length === 1);
    expect(again.length).toBeGreaterThanOrEqual(1);
    // Every writer refusing: the note and one alert.
    e.stand.refuse.add(`${SONNET}|story_so_far`);
    expect((await regenerate(e)).status).toBe(202);
    await drainAll(e);
    expect(recapJobs(e).at(-1)).toMatchObject({ state: 'failed' });
    const user = listUsers(e.main)[0].id;
    const rec = e.sync.getRecord(user, 'series-recap', '潮騒')!.data as {
      outcome: string;
      note: string;
      recap: unknown;
    };
    expect(rec.outcome).toBe('failed');
    // In plain words, each failure once (review of the states, 2026-11-24).
    expect(rec.note).toBe(
      'Every setup failed.\nClaude Opus 5.5 and Claude Sonnet 5.5 refused to write the story so far.',
    );
    // The recap made before stays.
    expect(rec.recap).not.toBeNull();
    expect(e.alerts.filter((a) => a.lines[0].includes('story so far'))).toHaveLength(1);
  });

  it('a language: translated point by point with the original in brackets; again after a rebuild', async () => {
    const e = recapSetup();
    await twoVolumes(e);
    await request(e.app)
      .post('/api/v1/summaries/series-recap/translate')
      .set(e.auth)
      .send({ series: '潮騒', lang: 'en' })
      .expect(202);
    await drainAll(e);
    const en = (await getRecap(e, 'en')).recap;
    expect(en.viewLang).toBe('en');
    expect(en.untranslated).toEqual([]);
    const char = en.sections.find((s: { key: string }) => s.key === 'characters').groups[0]
      .items[0];
    expect(char).toMatchObject({ heading: 'EN カイト (カイト)', text: 'EN 一族の最後の一人。' });
    expect(char.ruby).toBeUndefined();
    // A rebuild: the saved language is translated again by itself (the same points: answered
    // from the stored translation, nothing asked again).
    const before = e.stand.calls.filter((c) => c.schema === 'translation').length;
    const oldId = en.id;
    expect((await regenerate(e)).status).toBe(202);
    await drainAll(e);
    const en2 = (await getRecap(e, 'en')).recap;
    expect(en2.id).not.toBe(oldId);
    expect(en2.untranslated).toEqual([]);
    expect(e.stand.calls.filter((c) => c.schema === 'translation').length).toBe(before);
    // A rebuild that writes one point differently: only that point is asked.
    e.stand.recapOverview = '（改）';
    expect((await regenerate(e)).status).toBe(202);
    await drainAll(e);
    expect((await getRecap(e, 'en')).recap.untranslated).toEqual([]);
    const last = e.stand.calls.filter((c) => c.schema === 'translation');
    expect(last.length).toBe(before + 1);
    expect(
      [...last.at(-1)!.user.matchAll(/^(\S+)(?: HEADING: .*)?\nTEXT:/gm)].map((m) => m[1]),
    ).toEqual(['overview']);
    const user = listUsers(e.main)[0].id;
    const rec = e.sync.getRecord(user, 'series-recap', '潮騒')!.data as {
      recap: { langs: Record<string, string> };
    };
    expect(Object.keys(rec.recap.langs)).toEqual(['ja', 'en']);
  });

  it('the series changing (order, an undone completion) rebuilds at the 10-minute check', async () => {
    const e = recapSetup();
    await twoVolumes(e);
    const writes = recapCalls(e).length;
    // Calibre gives volume 1 another number: the order changes.
    e.main.prepare('UPDATE books SET series_index = 2.5 WHERE id = ?').run(e.books.v1);
    expect(e.svc.recaps.coverage('潮騒').volumes.map((v) => v.label)).toEqual(['2', '2.5']);
    e.svc.publishStale();
    expect(recapJobs(e).at(-1)).toMatchObject({ state: 'queued', reason: 'series changed' });
    e.clock.t += 10 * 60_000;
    await drainAll(e);
    expect(recapCalls(e)).toHaveLength(writes + 1);
    // Volume 2.5's completion undone: coverage ends at volume 2, fewer than two: the recap goes.
    await push(e, [
      { kind: 'read-through', id: `${e.books.v1}:1`, deletedAt: e.clock.t + 1000 },
      { kind: 'book-status', id: e.books.v1, data: { status: 'reading', auto: false } },
    ]);
    expect(e.svc.recaps.coverage('潮騒').volumes.map((v) => v.label)).toEqual(['2']);
    e.clock.t += 10 * 60_000;
    await drainAll(e);
    expect(e.svc.recaps.store.current('潮騒')).toBeNull();
  });

  it('cli summaries recaps: the plan; --apply has the server make the missing ones', async () => {
    const e = recapSetup();
    await register(e);
    await push(e, [recapAuto(false)]);
    await push(e, [...complete(e.books.v1), ...complete(e.books.v2)]);
    await drainAll(e);
    expect(e.svc.recaps.store.current('潮騒')).toBeNull();
    const plan = e.svc.recaps.plan();
    expect(plan).toMatchObject([{ series: '潮騒', volumes: 2, has: false }]);
    expect(plan[0].characters).toBeGreaterThan(50);
    e.sdb
      .prepare('INSERT INTO summary_state (key, value) VALUES (?, ?)')
      .run('recaps_requested', JSON.stringify(['潮騒']));
    await drainAll(e);
    expect(e.svc.recaps.store.current('潮騒')).not.toBeNull();
  });

  it('the coverage query uses the sync records index', () => {
    const e = recapSetup();
    const plan = e.main
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM sync_records WHERE user_id IN (SELECT id FROM users)
           AND book_id = ? AND kind IN ('read-through', 'book-status') AND deleted_at IS NULL`,
      )
      .all('x') as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/USING INDEX sync_records_book/);
  });
});

describe('review of the states (2026-11-24)', () => {
  it('a wait in plain words for the book page, without the provider error', async () => {
    const { plainWait } = await import('../src/summaries/service');
    expect(
      plainWait({
        kind: 'provider_busy',
        provider: 'anthropic',
        until: 0,
        error: '529 {"type":"error"}',
      }),
    ).toBe('Anthropic is busy, trying again soon');
    expect(plainWait({ kind: 'auth_failed', provider: 'openai', error: '401 bad key' })).toBe(
      'OpenAI refused the API key (Settings › AI)',
    );
  });
});

describe('review of the states: a failed setup in plain words (2026-11-24)', () => {
  it('names the models and the step, each failure once', async () => {
    const { plainFailure, failureLines } = await import('../src/summaries/service');
    const { Refused, Unusable } = await import('../src/summaries/engine');
    const h = { abandoned: false, wait: null };
    const busy = {
      abandoned: true,
      wait: { kind: 'provider_busy' as const, provider: 'openai' as const, until: 0, error: 'x' },
    };
    expect(
      failureLines([
        plainFailure(new Refused('sum.write', OPUS), h, 60),
        plainFailure(new Unusable('sum.support', SOL, 'invalid'), h, 60),
        plainFailure(new Refused('sum.write', SONNET), h, 60),
        plainFailure(new Error('stopped'), busy, 60),
      ]),
    ).toEqual([
      'Claude Opus 5.5 and Claude Sonnet 5.5 refused to write the summary.',
      'GPT-6.1 Sol gave no usable answer when asked to check the notes.',
      'Nothing could be sent for 60 min: OpenAI is busy, trying again soon.',
    ]);
  });
});
