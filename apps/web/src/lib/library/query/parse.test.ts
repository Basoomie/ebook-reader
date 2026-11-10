/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { parseQuery, QUERY_LIMITS, usesBookState, usesRegex, type QueryTerm } from './parse';

const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

function terms(text: string): QueryTerm[] {
  const result = parseQuery(text);
  if (!result.ok) throw new Error(`unexpected error: ${result.error.message}`);
  return result.query.terms;
}

/** Terms without their spans, for compact expectations. */
function shapes(text: string) {
  return terms(text).map(({ start: _s, end: _e, ...rest }) => rest);
}

function error(text: string) {
  const result = parseQuery(text);
  if (result.ok) throw new Error(`expected an error for ${text}`);
  return result.error;
}

const text = (value: string, exact = false) => ({ kind: 'text', value, exact });

describe('parseQuery: plain text', () => {
  it('splits on whitespace, including the ideographic space', () => {
    expect(shapes(`薬屋 日向${IDEOGRAPHIC_SPACE}夏\t外伝`)).toEqual([
      { type: 'any', negated: false, matcher: text('薬屋') },
      { type: 'any', negated: false, matcher: text('日向') },
      { type: 'any', negated: false, matcher: text('夏') },
      { type: 'any', negated: false, matcher: text('外伝') }
    ]);
  });

  it('is empty for an empty or blank query', () => {
    expect(terms('')).toEqual([]);
    expect(terms(`  ${IDEOGRAPHIC_SPACE} `)).toEqual([]);
  });

  it('keeps quoted phrases together', () => {
    expect(shapes('"Jane Doe" x')).toEqual([
      { type: 'any', negated: false, matcher: text('Jane Doe') },
      { type: 'any', negated: false, matcher: text('x') }
    ]);
  });

  it('runs an unclosed quote to the end', () => {
    expect(shapes('"unclosed phrase')).toEqual([
      { type: 'any', negated: false, matcher: text('unclosed phrase') }
    ]);
  });

  it('treats unknown field names and slashes inside words as text', () => {
    expect(shapes('Re:ゼロ Fate/stay 1/2 Re：ゼロ title:x')).toEqual(
      ['Re:ゼロ', 'Fate/stay', '1/2', 'Re：ゼロ', 'title:x'].map((v) => ({
        type: 'any',
        negated: false,
        matcher: text(v)
      }))
    );
  });

  it('treats an unclosed /pattern as text', () => {
    expect(shapes('/unclosed')).toEqual([
      { type: 'any', negated: false, matcher: text('/unclosed') }
    ]);
  });

  it('ignores empty terms', () => {
    expect(terms('- "" //')).toEqual([]);
  });

  it('keeps commas in plain text', () => {
    expect(shapes('a,b')).toEqual([{ type: 'any', negated: false, matcher: text('a,b') }]);
  });

  it('records the span of each term', () => {
    const [a, b] = terms('ab  author:"x y"');
    expect([a.start, a.end]).toEqual([0, 2]);
    expect([b.start, b.end]).toEqual([4, 16]);
  });
});

describe('parseQuery: negation', () => {
  it('negates any kind of term', () => {
    expect(shapes('-外伝 -status:completed -/^a/')).toEqual([
      { type: 'any', negated: true, matcher: text('外伝') },
      { type: 'status', negated: true, values: ['completed'] },
      { type: 'any', negated: true, matcher: { kind: 'regex', source: '^a', ignoreCase: false } }
    ]);
  });

  it('negates only once', () => {
    expect(shapes('--x')).toEqual([{ type: 'any', negated: true, matcher: text('-x') }]);
  });
});

