/**
 * WP21e-2: the reader's audio matcher on the new library's folder names (cleanup stage 6:
 * `<Author>/<Series>/Vol <N> - <Title>/`, `<Author>/<Series>/<Title>/`, `<Author>/<Title>/`,
 * `_Unknown`, full-width forms, ` {narrator}` and ` (2)` collision suffixes).
 *
 * The fixture is a seeded sample of real folders from the WP21e-1 dry run on a copy of the
 * live cleanup.db, each with its metadata.json title/series and the book its stage-5 values
 * describe. Every entry is built the way the scanner builds it (scan-service indexFolder).
 */
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/wp21e2-real-names.json';
import {
  baseName,
  entryKeys,
  extractVolume,
  parseAbsSeries,
  rankEntries,
  stripAudioName,
  type BookForMatch,
  type MatchTier,
} from '../src/audio/match';
import { titleKey } from '../src/migration/fingerprint';

interface FixtureEntry {
  folder: string;
  categories: string[];
  firstFile: string | null;
  fileCount: number;
  metadata: { title: string; series: unknown };
  book: BookForMatch;
}

const entries = fixture.entries as FixtureEntry[];

/** What the scanner stores for the folder: with its metadata.json, or without one. */
function scanned(e: FixtureEntry, withMeta: boolean) {
  const parts = e.folder.split('/');
  const name = parts[parts.length - 1];
  const meta = withMeta
    ? { title: e.metadata.title, series: parseAbsSeries(e.metadata.series) }
    : null;
  const sequence = meta?.series?.sequence ?? null;
  const sequenceNumber =
    sequence !== null && /^\d+(\.\d+)?$/.test(sequence) ? Number(sequence) : null;
  return {
    fixture: e,
    name,
    parentName: parts.length > 2 ? parts[parts.length - 2] : null,
    ...entryKeys(name),
    volume:
      sequenceNumber ??
      extractVolume(name) ??
      (e.firstFile ? extractVolume(baseName(e.firstFile)) : null),
    metaTitle: meta?.title ?? null,
    metaSeries: meta?.series?.name ?? null,
    fileCount: e.fileCount,
  };
}

/**
 * An entry ranked above the folder is allowed only as a tie with a copy of the same book:
 * the same score, the same title, and no conflicting volume (two recordings of one title
 * that nothing in the names tells apart, e.g. `罪の声 {三好翼}` and `罪の声 {津田健次郎}`).
 */
function sameBookTie(a: BookForMatch, b: BookForMatch): boolean {
  return (
    titleKey(a.title) === titleKey(b.title) &&
    (a.seriesIndex === null || b.seriesIndex === null || a.seriesIndex === b.seriesIndex)
  );
}

function rankAll(withMeta: boolean) {
  const all = entries.map((e) => scanned(e, withMeta));
  const tiers: Record<string, number> = {};
  const problems: string[] = [];
  const ties: string[] = [];
  for (const target of all) {
    const ranked = rankEntries(target.fixture.book, all, all.length);
    const i = ranked.findIndex((s) => s.entry === target);
    const tier: MatchTier | 'none' = i < 0 ? 'none' : ranked[i].tier;
    tiers[tier] = (tiers[tier] ?? 0) + 1;
    if (i < 0) {
      problems.push(`${target.fixture.folder}: not suggested`);
      continue;
    }
    if (!['exact', 'loose'].includes(tier)) problems.push(`${target.fixture.folder}: tier ${tier}`);
    for (const above of ranked.slice(0, i)) {
      if (
        above.score !== ranked[i].score ||
        !sameBookTie(above.entry.fixture.book, target.fixture.book)
      ) {
        problems.push(
          `${target.fixture.folder}: below ${above.entry.fixture.folder} (${above.tier} ${above.score})`,
        );
      } else ties.push(`${target.fixture.folder} = ${above.entry.fixture.folder}`);
    }
  }
  return { tiers, problems, ties };
}

describe('the fixture', () => {
  it('covers every shape and suffix of the new library', () => {
    const count = (c: string) => entries.filter((e) => e.categories.includes(c)).length;
    expect(entries.length).toBeGreaterThanOrEqual(60);
    for (const c of [
      'fullwidth',
      'narrator',
      'number',
      'vol-integer',
      'vol-decimal',
      'author-series-title',
      'author-title',
      'unknown-author',
      'ai',
    ]) {
      expect(count(c), c).toBeGreaterThan(0);
    }
    // Both collision suffixes on one name, and a series whose volumes share one title.
    expect(entries.some((e) => / \{[^{}]*\} \(\d+\)$/.test(e.folder))).toBe(true);
    expect(entries.filter((e) => /\/教場\/Vol \d - 教場$/.test(e.folder))).toHaveLength(2);
  });
});

