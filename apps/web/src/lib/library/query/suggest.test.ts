/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { parseQuery } from './parse';
import {
  applySuggestion,
  contextAt,
  fieldSuggestions,
  fixedValueSuggestions,
  nameForQuery,
  nameSuggestions,
  rankNames,
  type SuggestContext
} from './suggest';

/** The context with the caret at "|" in `marked`. */
function at(marked: string): { text: string; ctx: SuggestContext } {
  const cursor = marked.indexOf('|');
  const text = marked.replace('|', '');
  return { text, ctx: contextAt(text, cursor) };
}

function valueCtx(marked: string) {
  const { ctx } = at(marked);
  if (ctx.kind !== 'value') throw new Error(`expected a value context, got ${ctx.kind}`);
  return ctx;
}

describe('contextAt', () => {
  it('finds a field name being typed', () => {
    expect(at('ta|').ctx).toEqual({ kind: 'field', partial: 'ta', from: 0, to: 2 });
    expect(at('薬屋 -st|').ctx).toEqual({ kind: 'field', partial: 'st', from: 4, to: 6 });
  });

  it('ignores words that are no field, Japanese and the middle of a word', () => {
    expect(at('xy|').ctx.kind).toBe('none');
    expect(at('薬屋|').ctx.kind).toBe('none');
    expect(at('ta|g').ctx.kind).toBe('none');
    expect(at('|').ctx.kind).toBe('none');
  });

  it('finds a value after the colon, an = and earlier items', () => {
    expect(valueCtx('tag:S|')).toMatchObject({ field: 'tag', partial: 'S', from: 4, to: 5 });
    expect(valueCtx('tag:=S|')).toMatchObject({ partial: 'S', from: 5 });
    expect(valueCtx('tag：|')).toMatchObject({ field: 'tag', partial: '' });
    const list = valueCtx('-tag:SF,B|L chars:<1');
    expect(list).toMatchObject({ partial: 'B', from: 8, to: 10, taken: ['sf'], afterComma: true });
  });

  it('keeps quoted names whole', () => {
    const c = valueCtx('author:"Jane D| status:reading');
    expect(c).toMatchObject({ field: 'author', partial: 'Jane D', from: 7 });
    const d = valueCtx('author:"Doe, J",Sm|');
    expect(d).toMatchObject({ partial: 'Sm', taken: ['doe, j'] });
  });

  it('offers nothing inside a pattern', () => {
    expect(at('tag:/^S|').ctx.kind).toBe('none');
  });
});

describe('suggestions', () => {
  it('lists fields with their help', () => {
    expect(fieldSuggestions('s').map((s) => s.insert)).toEqual(['series:', 'status:']);
    expect(fieldSuggestions('ch')[0].detail).toContain('characters');
  });

  it('lists fixed values and leaves out ones already chosen', () => {
    expect(fixedValueSuggestions(valueCtx('status:|'))!.map((s) => s.insert)).toEqual([
      'unread',
      'reading',
      'completed',
      'dropped',
      'next'
    ]);
    expect(fixedValueSuggestions(valueCtx('status:reading,|'))!.map((s) => s.insert)).toEqual([
      'unread',
      'completed',
      'dropped',
      'next'
    ]);
    expect(fixedValueSuggestions(valueCtx('favorite:y|'))!.map((s) => s.insert)).toEqual(['yes']);
    expect(fixedValueSuggestions(valueCtx('favorite:yes,|'))).toEqual([]);
    expect(fixedValueSuggestions(valueCtx('chars:|'))!.length).toBe(3);
    expect(fixedValueSuggestions(valueCtx('chars:<1|'))).toEqual([]);
    expect(fixedValueSuggestions(valueCtx('tag:|'))).toBeNull();
  });

  it('every example and fixed value parses', () => {
    for (const field of ['chars', 'level', 'status', 'favorite', 'on']) {
      for (const s of fixedValueSuggestions(valueCtx(`${field}:|`))!) {
        expect(parseQuery(`${field}:${s.insert}`).ok).toBe(true);
      }
    }
  });

  it('ranks names: starts-with first, then by count, folding width and case', () => {
    const names = [
      { name: 'ハードSF', count: 50 },
      { name: 'SF', count: 10 },
      { name: 'ＳＦ短編', count: 3 },
      { name: 'BL', count: 99 }
    ];
    expect(rankNames(names, 'sf').map((n) => n.name)).toEqual(['SF', 'ＳＦ短編', 'ハードSF']);
    expect(rankNames(names, 'sf', ['sf']).map((n) => n.name)).toEqual(['ＳＦ短編', 'ハードSF']);
    expect(rankNames(names, '', [], 2).map((n) => n.name)).toEqual(['BL', 'ハードSF']);
  });

  it('quotes names that need it and skips ones that cannot be written', () => {
    expect(nameForQuery('Jane Doe')).toBe('"Jane Doe"');
    expect(nameForQuery('Doe, Jane')).toBe('"Doe, Jane"');
    expect(nameForQuery('-x')).toBe('"-x"');
    expect(nameForQuery('日向夏')).toBe('日向夏');
    expect(nameForQuery('a"b')).toBeNull();
    expect(nameSuggestions([{ name: 'a"b', count: 1 }])).toEqual([]);
  });

  it('applies a pick in place and puts the caret after it', () => {
    const { text, ctx } = at('-ta| 薬屋');
    if (ctx.kind === 'none') throw new Error('no context');
    expect(applySuggestion(text, ctx, fieldSuggestions('ta')[0])).toEqual({
      text: '-tag: 薬屋',
      cursor: 5
    });
    const v = at('tag:SF,b|l chars:<1');
    if (v.ctx.kind === 'none') throw new Error('no context');
    const picked = applySuggestion(v.text, v.ctx, { label: 'Boys Love', insert: '"Boys Love"' });
    expect(picked).toEqual({ text: 'tag:SF,"Boys Love" chars:<1', cursor: 18 });
    expect(parseQuery(picked.text).ok).toBe(true);
  });
});