describe('parseQuery: author, series and tag', () => {
  it('reads substring and exact values, case-insensitive field names', () => {
    expect(shapes('author:日向 Series:=薬屋のひとりごと TAG:SF')).toEqual([
      { type: 'field', field: 'author', negated: false, matchers: [text('日向')] },
      {
        type: 'field',
        field: 'series',
        negated: false,
        matchers: [text('薬屋のひとりごと', true)]
      },
      { type: 'field', field: 'tag', negated: false, matchers: [text('SF')] }
    ]);
  });

  it('accepts a full-width colon after a known field', () => {
    expect(shapes('tag：ライトノベル')).toEqual([
      { type: 'field', field: 'tag', negated: false, matchers: [text('ライトノベル')] }
    ]);
  });

  it('splits unquoted values at commas (any of them)', () => {
    expect(shapes('tag:A,B,,C')).toEqual([
      { type: 'field', field: 'tag', negated: false, matchers: [text('A'), text('B'), text('C')] }
    ]);
  });

  it('applies = to every alternative', () => {
    expect(shapes('tag:=A,B')).toEqual([
      { type: 'field', field: 'tag', negated: false, matchers: [text('A', true), text('B', true)] }
    ]);
  });

  it('never splits a quoted value', () => {
    expect(shapes('author:"Doe, Jane",Smith')).toEqual([
      {
        type: 'field',
        field: 'author',
        negated: false,
        matchers: [text('Doe, Jane'), text('Smith')]
      }
    ]);
  });

  it('accepts patterns as values', () => {
    expect(shapes('author:/^東野/ series:/外伝$/i,本')).toEqual([
      {
        type: 'field',
        field: 'author',
        negated: false,
        matchers: [{ kind: 'regex', source: '^東野', ignoreCase: false }]
      },
      {
        type: 'field',
        field: 'series',
        negated: false,
        matchers: [{ kind: 'regex', source: '外伝$', ignoreCase: true }, text('本')]
      }
    ]);
  });

  it('keeps two tag terms as two terms (all of them)', () => {
    expect(terms('tag:A tag:B').map((t) => t.type)).toEqual(['field', 'field']);
  });

  it('needs a value', () => {
    expect(error('author:').message).toMatch(/author: needs a value/);
    expect(error('x tag:"" y')).toMatchObject({ start: 2 });
    expect(error('series:,').message).toMatch(/series: needs a value/);
  });
});

describe('parseQuery: chars', () => {
  const bounds = (q: string) => {
    const [t] = terms(q);
    return t.type === 'chars' ? [t.min, t.max] : null;
  };

  it('reads comparisons, ranges, separators and k', () => {
    expect(bounds('chars:<150000')).toEqual([null, 149999]);
    expect(bounds('chars:<=150,000')).toEqual([null, 150000]);
    expect(bounds('chars:>50k')).toEqual([50001, null]);
    expect(bounds('chars:>=1.5k')).toEqual([1500, null]);
    expect(bounds('chars:=12_345')).toEqual([12345, 12345]);
    expect(bounds('chars:12345')).toEqual([12345, 12345]);
    expect(bounds('chars:50000-150000')).toEqual([50000, 150000]);
    expect(bounds('chars:50k-150k')).toEqual([50000, 150000]);
  });

  it('rejects anything that is not a number', () => {
    for (const q of ['chars:', 'chars:<', 'chars:abc', 'chars:<-5', 'chars:1-2-3', 'chars:"5"']) {
      expect(error(q).message, q).toMatch(/chars/);
    }
    expect(error('chars:9-1').message).toMatch(/smaller one/);
  });
});

