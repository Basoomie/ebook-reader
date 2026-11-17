/**
 * Season 2 Phase 12 session 5: reading the speaker model's answers (speaker-parse.ts) and the
 * grammar that shapes them (speaker-run.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  parseCharacters,
  parseGroups,
  parseSpeakers,
  tokenProbs,
  type TokenProb,
} from '../src/audio/speakers/speaker-parse';
import { speakerGrammar } from '../src/audio/speakers/speaker-run';

const tok = (token: string, p: number, alts: [string, number][] = []): TokenProb => ({
  token,
  logprob: Math.log(p),
  top: [[token, p] as [string, number], ...alts].map(([t, q]) => ({
    token: t,
    logprob: Math.log(q),
  })),
});

describe('stage 1 and 2 answers', () => {
  it('reads characters and the narrator, dropping broken entries', () => {
    const r = parseCharacters(
      JSON.stringify({
        characters: [
          { name: ' ホロ ', aliases: ['賢狼', ''], firstPerson: ['わっち'], gender: '女' },
          { name: '', aliases: [] },
          { name: 'ロレンス', aliases: 'x', gender: '?' },
        ],
        narrator: { firstPerson: true, name: '' },
      }),
    );
    expect(r.characters).toEqual([
      { name: 'ホロ', aliases: ['賢狼'], firstPerson: ['わっち'], gender: '女' },
      { name: 'ロレンス', aliases: [], firstPerson: [], gender: '不明' },
    ]);
    expect(r.narrator).toEqual({ firstPerson: true, name: null });
    expect(parseCharacters('not json').characters).toEqual([]);
  });

  it('reads groups of known ids, each id once', () => {
    expect(
      parseGroups(
        '{"same":[["C1","C4"],["C4","C2"],["C9","C3"],["C2","C3"]]}',
        new Set([1, 2, 3, 4]),
      ),
    ).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(parseGroups('{', new Set([1]))).toEqual([]);
  });
});

describe('stage 3 answers', () => {
  const valid = new Set([1, 2, 12]);

  it('reads one speaker per asked quote', () => {
    const r = parseSpeakers('Q5=C1\nQ6=+老人\nQ7=?\nQ8=C9\nQ99=C2\n', null, [5, 6, 7, 8], valid);
    expect(r.get(5)).toEqual({ kind: 'character', id: 1, p: null });
    expect(r.get(6)).toEqual({ kind: 'new', name: '老人', p: null });
    expect(r.get(7)).toEqual({ kind: 'unknown', p: null });
    expect(r.has(8)).toBe(false); // not in the list
    expect(r.has(99)).toBe(false); // not asked
  });

  it('measures how sure from the alternatives the grammar allowed', () => {
    // "Q5=" then "C" (p .9; "ロ" .1 is not allowed there) then "1" (p .6 vs "2" .3: valid)
    // then "\n". Sure = 1 (C among allowed) × .6/.9 (1 among allowed digits) = .667.
    const probs = [
      tok('Q', 1),
      tok('5', 1),
      tok('=', 1),
      tok('C', 0.9, [['ロ', 0.1]]),
      tok('1', 0.6, [
        ['2', 0.3],
        ['x', 0.1],
      ]),
      tok('\n', 1),
    ];
    const r = parseSpeakers('Q5=C1\n', probs, [5], valid);
    expect(r.get(5)!.p).toBeCloseTo(0.6 / 0.9, 5);
  });

  it('counts C1 and C12 as the alternatives they are, and a token that runs into the next line', () => {
    const probs = [
      tok('Q', 1),
      tok('5', 1),
      tok('=C', 1),
      tok('1', 0.5, [['12', 0.5]]),
      tok('\nQ', 1),
      tok('6', 1),
      tok('=?', 0.8, [['=C', 0.2]]),
      tok('\n', 1),
    ];
    const r = parseSpeakers('Q5=C1\nQ6=?\n', probs, [5, 6], valid);
    expect(r.get(5)!.p).toBeCloseTo(0.5, 5);
    expect(r.get(6)!.kind).toBe('unknown');
  });

  it('gives no sureness when the probabilities are not of this text', () => {
    const r = parseSpeakers('Q5=C1\n', [tok('Q5=C2\n', 1)], [5], valid);
    expect(r.get(5)!.p).toBeNull();
  });

  it('reads every form llama-server reports probabilities in', () => {
    expect(
      tokenProbs([{ token: 'a', logprob: -0.1, top_logprobs: [{ token: 'a', logprob: -0.1 }] }])[0]
        .logprob,
    ).toBe(-0.1);
    expect(
      tokenProbs([{ token: 'a', prob: 0.5, top_probs: [{ token: 'b', prob: 0.5 }] }])[0].top[0],
    ).toEqual({
      token: 'b',
      logprob: Math.log(0.5),
    });
    expect(tokenProbs([{ content: 'a', probs: [{ tok_str: 'a', prob: 1 }] }])[0]).toEqual({
      token: 'a',
      logprob: 0,
      top: [{ token: 'a', logprob: 0 }],
    });
  });
});

describe('the speaker grammar', () => {
  it('asks for every quote in order, with the listed ids', () => {
    const g = speakerGrammar([3, 4], [1, 12]);
    expect(g).toContain('root ::= "Q3=" speaker "\\n" "Q4=" speaker "\\n"');
    expect(g).toContain('speaker ::= "?" | "+" name | "C1" | "C12"');
  });
});