describe('real names of the new library (WP21e-2 dry run)', () => {
  it('ranks every folder first for its book, with its metadata.json', () => {
    const r = rankAll(true);
    console.log('with metadata.json', r.tiers, `${r.ties.length} ties with copies`);
    expect(r.problems).toEqual([]);
  });

  it('ranks every folder first for its book from the folder name alone', () => {
    const r = rankAll(false);
    console.log('folder name only', r.tiers, `${r.ties.length} ties with copies`);
    expect(r.problems).toEqual([]);
  });

  it('puts the right one of same-title volumes first (教場 1 and 3)', () => {
    const all = entries.map((e) => scanned(e, false));
    for (const index of [1, 3]) {
      const r = rankEntries({ title: '教場', seriesName: '教場', seriesIndex: index }, all);
      expect(r[0].entry.name).toBe(`Vol ${index} - 教場`);
      expect(r[0].tier).toBe('exact');
    }
  });
});

describe('suffixes and full-width forms', () => {
  const entry = (name: string, parentName: string | null = null) => ({
    name,
    parentName,
    ...entryKeys(name),
    volume: extractVolume(name),
  });

  it('drops the narrator, the copy number and both', () => {
    expect(stripAudioName('正体 {小林直人}')).toBe('正体');
    expect(stripAudioName('ララピポ (2)')).toBe('ララピポ');
    expect(stripAudioName('ララピポ (13)')).toBe('ララピポ');
    expect(stripAudioName('赤と青とエスキース {織田優成} (2)')).toBe('赤と青とエスキース');
    expect(stripAudioName('Vol 2 - 成瀬は信じた道をいく {山根綺} (2)')).toBe(
      '成瀬は信じた道をいく',
    );
    expect(stripAudioName('Vol 2.5 - タイトル {A・B} (3)')).toBe('タイトル');
  });

  it('keeps brackets and numbers that are part of the title', () => {
    expect(stripAudioName('Fate／strange Fake(8)')).toBe('Fate/strange Fake(8)');
    expect(stripAudioName('宮本武蔵（10） わすれ貝')).toBe('宮本武蔵(10) わすれ貝');
    expect(stripAudioName('{A} タイトル')).toBe('{A} タイトル');
    expect(stripAudioName('タイトル (上)')).toBe('タイトル (上)');
  });

  it('keeps the volume of a copy-numbered Vol folder', () => {
    expect(extractVolume('Vol 3 - ダンジョンに出会いを求めるのは間違っているだろうか 3 (2)')).toBe(
      3,
    );
    expect(extractVolume('最弱テイマーはゴミ拾いの旅を始めました。7 (2)')).toBe(7);
  });

  it('ranks a suffixed folder exactly', () => {
    for (const name of ['正体 {小林直人}', '正体 (2)', '正体 {小林直人} (3)']) {
      expect(
        rankEntries({ title: '正体', seriesName: null, seriesIndex: null }, [
          entry(name, '染井為人'),
        ])[0],
      ).toMatchObject({
        tier: 'exact',
        score: 100,
      });
    }
  });

  it('folds every full-width form stage 6 writes back to the title', () => {
    // build-names.ts: \ / : * ? " < > | -> ＼ ／ ： ＊ ？ ＂ ＜ ＞ ｜, a leading or trailing dot -> ．
    const forms: [string, string][] = [
      ['\\', '＼'],
      ['/', '／'],
      [':', '：'],
      ['*', '＊'],
      ['?', '？'],
      ['"', '＂'],
      ['<', '＜'],
      ['>', '＞'],
      ['|', '｜'],
    ];
    for (const [ascii, wide] of forms) {
      const title = `前${ascii}後ろの本`;
      const folder = `Vol 2 - 前${wide}後ろの本`;
      expect(stripAudioName(folder)).toBe(title);
      const r = rankEntries({ title, seriesName: 'シリーズ', seriesIndex: 2 }, [
        entry(folder, 'シリーズ'),
      ]);
      expect(r[0]?.tier, ascii).toBe('exact');
    }
    expect(stripAudioName('．hack')).toBe('.hack');
    expect(stripAudioName('終わりの本．')).toBe('終わりの本.');
    expect(
      rankEntries({ title: '.hack', seriesName: null, seriesIndex: null }, [entry('．hack')])[0]
        ?.tier,
    ).toBe('exact');
    // The old copy script's colon look-alike (U+A789) still reads as a colon.
    const colon = String.fromCharCode(0xa789);
    expect(stripAudioName(`Re${colon}ゼロから始める異世界生活`)).toBe(
      'Re:ゼロから始める異世界生活',
    );
  });

  it('matches a cut name (255 bytes) through the metadata.json title', () => {
    const title = 'あ'.repeat(100);
    const cut = 'あ'.repeat(85); // 255 bytes
    const e = { ...entry(cut, '作者'), metaTitle: title, metaSeries: null };
    expect(rankEntries({ title, seriesName: null, seriesIndex: null }, [e])[0]).toMatchObject({
      tier: 'exact',
    });
  });

  it('takes the numbered series of several, whatever the order', () => {
    expect(parseAbsSeries(['本好きの下剋上', '本好きの下剋上 ドラマCD #12'])).toEqual({
      name: '本好きの下剋上 ドラマCD',
      sequence: '12',
    });
    expect(parseAbsSeries(['本好きの下剋上 ドラマCD #12', '本好きの下剋上'])).toEqual({
      name: '本好きの下剋上 ドラマCD',
      sequence: '12',
    });
    expect(parseAbsSeries(['A', 'B'])).toEqual({ name: 'A', sequence: null });
  });
});
