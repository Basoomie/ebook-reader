/**
 * Book summaries session 2: the engine. Quotes found in the reader's own text at the reader's
 * positions; the quote check, chapter coverage, the cross-check, the writer's checks and the
 * translation; both cloud setups through the shared AI layer with a stand-in provider; a run
 * stopped mid-way and started again asks nothing twice and gives the same summary; the test's
 * spending cap only waits; the new request options leave the cleanup's requests unchanged.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallInput, CallResult, ProviderClient } from '../src/ai/providers';
import { AiRunner } from '../src/ai/runner';
import { readBookScript, type BookScript } from '../src/audio/book-script';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import {
  bookTextFromScript,
  isCountedChar,
  passageAt,
  QuoteIndex,
} from '../src/summaries/book-text';
import {
  askedMetrics,
  backgroundText,
  Pump,
  runCloudSetup,
  translate,
  type Asked,
  type BookInput,
} from '../src/summaries/engine';
import {
  applyTranslation,
  checkExtraction,
  checkWritten,
  cleanPairs,
  crossChecked,
  emptyChapters,
} from '../src/summaries/pipeline';
import { modelForTask, MODELS } from '../src/summaries/specs';
import { openSummariesDb } from '../src/summaries/summaries-db';
import type { CheckedItem } from '../src/summaries/types';
import { makeAiCore } from './helpers/ai-env';
import { write } from './helpers/audio-fixtures';
import { makeZip } from './helpers/epub-fixture';
import { makeTempDir } from './helpers/spawn-server';

// ---------------------------------------------------------------------------------------------
// a small book script (positions as the reader counts them)

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
  { title: 'あとがき', paragraphs: [['お読みいただきありがとうございました。']] },
]);

describe('the book text and the quote check', () => {
  it('finds a quote whole at its reader position, ignoring width, spaces and punctuation', () => {
    const idx = new QuoteIndex(BOOK);
    const hit = idx.find('カイトという少年が浜に倒れていた');
    // "ある夜、" before it: 3 counted characters (the comma isn't counted).
    const s = BOOK.chapters[0].sentences[2];
    expect(hit).toEqual({ position: s.position + 3, chapter: 0 });
    // Full-width / half-width, an added space, missing punctuation: still found.
    expect(idx.find('カイト という少年が浜に倒れていた。')).toEqual(hit);
    // Across a sentence end (one continuous passage).
    expect(idx.find('守ると決めた。二人は灯台へ')).toMatchObject({ chapter: 1 });
    // Not in the book, or too short to be evidence.
    expect(idx.find('カイトは海に帰っていった')).toBeNull();
    expect(idx.find('ナギ')).toBeNull();
    // Names: any length.
    expect(idx.hasName('汐見ナギ')).toBe(true);
    expect(idx.hasName('汐見 ナギ')).toBe(true);
    expect(idx.hasName('ミナト')).toBe(false);
  });

  it('prefers the chapter the model gave when a quote appears twice', () => {
    const s = scriptOf([
      { title: 'a', paragraphs: [['同じ言葉がここにある。']] },
      { title: 'b', paragraphs: [['同じ言葉がここにある。']] },
    ]);
    const idx = new QuoteIndex(s);
    expect(idx.find('同じ言葉がここにある', 1)?.chapter).toBe(1);
    expect(idx.find('同じ言葉がここにある')?.chapter).toBe(0);
  });

  it('a passage is the text around the position', () => {
    const book = bookTextFromScript(BOOK);
    const idx = new QuoteIndex(BOOK);
    const hit = idx.find('最後の一人だと明かした')!;
    expect(passageAt(book, hit.position, 10)).toContain('最後の一人');
  });

  it('reads the real reader import (an EPUB with ruby) with positions that agree with it', async () => {
    const dir = makeTempDir('sum-epub');
    const xhtml = (body: string) =>
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
    const epub = makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      {
        name: 'META-INF/container.xml',
        data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'OEBPS/content.opf',
        data: `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>試験</dc:title><dc:identifier id="id">x</dc:identifier></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
      },
      {
        name: 'OEBPS/nav.xhtml',
        data: xhtml(
          '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="c1.xhtml">一章</a></li><li><a href="c2.xhtml">二章</a></li></ol></nav>',
        ),
      },
      {
        name: 'OEBPS/c1.xhtml',
        data: xhtml(
          '<p><ruby>汐見<rt>しおみ</rt></ruby>ナギは、ＡＢＣの港で<ruby>潮呪<rt>ちょうじゅ</rt></ruby>を知った。カイトは黙っていた！</p><p>二人は歩き出した。</p>',
        ),
      },
      { name: 'OEBPS/c2.xhtml', data: xhtml('<p>灯台の光が、遠くで揺れていた。</p>') },
    ]);
    const file = write(dir, 'book.epub', epub);
    expect(fs.existsSync(COUNTER_BUNDLE)).toBe(true);
    const script = await readBookScript(file, {
      importOptions: { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true },
      maxSentence: 120,
      timeoutMs: 120_000,
    });
    // Each sentence starts where the one before it ends, counted as the reader counts.
    const flat = script.chapters.flatMap((c) => c.sentences);
    for (let i = 0; i + 1 < flat.length; i++) {
      const counted = [...flat[i].text].filter(isCountedChar).length;
      expect(flat[i].position + counted).toBe(flat[i + 1].position);
    }
    const book = bookTextFromScript(script);
    expect(book.chapters[0].text).toContain('汐見ナギは'); // ruby base only, no furigana
    expect(book.chapters[0].text).not.toContain('しおみ');
    const idx = new QuoteIndex(script);
    const s0 = script.chapters[0].sentences[0];
    // "ＡＢＣの港で…" starts after 汐見ナギは、 (5 counted characters; furigana not counted).
    expect(idx.find('abcの港で潮呪を知った')).toEqual({ position: s0.position + 5, chapter: 0 });
    expect(idx.find('灯台の光が遠くで揺れていた')?.chapter).toBe(1);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// the pure checks

function item(id: string, chapter: number, text: string, quote: string, pos = 0): CheckedItem {
  return { id, model: 'm', chapter, kind: 'event', text, quote, names: [], position: pos };
}

describe('the checks between the steps', () => {
  it('drops and counts quotes not in the book; finds chapters left empty; follow-ups fill them', () => {
    const book = bookTextFromScript(BOOK);
    const idx = new QuoteIndex(BOOK);
    const whole = {
      chapters: [
        {
          chapter: 0,
          not_story: false,
          items: [
            {
              kind: 'event' as const,
              text: 'カイトが浜に倒れていた',
              quote: 'カイトという少年が浜に倒れていた',
              names: ['カイト', 'ミナト'],
            },
            {
              kind: 'event' as const,
              text: '別の巻の出来事',
              quote: 'カイトは王都で剣を抜いた',
              names: [],
            },
          ],
        },
      ],
    };
    expect(emptyChapters(book, whole)).toEqual([1, 2]);
    const follow = new Map([
      [
        1,
        {
          not_story: false,
          items: [
            {
              kind: 'reveal' as const,
              text: 'カイトは一族の最後',
              quote: '潮呪を受けた一族の最後の一人',
              names: [],
            },
          ],
        },
      ],
      [2, { not_story: true, items: [] }],
    ]);
    const c = checkExtraction('sonnet', MODELS.sonnet, book, idx, whole, follow);
    expect(c.extracted).toBe(3);
    expect(c.quoteNotFound).toBe(1);
    expect(c.items.map((x) => x.id)).toEqual(['sonnet:0:0', 'sonnet:1:0']);
    expect(c.items[0].names).toEqual(['カイト']); // a name not in the book is left off
    expect(c.notStory).toEqual([2]);
  });

  it('pairs are one-to-one between existing items; single items need a supported verdict', () => {
    const A = [item('a1', 0, 'x', 'q'), item('a2', 0, 'y', 'q'), item('a3', 1, 'z', 'q')];
    const B = [item('b1', 0, 'x', 'q'), item('b2', 1, 'w', 'q')];
    const pairs = cleanPairs(
      [
        { a: 'a1', b: 'b1' },
        { a: 'a2', b: 'b1' }, // b1 already used
        { a: 'zz', b: 'b2' }, // no such item
      ],
      A,
      B,
    );
    expect(pairs).toEqual([{ a: 'a1', b: 'b1' }]);
    const c = crossChecked(
      A,
      B,
      pairs,
      new Map([
        ['a2', 'supported'],
        ['a3', 'partly'],
        ['b2', 'not_supported'],
      ]),
    );
    expect(c.items.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(c).toMatchObject({
      confirmed: 1,
      checked: 3,
      supported: 1,
      partly: 1,
      notSupported: 1,
      noVerdict: 0,
    });
  });

  it('the written summary: cites must exist, quotes come from a cited item, names must be in the book', () => {
    const book = bookTextFromScript(BOOK);
    const idx = new QuoteIndex(BOOK);
    const items = [
      item('s:0:0', 0, 'カイトが浜に倒れていた', 'カイトという少年が浜に倒れていた', 30),
    ];
    const w = {
      overview: { text: 'ナギとカイトの物語。', cites: ['s:0:0', 'nope'] },
      chapters: [
        {
          chapter: 0,
          items: [
            {
              text: 'ナギはカイトを見つける。',
              cites: ['s:0:0'],
              quote_from: 's:0:0',
              show_quote: true,
            },
          ],
        },
        {
          chapter: 1,
          items: [{ text: '根拠のない話。', cites: ['nope'], quote_from: '', show_quote: false }],
        },
      ],
      characters: [
        {
          name: 'カイト',
          text: '浜に倒れていた少年。',
          cites: ['s:0:0'],
          quote_from: 'other',
          show_quote: true,
        },
        {
          name: 'ミナト',
          text: '前の巻の人物。',
          cites: ['s:0:0'],
          quote_from: '',
          show_quote: false,
        },
      ],
      also_mentioned: ['汐見ナギ', '王都の騎士'],
      relationships: [],
      terms: [],
      threads: [],
    };
    const r = checkWritten(w, items, book, idx, {
      lang: 'ja',
      title: 't',
      models: ['m'],
      madeAt: 1,
    });
    const keys = r.summary.sections.map((s) => s.key);
    expect(keys).toEqual(['overview', 'chapters', 'characters']);
    const ch = r.summary.sections[1].groups;
    expect(ch).toHaveLength(1);
    expect(ch[0].items[0]).toMatchObject({
      quote: 'カイトという少年が浜に倒れていた',
      position: 30,
      showQuote: true,
    });
    const chars = r.summary.sections[2].groups[0].items;
    expect(chars).toHaveLength(1);
    // quote_from not among its cites: no quote shown.
    expect(chars[0]).toMatchObject({ heading: 'カイト', quote: null, showQuote: false });
    expect(r.summary.alsoMentioned).toEqual(['汐見ナギ']);
    expect(r.dropped).toBe(3);
  });

  it('a translation keeps the quotes and puts the original in brackets in Characters and Terms headings', () => {
    const s = {
      lang: 'ja',
      bookTitle: 't',
      models: ['m'],
      madeAt: 1,
      alsoMentioned: [],
      sections: [
        {
          key: 'characters' as const,
          groups: [
            {
              items: [
                {
                  ref: 'char0',
                  heading: '汐見ナギ',
                  text: '港町の少女。',
                  cites: ['x'],
                  quote: '汐見ナギは港町に住む少女だった',
                  position: 0,
                  showQuote: true,
                },
              ],
            },
          ],
        },
        {
          key: 'terms' as const,
          groups: [
            {
              items: [
                {
                  ref: 'term0',
                  heading: '潮呪',
                  text: '一族の呪い。',
                  cites: ['x'],
                  quote: null,
                  position: null,
                  showQuote: false,
                },
              ],
            },
          ],
        },
        {
          key: 'relationships' as const,
          groups: [
            {
              items: [
                {
                  ref: 'rel0',
                  between: ['汐見ナギ', 'カイト'] as [string, string],
                  text: '守る。',
                  cites: ['x'],
                  quote: null,
                  position: null,
                  showQuote: false,
                },
              ],
            },
          ],
        },
      ],
    };
    const t = applyTranslation(s, 'en', [
      { ref: 'char0', heading: 'Nagi Shiomi', text: 'A girl of the port town.' },
      { ref: 'term0', heading: 'Chōju', text: "The clan's curse." },
      { ref: 'rel0', heading: 'Nagi Shiomi / Kaito', text: 'She protects him.' },
    ]);
    expect(t.missing).toEqual([]);
    const [c, term, rel] = t.summary.sections.map((x) => x.groups[0].items[0]);
    expect(c).toMatchObject({
      heading: 'Nagi Shiomi (汐見ナギ)',
      text: 'A girl of the port town.',
      quote: '汐見ナギは港町に住む少女だった',
    });
    expect(term.heading).toBe('Chōju (潮呪)');
    expect(rel).toMatchObject({ between: ['Nagi Shiomi', 'Kaito'], heading: undefined });
  });
});

// ---------------------------------------------------------------------------------------------
// both setups through the shared layer, with a stand-in provider

interface Log {
  calls: { model: string; schema: string; user: string; opts: Partial<CallInput> }[];
}

/** Answers each step from the prompt, as a careful model would (plus one invented quote). */
function standIn(
  log: Log,
  refuse: { model?: string; schema?: string } = {},
): (p: 'anthropic' | 'openai') => ProviderClient {
  const answer = (input: CallInput): unknown => {
    const name = input.schema?.name ?? '';
    const u = input.user;
    if (name === 'chapter_items' && u.includes('=== Chapter 0')) {
      const sol = input.model === MODELS.sol;
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
              ...(sol
                ? [
                    {
                      kind: 'term',
                      text: '潮呪という言葉が出る',
                      quote: '潮呪（ちょうじゅ）なんて信じない',
                      names: [],
                    },
                  ]
                : [
                    {
                      kind: 'event',
                      text: '別の本の話',
                      quote: 'この文はどこにもない文章です',
                      names: [],
                    },
                  ]),
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
          // chapter 2 left out: asked again
        ],
      };
    }
    if (name === 'chapter_items') return { not_story: true, items: [] };
    if (name === 'pairs') {
      const a = /^(\S+) \[ch 0\] カイトが浜/m.exec(u.split('LIST B:')[0])?.[1];
      const b = /^(\S+) \[ch 0\] カイトが浜/m.exec(u.split('LIST B:')[1])?.[1];
      const a2 = /^(\S+) \[ch 1\]/m.exec(u.split('LIST B:')[0])?.[1];
      const b2 = /^(\S+) \[ch 1\]/m.exec(u.split('LIST B:')[1])?.[1];
      return {
        pairs: [
          { a, b },
          { a: a2, b: b2 },
        ],
      };
    }
    if (name === 'verdicts') {
      const ids = [...u.matchAll(/^CLAIM (\S+):/gm)].map((m) => m[1]);
      return { verdicts: ids.map((id) => ({ id, verdict: 'supported' })) };
    }
    if (name === 'summary') {
      const ids = [...u.matchAll(/^(\S+) \[ch (\d+)/gm)].map((m) => ({
        id: m[1],
        ch: Number(m[2]),
      }));
      return {
        overview: { text: 'ナギとカイトの物語。', cites: ids.map((x) => x.id) },
        chapters: [0, 1].map((c) => ({
          chapter: c,
          items: ids
            .filter((x) => x.ch === c)
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
        also_mentioned: [],
        relationships: [
          {
            a: '汐見ナギ',
            b: 'カイト',
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
      const refs = [...u.matchAll(/^(\S+)(?: HEADING: (.*))?\nTEXT: (.*)$/gm)];
      return {
        items: refs.map((m) => ({
          ref: m[1],
          heading: m[2] ? `EN ${m[2]}` : '',
          text: `EN ${m[3]}`,
        })),
      };
    }
    throw new Error(`unexpected ${name}`);
  };
  return (provider) => ({
    provider,
    listModels: async () => Object.values(MODELS),
    call: async (input): Promise<CallResult> => {
      log.calls.push({
        model: input.model,
        schema: input.schema?.name ?? '',
        user: input.user,
        opts: {
          effort: input.effort,
          stream: input.stream,
          outputLimit: input.outputLimit,
          maxTokens: input.maxTokens,
        },
      });
      const usage = { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 };
      if (refuse.model === input.model && (!refuse.schema || refuse.schema === input.schema?.name))
        return { kind: 'blocked', detail: 'refusal', text: null, usage };
      const json = answer(input);
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

function env(
  log: Log,
  opts: { refuse?: { model?: string; schema?: string }; limit?: number } = {},
) {
  const { core } = makeAiCore({
    keys: { read: () => 'key' },
    providers: standIn(log, opts.refuse),
  });
  core.registerFeature('summaries', 'Book summaries');
  core.updateSettings({
    spendLimitUsd: opts.limit ?? 30,
    modes: Object.fromEntries(Object.values(MODELS).map((m) => [m, 'direct'])),
  });
  const db = openSummariesDb(path.join(makeTempDir('sum-db'), 'summaries.db'));
  const runner = new AiRunner({
    db,
    core,
    source: 'summaries',
    featureOf: () => 'summaries',
    modelFor: modelForTask,
    sleep: async () => {},
  });
  return { core, db, runner };
}

const INPUT: BookInput = {
  key: 'nagi1',
  title: '潮騒のナギ',
  script: BOOK,
  lang: 'ja',
  background: null,
};

let pumps: Pump[] = [];
afterEach(() => {
  for (const p of pumps) p.stop();
  pumps = [];
});
function pumpOf(runner: AiRunner, runId = 'r1') {
  const p = new Pump(runner, runId, undefined, 5);
  pumps.push(p);
  p.start();
  return p;
}

describe('the setups through the shared layer', () => {
  it('two models: both extract, invented quotes dropped, pairs confirmed, singles checked by the other model, written by Sonnet', async () => {
    const log: Log = { calls: [] };
    const { runner, db } = env(log);
    const asked: Asked[] = [];
    const pump = pumpOf(runner);
    const { summary, report } = await runCloudSetup(
      { runner, pump, runId: 'r1', onAsk: (a) => asked.push(a) },
      INPUT,
      'two',
    );
    expect(report.extracted.sonnet.quoteNotFound).toBe(1);
    expect(report.extracted.sol.quoteNotFound).toBe(0);
    expect(report.extracted.sonnet.notStory).toEqual([2]);
    expect(report.cross).toMatchObject({ confirmed: 2, checked: 1, supported: 1 });
    // Sol's single item (the term) was checked by Sonnet.
    const support = log.calls.filter((c) => c.schema === 'verdicts');
    expect(support.map((c) => c.model)).toEqual([MODELS.sonnet]);
    expect(support[0].user).toContain('sol:0:1');
    expect(log.calls.find((c) => c.schema === 'summary')?.model).toBe(MODELS.sonnet);
    expect(summary.sections.map((s) => s.key)).toEqual([
      'overview',
      'chapters',
      'characters',
      'relationships',
    ]);
    expect(summary.models).toEqual([MODELS.sonnet, MODELS.sol]);
    // Every request: effort high, streamed, its own output limit.
    for (const c of log.calls) expect(c.opts).toMatchObject({ effort: 'high', stream: true });
    expect(log.calls.find((c) => c.schema === 'summary')?.opts.outputLimit).toBe(64_000);
    const m = askedMetrics(db, asked);
    expect(m.requests).toBe(log.calls.length);
    expect(m.costUsd).toBeGreaterThan(0);
  });

  it('Opus alone checks every one of its own items, and writes', async () => {
    const log: Log = { calls: [] };
    const { runner } = env(log);
    const pump = pumpOf(runner);
    const { report } = await runCloudSetup({ runner, pump, runId: 'r1' }, INPUT, 'opus');
    expect(new Set(log.calls.map((c) => c.model))).toEqual(new Set([MODELS.opus]));
    expect(report.cross).toMatchObject({ confirmed: 0, checked: 2, supported: 2 });
  });

  it('a refusal is recorded and final; the other model goes on alone and checks its own items', async () => {
    const log: Log = { calls: [] };
    const { runner } = env(log, { refuse: { model: MODELS.sol, schema: 'chapter_items' } });
    const pump = pumpOf(runner);
    const { report, summary } = await runCloudSetup({ runner, pump, runId: 'r1' }, INPUT, 'two');
    expect(report.refusals).toEqual([{ stage: 'sum.extract', model: MODELS.sol }]);
    expect(summary.models).toEqual([MODELS.sonnet]);
    const solCalls = log.calls.filter((c) => c.model === MODELS.sol).length;
    // Asked again: the refusal is answered from the store, not sent.
    await runCloudSetup({ runner, pump, runId: 'r1' }, INPUT, 'two');
    expect(log.calls.filter((c) => c.model === MODELS.sol).length).toBe(solCalls);
  });

  it('a run stopped mid-way and started again asks nothing twice and gives the same summary', async () => {
    const full: Log = { calls: [] };
    const a = env(full);
    const ref = await runCloudSetup(
      { runner: a.runner, pump: pumpOf(a.runner), runId: 'r1' },
      INPUT,
      'two',
      () => 1,
    );

    const log: Log = { calls: [] };
    const b = env(log);
    const p1 = pumpOf(b.runner);
    // Stop as soon as the first match question was answered.
    const run1 = runCloudSetup({ runner: b.runner, pump: p1, runId: 'r1' }, INPUT, 'two', () => 1);
    for (let i = 0; i < 2000 && !log.calls.some((c) => c.schema === 'pairs'); i++)
      await new Promise((r) => setTimeout(r, 5));
    p1.stop();
    await expect(run1).rejects.toThrow();
    const before = log.calls.length;
    expect(before).toBeLessThan(full.calls.length);
    const again = await runCloudSetup(
      { runner: b.runner, pump: pumpOf(b.runner), runId: 'r1' },
      INPUT,
      'two',
      () => 1,
    );
    // Every question asked exactly once over both runs, the same as one uninterrupted run.
    const keyOf = (c: Log['calls'][number]) => `${c.model}|${c.schema}|${c.user}`;
    expect(log.calls.length).toBe(full.calls.length);
    expect(new Set(log.calls.map(keyOf)).size).toBe(log.calls.length);
    expect(log.calls.map(keyOf).sort()).toEqual(full.calls.map(keyOf).sort());
    expect(JSON.stringify(again.summary)).toBe(JSON.stringify(ref.summary));
  });

  it('the spending cap only waits: nothing is sent past it and the run goes on with room', async () => {
    const log: Log = { calls: [] };
    const { core, runner } = env(log, { limit: 0.0001 });
    const pump = pumpOf(runner);
    const run = runCloudSetup({ runner, pump, runId: 'r1' }, INPUT, 'opus');
    await new Promise((r) => setTimeout(r, 100));
    expect(log.calls).toHaveLength(0);
    expect(pump.lastWait).toMatchObject({ kind: 'limit_reached' });
    core.updateSettings({ spendLimitUsd: 30 });
    await run;
    expect(log.calls.length).toBeGreaterThan(0);
  });

  it('translation item by item; background text leaves the chapters out', async () => {
    const log: Log = { calls: [] };
    const { runner } = env(log);
    const pump = pumpOf(runner);
    const { summary } = await runCloudSetup({ runner, pump, runId: 'r1' }, INPUT, 'opus');
    const en = await translate({ runner, pump, runId: 'r1' }, 'nagi1|opus', summary, 'en');
    expect(en.missing).toEqual([]);
    const chars = en.summary.sections.find((s) => s.key === 'characters')!.groups[0].items[0];
    expect(chars.heading).toBe('EN カイト (カイト)');
    expect(chars.quote).toBe(
      summary.sections.find((s) => s.key === 'characters')!.groups[0].items[0].quote,
    );
    const bg = backgroundText([{ title: '1巻', summary }])!;
    expect(bg).toContain('(characters) カイト: 浜に倒れていた少年。');
    expect(bg).not.toContain('第0章の出来事');
  });
});
