/**
 * WP21b: the audiobook cleanup's stage 3, duplicates (same recording). Title keys, fingerprint
 * windows and scores, the best-copy order, groups, the gate on labeled pairs, cleanup.db v10,
 * the proofs that nothing is written under the audiobook roots, and the whole stage on fixture
 * audio with the real tools (ffmpeg, fpcalc, faad2) and the routes. The real-tool part needs
 * fpcalc and faad on PATH (it runs in the Linux image: .tmp-e2e/wp21b/Dockerfile.test).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getAudioStage, setAudioStageMode } from '../src/cleanup/audio/audio-stages';
import {
  bestAlignment,
  fingerprintVerdict,
  fpFromBuffer,
  fpToBuffer,
  parseFpcalc,
  planWindows,
  secondsToItems,
  type WindowScore,
} from '../src/cleanup/audio/dup-fingerprint';
import { expected, scoreGate, type GateLookups } from '../src/cleanup/audio/dup-gate';
import { groupCopies, groupKey } from '../src/cleanup/audio/dup-groups';
import { cleanTitle, printedVolume, titleKey } from '../src/cleanup/audio/dup-names';
import {
  comparePair,
  decideGroup,
  sameChapters,
  type CopyFacts,
  type RuleSettings,
} from '../src/cleanup/audio/dup-rules';
import { toolArgs, wavFormat } from '../src/cleanup/audio/probe';
import { pairVerdict, spansOf, windowKey } from '../src/cleanup/audio/stage3-dups';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DISK_OWNERS } from '../src/cleanup/disk-lock';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';

const SRC = path.join(__dirname, '..', 'src');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function hasTool(name: string, arg = '-version'): boolean {
  try {
    execFileSync(name, [arg], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (err) {
    // faad -h exits 1 but runs.
    return (err as { status?: number }).status !== undefined && name === 'faad';
  }
}
const HAS_TOOLS =
  hasTool('ffmpeg') && hasTool('ffprobe') && hasTool('fpcalc') && hasTool('faad', '-h');
if (!HAS_TOOLS)
  console.warn('WP21b real-tool tests SKIPPED: ffmpeg/ffprobe/fpcalc/faad not all on PATH');

function freshDb(): Database.Database {
  const s = initCleanupDatabase(makeTempDir('wp21b-db'));
  if (!s.ok) throw new Error(s.error);
  return s.db;
}

const RS: RuleSettings = {
  lengthEqualSeconds: 2,
  incompleteSeconds: 60,
  bitrateMarginPercent: 5,
  chapterToleranceSeconds: 2,
};

function facts(over: Partial<CopyFacts> & { key: string }): CopyFacts {
  const seconds = over.seconds ?? 1000;
  return {
    path: over.key,
    files: 1,
    seconds,
    codec: 'aac',
    bitrate: 125_588,
    sampleRate: 44100,
    chapters: [
      { start: 0, end: 300 },
      { start: 300, end: 700 },
      { start: 700, end: seconds },
    ],
    hasCover: true,
    asinInName: true,
    damage: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
describe('title keys', () => {
  it('ignore the sources’ decorations and keep what says which book it is', () => {
    expect(titleKey('[20] バチカン奇跡調査官 王の中の王 [B0DBH181YY]')).toBe(
      titleKey('[20巻] バチカン奇跡調査官 王の中の王_ (KADOKAWA) [B0DBH181YY]'),
    );
    expect(titleKey('[03] マジック・ツリーハウス 第3巻 アマゾン大脱出 [B07MFS71CF]')).toBe(
      titleKey('[3巻] マジック・ツリーハウス 第3巻 アマゾン大脱出_ (KADOKAWA) [B07MFS71CF]'),
    );
    expect(titleKey('風花帖 [audiobook.jp 241553]')).toBe(titleKey('風花帖'));
    expect(titleKey('双血の墓碑銘 ３ ガガガ文庫_ (小学館) [B0DPQHMHFV]')).toBe(
      titleKey('[03] 双血の墓碑銘 ３ [B0DPQHMHFV]'),
    );
    // Different volumes and parts stay apart (the sample's first grouping paired them).
    expect(titleKey('[05] Fate∕strange Fake(5) [B0D6NNDY45]')).not.toBe(
      titleKey('[04] Fate∕strange Fake(4) [B0D6NNMS7Z]'),
    );
    expect(titleKey('名前探しの放課後 上')).not.toBe(titleKey('名前探しの放課後 下'));
    expect(titleKey('[01] 本C 1')).not.toBe(titleKey('[02] 本C 2'));
    expect(printedVolume('[19巻] 四つ子ぐらし 19 四姉妹のナゾ解きチャレンジ！')).toBe('19');
    expect(printedVolume('神の子 下')).toBe('下');
    expect(cleanTitle('[1巻] 本A 1_ (KADOKAWA) [B0A0000001]')).toBe('本A 1');
  });
});

// ---------------------------------------------------------------------------------------
describe('fingerprints', () => {
  const rand = (n: number, seed: number) => {
    let s = seed;
    return Uint32Array.from({ length: n }, () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    });
  };

  it('finds a shifted copy at its offset and scores unrelated audio near half', () => {
    const a = rand(400, 1);
    const b = new Uint32Array(500);
    b.set(rand(60, 9), 0);
    b.set(a, 60); // b runs 60 items later
    const al = bestAlignment(a, b, -100, 100, 200);
    expect(al.score).toBe(1);
    expect(al.offset).toBe(60);
    const other = bestAlignment(a, rand(400, 2), -50, 50, 200);
    expect(other.score!).toBeGreaterThan(0.4);
    expect(other.score!).toBeLessThan(0.6);
    expect(bestAlignment(a, b, 0, 0, 10_000).score).toBeNull();
  });

  it('round-trips fingerprints and reads fpcalc’s output (also signed values)', () => {
    const fp = Uint32Array.from([0, 1, 4294967295, 2147483648]);
    expect([...fpFromBuffer(fpToBuffer(fp))]).toEqual([...fp]);
    expect([...parseFpcalc('DURATION=0\nFINGERPRINT=1,-1,5\n')!]).toEqual([1, 4294967295, 5]);
    expect(parseFpcalc('DURATION=0\n')).toBeNull();
  });

  it('anchors windows at both ends and searches the middle between both anchors', () => {
    const s = { windowSeconds: 45, shiftSeconds: 60, middleSearchMinutes: 15 };
    // 風花帖: same 27 chapters, 342 s apart.
    const { plans, skipped } = planWindows(24365.2, 24023.2, s);
    expect(skipped).toEqual([]);
    const start = plans.find((p) => p.name === 'start')!;
    const end = plans.find((p) => p.name === 'end')!;
    const mid = plans.find((p) => p.name === 'middle')!;
    expect(start.a).toEqual({ start: 0, length: 105 });
    expect(end.a.start).toBeCloseTo(24365.2 - 105, 3);
    expect(end.b.start).toBeCloseTo(24023.2 - 105, 3);
    expect(start.maxOffset).toBe(secondsToItems(60));
    // The middle searches both "same time from the start" and "same time from the end".
    const mA = mid.a.start;
    expect(mid.b.start).toBeLessThanOrEqual(mA - 342 - 59);
    expect(mid.b.start + mid.b.length).toBeGreaterThanOrEqual(mA + 45 + 59);
    // Lengths further apart than searched: no middle window, said why.
    const far = planWindows(30000, 30000 + 3600, s);
    expect(far.plans.map((p) => p.name)).toEqual(['start', 'end']);
    expect(far.skipped[0].reason).toMatch(/3600 s/);
    expect(planWindows(3, 3, s).plans).toEqual([]);
  });

  it('same when every window is at the line; different when none is; else review', () => {
    const w = (scores: (number | null)[]): WindowScore[] =>
      scores.map((score, i) => ({
        name: (['start', 'middle', 'end'] as const)[i],
        score,
        shiftSeconds: 0,
      }));
    expect(fingerprintVerdict(w([0.9, 0.98, 0.91]), 0.75)).toBe('same');
    expect(fingerprintVerdict(w([0.57, 0.6, 0.61]), 0.75)).toBe('different');
    expect(fingerprintVerdict(w([0.57, 0.95, 0.96]), 0.75)).toBe('partly');
    expect(fingerprintVerdict(w([0.95, null, 0.96]), 0.75)).toBe('unknown');
    expect(fingerprintVerdict(w([null, null, null]), 0.75)).toBe('unknown');
  });

  it('maps a copy’s timeline onto its files', () => {
    const files = [
      { id: 1, duration: 100 },
      { id: 2, duration: 50 },
    ];
    expect(spansOf(files, { start: 90, length: 30 })).toEqual([
      { fileId: 1, start: 90, length: 10 },
      { fileId: 2, start: 0, length: 20 },
    ]);
    expect(windowKey(spansOf(files, { start: 0, length: 10 }))).toBe('[[1,0,10000]]');
  });

  it('a pair’s verdict follows its test', () => {
    const s = { dupAsinToleranceSeconds: 60 };
    expect(pairVerdict('title', 'same', 3, s).verdict).toBe('same');
    expect(pairVerdict('title', 'different', 3, s).verdict).toBe('different');
    expect(pairVerdict('title', 'partly', 3, s).verdict).toBe('unsure');
    // Same ASIN but other audio: never "different" silently, never merged.
    expect(pairVerdict('asin', 'different', 3, s)).toMatchObject({ verdict: 'unsure' });
    expect(pairVerdict('asin', 'unknown', 15, s).verdict).toBe('same');
    expect(pairVerdict('asin', 'unknown', 900, s).verdict).toBe('unsure');
    expect(pairVerdict('abs_asin', 'unknown', 1, s).verdict).toBe('unsure');
  });
});

// ---------------------------------------------------------------------------------------
describe('the best-copy order', () => {
  it('the 15 s pairs (Discord vs TMW, same chapters) go to review, as labeled', () => {
    // As measured in the live data: 7.78 s more in the first chapter, 7.28 s more in the last.
    const tmw = facts({ key: 'tmw', seconds: 32963.3 });
    const discord = facts({
      key: 'discord',
      seconds: 32978.32,
      chapters: [
        { start: 0, end: 307.78 },
        { start: 307.78, end: 707.78 },
        { start: 707.78, end: 32978.32 },
      ],
    });
    expect(sameChapters(tmw, discord, 2)).toBe(true);
    const r = comparePair(tmw, discord, RS);
    expect(r.rule).toBe('tie');
    expect(r.review).toMatch(/lengths differ by 15\.0 s/);
  });

  it('a longer copy that wins anyway is decided (pair 6 as labeled: a, higher sample rate)', () => {
    const a = facts({ key: 'a', seconds: 7649.9, sampleRate: 44100 });
    const b = facts({ key: 'b', seconds: 7636.4, sampleRate: 22050 });
    const r = comparePair(a, b, RS);
    expect(r).toMatchObject({ best: 'a', rule: 5, review: null });
    // The shorter one winning on a later rule: review.
    const r2 = comparePair(facts({ key: 'a', seconds: 7649.9, sampleRate: 22050 }), b, {
      ...RS,
    });
    expect(r2.best).toBe('a');
    const r3 = comparePair(
      facts({ key: 'a', seconds: 7636.4, sampleRate: 44100 }),
      facts({ key: 'b', seconds: 7649.9, sampleRate: 22050 }),
      RS,
    );
    expect(r3.best).toBe('a');
    expect(r3.review).toMatch(/13\.5 s shorter/);
  });

  it('bitrate decides within a codec (rule 5); chapters that differ go to review (rule 1)', () => {
    expect(
      comparePair(facts({ key: 'a', bitrate: 160_000 }), facts({ key: 'b', bitrate: 128_000 }), RS),
    ).toMatchObject({ best: 'a', rule: 5, review: null });
    expect(
      comparePair(facts({ key: 'a', bitrate: 130_000 }), facts({ key: 'b', bitrate: 128_000 }), RS)
        .rule,
    ).toBe('tie');
    // ララピポ: 6 vs 24 chapters, which are original is unknown.
    const six = facts({
      key: 'six',
      seconds: 30741,
      chapters: Array.from({ length: 6 }, (_, i) => ({ start: i * 5000, end: (i + 1) * 5000 })),
      hasCover: false,
    });
    const many = facts({
      key: 'many',
      seconds: 30741,
      bitrate: 160_976,
      chapters: Array.from({ length: 24 }, (_, i) => ({ start: i * 1280, end: (i + 1) * 1280 })),
    });
    const r = comparePair(six, many, RS);
    expect(r.review).toMatch(/6 vs 24/);
    expect(r.best).toBe('many');
  });

  it('a damaged copy always loses (no review for later rules); unconfirmed damage on the chosen copy goes to review', () => {
    const r = comparePair(
      facts({ key: 'bad', bitrate: 160_000, damage: 'damaged' }),
      facts({ key: 'ok', bitrate: 64_000 }),
      RS,
    );
    expect(r).toMatchObject({ best: 'ok', rule: 0, review: null, conflicts: [5] });
    const s = comparePair(
      facts({ key: 'suspect', bitrate: 160_000, damage: 'suspect' }),
      facts({ key: 'ok', bitrate: 64_000 }),
      RS,
    );
    expect(s.best).toBe('suspect');
    expect(s.review).toMatch(/not confirmed by a second decoder/);
    // Incomplete: shorter by the limit or more.
    const inc = comparePair(
      facts({ key: 'short', seconds: 24023, bitrate: 160_000 }),
      facts({ key: 'long', seconds: 24365 }),
      RS,
    );
    expect(inc).toMatchObject({ best: 'long', rule: 0, review: null });
  });

  it('a later rule against an earlier one makes a review item; single file, chapters, AAC, cover, ASIN', () => {
    const conflict = comparePair(
      facts({ key: 'a', bitrate: 160_000, hasCover: false }),
      facts({ key: 'b', bitrate: 64_000, hasCover: true }),
      RS,
    );
    expect(conflict).toMatchObject({ best: 'a', rule: 5, conflicts: [6] });
    expect(conflict.review).toMatch(/has a cover/);
    expect(comparePair(facts({ key: 'a' }), facts({ key: 'b', files: 3 }), RS).rule).toBe(2);
    expect(comparePair(facts({ key: 'a', chapters: [] }), facts({ key: 'b' }), RS)).toMatchObject({
      best: 'b',
      rule: 3,
    });
    expect(comparePair(facts({ key: 'a', codec: 'mp3' }), facts({ key: 'b' }), RS)).toMatchObject({
      best: 'b',
      rule: 4,
    });
    expect(comparePair(facts({ key: 'a', codec: 'opus' }), facts({ key: 'b' }), RS).review).toMatch(
      /no rule/,
    );
    expect(comparePair(facts({ key: 'a', hasCover: false }), facts({ key: 'b' }), RS).rule).toBe(6);
    expect(comparePair(facts({ key: 'a', asinInName: false }), facts({ key: 'b' }), RS).rule).toBe(
      7,
    );
    // Nothing separates them and they are equally long: a tie, decided (no review).
    expect(comparePair(facts({ key: 'b' }), facts({ key: 'a' }), RS)).toMatchObject({
      best: 'a',
      rule: 'tie',
      review: null,
    });
  });

  it('a group: the best copy and the rule that beat its closest rival', () => {
    const d = decideGroup(
      [
        facts({ key: 'x', bitrate: 64_000 }),
        facts({ key: 'y', bitrate: 160_000 }),
        facts({ key: 'z', damage: 'damaged', bitrate: 200_000 }),
      ],
      RS,
    );
    expect(d.best).toBe('y');
    expect(d.rule).toBe(5);
    expect(d.review).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
describe('groups', () => {
  it('joins same edges, flags a different edge inside, keeps unsure pairs apart', () => {
    const g = groupCopies(6, [
      { a: 0, b: 1, test: 'identical', verdict: 'same' },
      { a: 1, b: 2, test: 'asin', verdict: 'same' },
      { a: 0, b: 2, test: 'title', verdict: 'different' },
      { a: 3, b: 4, test: 'title', verdict: 'unsure' },
      { a: 4, b: 5, test: 'title', verdict: 'different' },
    ]);
    expect(g.components).toHaveLength(1);
    expect(g.components[0]).toMatchObject({
      members: [0, 1, 2],
      firstTest: 'identical',
      tests: ['identical', 'asin'],
      conflict: true,
    });
    expect(g.unsure).toEqual([{ a: 3, b: 4, test: 'title', verdict: 'unsure' }]);
    expect(groupKey(['b', 'a'])).toBe(groupKey(['a', 'b']));
  });

  it('handles a library-sized input without per-pair maps', () => {
    const n = 200_000;
    const edges = Array.from({ length: n - 1 }, (_, i) => ({
      a: i,
      b: i + 1,
      test: 'title' as const,
      verdict: i % 2 === 0 ? ('same' as const) : ('different' as const),
    }));
    const t0 = Date.now();
    const g = groupCopies(n, edges);
    expect(g.components).toHaveLength(n / 2);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------------------
describe('the gate on the labeled pairs', () => {
  const labels = {
    pairs: [
      { n: 0, kind: 'same_asin', fa: 'A', fb: 'B', same: true, best: 'review: 15 s' },
      { n: 1, kind: 'same_title_near', fa: 'C', fb: 'D', same: true, best: 'b (rule 5)' },
      { n: 2, kind: 'same_title_near', fa: 'E', fb: 'F', same: false },
      { n: 3, kind: 'in_folder', fa: 'G', fb: 'H', same: null },
      { n: 4, kind: 'in_folder', fa: 'I', fb: 'J', same: true, best: 'either (identical)' },
    ],
  };
  const look = (over: Partial<GateLookups> = {}): GateLookups => ({
    copiesOf: (rel) => (rel === 'J' ? ['i'] : [rel.toLowerCase()]),
    groupOf: (k) =>
      ({
        a: { key: 'g1', outcome: 'review' as const, rank: 0 },
        b: { key: 'g1', outcome: 'review' as const, rank: 1 },
        c: { key: 'g2', outcome: 'auto' as const, rank: 1 },
        d: { key: 'g2', outcome: 'auto' as const, rank: 0 },
      })[k] ?? null,
    unsurePair: () => false,
    ...over,
  });

  it('passes when every labeled pair comes out as labeled, null labels left out', () => {
    const r = scoreGate(labels, look());
    expect(r).toMatchObject({ passed: true, checked: 4, correct: 4, skipped: 1, misses: [] });
    expect(expected(labels.pairs[1] as never)).toEqual({ same: true, best: 'b' });
  });

  it('lists every miss: a wrong best copy, an unsure pair labeled different, a file not found', () => {
    const r = scoreGate(
      labels,
      look({
        groupOf: (k) =>
          ({
            a: { key: 'g1', outcome: 'auto' as const, rank: 0 },
            b: { key: 'g1', outcome: 'auto' as const, rank: 1 },
            c: { key: 'g2', outcome: 'auto' as const, rank: 0 },
            d: { key: 'g2', outcome: 'auto' as const, rank: 1 },
          })[k] ?? null,
        unsurePair: (a, b) => a === 'e' && b === 'f',
        copiesOf: (rel) => (rel === 'J' ? [] : [rel.toLowerCase()]),
      }),
    );
    expect(r.passed).toBe(false);
    expect(r.misses.map((m) => [m.n, m.got])).toEqual([
      [0, 'best a'],
      [1, 'best a'],
      [2, 'unsure (both stay, review)'],
      [4, 'not found (J)'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------
describe('cleanup.db v10', () => {
  it('adds stage 3 and its tables; the page’s queries use indexes', () => {
    const db = freshDb();
    expect(getAudioStage(db, 3).name).toBe('Duplicates (same recording)');
    expect(getAudioStage(db, 3).mode).toBe('off');
    setAudioStageMode(db, 3, 'analyse');
    expect(() => setAudioStageMode(db, 3, 'on')).toThrow(/switched on/);
    const plan = (sql: string, ...args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    const queries = [
      `SELECT COUNT(*) FROM audio_dup_groups g WHERE g.analysis_id = 'a' AND g.outcome = 'review'`,
      `SELECT g.* FROM audio_dup_groups g WHERE g.analysis_id = 'a' AND g.outcome = 'auto' AND g.kind = 'group' ORDER BY g.id LIMIT 50`,
      `SELECT COUNT(*) FROM audio_dup_groups g WHERE g.analysis_id = 'a' AND g.damaged = 1`,
      `SELECT g.* FROM audio_dup_groups g WHERE g.analysis_id = 'a' AND g.first_test = 'asin' AND g.kind = 'group'`,
      `SELECT copy_id, rank FROM audio_dup_members WHERE group_id = 1 ORDER BY rank`,
      `SELECT * FROM audio_dup_pairs WHERE analysis_id = 'a' AND a_id = 1 AND b_id = 2`,
      `SELECT * FROM audio_dup_pairs WHERE analysis_id = 'a' AND verdict = 'different' ORDER BY id`,
      `SELECT id FROM audio_dup_pairs WHERE analysis_id = 'a' AND test <> 'identical' AND (rules_key IS NULL OR rules_key <> 'k') ORDER BY id LIMIT 50`,
      `SELECT g.group_key, m.rank FROM audio_dup_members m JOIN audio_dup_groups g ON g.id = m.group_id WHERE m.copy_id = 5 AND g.analysis_id = 'a'`,
      `DELETE FROM audio_dup_groups WHERE analysis_id = 'a'`,
      `DELETE FROM audio_dup_copies WHERE analysis_id = 'a'`,
      `DELETE FROM audio_dup_pairs WHERE analysis_id = 'a'`,
      `SELECT files_sig FROM audio_fingerprints WHERE win_key = 'x'`,
      `SELECT ok FROM audio_full_decodes WHERE file_id = 1 AND decoder = 'ffmpeg'`,
    ];
    for (const q of queries) expect(plan(q), q).not.toMatch(/SCAN (audio_dup|g\b|m\b)/);
    // Deleting groups cascades to members through their primary key.
    expect(plan(`SELECT 1 FROM audio_dup_members WHERE group_id = 1`)).toMatch(/SEARCH/);
  });

  it('settings: stage 3’s limits are user settings and validated', () => {
    const db = freshDb();
    const s = getSettings(db).audiobooks;
    expect(s).toMatchObject({ dupSameScore: 0.75, dupIncompleteSeconds: 60, dupWindowSeconds: 45 });
    updateSettings(db, { audiobooks: { dupSameScore: 0.8 } });
    expect(getSettings(db).audiobooks.dupSameScore).toBe(0.8);
    expect(() => updateSettings(db, { audiobooks: { dupSameScore: 2 } })).toThrow(/0\.5 to 1/);
    expect(getSettings(db).gate.audiobookPairsFile).toBe('');
  });
});

// ---------------------------------------------------------------------------------------
describe('nothing in stage 3 writes under the audiobook roots', () => {
  it('every new tool command reads one input and writes only to stdout', () => {
    for (const kind of ['window-pcm', 'clip-start', 'clip-end'] as const) {
      const a = toolArgs(kind, '/dev/fd/3', 0, { start: 10, length: 20 });
      expect(a[a.length - 1]).toBe('-');
      expect(a).not.toContain('-y');
      expect(a.filter((x) => x === '-i')).toHaveLength(1);
      expect(a[a.indexOf('-i') + 1]).toBe('/dev/fd/3');
    }
    expect(toolArgs('full-decode', '/dev/fd/3', 0).slice(-3)).toEqual(['-f', 'null', '-']);
    expect(toolArgs('faad', '/dev/fd/3', 0)).toEqual(['-w', '/dev/fd/3']);
    const fp = toolArgs('fpcalc', '-', 0, { start: 0, length: 100 });
    expect(fp[fp.length - 1]).toBe('-');
    expect(fp).toContain('-raw');
  });

  it('the stage 3 modules use neither fs nor processes; the inputs module stays outside the roots', () => {
    const dir = path.join(SRC, 'cleanup', 'audio');
    for (const f of [
      'stage3-dups.ts',
      'dup-fingerprint.ts',
      'dup-rules.ts',
      'dup-groups.ts',
      'dup-names.ts',
      'dup-gate.ts',
    ]) {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(s, f).not.toMatch(/from 'fs'|from 'fs\/promises'|require\('fs'\)|child_process/);
    }
    const inputs = fs.readFileSync(path.join(SRC, 'cleanup', 'audio-stage3-inputs.ts'), 'utf8');
    expect(inputs).not.toMatch(/audio-source-fs/);
    expect(inputs.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /writeFile|mkdir|rename|unlink|rmSync|copyFile|createWriteStream/,
    );
  });

  it('reads the WAV header faad writes', () => {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'latin1');
    h.write('WAVE', 8, 'latin1');
    h.write('fmt ', 12, 'latin1');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(2, 22);
    h.writeUInt32LE(44100, 24);
    h.writeUInt16LE(16, 34);
    h.write('data', 36, 'latin1');
    expect(wavFormat(h)).toEqual({ rate: 44100, channels: 2, bits: 16, dataOffset: 44 });
    expect(wavFormat(Buffer.alloc(10))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Fixture audio: "recordings" made of tones that change every quarter second (so Chromaprint
// has something to hold on to), one per seed. The same seed is the same recording.

function samples(seconds: number, seed: number, rate = 22050): Int16Array {
  const n = Math.round(seconds * rate);
  const out = new Int16Array(n);
  let s = seed >>> 0 || 1;
  const r = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const seg = Math.round(rate / 4);
  let f1 = 0;
  let f2 = 0;
  let amp = 0;
  for (let i = 0; i < n; i++) {
    if (i % seg === 0) {
      f1 = 150 + r() * 1500;
      f2 = 300 + r() * 2500;
      amp = 0.2 + r() * 0.5;
    }
    const t = i / rate;
    const k = i % seg;
    const env = Math.min(1, k / 200, (seg - k) / 200);
    const v =
      amp * env * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t));
    out[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

function wav(parts: Int16Array[], rate = 22050): Buffer {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const b = Buffer.alloc(44 + total * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + total * 2, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(total * 2, 40);
  let o = 44;
  for (const p of parts) for (let i = 0; i < p.length; i++, o += 2) b.writeInt16LE(p[i], o);
  return b;
}

function put(root: string, rel: string, data: Buffer): string {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

function treeProof(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p, { bigint: true });
      if (st.isDirectory()) {
        out.push(`D ${path.relative(dir, p)} ${st.mtimeMs}`);
        walk(p);
      } else {
        out.push(
          `F ${path.relative(dir, p)} ${st.size} ${st.mtimeMs} ${st.ino} ${st.nlink} ${sha(fs.readFileSync(p))}`,
        );
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

describe.skipIf(!HAS_TOOLS)('stage 3 on fixture audio with ffmpeg, fpcalc and faad2', () => {
  const tmp = () => makeTempDir('wp21b-src');

  /** Encodes recordings to m4b with chapters (lengths in seconds). */
  function m4b(
    dir: string,
    name: string,
    parts: Int16Array[],
    bitrate: string,
    chapters: number[],
  ) {
    const w = path.join(dir, `${name}.wav`);
    fs.writeFileSync(w, wav(parts));
    const meta = path.join(dir, `${name}.txt`);
    let t = 0;
    const lines = [';FFMETADATA1', 'title=本'];
    chapters.forEach((len, i) => {
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(t * 1000)}`);
      t += len;
      lines.push(`END=${Math.round(t * 1000)}`, `title=第${i + 1}章`);
    });
    fs.writeFileSync(meta, lines.join('\n') + '\n');
    const out = path.join(dir, `${name}.m4b`);
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        w,
        '-i',
        meta,
        '-map_metadata',
        '1',
        '-map',
        '0:a',
        '-c:a',
        'aac',
        '-b:a',
        bitrate,
        out,
      ],
      { windowsHide: true },
    );
    // Checked before use (WP21 lessons: a fixture once came out 0.02 s long).
    const d = Number(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        out,
      ])
        .toString()
        .trim(),
    );
    const want = parts.reduce((a, p) => a + p.length, 0) / 22050;
    expect(Math.abs(d - want)).toBeLessThan(0.2);
    return fs.readFileSync(out);
  }

  it('groups, decides, confirms damage with faad2, passes the gate, writes nothing; routes, clips, decisions and settings changes', async () => {
    const src = tmp();
    const A = samples(150, 1);
    const jingleIn = samples(7.8, 999);
    const jingleOut = samples(7.3, 998);
    const fA = m4b(src, 'a', [A], '96k', [50, 50, 50]);
    const fA15 = m4b(src, 'a15', [jingleIn, A, jingleOut], '96k', [57.8, 50, 57.3]);
    const B = samples(150, 2);
    const fB64 = m4b(src, 'b64', [B], '64k', [50, 50, 50]);
    const fB128 = m4b(src, 'b128', [B], '128k', [50, 50, 50]);
    const fC1 = m4b(src, 'c1', [samples(150, 3)], '64k', [75, 75]);
    const fC2 = m4b(src, 'c2', [samples(150, 4)], '64k', [75, 75]);
    const fD1 = m4b(src, 'd1', [samples(150, 5)], '64k', [75, 75]);
    const fD2 = m4b(src, 'd2', [samples(148, 6)], '64k', [74, 74]);
    const E = samples(150, 7);
    const fE96 = m4b(src, 'e96', [E], '96k', [75, 75]);
    const fE64 = m4b(src, 'e64', [E], '64k', [75, 75]);
    const F = samples(150, 8);
    const fF64 = m4b(src, 'f64', [F], '64k', [75, 75]);
    const fF128 = Buffer.from(m4b(src, 'f128', [F], '128k', [75, 75]));
    // Damage between the windows (the windows still read; a full decode finds it).
    fF128.fill(0x55, Math.floor(fF128.length * 0.72), Math.floor(fF128.length * 0.72) + 3000);
    const G = samples(150, 9);
    const fG96 = m4b(src, 'g96', [G], '96k', [75, 75]);
    const fG64 = m4b(src, 'g64', [G], '64k', [75, 75]);
    const fH = m4b(src, 'h', [samples(60, 10)], '64k', [60]);

    const base = makeTempDir('wp21b-roots');
    const torrents = path.join(base, 'torrents');
    const library = path.join(base, 'library');
    const tmw = 'TMW Japanese Audiobooks Collection (Part 15) - Light Novels V';
    const tmw12 = 'TMW Japanese Audiobooks Collection (Part 12) - General Fiction (audiobook.jp)';
    put(torrents, `${tmw}/[作者A] 本A/[01] 本A 1 [B0A0000001].m4b`, fA);
    put(
      torrents,
      'Discord/moved/本A 1 [B0A0000001]/[1巻] 本A 1_ (KADOKAWA) [B0A0000001].m4b',
      fA15,
    );
    put(torrents, 'Discord/new/本A 1 copy/[1巻] 本A 1 [B0A0000001].m4b', fA);
    put(torrents, `${tmw}/[作者B] 本B/本B [audiobook.jp 123].m4b`, fB64);
    put(torrents, `${tmw12}/本B/本B.m4b`, fB128);
    put(torrents, `${tmw}/[作者C] 本C/[01] 本C 1.m4b`, fC1);
    put(torrents, `${tmw}/[作者C] 本C/[02] 本C 2.m4b`, fC2);
    put(torrents, `${tmw}/[作者D] 本D/本D.m4b`, fD1);
    put(torrents, 'MAM/本D/本D.m4b', fD2);
    put(torrents, 'Discord/moved/本E/本E (1).m4b', fE96);
    put(torrents, 'Discord/moved/本E/本E (2).m4b', fE64);
    put(torrents, `${tmw}/[作者F] 本F/[01] 本F [B0A0000006].m4b`, fF64);
    put(torrents, 'Discord/moved/本F [B0A0000006]/本F [B0A0000006].m4b', fF128);
    put(torrents, `${tmw}/[作者G] 本G/[01] 本G 1 [B0A0000009].m4b`, fG96);
    put(torrents, 'AI/本A 1/本A 1.m4b', fA); // the same audio, but AI: never competes
    put(library, '_Unknown/本A/[01] 本A 1 [B0A0000001].m4b', fA);
    put(library, '_Unknown/本A_/[1巻] 本A 1_ (KADOKAWA) [B0A0000001].m4b', fA15);
    put(library, '_Unknown/本B jp/本B [audiobook.jp 123].m4b', fB64);
    put(library, '_Unknown/本B/本B.m4b', fB128);
    put(library, '_Unknown/本D/本D.m4b', fD1);
    put(library, '_Unknown/本D2/本D.m4b', fD2);
    put(library, '_Unknown/本G/本G 1 [B0A0000009].m4b', fG64); // library-only
    put(library, '_Unknown/本H/本H (merged).m4b', fH); // written by the reader
    const labelsFile = path.join(makeTempDir('wp21b-labels'), 'labels.json');
    const labels = {
      pairs: [
        {
          n: 0,
          kind: 'same_asin',
          fa: '_Unknown/本A/[01] 本A 1 [B0A0000001].m4b',
          fb: '_Unknown/本A_/[1巻] 本A 1_ (KADOKAWA) [B0A0000001].m4b',
          same: true,
          best: 'review: the Discord copy is ~15 s longer',
        },
        {
          n: 1,
          kind: 'same_title_near',
          fa: '_Unknown/本B jp/本B [audiobook.jp 123].m4b',
          fb: '_Unknown/本B/本B.m4b',
          same: true,
          best: 'b (rule 5: bitrate)',
        },
        {
          n: 2,
          kind: 'same_title_near',
          fa: '_Unknown/本D/本D.m4b',
          fb: '_Unknown/本D2/本D.m4b',
          same: false,
        },
        { n: 3, kind: 'in_folder', fa: 'x', fb: 'y', same: null },
      ],
    };
    fs.writeFileSync(labelsFile, JSON.stringify(labels));
    const before = treeProof(base);

    const tools = {
      ffprobePath: 'ffprobe',
      ffmpegPath: 'ffmpeg',
      fpcalcPath: 'fpcalc',
      faadPath: 'faad',
    };
    const { env, setup } = await makeCleanupEnv({
      audio: {
        roots: { torrents, library },
        tools,
        readLabels: () => ({ text: fs.readFileSync(labelsFile, 'utf8'), error: null }),
        readerWrittenFiles: () => ['_Unknown/本H/本H (merged).m4b'],
      },
    });
    try {
      await setup();
      const db = env.cleanupDb;
      const audio = env.audio!;
      updateSettings(db, {
        audiobooks: {
          decodeSeconds: 2,
          copyHintMinMinutes: 0,
          dupWindowSeconds: 20,
          dupShiftSeconds: 15,
          dupMiddleSearchMinutes: 2,
        },
      });
      for (const st of [audio.stage1!, audio.stage2!]) {
        st.restart();
        for (let i = 0; i < 200; i++) if (await st.step(() => false)) break;
        expect(st.progress()!.error).toBeNull();
      }
      const s3 = audio.stage3!;
      s3.restart();
      const phases: string[] = [];
      for (let i = 0; i < 500; i++) {
        const ph = s3.progress()!.phase;
        if (phases[phases.length - 1] !== ph) phases.push(ph);
        if (await s3.step(() => false)) break;
      }
      const p = s3.progress()!;
      expect(p.error).toBeNull();
      expect(p.phase).toBe('done');
      expect(phases).toEqual([
        'copies',
        'candidates',
        'fingerprints',
        'compare',
        'decode',
        'decide',
      ]);
      expect(p.windowErrors).toBe(0);
      expect(p.tools?.fpcalc).toMatch(/fpcalc/);
      expect(p.tools?.faad).toMatch(/Decoder V\d/);
      // Progress of the compare and decode steps (the page's bars and time left).
      expect(p.compareDone).toBe(p.compareTotal);
      expect(p.compareTotal).toBeGreaterThan(0);
      expect(p.decodesLeft).toBe(0);
      expect(p.decodeAudioLeft).toBe(0);
      expect(p.decodeAudioDone!).toBeGreaterThan(150 * (p.decodesDone - 1));
      expect(p.decodeRateFrom?.at).toBeGreaterThan(0);

      // Lookups by torrent path.
      const copyOf = (rel: string) =>
        db
          .prepare(
            `SELECT c.* FROM audio_dup_copies c, json_each(c.file_ids) j JOIN audio_files f ON f.id = j.value
             WHERE c.analysis_id = ? AND f.rel_path = ?`,
          )
          .get(p.analysisId, rel) as
          | { id: number; excluded: string | null; kind: string }
          | undefined;
      const groupOf = (rel: string) =>
        db
          .prepare(
            `SELECT g.*, m.rank, m.role FROM audio_dup_members m JOIN audio_dup_groups g ON g.id = m.group_id
             WHERE m.copy_id = ? AND g.analysis_id = ?`,
          )
          .get(copyOf(rel)!.id, p.analysisId) as
          | {
              id: number;
              outcome: string;
              rule: string;
              first_test: string;
              members: number;
              review_reason: string | null;
              best_copy_id: number;
              damaged: number;
              kind: string;
            }
          | undefined;
      const pairOf = (x: string, y: string) => {
        const a = copyOf(x)!.id;
        const b = copyOf(y)!.id;
        return db
          .prepare('SELECT * FROM audio_dup_pairs WHERE analysis_id = ? AND a_id = ? AND b_id = ?')
          .get(p.analysisId, Math.min(a, b), Math.max(a, b)) as
          | { verdict: string; test: string; scores_json: string }
          | undefined;
      };
      const aT = `${tmw}/[作者A] 本A/[01] 本A 1 [B0A0000001].m4b`;
      const aD = 'Discord/moved/本A 1 [B0A0000001]/[1巻] 本A 1_ (KADOKAWA) [B0A0000001].m4b';
      // 本A: identical copy + the 15 s copy: one group of three, review (as labeled).
      const gA = groupOf(aT)!;
      expect(gA).toMatchObject({ members: 3, outcome: 'review', first_test: 'identical' });
      expect(gA.review_reason).toMatch(/lengths differ by 15\.\d s/);
      const scores = JSON.parse(pairOf(aT, aD)!.scores_json) as { windows: WindowScore[] };
      const start = scores.windows.find((w) => w.name === 'start')!;
      expect(start.score!).toBeGreaterThan(0.85);
      // 7.8 s apart at the start (the sign says which copy of the pair is first by id).
      expect(Math.abs(Math.abs(start.shiftSeconds!) - 7.8)).toBeLessThan(0.3);
      // 本B: same title, other bitrate: the 128 kbps copy (rule 5).
      const gB = groupOf(`${tmw12}/本B/本B.m4b`)!;
      expect(gB.review_reason).toBeNull();
      expect(gB).toMatchObject({ outcome: 'auto', rule: '5', first_test: 'title' });
      expect(gB.best_copy_id).toBe(copyOf(`${tmw12}/本B/本B.m4b`)!.id);
      // 本C: other volumes are never paired; 本D: same title, other recording.
      expect(
        pairOf(`${tmw}/[作者C] 本C/[01] 本C 1.m4b`, `${tmw}/[作者C] 本C/[02] 本C 2.m4b`),
      ).toBeUndefined();
      expect(pairOf(`${tmw}/[作者D] 本D/本D.m4b`, 'MAM/本D/本D.m4b')).toMatchObject({
        test: 'title',
        verdict: 'different',
      });
      expect(groupOf('MAM/本D/本D.m4b')).toBeUndefined();
      // 本E: two full copies in one folder.
      expect(groupOf('Discord/moved/本E/本E (1).m4b')).toMatchObject({
        first_test: 'in_folder',
        outcome: 'auto',
        rule: '5',
      });
      // 本F: the 128 kbps copy is damaged in the middle: ffmpeg reports it, faad2 stops early,
      // so it loses (rule 0) although it wins on bitrate.
      const fD = 'Discord/moved/本F [B0A0000006]/本F [B0A0000006].m4b';
      const gF = groupOf(fD)!;
      expect(gF).toMatchObject({ outcome: 'auto', rule: '0', damaged: 1 });
      expect(gF.best_copy_id).toBe(copyOf(`${tmw}/[作者F] 本F/[01] 本F [B0A0000006].m4b`)!.id);
      const dec = db
        .prepare(
          `SELECT d.decoder, d.ok, d.decoded_seconds FROM audio_full_decodes d JOIN audio_files f ON f.id = d.file_id
           WHERE f.rel_path = ? ORDER BY d.decoder`,
        )
        .all(fD) as { decoder: string; ok: number; decoded_seconds: number | null }[];
      expect(dec.map((d) => [d.decoder, d.ok])).toEqual([
        ['faad', 0],
        ['ffmpeg', 0],
      ]);
      expect(dec[0].decoded_seconds!).toBeLessThan(140);
      // 本G: the library-only file competes with its torrent twin.
      const gG = groupOf(`${tmw}/[作者G] 本G/[01] 本G 1 [B0A0000009].m4b`)!;
      expect(gG).toMatchObject({ members: 2, outcome: 'auto', rule: '5' });
      expect(copyOf('_Unknown/本G/本G 1 [B0A0000009].m4b')!.kind).toBe('library_only');
      // AI never competes; the reader's merge never takes part.
      const ai = copyOf('AI/本A 1/本A 1.m4b')!;
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM audio_dup_pairs WHERE a_id = ? OR b_id = ?')
          .get(ai.id, ai.id),
      ).toEqual({ n: 0 });
      expect(copyOf('_Unknown/本H/本H (merged).m4b')!.excluded).toMatch(/reader/);
      // The gate on the labeled pairs.
      expect(p.gate).toMatchObject({ passed: true, checked: 3, skipped: 1 });

      // Routes through the app.
      const auth = { Authorization: `Bearer ${env.userToken()}` };
      const st = await request(env.app).get('/api/v1/cleanup/audio/status').set(auth).expect(200);
      expect(st.body.stage3.progress.phase).toBe('done');
      expect(st.body.stage3.progress.gate.passed).toBe(true);
      const review = await request(env.app)
        .get('/api/v1/cleanup/audio/dups?list=review')
        .set(auth)
        .expect(200);
      const itemA = review.body.items.find((g: { id: number }) => g.id === gA.id);
      expect(itemA.copies).toHaveLength(3);
      expect(itemA.copies[0]).toMatchObject({ codec: 'aac', chapters: 3, cover: false });
      expect(itemA.pairs.length).toBeGreaterThan(0);
      const keepKey = itemA.copies[1].key as string;
      await request(env.app)
        .post(`/api/v1/cleanup/audio/dups/${gA.id}`)
        .set(auth)
        .send({ decision: `keep:${keepKey}` })
        .expect(200);
      await request(env.app)
        .post(`/api/v1/cleanup/audio/dups/${gA.id}`)
        .set(auth)
        .send({ decision: 'keep:not-a-member' })
        .expect(400);
      await request(env.app).get('/api/v1/cleanup/audio/dups?list=nope').set(auth).expect(400);
      const gate = await request(env.app)
        .get('/api/v1/cleanup/audio/dups?list=gate')
        .set(auth)
        .expect(200);
      expect(gate.body.total).toBe(3);
      const clip = await request(env.app)
        .get(`/api/v1/cleanup/audio/clip/${copyOf(aD)!.id}/end`)
        .set(auth)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(clip.headers['content-type']).toBe('audio/mpeg');
      expect((clip.body as Buffer).length).toBeGreaterThan(1000);
      // While a Calibre job uses the disk the clip waits (503, try again).
      env.service.diskLock.tryAcquire(DISK_OWNERS.calibre3, 'calibre');
      const busy = await request(env.app)
        .get(`/api/v1/cleanup/audio/clip/${copyOf(aD)!.id}/start`)
        .set(auth)
        .expect(503);
      expect(busy.headers['retry-after']).toBe('15');
      env.service.diskLock.release(DISK_OWNERS.calibre3);

      // A new analysis takes every window and decode over (the tools are gone now) and the
      // choice survives it (kept by the group's copies).
      const fpRows = (
        db.prepare('SELECT COUNT(*) AS n FROM audio_fingerprints').get() as { n: number }
      ).n;
      const decRows = (
        db.prepare('SELECT COUNT(*) AS n FROM audio_full_decodes').get() as { n: number }
      ).n;
      const gone = {
        ffprobePath: 'nope-ffprobe',
        ffmpegPath: 'nope-ffmpeg',
        fpcalcPath: 'nope',
        faadPath: 'nope',
      };
      const { AudioStage3 } = await import('../src/cleanup/audio/stage3-dups');
      const again = new AudioStage3({
        db,
        roots: { torrents, library },
        tools: gone,
        lock: env.service.diskLock,
        readLabels: () => ({ text: fs.readFileSync(labelsFile, 'utf8'), error: null }),
        readerWrittenFiles: () => ['_Unknown/本H/本H (merged).m4b'],
      });
      (again as unknown as { versions: unknown }).versions = p.tools; // no version runs either
      again.restart();
      for (let i = 0; i < 500; i++) if (await again.step(() => false)) break;
      const p2 = again.progress()!;
      expect(p2.error).toBeNull();
      expect(p2.windowsReused).toBe(p2.windowsTotal);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM audio_fingerprints').get() as { n: number }).n,
      ).toBe(fpRows);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM audio_full_decodes').get() as { n: number }).n,
      ).toBe(decRows);
      const listed = audio.dups('review').items.find((g) => g.groupKey === itemA.groupKey)!;
      expect((listed.decision as { decision: string }).decision).toBe(`keep:${keepKey}`);

      // A settings change compares again from what is stored: no window is read again, and a
      // file already decoded is never decoded again (only copies that newly went to review and
      // were never decoded are). A stricter line turns re-encoded pairs into review items.
      const decodedBefore = db
        .prepare(
          'SELECT file_id, decoder, checked_at FROM audio_full_decodes ORDER BY file_id, decoder',
        )
        .all();
      updateSettings(db, { audiobooks: { dupSameScore: 0.995 } });
      audio.stage3!.restart();
      for (let i = 0; i < 500; i++) if (await audio.stage3!.step(() => false)) break;
      const p3 = audio.stage3!.progress()!;
      expect(p3.error).toBeNull();
      expect(p3.windowsReused).toBe(p3.windowsTotal);
      expect(p3.gate!.passed).toBe(false);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM audio_fingerprints').get() as { n: number }).n,
      ).toBe(fpRows);
      const decodedAfter = db
        .prepare(
          'SELECT file_id, decoder, checked_at FROM audio_full_decodes ORDER BY file_id, decoder',
        )
        .all();
      for (const d of decodedBefore) expect(decodedAfter).toContainEqual(d);

      // Nothing under the roots changed.
      expect(treeProof(base)).toBe(before);
    } finally {
      await env.close();
    }
  }, 300_000);

  it('a decode gives the disk to a Calibre job at once and is read again later', async () => {
    const { DiskLock } = await import('../src/cleanup/disk-lock');
    const lock = new DiskLock(5);
    lock.tryAcquire(DISK_OWNERS.calibre1, 'calibre');
    // An audio holder can't take it while Calibre holds it; acquire returns when told to stop.
    let stop = false;
    setTimeout(() => (stop = true), 100);
    expect(await lock.acquire(DISK_OWNERS.audio3, 'audio', () => stop)).toBe(false);
    lock.release(DISK_OWNERS.calibre1);
    expect(await lock.acquire(DISK_OWNERS.audio3, 'audio')).toBe(true);
    void lock.acquire(DISK_OWNERS.calibre2, 'calibre');
    await new Promise((r) => setTimeout(r, 20));
    expect(lock.shouldYield(DISK_OWNERS.audio3)).toBe(true);
    lock.release(DISK_OWNERS.audio3);
  });
});