describe('parseQuery: status and favorite', () => {
  it('reads one or more statuses, ignoring case and repeats', () => {
    expect(shapes('status:Reading,completed,reading')).toEqual([
      { type: 'status', negated: false, values: ['reading', 'completed'] }
    ]);
  });

  it('rejects unknown statuses and empty values', () => {
    expect(error('status:foo').message).toMatch(/"foo" isn't a status/);
    expect(error('status:').message).toMatch(/needs a value/);
  });

  it('reads favorite:yes and favorite:no only', () => {
    expect(shapes('favorite:yes favorite:NO')).toEqual([
      { type: 'favorite', negated: false, value: true },
      { type: 'favorite', negated: false, value: false }
    ]);
    expect(error('favorite:maybe').message).toMatch(/favorite:yes/);
    expect(error('favorite:yes,no').message).toMatch(/favorite:yes/);
  });

  it('tells when book state is used', () => {
    expect(usesBookState(parsed('a status:reading'))).toBe(true);
    expect(usesBookState(parsed('-favorite:yes'))).toBe(true);
    expect(usesBookState(parsed('a tag:b'))).toBe(false);
  });
});

function parsed(q: string) {
  const r = parseQuery(q);
  if (!r.ok) throw new Error(r.error.message);
  return r.query;
}

describe('parseQuery: regex', () => {
  it('reads /pattern/ and /pattern/i', () => {
    expect(shapes('/^薬屋.*[0-9]$/ /abc/i')).toEqual([
      {
        type: 'any',
        negated: false,
        matcher: { kind: 'regex', source: '^薬屋.*[0-9]$', ignoreCase: false }
      },
      { type: 'any', negated: false, matcher: { kind: 'regex', source: 'abc', ignoreCase: true } }
    ]);
  });

  it('allows spaces inside a pattern', () => {
    expect(shapes('/ごと [0-9]$/ x')).toEqual([
      {
        type: 'any',
        negated: false,
        matcher: { kind: 'regex', source: 'ごと [0-9]$', ignoreCase: false }
      },
      { type: 'any', negated: false, matcher: text('x') }
    ]);
  });

  it('allows escaped slashes and slashes in classes', () => {
    expect(shapes('/a\\/b/ /[/]x/')).toEqual([
      {
        type: 'any',
        negated: false,
        matcher: { kind: 'regex', source: 'a\\/b', ignoreCase: false }
      },
      { type: 'any', negated: false, matcher: { kind: 'regex', source: '[/]x', ignoreCase: false } }
    ]);
  });

  it('rejects invalid patterns and other flags', () => {
    expect(error('/(/').message).toMatch(/That pattern isn't valid/);
    expect(error('/a/g').message).toMatch(/Only the i flag/);
    expect(error('/usr/bin').message).toMatch(/put the text in quotes/);
  });

  it('limits the number and length of patterns', () => {
    expect(terms('/a/ /b/ /c/')).toHaveLength(3);
    expect(error('/a/ /b/ /c/ /d/').message).toMatch(/at most 3 patterns/);
    expect(error(`/${'a'.repeat(QUERY_LIMITS.maxRegexLength + 1)}/`).message).toMatch(
      /at most 200 characters/
    );
  });

  it('tells when a pattern is used', () => {
    expect(usesRegex(parsed('a /b/'))).toBe(true);
    expect(usesRegex(parsed('author:x,/y/'))).toBe(true);
    expect(usesRegex(parsed('a author:b 1/2'))).toBe(false);
  });
});

describe('parseQuery: limits', () => {
  it('limits the length', () => {
    expect(parseQuery('a'.repeat(QUERY_LIMITS.maxLength)).ok).toBe(true);
    expect(error('a'.repeat(QUERY_LIMITS.maxLength + 1)).message).toMatch(/at most 500 characters/);
  });

  it('limits the number of terms', () => {
    const many = Array.from({ length: QUERY_LIMITS.maxTerms }, (_, i) => `t${i}`).join(' ');
    expect(terms(many)).toHaveLength(16);
    expect(error(`${many} extra`).message).toMatch(/at most 16 parts/);
  });

  it('never throws on odd input', () => {
    for (const q of [
      '"',
      '/',
      '-',
      ':',
      'author:/',
      'tag:/x',
      '\\',
      '"/a/"',
      'author:"',
      '/[/',
      '-"'
    ]) {
      expect(() => parseQuery(q), q).not.toThrow();
    }
  });
});
