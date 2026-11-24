/**
 * WP20g (2026-11-24): the measuring's plan. Pairs that cannot change an outcome are left out,
 * and owners sharing copies are measured together (each file read once per group).
 */
import { describe, expect, it } from 'vitest';
import { groupUnits, neededOthers } from '../src/cleanup/arrivals/measure-plan';

describe('wp20g: pairs that cannot change an outcome', () => {
  it('keeps every pair of an unsettled book; of a settled one only those with unsettled new books', () => {
    const settled = (k: number) => k === -1 || k === -3;
    expect(neededOthers(2, [5, -1, -3], settled)).toEqual([5, -1, -3]);
    expect(neededOthers(1, [5, -2, -3], settled)).toEqual([-2]);
    expect(neededOthers(1, [5, -3], settled)).toEqual([]);
  });

  it('leaves every outcome and the copy it names as measuring every pair does (random books and orders)', () => {
    let seed = 3;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    type Keep = 'a' | 'b' | null;
    // The outcome step: the first verdict that the other copy is as good or better names a
    // duplicate; else the first win over a library book; else new.
    const decide = (vs: { other: number; keep: 'new' | 'other' | null }[]) => {
      const lost = vs.find((v) => v.keep === 'other');
      if (lost) return `duplicate of ${lost.other}`;
      const beat = vs.find((v) => v.keep === 'new' && v.other > 0);
      return beat ? `better than ${beat.other}` : 'new';
    };
    let skippedTotal = 0;
    for (let round = 0; round < 300; round++) {
      const nNew = 2 + rand(8);
      const nLib = 1 + rand(4);
      const pairs: { a: number; b: number; keep: Keep }[] = [];
      for (let i = 1; i <= nNew; i++) {
        for (let j = 1; j < i; j++)
          if (rand(3) === 0) pairs.push({ a: -i, b: -j, keep: [null, 'a', 'b'][rand(3)] as Keep });
        for (let l = 1; l <= nLib; l++)
          if (rand(2) === 0)
            pairs.push({ a: -i, b: 100 + l, keep: [null, 'a', 'b'][rand(3)] as Keep });
      }
      // Any order the measuring might take them in.
      for (let k = pairs.length - 1; k > 0; k--) {
        const j = rand(k + 1);
        [pairs[k], pairs[j]] = [pairs[j], pairs[k]];
      }
      const run = (skip: boolean) => {
        const vs = new Map<number, { other: number; keep: 'new' | 'other' | null }[]>();
        const settled = (k: number) => k < 0 && (vs.get(k) ?? []).some((v) => v.keep === 'other');
        let skipped = 0;
        for (const p of pairs) {
          if (skip && neededOthers(-p.a, [p.b], settled).length === 0) {
            skipped++;
            continue;
          }
          const forA = p.keep === null ? null : p.keep === 'a' ? 'new' : 'other';
          vs.set(p.a, [...(vs.get(p.a) ?? []), { other: p.b, keep: forA }]);
          if (p.b < 0) {
            const forB = p.keep === null ? null : p.keep === 'b' ? 'new' : 'other';
            vs.set(p.b, [...(vs.get(p.b) ?? []), { other: p.a, keep: forB }]);
          }
        }
        const out: string[] = [];
        for (let i = 1; i <= nNew; i++) out.push(decide(vs.get(-i) ?? []));
        return { out, skipped };
      };
      const all = run(false);
      const some = run(true);
      expect(some.out).toEqual(all.out);
      skippedTotal += some.skipped;
    }
    // Enough pairs were actually left out for the check to mean something.
    expect(skippedTotal).toBeGreaterThan(500);
  });
});

describe('wp20g: owners measured together', () => {
  it('puts owners that share copies in one group of at most 8 books, each pair once', () => {
    const units = groupUnits(
      [
        { owner: 1, others: [50] },
        { owner: 2, others: [-1, 50] },
        { owner: 3, others: [-1, -2, 50] },
        { owner: 9, others: [60] },
      ],
      8,
    );
    expect(units).toHaveLength(2);
    const d = units.find((u) => u.owners.includes(1))!;
    expect(d.owners).toEqual([1, 2, 3]);
    expect([...d.books].sort((a, b) => a - b)).toEqual([-3, -2, -1, 50]);
    expect(d.pairs).toHaveLength(6);
    expect(units.find((u) => u.owners.includes(9))!.books.sort()).toEqual([-9, 60]);
  });

  it('splits a large group at 8 books and keeps an owner with more copies on its own', () => {
    const big = { owner: 100, others: Array.from({ length: 10 }, (_, i) => 200 + i) };
    const chain = Array.from({ length: 6 }, (_, i) => ({
      owner: i + 1,
      others: [300 + i, 301 + i],
    }));
    const units = groupUnits([big, ...chain], 8);
    for (const u of units)
      if (!u.owners.includes(100)) expect(u.books.length).toBeLessThanOrEqual(8);
    expect(units.find((u) => u.owners.includes(100))!.owners).toEqual([100]);
    // Every owner's pairs are in exactly one unit.
    const all = units.flatMap((u) => u.pairs.map((p) => `${p.a}:${p.b}`));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(10 + 12);
  });
});
