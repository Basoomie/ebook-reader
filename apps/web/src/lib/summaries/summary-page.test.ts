/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { dragAxis, swipeStep, wrapIndex } from './carousel';
import { layoutDiagram } from './relationship-diagram';
import { SummaryApi } from './summary-api';
import {
  chapterButtonLabel,
  languageChoices,
  madeLine,
  makingProgress,
  modelName,
  quoteLinkText,
  sectionState,
  startLanguage,
  summaryHidden
} from './summary-page';
import {
  addSetup,
  moveSetup,
  removeSetup,
  routeProblem,
  setFinder,
  setWriter
} from './summary-route-edit';

const NOV23 = Date.UTC(2026, 10, 23, 12);

describe('the model line', () => {
  it('names models as people read them', () => {
    expect(modelName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelName('claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(modelName('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(modelName('gpt-6-luna')).toBe('GPT-6 Luna');
    expect(modelName('local-thing')).toBe('local-thing');
  });

  it('the writer first, then the models whose notes it wrote from (user, 2026-11-23)', () => {
    const at = { madeAt: NOV23 };
    expect(
      madeLine(
        { origin: 'ai', models: ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-opus-5-5'], ...at },
        'en-GB'
      )
    ).toBe(
      'Written by Claude Opus 5.5 from notes by Claude Sonnet 5.5 and GPT-6.1 Sol, on 23 Nov 2026'
    );
    // Sonnet + Sol written by Sonnet: the writer is named once.
    expect(
      madeLine(
        { origin: 'ai', setup: 'two', models: ['claude-sonnet-5-5', 'gpt-6.1-sol'], ...at },
        'en-GB'
      )
    ).toBe('Written by Claude Sonnet 5.5 from notes by GPT-6.1 Sol, on 23 Nov 2026');
    expect(
      madeLine(
        {
          origin: 'ai',
          setup: 'gpt-6.1-sol>claude-opus-5-5',
          models: ['gpt-6.1-sol', 'claude-opus-5-5'],
          ...at
        },
        'en-GB'
      )
    ).toBe('Written by Claude Opus 5.5 from notes by GPT-6.1 Sol, on 23 Nov 2026');
    expect(
      madeLine({ origin: 'ai', setup: 'opus', models: ['claude-opus-5-5'], ...at }, 'en-GB')
    ).toBe('Written by Claude Opus 5.5 on 23 Nov 2026');
    expect(madeLine({ origin: 'import', models: ['claude-opus-5-5'], ...at }, 'en-GB')).toBe(
      'Written by Claude Opus 5.5 on 23 Nov 2026'
    );
    expect(madeLine({ origin: 'user', models: [], ...at }, 'en-GB')).toBe(
      'Written by you on 23 Nov 2026'
    );
  });
});

describe('spoiler blur and languages', () => {
  it('blurs by the setting and the book’s status now', () => {
    expect(summaryHidden('completed', 'completed')).toBe(false);
    expect(summaryHidden('completed', 'reading')).toBe(true);
    expect(summaryHidden('completed', undefined)).toBe(true);
    expect(summaryHidden('always', 'completed')).toBe(true);
    expect(summaryHidden('never', 'unread')).toBe(false);
    expect(summaryHidden('something-old', 'completed')).toBe(false);
  });

  it('the book’s language first, then the setting’s, each once', () => {
    const c = languageChoices('ja', ['en', 'ja']);
    expect(c.map((x) => x.lang)).toEqual(['ja', 'en']);
    expect(c[0]).toMatchObject({ original: true, label: '日本語 (original)' });
    expect(c[1]).toMatchObject({ original: false, label: 'English (translation)' });
    expect(languageChoices('en', ['en', 'ja']).map((x) => x.lang)).toEqual(['en', 'ja']);
    expect(startLanguage('en', c)).toBe('en');
    expect(startLanguage('fr', c)).toBe('ja');
    expect(startLanguage('', c)).toBe('ja');
  });
});

describe('the states', () => {
  it('making shows the step, a bar and the time so far', () => {
    expect(makingProgress({ making: null }, NOV23)).toBeNull();
    expect(makingProgress({ making: 'queued' }, NOV23)).toMatchObject({
      value: 0,
      text: 'Waiting to start'
    });
    expect(
      makingProgress({ making: 'queued' }, NOV23, { waiting: null, afterVolume: true })?.text
    ).toMatch(/earlier volume/);
    const p = makingProgress(
      { making: 'running', phase: 'checking', since: NOV23 - 6 * 60_000 },
      NOV23
    );
    expect(p).toMatchObject({ value: 50, detail: '6 min so far · usually 15–20 minutes.' });
    expect(p?.text).toMatch(/^Step 2 of 3/);
    // An older server without the step: the first.
    expect(makingProgress({ making: 'running' }, NOV23)?.text).toMatch(/^Step 1 of 3/);
  });

  it('decides what the section shows', () => {
    expect(sectionState({ hasSummary: false, record: null, offline: false })).toEqual(['none']);
    expect(sectionState({ hasSummary: false, record: null, offline: true })).toEqual([
      'offline_none'
    ]);
    expect(
      sectionState({
        hasSummary: false,
        record: { making: 'running', outcome: null },
        offline: false
      })
    ).toEqual(['making']);
    expect(
      sectionState({
        hasSummary: true,
        record: { making: 'queued', outcome: 'made' },
        offline: false
      })
    ).toEqual(['making', 'shown']);
    expect(
      sectionState({
        hasSummary: false,
        record: { making: null, outcome: 'failed' },
        offline: false
      })
    ).toEqual(['failed']);
    expect(
      sectionState({
        hasSummary: true,
        record: { making: null, outcome: 'failed' },
        offline: false
      })
    ).toEqual(['failed', 'shown']);
    expect(
      sectionState({
        hasSummary: false,
        record: { making: null, outcome: 'no_text' },
        offline: false
      })
    ).toEqual(['no_text']);
  });

  it('a shown quote links to its place', () => {
    expect(quoteLinkText(41_000, 100_000, '第三章')).toBe('Open the book here · 第三章 · 41 %');
    expect(quoteLinkText(10, null, null)).toBe('Open the book here');
  });
});

describe('the chapter buttons', () => {
  it('show the chapter mark, else the title cut short', () => {
    expect(
      chapterButtonLabel(`１章${String.fromCharCode(0x3000)}ちょっと嫁いでみませんか`, 1)
    ).toBe('１章');
    expect(chapterButtonLabel('第三章 港長の疑い', 2)).toBe('第三章');
    expect(chapterButtonLabel('プロローグ', 0)).toBe('プロローグ');
    expect(chapterButtonLabel('Chapter 12: The Storm', 11)).toBe('Chapter 12');
    expect(chapterButtonLabel('とある月のひとりごと', 9)).toBe('とある月のひとりごと');
    expect(chapterButtonLabel('とても長いタイトルの章で区切りがない話', 3)).toBe(
      'とても長いタイトルの章…'
    );
    expect(chapterButtonLabel('  ', 4)).toBe('Chapter 5');
  });
});

describe('the characters carousel', () => {
  it('goes round and turns on a sideways swipe only', () => {
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(3, 0)).toBe(0);
    expect(dragAxis(3, 2)).toBeNull();
    expect(dragAxis(20, 5)).toBe('x');
    expect(dragAxis(5, 20)).toBe('y');
    expect(swipeStep(-60, 'x')).toBe(1);
    expect(swipeStep(60, 'x')).toBe(-1);
    expect(swipeStep(30, 'x')).toBe(0);
    expect(swipeStep(-90, 'y')).toBe(0);
  });
});

describe('the relationship diagram', () => {
  const rel = (ref: string, a: string, b: string, label?: string) => ({
    ref,
    between: [a, b] as [string, string],
    ...(label ? { label } : {})
  });

  it('one node per person, a line per relationship, labels or numbers on the lines', () => {
    const d = layoutDiagram([
      rel('r0', 'ナギ', 'レン', '師弟'),
      rel('r1', 'ナギ', '鷹野', '疑い'),
      rel('r2', 'ナギ', 'ガルド'),
      rel('r3', 'レン', 'ガルド', '誘惑'),
      rel('r4', 'レン', '兄', '兄弟')
    ]);
    expect(d.nodes.map((n) => n.name)).toEqual(['ナギ', 'レン', '鷹野', 'ガルド', '兄']);
    expect(d.edges.map((e) => e.label)).toEqual(['師弟', '疑い', '3', '誘惑', '兄弟']);
    expect(d.edges[2].numbered).toBe(true);
    // Everything inside the box (no scrolling), names not on top of each other.
    for (const n of d.nodes) {
      expect(n.x).toBeGreaterThan(5);
      expect(n.x).toBeLessThan(95);
      expect(n.y).toBeGreaterThan(5);
      expect(n.y).toBeLessThan(95);
    }
    for (const [i, a] of d.nodes.entries())
      for (const b of d.nodes.slice(i + 1))
        expect(Math.hypot(a.x - b.x, (a.y - b.y) / d.aspect)).toBeGreaterThan(10);
    // Labels apart from each other.
    for (const [i, a] of d.edges.entries())
      for (const b of d.edges.slice(i + 1))
        expect(Math.abs(a.lx - b.lx) > 5 || Math.abs(a.ly - b.ly) > 4).toBe(true);
  });

  it('the person tied to many sits in the middle; two people side by side', () => {
    const many = layoutDiagram(['A', 'B', 'C', 'D', 'E'].map((x, i) => rel(`r${i}`, 'Hub', x)));
    expect(many.nodes[0]).toMatchObject({ name: 'Hub', x: 50, y: 50 });
    const two = layoutDiagram([rel('r0', 'A', 'B')]);
    expect(two.nodes[0].y).toBe(two.nodes[1].y);
    expect(two.nodes[0].x).toBeLessThan(two.nodes[1].x);
    // A phone gets a taller box.
    expect(layoutDiagram([rel('r0', 'A', 'B')], true).aspect).toBeLessThan(two.aspect);
  });
});

describe('the fallback order of setups', () => {
  const S = 'claude-sonnet-5-5';
  const O = 'claude-opus-5-5';
  const G = 'gpt-6.1-sol';
  const route = [
    { finders: [S, G], writer: O },
    { finders: [S, G], writer: S },
    { finders: [O], writer: O }
  ];

  it('moves, adds, removes and changes setups', () => {
    expect(moveSetup(route, 2, -1).map((r) => r.writer)).toEqual([O, O, S]);
    expect(moveSetup(route, 0, -1)).toBe(route);
    expect(removeSetup(route, 1)).toHaveLength(2);
    expect(removeSetup([route[0]], 0)).toHaveLength(1);
    expect(addSetup(route, S)[3]).toEqual({ finders: [O], writer: O });
    expect(addSetup([], S)).toEqual([{ finders: [S], writer: S }]);
    expect(setFinder(route, 2, 1, G)[2].finders).toEqual([O, G]);
    expect(setFinder(route, 0, 1, null)[0].finders).toEqual([S]);
    expect(setFinder(route, 0, 1, S)[0].finders).toEqual([S]);
    expect(setWriter(route, 2, S)[2].writer).toBe(S);
  });

  it('says what is wrong in the settings’ words', () => {
    expect(routeProblem(route, [S, O, G])).toBeNull();
    expect(routeProblem([], [S])).toMatch(/at least one/);
    expect(routeProblem(route, [S, O])).toBe(
      "Setup 1: gpt-6.1-sol is not in Settings › AI's list."
    );
  });
});

describe('the API', () => {
  it('reads a 202 with a body (Regenerate’s job) and without one (a translation)', async () => {
    const fake = (async (url: string) =>
      String(url).endsWith('/regenerate')
        ? new Response(JSON.stringify({ job: 7 }), { status: 202 })
        : new Response(null, { status: 202 })) as typeof fetch;
    const api = new SummaryApi('http://s', 't', 0, fake);
    await expect(api.regenerate('b')).resolves.toEqual({ job: 7 });
    await expect(api.translate('b', 'en')).resolves.toBeUndefined();
  });
});
