/**
 * WP21f-1: audiobook stage 7, the daily new arrivals. The upgrade bookkeeping (an upgrade skips
 * values already decided by that design or a stronger one), J in stage 5, the parts rule on the
 * live library's names, the schedule and the backup window, the classifier (in the library,
 * identical, proven copy, better copy, new, waiting, held, removed by hand), the plan against an
 * existing tree (collisions, existing spellings, a book folder never used as a series folder),
 * the linking sidecar's new abilities with tree proofs (an existing book's folder or files are
 * never touched; only _extracted/ is new in the torrents), archives with the real bsdtar where it
 * is installed (the Linux image), the static guarantees, the post-switch fixes, a whole run
 * through stage 7 with the real writer and a stand-in Audiobookshelf, and EXPLAIN of every polled
 * or claimed query.
 */
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { Readable } from 'stream';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { crc32 } from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkWriter, WriteRefused, ARRIVAL_ROOTS, EXTRACTED } from '../../cleanup-link/src/writer';
import { LinkWorker } from '../../cleanup-link/src/worker';
import {
  asUtf8,
  entryStream,
  exactPattern,
  extractArgs,
  listArchive,
  parseListing,
  unescapeName,
} from '../../cleanup-link/src/archive';
import {
  designCounts,
  designsAtLeast,
  upgradeTargets,
  writeDecisions,
  type DecisionRow,
} from '../src/cleanup/ai/values';
import { decideUnit, needsUpgrade } from '../src/cleanup/audio/meta-decide';
import { metaEvidenceText } from '../src/cleanup/audio/meta-prompt';
import { EvidenceBuilder } from '../src/cleanup/audio/meta-evidence';
import { filesLookLikeParts, folderBooks } from '../src/cleanup/audio/book-units';
import {
  clockNow,
  inWindow,
  nextScheduledRun,
  scheduledRunDue,
} from '../src/cleanup/audio/arrivals-schedule';
import { classifyArrivals, type ArrivalFile } from '../src/cleanup/audio/arrivals-classify';
import { planArrivals } from '../src/cleanup/audio/arrivals-plan';
import type { PlanCopy, PlannedBook } from '../src/cleanup/audio/build-plan';
import { bookValues, metadataBytes } from '../src/cleanup/audio/build-metadata';
import {
  AudioStage7,
  absValuesAgree,
  entrySkip,
  listProblemState,
  versionAtLeast,
} from '../src/cleanup/audio/stage7-arrivals';
import { librarySwitched } from '../src/cleanup/audio/switch-state';
import { reuseTwinHealth } from '../src/cleanup/audio/stage2-books';
import { readerLibraryFolder } from '../src/cleanup/audio-stage3-inputs';
import { getAudioStage, setAudioStageMode } from '../src/cleanup/audio/audio-stages';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { liveCases, seedStage4 } from './helpers/audio-meta-seed';
import { IDS, seedBuild, type BuildSeed } from './helpers/build-seed';
import { makeTempDir } from './helpers/spawn-server';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const LINK_SRC = path.join(__dirname, '..', '..', 'cleanup-link', 'src');
const AUDIO_SRC = path.join(__dirname, '..', 'src', 'cleanup', 'audio');

function freshDb(prefix = 'wp21f'): Database.Database {
  const s = initCleanupDatabase(makeTempDir(prefix));
  if (!s.ok) throw new Error(s.error);
  return s.db;
}

function hasTool(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const BSDTAR = process.platform === 'linux' && hasTool('bsdtar');

/** Every entry under a folder: name, size, mtime, inode, links and content hash. */
function treeProof(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p, { bigint: true });
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (st.isDirectory()) {
        out.set(rel, `D ${st.ino}`);
        walk(p);
      } else
        out.set(rel, `F ${st.size} ${st.mtimeMs} ${st.dev}:${st.ino} ${sha(fs.readFileSync(p))}`);
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------------------------

describe('the upgrade bookkeeping (WP21f-1)', () => {
  const row = (
    item: string,
    field: string,
    source: string,
    flagged: boolean,
    design?: string,
  ): DecisionRow => ({
    itemKey: item,
    field,
    decision: { value: 'v', source: source as 'rules', flagged, reason: null },
    rules: null,
    primary: null,
    secondary: null,
    evidenceHash: 'h',
    ...(design ? { design } : {}),
  });

  it('J skips values decided with J, F skips F and J; the setting includes them', () => {
    const db = freshDb();
    writeDecisions(
      db,
      'audio5',
      [
        row('e1', 'title', 'both_models', false),
        row('e1', 'series', 'secondary_guess', true),
        row('e2', 'title', 'rules', false),
        row('j1', 'title', 'both_models', false, 'J'),
        row('j1', 'series', 'secondary_guess', true, 'J'),
        row('f1', 'series', 'secondary_guess', true, 'F'),
      ],
      'E',
      1,
    );
    expect(designsAtLeast('J')).toEqual(['J']);
    expect(designsAtLeast('F')).toEqual(['F', 'J']);
    expect(upgradeTargets(db, 'audio5', 'J')).toEqual([
      { itemKey: 'e1', field: 'series' },
      { itemKey: 'e1', field: 'title' },
      { itemKey: 'f1', field: 'series' },
    ]);
    expect(upgradeTargets(db, 'audio5', 'F')).toEqual([{ itemKey: 'e1', field: 'series' }]);
    // Explicitly configured: the arrivals decided with J are re-checked too.
    expect(upgradeTargets(db, 'audio5', 'J', { includeDecided: true })).toEqual([
      { itemKey: 'e1', field: 'series' },
      { itemKey: 'e1', field: 'title' },
      { itemKey: 'f1', field: 'series' },
      { itemKey: 'j1', field: 'series' },
      { itemKey: 'j1', field: 'title' },
    ]);
    expect(designCounts(db, 'audio5')).toEqual({ E: 2, F: 1, J: 1 });
  });

  it('a later pass keeps a row’s design (the post-steps write the stored design back)', () => {
    const db = freshDb();
    writeDecisions(db, 'audio5', [row('j1', 'series', 'secondary_guess', true, 'J')], 'E', 1);
    writeDecisions(db, 'audio5', [row('j1', 'series', 'rules', false, 'J')], 'E', 2);
    const d = db.prepare(`SELECT design FROM ai_values WHERE item_key = 'j1'`).get() as {
      design: string;
    };
    expect(d.design).toBe('J');
  });
});

describe('J in stage 5 (decideUnit with the stronger pair)', () => {
  const db = freshDb('wp21f-j');
  seedStage4(db, liveCases());
  const ev = (() => {
    const u = EvidenceBuilder.units(db, 's4-test').find((x) => x.unit_key === 'u:cop')!;
    return new EvidenceBuilder(db).build(u);
  })();
  const text = metaEvidenceText(ev);
  const ans = (title: string) => ({
    record: 'B0COPCRAFT',
    title,
    authors: ['賀東招二'],
    narrators: ['某朗読者'],
    series: [],
    drama: false,
    confidence: 'high',
  });
  const opts = { multiNarratorMin: 2 };

  it('E flags a rules title both cheap models disagree with; J sets it back when the stronger pair agrees with the rules', () => {
    const e = decideUnit(
      ev,
      { primary: ans('コップクラフト'), secondary: ans('コップクラフト') },
      text,
      opts,
    );
    expect(e.fields.title!.decision).toMatchObject({ flagged: true });
    expect(needsUpgrade(e, 'J')).toBe(true);
    expect(needsUpgrade(e, 'F')).toBe(true);
    const j = decideUnit(
      ev,
      { primary: ans('コップクラフト'), secondary: ans('コップクラフト') },
      text,
      opts,
      {
        design: 'J',
        primary: ans('コップクラフト5'),
        secondary: ans('コップクラフト5'),
      },
    );
    expect(j.fields.title!.decision).toMatchObject({
      value: 'コップクラフト5',
      source: 'rules',
      flagged: false,
    });
  });

  it('J takes the answer all four models agree on against the rules', () => {
    const j = decideUnit(
      ev,
      { primary: ans('コップクラフト'), secondary: ans('コップクラフト') },
      text,
      opts,
      {
        design: 'J',
        primary: ans('コップクラフト'),
        secondary: ans('コップクラフト'),
      },
    );
    expect(j.fields.title!.decision).toMatchObject({
      value: 'コップクラフト',
      source: 'upgrade_models',
      flagged: false,
    });
  });

  it('without the stronger pair’s answers the item is decided as E; nothing to re-check is never asked', () => {
    const agree = decideUnit(
      ev,
      { primary: ans('コップクラフト5'), secondary: ans('コップクラフト5') },
      text,
      opts,
    );
    const j = decideUnit(
      ev,
      { primary: ans('コップクラフト5'), secondary: ans('コップクラフト5') },
      text,
      opts,
      {
        design: 'J',
        primary: null,
        secondary: null,
      },
    );
    expect(j.fields.title!.decision).toEqual(agree.fields.title!.decision);
  });
});

describe('the parts rule (full-length files named as parts of one book)', () => {
  it('measured live names stay separate books', () => {
    // 涼宮ハルヒ: numbered tracks with different titles (13 different books).
    expect(
      filesLookLikeParts(['01 涼宮ハルヒの憂鬱', '02 涼宮ハルヒの溜息', '03 涼宮ハルヒの退屈']),
    ).toBe(false);
    // 前編/後編 are volumes Audible sells apart (each has its own ASIN).
    expect(
      filesLookLikeParts([
        '[1巻・前編] オーバーロード1 不死者の王 前編 [B0AAAAAAA1]',
        '[1巻・後編] オーバーロード1 不死者の王 後編 [B0AAAAAAA2]',
      ]),
    ).toBe(false);
    // Without an ASIN, 前編/後編 is still a volume mark (東京タワー: two audiobook.jp products).
    expect(filesLookLikeParts(['東京タワー（前編）', '東京タワー（後編）'])).toBe(false);
    // AI series volumes and unrelated novels side by side.
    expect(filesLookLikeParts(['月が導く異世界道中 1', '月が導く異世界道中 2'])).toBe(false);
    expect(filesLookLikeParts(['魔眼の匣の殺人', '兇人邸の殺人'])).toBe(false);
    // Drama CDs numbered in their names are separate releases.
    expect(
      filesLookLikeParts(['[CD1]本好きの下剋上ドラマCD', '[CD2]本好きの下剋上ドラマCD2']),
    ).toBe(false);
  });

  it('file-numbering marks make one book', () => {
    expect(filesLookLikeParts(['長い本 Part 1', '長い本 Part 2', '長い本 Part 3'])).toBe(true);
    expect(filesLookLikeParts(['長い本 Disc 1', '長い本 Disc 2'])).toBe(true);
    expect(filesLookLikeParts(['長い本 (1／2)', '長い本 (2／2)'])).toBe(true);
    expect(filesLookLikeParts(['01 長い本', '02 長い本'])).toBe(true);
    expect(filesLookLikeParts(['長い本 パート１', '長い本 パート２'])).toBe(true);
    // An own store id on a file: sold apart, separate books.
    expect(filesLookLikeParts(['長い本 Part 1 [B0AAAAAAA1]', '長い本 Part 2 [B0AAAAAAA2]'])).toBe(
      false,
    );
    // The same number twice is not parts.
    expect(filesLookLikeParts(['長い本 Part 1', '別の本 Part 1'])).toBe(false);
  });

  it('folderBooks keeps named parts as one book; everything else as before', () => {
    const f = (min: number, name?: string) => ({ seconds: min * 60, disc: null, name });
    expect(folderBooks([f(480, '長い本 Part 1'), f(470, '長い本 Part 2')], 120)).toBe(
      'named_parts',
    );
    expect(folderBooks([f(480, '01 涼宮ハルヒの憂鬱'), f(470, '02 涼宮ハルヒの溜息')], 120)).toBe(
      'split',
    );
    expect(folderBooks([f(480), f(500)], 120)).toBe('split');
    expect(folderBooks([f(2, 'a Part 1'), f(3, 'a Part 2')], 120)).toBe('parts');
  });
});

describe('the schedule', () => {
  const s = { arrivalsTime: '05:00', arrivalsQuietStart: '23:30', arrivalsQuietEnd: '00:30' };
  const at = (iso: string) => Date.parse(iso);
  it('once a day from the set time, never in the backup window', () => {
    expect(scheduledRunDue(at('2026-11-21T04:59:00Z'), s, null, 'UTC')).toBe(false);
    expect(scheduledRunDue(at('2026-11-21T05:00:00Z'), s, null, 'UTC')).toBe(true);
    expect(scheduledRunDue(at('2026-11-21T13:00:00Z'), s, null, 'UTC')).toBe(true);
    expect(scheduledRunDue(at('2026-11-21T13:00:00Z'), s, '2026-11-21', 'UTC')).toBe(false);
    expect(inWindow(23 * 60 + 45, 23 * 60 + 30, 30)).toBe(true);
    expect(inWindow(15, 23 * 60 + 30, 30)).toBe(true);
    expect(inWindow(45, 23 * 60 + 30, 30)).toBe(false);
    // A time set inside the window never starts there.
    expect(
      scheduledRunDue(at('2026-11-21T23:40:00Z'), { ...s, arrivalsTime: '23:35' }, null, 'UTC'),
    ).toBe(false);
    expect(
      scheduledRunDue(at('2026-11-21T23:40:00Z'), { ...s, arrivalsTime: '22:00' }, null, 'UTC'),
    ).toBe(false);
    expect(clockNow(at('2026-11-21T08:07:00Z'), 'America/Denver')).toEqual({
      day: '2026-11-21',
      minutes: 67,
    });
  });
  it('the next run is tomorrow once today’s has started', () => {
    expect(
      new Date(nextScheduledRun(at('2026-11-21T06:00:00Z'), s, '2026-11-21', 'UTC')).toISOString(),
    ).toBe('2026-11-22T05:00:00.000Z');
    expect(
      new Date(nextScheduledRun(at('2026-11-21T03:00:30Z'), s, '2026-11-20', 'UTC')).toISOString(),
    ).toBe('2026-11-21T05:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------------------------

describe('the classifier', () => {
  const file = (
    id: number,
    rel: string,
    ino: number,
    more: Partial<ArrivalFile> = {},
  ): ArrivalFile => ({
    id,
    root: 'torrents',
    rel,
    size: 100,
    mtimeMs: 0,
    dev: 1,
    ino,
    sha: `s${id}`,
    startOk: true,
    endOk: true,
    ...more,
  });
  const copy = (key: string, fileIds: number[], group: PlanCopy['group'] = null): PlanCopy => ({
    id: fileIds[0],
    key,
    bookKey: key,
    kind: 'file',
    fileIds,
    ai: false,
    excluded: false,
    group,
  });
  const g = (id: number, role: 'keep' | 'drop', outcome: 'auto' | 'review' = 'auto') => ({
    id,
    key: `g${id}`,
    kind: 'group' as const,
    outcome,
    role,
    rank: role === 'keep' ? 0 : 1,
  });
  const NOW = 10_000_000;

  it('every outcome', () => {
    const files = new Map<number, ArrivalFile>([
      [1, file(1, 'old/a.m4b', 11)], // in the library (linked)
      [2, file(2, 'new/a copy.m4b', 12, { sha: 's1' })], // byte-identical to 1
      [3, file(3, 'old/b.m4b', 13)], // linked
      [4, file(4, 'new/b worse.m4b', 14)], // proven the same, dropped
      [5, file(5, 'old/c.m4b', 15)], // linked, proven worse than 6
      [6, file(6, 'new/c better.m4b', 16)],
      [7, file(7, 'new/d.m4b', 17)], // new
      [8, file(8, 'new/e.m4b', 18, { mtimeMs: NOW - 60_000 })], // still changing
      [9, file(9, 'new/f.m4b', 19, { endOk: false })], // held
      [10, file(10, 'new/g.m4b', 20, { endOk: false })], // held, but Add anyway
      [11, file(11, 'old/h.m4b', 21)], // linked once, removed by hand
      [12, file(12, 'old/i.m4b', 22)], // at the build, never linked
      [21, { ...file(21, 'japanese/x/a.m4b', 11), root: 'library' }],
      [23, { ...file(23, 'japanese/x/b.m4b', 13), root: 'library' }],
      [25, { ...file(25, 'japanese/x/c.m4b', 15), root: 'library' }],
    ]);
    const copies = new Map<string, PlanCopy>(
      [
        copy('A', [1], g(1, 'keep')),
        copy('A2', [2], g(1, 'drop')),
        copy('B', [3], g(2, 'keep')),
        copy('B2', [4], g(2, 'drop')),
        copy('C', [5], g(3, 'drop')),
        copy('C2', [6], g(3, 'keep')),
        copy('D', [7]),
        copy('E', [8]),
        copy('F', [9]),
        copy('G', [10]),
        copy('H', [11]),
        copy('I', [12]),
      ].map((c) => [c.key, c]),
    );
    const units = [
      { key: 'uA', name: 'A', copyKeys: ['A', 'A2'] },
      { key: 'uB', name: 'B', copyKeys: ['B', 'B2'] },
      { key: 'uC', name: 'C', copyKeys: ['C', 'C2'] },
      { key: 'uD', name: 'D', copyKeys: ['D'] },
      { key: 'uE', name: 'E', copyKeys: ['E'] },
      { key: 'uF', name: 'F', copyKeys: ['F'] },
      { key: 'uG', name: 'G', copyKeys: ['G'] },
      { key: 'uH', name: 'H', copyKeys: ['H'] },
      { key: 'uI', name: 'I', copyKeys: ['I'] },
    ];
    const r = classifyArrivals({
      units,
      copies,
      files,
      decisions: new Map(),
      baseline: new Set(['old/a.m4b', 'old/b.m4b', 'old/c.m4b', 'old/h.m4b', 'old/i.m4b']),
      present: new Set(['1:11', '1:13', '1:15']),
      everLinked: new Set(['1:11', '1:13', '1:15', '1:21']),
      addAnyway: new Set(['G']),
      now: NOW,
      settleMs: 30 * 60_000,
    });
    const by = Object.fromEntries(r.outcomes.map((o) => [o.unitKey, o.outcome]));
    expect(by).toEqual({
      uA: 'identical',
      uB: 'duplicate',
      uC: 'better',
      uD: 'new',
      uE: 'waiting',
      uF: 'held',
      uG: 'new',
      uH: 'removed',
    });
    expect(r.unlinkedKnown).toBe(1);
    expect(r.outcomes.find((o) => o.unitKey === 'uD')!.link).toEqual(['D']);
  });

  it('a proven group of two arrivals links only the kept copy; unproven copies each stay', () => {
    const files = new Map<number, ArrivalFile>([
      [1, file(1, 'n/a.m4b', 1)],
      [2, file(2, 'n/a2.m4b', 2)],
      [3, file(3, 'n/b.m4b', 3)],
    ]);
    const copies = new Map<string, PlanCopy>(
      [
        copy('A', [1], g(1, 'keep')),
        copy('A2', [2], g(1, 'drop')),
        copy('B', [3], g(2, 'keep', 'review')),
      ].map((c) => [c.key, c]),
    );
    const r = classifyArrivals({
      units: [
        { key: 'u1', name: 'a', copyKeys: ['A', 'A2'] },
        { key: 'u2', name: 'b', copyKeys: ['B'] },
      ],
      copies,
      files,
      decisions: new Map(),
      baseline: new Set(),
      present: new Set(),
      everLinked: new Set(),
      addAnyway: new Set(),
      now: NOW,
      settleMs: 0,
    });
    expect(r.outcomes.map((o) => [o.unitKey, o.outcome, o.link])).toEqual([
      ['u1', 'new', ['A']],
      ['u2', 'new', ['B']],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the plan against the existing library', () => {
  const book = (
    over: Partial<PlannedBook> & { title: string; author: string; narrator?: string },
  ): PlannedBook => {
    const values = bookValues(
      {
        title: over.title,
        authors: [over.author],
        narrators: over.narrator ? [over.narrator] : [],
        series: [],
      },
      over.title,
    );
    const folder = `japanese-new/${over.author}/${over.series ? `${over.series}/` : ''}${over.title}`;
    return {
      unitKey: `u:${over.title}`,
      copyKey: `c:${over.title}`,
      area: 'main',
      state: 'build',
      folder,
      baseFolder: folder,
      series: null,
      notes: [],
      files: [{ fileId: 1, dst: `${folder}/${over.title}.m4b` }],
      pdfs: [],
      cover: true,
      metadata: metadataBytes(values),
      values,
      rank: 0,
      ...over,
    } as PlannedBook;
  };
  const tree = {
    dirs: new Set([
      'japanese',
      'japanese/作者A',
      'japanese/作者A/同じ題',
      'japanese/作者A/シリーズ',
      'japanese/作者A/シリーズ/Vol 1 - シリーズ 1',
      'japanese/作者B',
      'japanese/作者B/題名',
      'japanese/ABC',
    ]),
    bookDirs: new Set([
      'japanese/作者A/同じ題',
      'japanese/作者A/シリーズ/Vol 1 - シリーズ 1',
      'japanese/作者B/題名',
    ]),
    narrators: new Map<string, string | null>([
      ['japanese/作者A/同じ題', '読み手X'],
      ['japanese/作者B/題名', '読み手Y'],
    ]),
  };

  it('collisions: {narrator} when it differs, else (2); existing folders keep their names', () => {
    const p = planArrivals(
      [
        book({ title: '同じ題', author: '作者A', narrator: '読み手Z' }),
        book({ title: '題名', author: '作者B', narrator: '読み手Y' }),
        book({ title: '新しい本', author: 'abc', narrator: '誰か' }),
      ],
      tree,
    );
    expect(p.books.map((b) => b.folder)).toEqual([
      'japanese/作者A/同じ題 {読み手Z}',
      'japanese/作者B/題名 (2)',
      // An existing author folder is used with its spelling (the same name for Windows).
      'japanese/ABC/新しい本',
    ]);
    expect(p.counts.collisions).toMatchObject({ narrator: 1, number: 1 });
    // Only missing folders are made: the book folders (the authors exist).
    expect(p.ops.filter((o) => o.kind === 'folder').map((o) => o.dst)).toEqual([
      'japanese/作者A/同じ題 {読み手Z}',
      'japanese/作者B/題名 (2)',
      'japanese/ABC/新しい本',
    ]);
    expect(p.books[0].planned).toEqual(['metadata.json', '同じ題.m4b']);
    expect(p.books[0].files[0].dst).toBe('japanese/作者A/同じ題 {読み手Z}/同じ題.m4b');
  });

  it('editions stage 6 named with their narrators: the new one takes its own (the replay test found this)', () => {
    // As built live: 変な家 {小林裕介} / {河西健吾}; 赤と青とエスキース {井上悟} / {織田優成} / {織田優成} (2).
    const fam = {
      dirs: new Set([
        'japanese',
        'japanese/雨穴',
        'japanese/雨穴/変な家 {小林裕介}',
        'japanese/青山美智子',
        'japanese/青山美智子/赤と青とエスキース {井上悟}',
        'japanese/青山美智子/赤と青とエスキース {織田優成}',
        'japanese/青山美智子/赤と青とエスキース {織田優成} (2)',
        'japanese/作者C',
        'japanese/作者C/本',
        'japanese/作者C/本 (2)',
        'japanese/作者C/本の続き',
      ]),
      bookDirs: new Set<string>(),
      narrators: new Map<string, string | null>([
        ['japanese/雨穴/変な家 {小林裕介}', '小林裕介'],
        ['japanese/青山美智子/赤と青とエスキース {井上悟}', '井上悟'],
        ['japanese/青山美智子/赤と青とエスキース {織田優成}', '織田優成'],
        ['japanese/青山美智子/赤と青とエスキース {織田優成} (2)', '織田優成'],
        ['japanese/作者C/本', '読み手'],
        ['japanese/作者C/本 (2)', '読み手'],
        ['japanese/作者C/本の続き', '別の人'],
      ]),
    };
    for (const d of fam.dirs) if (d.split('/').length === 3) fam.bookDirs.add(d);
    const p = planArrivals(
      [
        book({ title: '変な家', author: '雨穴', narrator: '河西健吾' }),
        book({ title: '赤と青とエスキース', author: '青山美智子', narrator: '織田優成' }),
        // Same narrator, no braces in the family: the next number; 本の続き is another book.
        book({ title: '本', author: '作者C', narrator: '読み手' }),
      ],
      fam,
    );
    expect(p.books.map((b) => b.folder)).toEqual([
      'japanese/雨穴/変な家 {河西健吾}',
      'japanese/青山美智子/赤と青とエスキース {織田優成} (3)',
      'japanese/作者C/本 (3)',
    ]);
    expect(p.counts.collisions).toMatchObject({ narrator: 2, number: 2 });
  });

  it('a series goes into the existing series folder; a book folder is never used as a series folder', () => {
    const p = planArrivals(
      [
        book({ title: 'Vol 2 - シリーズ 2', author: '作者A', series: 'シリーズ' }),
        // 作者B/題名 is a book (it holds files): the series folder takes the next number.
        book({ title: 'Vol 1 - 題名 1', author: '作者B', series: '題名' }),
      ],
      tree,
    );
    expect(p.books.map((b) => b.folder)).toEqual([
      'japanese/作者A/シリーズ/Vol 2 - シリーズ 2',
      'japanese/作者B/題名 (2)/Vol 1 - 題名 1',
    ]);
    expect(p.ops.filter((o) => o.kind === 'folder').map((o) => o.dst)).toEqual([
      'japanese/作者A/シリーズ/Vol 2 - シリーズ 2',
      'japanese/作者B/題名 (2)',
      'japanese/作者B/題名 (2)/Vol 1 - 題名 1',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('the linking sidecar: new books after the switch (create-only)', () => {
  function disk() {
    const dir = makeTempDir('wp21f-writer');
    const data = path.join(dir, 'data');
    const torrents = path.join(data, 'torrents', 'audiobooks', 'japanese');
    const media = path.join(data, 'media', 'audiobooks');
    for (const d of [
      torrents,
      path.join(media, 'japanese', '作者', '既存の本'),
      path.join(media, 'japanese-generated'),
    ])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(torrents, 'old.m4b'), Buffer.alloc(3000, 1));
    fs.linkSync(
      path.join(torrents, 'old.m4b'),
      path.join(media, 'japanese', '作者', '既存の本', 'old.m4b'),
    );
    fs.writeFileSync(
      path.join(media, 'japanese', '作者', '既存の本', 'metadata.json'),
      '{"title":"既存"}\n',
    );
    fs.mkdirSync(path.join(torrents, 'new'), { recursive: true });
    fs.writeFileSync(path.join(torrents, 'new', '新しい本.m4b'), Buffer.alloc(4000, 2));
    const writer = new LinkWriter({ dataDir: data });
    const st = fs.lstatSync(path.join(torrents, 'new', '新しい本.m4b'));
    const src = {
      rel: 'new/新しい本.m4b',
      raw: null,
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      dev: st.dev,
      ino: st.ino,
    };
    return { dir, data, torrents, media, writer, src };
  }

  it('adds a new book under an existing author; the existing book and the torrents stay byte-identical', async () => {
    const d = disk();
    const beforeT = treeProof(d.torrents);
    const beforeOld = treeProof(path.join(d.media, 'japanese', '作者', '既存の本'));
    const book = 'japanese/作者/新しい本';
    const planned = ['metadata.json', '新しい本.m4b'];
    expect(await d.writer.makeArrivalFolder(book, book, planned)).toEqual({ existed: false });
    const bytes = Buffer.from('{"title":"新しい本"}\n');
    expect(
      await d.writer.writeArrivalMetadata(`${book}/metadata.json`, bytes, 7, book, planned),
    ).toEqual({
      existed: false,
      absRewrote: false,
    });
    const l = await d.writer.linkArrival(d.src, `${book}/新しい本.m4b`, book, planned);
    expect(l.existed).toBe(false);
    expect(fs.lstatSync(path.join(d.media, book, '新しい本.m4b')).ino).toBe(d.src.ino);
    // Safe to repeat (a batch handed out again after a restart).
    expect((await d.writer.makeArrivalFolder(book, book, planned)).existed).toBe(true);
    expect((await d.writer.linkArrival(d.src, `${book}/新しい本.m4b`, book, planned)).existed).toBe(
      true,
    );
    // Audiobookshelf rewrote metadata.json in its own form after its scan: done, not replaced.
    fs.writeFileSync(
      path.join(d.media, book, 'metadata.json'),
      '{"title":"新しい本","chapters":[]}\n',
    );
    fs.writeFileSync(path.join(d.media, book, 'cover.jpg'), 'img');
    expect(
      await d.writer.writeArrivalMetadata(`${book}/metadata.json`, bytes, 7, book, planned),
    ).toEqual({
      existed: true,
      absRewrote: true,
    });
    // Nothing else changed: the existing book's folder and the torrents (but the one link count).
    expect(treeProof(path.join(d.media, 'japanese', '作者', '既存の本'))).toEqual(beforeOld);
    const afterT = treeProof(d.torrents);
    expect([...afterT.keys()]).toEqual([...beforeT.keys()]);
    for (const [k, v] of beforeT) expect(afterT.get(k)).toBe(v);
    expect(fs.lstatSync(path.join(d.torrents, 'new', '新しい本.m4b')).nlink).toBe(2);
  });

  it('refuses an existing book’s folder, a book under a book, outside the library and unplanned names', async () => {
    const d = disk();
    const before = treeProof(d.media);
    const existing = 'japanese/作者/既存の本';
    // The folder holds old.m4b and metadata.json, which aren't this new book's.
    await expect(
      d.writer.makeArrivalFolder(existing, existing, ['metadata.json', 'x.m4b']),
    ).rejects.toThrow(/isn't this new book's/);
    await expect(
      d.writer.linkArrival(d.src, `${existing}/新しい本.m4b`, existing, [
        '新しい本.m4b',
        'metadata.json',
      ]),
    ).rejects.toThrow(/isn't this new book's/);
    await expect(
      d.writer.writeArrivalMetadata(`${existing}/metadata.json`, Buffer.from('{}'), 1, existing, [
        'metadata.json',
      ]),
    ).rejects.toThrow(/isn't this new book's/);
    // A new book inside an existing book's folder (that folder holds files): refused.
    const inner = `${existing}/中の本`;
    await expect(d.writer.makeArrivalFolder(inner, inner, ['metadata.json'])).rejects.toThrow(
      /existing book's folder/,
    );
    // Only under japanese/ and japanese-generated/.
    expect(ARRIVAL_ROOTS).toEqual(['japanese', 'japanese-generated']);
    await expect(
      d.writer.makeArrivalFolder('english/a/b', 'english/a/b', ['x.m4b']),
    ).rejects.toThrow(WriteRefused);
    await expect(
      d.writer.makeArrivalFolder('japanese-old/a/b', 'japanese-old/a/b', ['x.m4b']),
    ).rejects.toThrow(WriteRefused);
    // A file that is not planned for the book.
    const book = 'japanese/作者/新しい本';
    await expect(
      d.writer.linkArrival(d.src, `${book}/別.m4b`, book, ['新しい本.m4b']),
    ).rejects.toThrow(/Not a planned file/);
    // Never over an existing name.
    await d.writer.makeArrivalFolder(book, book, ['新しい本.m4b', 'metadata.json']);
    fs.writeFileSync(path.join(d.media, book, '新しい本.m4b'), 'something else');
    await expect(
      d.writer.linkArrival(d.src, `${book}/新しい本.m4b`, book, ['新しい本.m4b', 'metadata.json']),
    ).rejects.toThrow(/different file/);
    // A changed source.
    fs.appendFileSync(path.join(d.torrents, 'new', '新しい本.m4b'), 'x');
    fs.rmSync(path.join(d.media, book, '新しい本.m4b'));
    await expect(
      d.writer.linkArrival(d.src, `${book}/新しい本.m4b`, book, ['新しい本.m4b', 'metadata.json']),
    ).rejects.toThrow(/changed/);
    // The existing book is as it was.
    const after = treeProof(d.media);
    for (const [k, v] of before)
      if (k.startsWith('japanese/作者/既存の本')) expect(after.get(k)).toBe(v);
  });

  it('unpacks only under _extracted/, never over a different file, and checks the size', async () => {
    const d = disk();
    fs.writeFileSync(path.join(d.torrents, 'a.zip'), Buffer.alloc(500, 9));
    const st = fs.lstatSync(path.join(d.torrents, 'a.zip'));
    const zip = {
      rel: 'a.zip',
      raw: null,
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      dev: st.dev,
      ino: st.ino,
    };
    const before = treeProof(d.torrents);
    const fake =
      (bytes: Buffer, code = 0) =>
      () => {
        return {
          stream: Readable.from([bytes]),
          done: Promise.resolve({ code, stderr: code ? 'Passphrase required for this entry' : '' }),
          kill: () => undefined,
        };
      };
    expect(EXTRACTED).toBe('_extracted');
    const r = await d.writer.extractEntry(
      zip,
      '_extracted/a.zip/本/01.m4b',
      5,
      1,
      fake(Buffer.from('hello')),
    );
    expect(r).toEqual({ existed: false, bytes: 5 });
    expect(
      fs.readFileSync(path.join(d.torrents, '_extracted', 'a.zip', '本', '01.m4b'), 'utf8'),
    ).toBe('hello');
    expect(
      (
        await d.writer.extractEntry(
          zip,
          '_extracted/a.zip/本/01.m4b',
          5,
          1,
          fake(Buffer.from('hello')),
        )
      ).existed,
    ).toBe(true);
    await expect(
      d.writer.extractEntry(zip, '_extracted/a.zip/本/02.m4b', 9, 2, fake(Buffer.from('short'))),
    ).rejects.toThrow(/Unpacked 5 of 9/);
    await expect(
      d.writer.extractEntry(zip, '_extracted/a.zip/本/03.m4b', 3, 3, fake(Buffer.from('toolong'))),
    ).rejects.toThrow(/longer than listed/);
    await expect(
      d.writer.extractEntry(zip, '_extracted/a.zip/本/04.m4b', 0, 4, fake(Buffer.alloc(0), 1)),
    ).rejects.toThrow(/Passphrase/);
    await expect(
      d.writer.extractEntry(zip, 'new/x.m4b', 5, 5, fake(Buffer.from('hello'))),
    ).rejects.toThrow(/Not inside _extracted/);
    await expect(
      d.writer.extractEntry(zip, '_extracted/a.zip/../x.m4b', 5, 6, fake(Buffer.from('hello'))),
    ).rejects.toThrow(WriteRefused);
    await expect(
      d.writer.extractEntry(zip, '_extracted/a.zip/.hidden', 5, 7, fake(Buffer.from('hello'))),
    ).rejects.toThrow(WriteRefused);
    // Everything that was there is unchanged; only _extracted/ is new; no temporary file is left.
    const after = treeProof(d.torrents);
    for (const [k, v] of before) expect(after.get(k)).toBe(v);
    expect([...after.keys()].filter((k) => !before.has(k))).toEqual([
      '_extracted',
      '_extracted/a.zip',
      '_extracted/a.zip/本',
      '_extracted/a.zip/本/01.m4b',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

/** A small zip (stored entries): names as bytes, the UTF-8 flag, ZipCrypto, a symlink. */
function makeZip(
  entries: {
    name: Buffer | string;
    data: Buffer | string;
    utf8?: boolean;
    password?: string;
    symlink?: boolean;
  }[],
): Buffer {
  const crcTable = (c: number) => {
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  };
  const table = Array.from({ length: 256 }, (_, i) => crcTable(i));
  const crcByte = (crc: number, b: number) => (table[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    let data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);
    let flags = e.utf8 ? 0x0800 : 0;
    if (e.password) {
      flags |= 1;
      let k0 = 0x12345678,
        k1 = 0x23456789,
        k2 = 0x34567890;
      const upd = (b: number) => {
        k0 = crcByte(k0, b);
        k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
        k2 = crcByte(k2, k1 >>> 24);
      };
      for (const b of Buffer.from(e.password)) upd(b);
      const enc = (b: number) => {
        const t = (k2 | 2) & 0xffff;
        const c = (b ^ ((Math.imul(t, t ^ 1) >>> 8) & 0xff)) & 0xff;
        upd(b);
        return c;
      };
      const head = Buffer.alloc(12, 7);
      head[11] = crc >>> 24;
      data = Buffer.from([...head, ...data].map(enc));
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(e.password ? data.length - 12 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(e.password ? data.length - 12 : data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('archive listings (pure)', () => {
  it('bsdtar’s escapes and listing lines', () => {
    expect(unescapeName('a\\344\\270\\200b').toString('utf8')).toBe('a一b');
    expect(unescapeName('back\\\\slash').toString()).toBe('back\\slash');
    const l = parseListing(
      [
        '-rw-r--r--  0 0      0       12 Jan  1  1980 本/01 x.m4b',
        'drwxr-xr-x  0 0      0        0 Jan  1  1980 本/',
        'lrwxrwxrwx  0 0      0        0 Jan  1  1980 link -> /etc/passwd',
        '-rw-r--r--  0 0      0        5 Jan  1 12:00 \\202\\240.txt',
      ].join('\n'),
    );
    expect(l.map((e) => [e.raw.toString('latin1'), e.kind, e.size])).toEqual([
      [Buffer.from('本/01 x.m4b').toString('latin1'), 'file', 12],
      [Buffer.from('本/').toString('latin1'), 'dir', 0],
      ['link', 'link', 0],
      ['\x82\xa0.txt', 'file', 5],
    ]);
    expect(asUtf8(Buffer.from([0x82, 0xa0]))).toBeNull();
    expect(exactPattern('[B0AAAA] a*b?.m4b')).toBe('\\[B0AAAA\\] a\\*b\\?.m4b');
    expect(extractArgs('x.m4b', 'cp932')).toEqual([
      '-x',
      '-O',
      '--options',
      'hdrcharset=CP932',
      '-f',
      '/dev/fd/3',
      '--',
      'x.m4b',
    ]);
  });
  it('what is unpacked, and what a failed listing means', () => {
    expect(entrySkip('本/01.m4b')).toBeNull();
    expect(entrySkip('__MACOSX/本/._01.m4b')).toBe('macOS metadata');
    expect(entrySkip('本/._01.m4b')).toBe('hidden');
    expect(entrySkip('../x.m4b')).toBe('not a safe path');
    expect(entrySkip('a/'.repeat(1) + 'x'.repeat(300))).toBe('name too long');
    expect(
      listProblemState('TMW (Part 2)/._また、同じ夢見ていた.rar', 'Unrecognized archive format'),
    ).toBe('not_archive');
    expect(listProblemState('a.zip', 'Passphrase required for this entry')).toBe('password');
    expect(listProblemState('a.zip', 'Truncated input file')).toBe('failed');
    expect(versionAtLeast('1.2.0', '1.2.0')).toBe(true);
    expect(versionAtLeast('1.10.0', '1.2.0')).toBe(true);
    expect(versionAtLeast('1.1.0', '1.2.0')).toBe(false);
  });
});

describe.skipIf(!BSDTAR)('archives with the real bsdtar (Linux image)', () => {
  const cp932 = Buffer.from([0x96, 0x7b, 0x2f, 0x82, 0xa0, 0x2e, 0x6d, 0x34, 0x62]); // 本/あ.m4b in CP932
  function archive(dir: string, name: string, bytes: Buffer) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  }
  it('lists UTF-8 and CP932 names, refuses a mix, and unpacks one entry by its name', async () => {
    const dir = makeTempDir('wp21f-bsdtar');
    const utf = archive(
      dir,
      'u.zip',
      makeZip([
        { name: '本/[B0AAAA] 一.m4b', data: 'hello', utf8: true },
        { name: 'link', data: 'x', symlink: true },
      ]),
    );
    const jp = archive(dir, 'j.zip', makeZip([{ name: cp932, data: 'world' }]));
    const mixed = archive(
      dir,
      'm.zip',
      makeZip([
        { name: cp932, data: 'a' },
        { name: '本/二.m4b', data: 'b', utf8: true },
      ]),
    );
    const open = (p: string) => fs.promises.open(p, 'r');
    const lu = await listArchive('bsdtar', await open(utf));
    expect(lu).toMatchObject({ encoding: 'utf8', problem: null });
    expect(lu.entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ['本/[B0AAAA] 一.m4b', 'file', 5],
      ['link', 'link', 0],
    ]);
    const lj = await listArchive('bsdtar', await open(jp));
    expect(lj).toMatchObject({ encoding: 'cp932', problem: null });
    expect(lj.entries[0].name).toBe('本/あ.m4b');
    // A name marked UTF-8 stays UTF-8 while the unmarked one is read as CP932: both right.
    const lm = await listArchive('bsdtar', await open(mixed));
    expect(lm).toMatchObject({ encoding: 'cp932', problem: null });
    expect(lm.entries.map((e) => e.name)).toEqual(['本/あ.m4b', '本/二.m4b']);
    // Two unmarked names, one UTF-8 and one CP932: refused (bsdtar can't convert the UTF-8 one
    // from CP932, or it would come out garbled).
    const ambiguous = archive(
      dir,
      'a.zip',
      makeZip([
        { name: cp932, data: 'a' },
        { name: Buffer.from('本/二.m4b', 'utf8'), data: 'b' },
      ]),
    );
    expect((await listArchive('bsdtar', await open(ambiguous))).problem).toMatch(
      /two encodings|can't be read as CP932/,
    );
    // One entry to stdout, by its exact name (its [ ] are pattern characters).
    const read = async (p: string, name: string, enc: 'utf8' | 'cp932') => {
      const h = await open(p);
      const r = entryStream('bsdtar', h, extractArgs(name, enc));
      const chunks: Buffer[] = [];
      for await (const c of r.stream as AsyncIterable<Buffer>) chunks.push(c);
      const done = await r.done;
      await h.close();
      return { text: Buffer.concat(chunks).toString(), code: done.code };
    };
    expect(await read(utf, '本/[B0AAAA] 一.m4b', 'utf8')).toEqual({ text: 'hello', code: 0 });
    expect(await read(jp, '本/あ.m4b', 'cp932')).toEqual({ text: 'world', code: 0 });
  });

  it('a password zip lists but can’t be unpacked; a broken file isn’t an archive', async () => {
    const dir = makeTempDir('wp21f-bsdtar2');
    const pw = archive(
      dir,
      'p.zip',
      makeZip([{ name: '本.m4b', data: 'secret audio', utf8: true, password: 'pw' }]),
    );
    const l = await listArchive('bsdtar', await fs.promises.open(pw, 'r'));
    expect(l.entries.map((e) => e.name)).toEqual(['本.m4b']);
    const h = await fs.promises.open(pw, 'r');
    const r = entryStream('bsdtar', h, extractArgs('本.m4b', 'utf8'));
    for await (const _ of r.stream as AsyncIterable<Buffer>) void _;
    const done = await r.done;
    await h.close();
    expect(done.code).not.toBe(0);
    expect(listProblemState('p.zip', done.stderr)).toBe('password');
    const bad = archive(dir, '._x.rar', Buffer.alloc(4096, 0));
    // A file of zeros lists as an empty archive (bsdtar exits 0); the run reads that as 'not an
    // archive' for a ._ name, else 'no audio'.
    expect((await listArchive('bsdtar', await fs.promises.open(bad, 'r'))).entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('static guarantees', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  it('archive.ts only reads (it spawns bsdtar with -t or -x -O and the archive as a read-only fd)', () => {
    const src = read(path.join(LINK_SRC, 'archive.ts'));
    expect(src).not.toMatch(/\bfs\.|import (?!type)[^;]*from 'fs|writeFile|mkdir|unlink|rename/);
    expect(src).toMatch(/'-x',\s*'-O'/);
    expect(src).not.toMatch(/'-C'|--directory|'-x',\s*'-f'/);
  });
  it('the nudge has one route and one method, and only stage 7 imports it', () => {
    const src = read(path.join(AUDIO_SRC, 'abs-watch-notifier.ts'));
    expect(src.match(/fetchImpl\(/g)).toHaveLength(1);
    expect(src.match(/method: '/g)).toEqual(["method: '"]);
    expect(src).toMatch(/method: 'POST'/);
    expect(src).toMatch(/\/api\/watcher\/update/);
    expect(src).not.toMatch(/\/api\/libraries\/[^']*scan|PATCH|DELETE|PUT/);
    const users = fs
      .readdirSync(path.join(__dirname, '..', 'src'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'))
      .filter(
        (f) =>
          /abs-watch-notifier/.test(read(path.join(__dirname, '..', 'src', f))) &&
          !f.endsWith('abs-watch-notifier.ts'),
      );
    expect(users.map((f) => f.split(path.sep).join('/'))).toEqual([
      'cleanup/audio/stage7-arrivals.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('post-switch fixes', () => {
  it('the switch state, the twin health reuse and the reader’s folder name', () => {
    const db = freshDb('wp21f-post');
    expect(librarySwitched(db)).toBe(false);
    db.prepare(`UPDATE audio_switch SET state = 'switched' WHERE id = 1`).run();
    expect(librarySwitched(db)).toBe(true);
    const ins = db.prepare(
      `INSERT INTO audio_files (root, rel_path, ext, kind, size, mtime_ms, dev, ino, nlink, first_seen_at, seen_at)
       VALUES (?, ?, '.m4b', 'audio', 100, 5, 1, ?, 2, 0, 0)`,
    );
    const t = Number(ins.run('torrents', 'a.m4b', 77).lastInsertRowid);
    const l = Number(ins.run('library', 'x/a.m4b', 77).lastInsertRowid);
    const other = Number(ins.run('library', 'x/b.m4b', 78).lastInsertRowid);
    db.prepare(
      `INSERT INTO audio_file_health (file_id, size, mtime_ms, duration, header_ok, start_decode_ok, end_decode_ok, checked_at)
       VALUES (?, 100, 5, 600, 1, 1, 1, 9)`,
    ).run(t);
    expect(reuseTwinHealth(db)).toBe(1);
    const h = db
      .prepare('SELECT file_id, duration, checked_at FROM audio_file_health ORDER BY file_id')
      .all();
    expect(h).toEqual([
      { file_id: t, duration: 600, checked_at: 9 },
      { file_id: l, duration: 600, checked_at: 9 },
    ]);
    expect(other).toBeGreaterThan(0);
    // The reader's folder name from libraries.audio_dir (the NAS's mount is /cleanup-audio/library).
    const main = new BetterSqlite3(':memory:');
    main.exec(
      `CREATE TABLE libraries (audio_dir TEXT); INSERT INTO libraries VALUES ('japanese'), ('english'), (NULL);`,
    );
    expect(readerLibraryFolder(main, '/cleanup-audio/library')).toBe('japanese');
    expect(readerLibraryFolder(main, '/x/english')).toBe('english');
  });

  it('stage 3’s gate follows a labeled file of the deleted old library by its content (the diff found this)', () => {
    const db = freshDb('wp21f-gate3');
    const ins = db.prepare(
      `INSERT INTO audio_files (root, rel_path, ext, kind, size, mtime_ms, dev, ino, nlink, sha256, first_seen_at, seen_at, gone_at)
       VALUES (?, ?, '.m4b', 'audio', ?, 5, 1, ?, 1, ?, 0, 0, ?)`,
    );
    // The old library: a byte copy of a torrent file, and a library-only file (never hashed) that
    // the switch linked under _from-library (the same inode). Both are gone now.
    ins.run('library', '_Unknown/本/本.m4b', 100, 10, 'sha-a', 50);
    ins.run('library', '_Unknown/他/他.m4b', 200, 11, null, 50);
    const t1 = Number(ins.run('torrents', 'TMW/本.m4b', 100, 20, 'sha-a', null).lastInsertRowid);
    const t2 = Number(
      ins.run('torrents', '_from-library/他/他.m4b', 200, 11, null, null).lastInsertRowid,
    );
    const copy = db.prepare(
      `INSERT INTO audio_dup_copies (analysis_id, copy_key, book_key, kind, file_ids, name)
       VALUES ('a3', ?, ?, 'file', ?, 'n')`,
    );
    copy.run('c1', 'torrents:TMW/本.m4b', JSON.stringify([t1]));
    copy.run('c2', 'torrents:_from-library/他', JSON.stringify([t2]));
    const stage = new AudioStage3({
      db,
      roots: { torrents: '/none', library: '/none' },
      tools: { ffprobePath: 'x', ffmpegPath: 'x' },
      lock: new DiskLock(5),
    });
    const look = (p: { analysisId: string; stage1Id: string }) =>
      (
        stage as unknown as {
          gateLookups: (p: unknown) => { copyIdsOf: (rel: string) => number[] };
        }
      ).gateLookups(p);
    const p = { analysisId: 'a3', stage1Id: 's1' };
    // Before the switch a gone file is not followed (as before WP21f-1).
    expect(look(p).copyIdsOf('_Unknown/本/本.m4b')).toEqual([]);
    db.prepare(`UPDATE audio_switch SET state = 'deleted' WHERE id = 1`).run();
    const ids = (rel: string) =>
      look(p)
        .copyIdsOf(rel)
        .map(
          (id) =>
            (
              db.prepare('SELECT copy_key FROM audio_dup_copies WHERE id = ?').get(id) as {
                copy_key: string;
              }
            ).copy_key,
        );
    expect(ids('_Unknown/本/本.m4b')).toEqual(['c1']);
    expect(ids('_Unknown/他/他.m4b')).toEqual(['c2']);
    expect(ids('_Unknown/無い.m4b')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// A whole run through stage 7: real files, the real writer, a stand-in Audiobookshelf.

describe('a run of stage 7 (Preview, then On)', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function setup(opts: { absShows: boolean }) {
    const db = freshDb('wp21f-run');
    const dir = makeTempDir('wp21f-run-disk');
    const v = (title: string, narr: string) => ({
      title,
      authors: ['作者A'],
      narrators: [narr],
      series: [],
      drama: false,
      multi_narr: false,
      publisher: '出版社',
      year: 2024,
      language: 'ja',
      store_id: null,
      description: 'あらすじ。',
    });
    const seed: BuildSeed = {
      files: [
        { root: 'torrents', rel: 'old/既存の本.m4b', bytes: Buffer.alloc(3000, 1) },
        { root: 'torrents', rel: 'new/新しい本.m4b', bytes: Buffer.alloc(4000, 2) },
        { root: 'torrents', rel: 'new/新しい本 copy.m4b', bytes: Buffer.alloc(3000, 1) },
        { root: 'library', rel: '作者A/既存の本/既存の本.m4b', bytes: Buffer.alloc(3000, 1) },
      ],
      books: [
        { rel: 'old/既存の本.m4b', kind: 'file', files: ['old/既存の本.m4b'] },
        { rel: 'new/新しい本.m4b', kind: 'file', files: ['new/新しい本.m4b'] },
        { rel: 'new/新しい本 copy.m4b', kind: 'file', files: ['new/新しい本 copy.m4b'] },
      ],
      copies: [
        {
          key: 'cOld',
          bookKey: 'torrents:old/既存の本.m4b',
          kind: 'file',
          files: ['torrents:old/既存の本.m4b'],
          group: { key: 'g1', kind: 'group', outcome: 'auto', role: 'keep', rank: 0 },
        },
        {
          key: 'cCopy',
          bookKey: 'torrents:new/新しい本 copy.m4b',
          kind: 'file',
          files: ['torrents:new/新しい本 copy.m4b'],
          group: { key: 'g1', kind: 'group', outcome: 'auto', role: 'drop', rank: 1 },
        },
        {
          key: 'cNew',
          bookKey: 'torrents:new/新しい本.m4b',
          kind: 'file',
          files: ['torrents:new/新しい本.m4b'],
        },
      ],
      units: [
        {
          key: 'uOld',
          kind: 'record',
          name: '既存の本',
          copies: ['cOld', 'cCopy'],
          values: v('既存の本', '読み手'),
        },
        {
          key: 'uNew',
          kind: 'record',
          name: '新しい本',
          copies: ['cNew'],
          values: v('新しい本', '読み手'),
        },
      ],
      libraryCopies: { '作者A/既存の本/既存の本.m4b': ['old/既存の本.m4b'] },
    };
    const disk = seedBuild(db, dir, seed);
    // The library after the switch: hard links to the torrents' files.
    const libFile = path.join(disk.library, '作者A', '既存の本', '既存の本.m4b');
    fs.rmSync(libFile);
    fs.linkSync(path.join(disk.torrents, 'old', '既存の本.m4b'), libFile);
    const st = fs.lstatSync(libFile);
    db.prepare(`UPDATE audio_files SET dev = ?, ino = ? WHERE root = 'library'`).run(
      st.dev,
      st.ino,
    );
    fs.writeFileSync(path.join(disk.library, '作者A', '既存の本', 'metadata.json'), '{}\n');
    fs.mkdirSync(path.join(disk.media, 'japanese-generated'), { recursive: true });
    // The library was switched; stage 6's walk before the build knew only old/.
    db.prepare(`UPDATE audio_switch SET state = 'deleted' WHERE id = 1`).run();
    db.prepare(`UPDATE audio_stages SET progress_json = ? WHERE stage = 6`).run(
      JSON.stringify({ analysisId: 'b6', phase: 'done' }),
    );
    db.prepare(
      `INSERT INTO audio_build_manifest (analysis_id, phase, root, rel, is_dir, size, mtime_ms, dev, ino, nlink)
       VALUES ('b6', 'before', 'torrents', 'old/既存の本.m4b', 0, 3000, 0, 0, 0, 1)`,
    ).run();
    // Files settled long ago (the 30-minute rule): their real mtimes in 2020.
    const old = new Date('2020-01-01T00:00:00Z');
    for (const r of db.prepare(`SELECT id, root, rel_path FROM audio_files`).all() as {
      id: number;
      root: string;
      rel_path: string;
    }[]) {
      const p = path.join(
        r.root === 'torrents' ? disk.torrents : disk.library,
        ...r.rel_path.split('/'),
      );
      fs.utimesSync(p, old, old);
    }
    for (const r of db.prepare(`SELECT id, root, rel_path FROM audio_files`).all() as {
      id: number;
      root: string;
      rel_path: string;
    }[]) {
      const p = path.join(
        r.root === 'torrents' ? disk.torrents : disk.library,
        ...r.rel_path.split('/'),
      );
      db.prepare('UPDATE audio_files SET mtime_ms = ? WHERE id = ?').run(
        Math.floor(fs.lstatSync(p).mtimeMs),
        r.id,
      );
    }
    for (const s of [1, 2, 3, 4, 5]) setAudioStageMode(db, s, 'analyse');
    // The sidecar 1.2.0 is online.
    db.prepare(
      `INSERT OR REPLACE INTO link_sidecar_status (id, sidecar_id, version, last_seen_at) VALUES (1, 's', '1.2.0', ?)`,
    ).run(Date.now() + 3_600_000);
    // Stages 1 and 2 "run again" (the test moves their analysis ids on; the data stays).
    let n = 0;
    const reanalyse = (stage: 1 | 2) => {
      n++;
      const p = getAudioStage(db, stage).progress as Record<string, unknown>;
      const id = `${IDS[stage === 1 ? 's1' : 's2']}-${n}`;
      db.prepare('UPDATE audio_stages SET progress_json = ? WHERE stage = ?').run(
        JSON.stringify({ ...p, analysisId: id, phase: 'done' }),
        stage,
      );
      const p3 = getAudioStage(db, 3).progress as Record<string, unknown>;
      db.prepare('UPDATE audio_stages SET progress_json = ? WHERE stage = 3').run(
        JSON.stringify({ ...p3, [stage === 1 ? 'stage1Id' : 'stage2Id']: id }),
      );
    };
    // A stand-in Audiobookshelf.
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (u.pathname === '/api/libraries')
        return json({
          libraries: [
            {
              id: 'lib1',
              name: 'Japanese Audiobooks',
              folders: [{ fullPath: '/audiobooks/japanese' }],
            },
          ],
        });
      if (u.pathname === '/api/libraries/lib1')
        return json({
          settings: { metadataPrecedence: ['folderStructure', 'audioMetatags', 'absMetadata'] },
        });
      if (u.pathname === '/api/libraries/lib1/items') {
        const results = [{ id: 'i0', relPath: '作者A/既存の本' }];
        if (opts.absShows) results.push({ id: 'i1', relPath: '作者A/新しい本' });
        return json({ results, total: results.length });
      }
      if (u.pathname === '/api/items/i1')
        return json({
          media: {
            metadata: {
              title: '新しい本',
              authors: [{ name: '作者A' }],
              narrators: ['読み手'],
              series: [],
              asin: null,
            },
          },
        });
      if (u.pathname === '/api/watcher/update') return new Response('OK', { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const lock = new DiskLock(5);
    const stage7 = new AudioStage7({
      db,
      roots: { torrents: disk.torrents, library: disk.library, media: disk.media },
      lock,
      reanalyse,
      abs: () => ({ baseUrl: 'http://abs.test', apiKey: 'k', timeoutMs: 1000 }),
      fetchImpl,
      timeZone: 'UTC',
    });
    const worker = new LinkWorker(
      {
        serverUrl: 'http://x',
        token: 'ttsu_x',
        dataDir: disk.data,
        dirMode: 0o777,
        fileMode: 0o666,
        serverTimeoutSeconds: 5,
        bsdtar: 'bsdtar',
        archiveCharset: 'CP932',
      },
      () => undefined,
    );
    cleanups.push(() => db.close());
    return { db, disk, stage7, worker, calls };
  }

  async function drive(t: ReturnType<typeof setup>, limit = 400) {
    for (let i = 0; i < limit; i++) {
      const b = t.stage7.claim();
      if (b) t.stage7.report(b.id, (await t.worker.process(b as never)) as never);
      const r = await t.stage7.step(() => false);
      if (r === 'done') return;
    }
    throw new Error(`stage 7 did not finish: ${JSON.stringify(t.stage7.current()?.phase)}`);
  }

  it('Preview plans the new book, records the proven copy, and writes nothing', async () => {
    const t = setup({ absShows: true });
    setAudioStageMode(t.db, 7, 'analyse');
    const before = treeProof(path.join(t.disk.data));
    t.stage7.requestRun();
    expect(t.stage7.maybeStart()).not.toBeNull();
    await drive(t);
    expect(treeProof(path.join(t.disk.data))).toEqual(before);
    const run = t.stage7.lastRun()!;
    expect(run.report).toMatchObject({ mode: 'analyse', added: 0, planned: 1 });
    expect(run.report!.outcomes).toEqual({ new: 1, identical: 1 });
    expect(t.stage7.list('plan').items.map((b) => (b as { folder: string }).folder)).toEqual([
      'japanese/作者A/新しい本',
    ]);
  });

  it('On adds it as a hard link with its metadata.json; the check passes; ABS shows it with our values', async () => {
    const t = setup({ absShows: true });
    setAudioStageMode(t.db, 7, 'on');
    const torrentsBefore = treeProof(t.disk.torrents);
    const oldBook = treeProof(path.join(t.disk.library, '作者A', '既存の本'));
    t.stage7.requestRun();
    t.stage7.maybeStart();
    await drive(t);
    const run = t.stage7.lastRun()!;
    expect(run.progress.check?.passed).toBe(true);
    expect(run.report).toMatchObject({ mode: 'on', added: 1 });
    const linked = path.join(t.disk.library, '作者A', '新しい本', '新しい本.m4b');
    expect(fs.lstatSync(linked).ino).toBe(
      fs.lstatSync(path.join(t.disk.torrents, 'new', '新しい本.m4b')).ino,
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(t.disk.library, '作者A', '新しい本', 'metadata.json'), 'utf8'),
      ).title,
    ).toBe('新しい本');
    expect(treeProof(path.join(t.disk.library, '作者A', '既存の本'))).toEqual(oldBook);
    const after = treeProof(t.disk.torrents);
    expect([...after.keys()]).toEqual([...torrentsBefore.keys()]);
    expect(run.progress.abs).toMatchObject({
      found: 1,
      missing: 0,
      valuesOk: 1,
      nudged: 0,
      precedence: 'folderStructure < audioMetatags < absMetadata',
    });
    expect(t.calls.some((c) => c.startsWith('POST'))).toBe(false);
    // The next run finds the new book in the library: nothing more to add.
    db_reset_stage1(t.db, t.disk);
    t.stage7.requestRun();
    t.stage7.maybeStart();
    await drive(t);
    expect(t.stage7.lastRun()!.report).toMatchObject({ added: 0, planned: 0 });
  });

  it('when ABS doesn’t show the book: listed for review with the nudge off; told with it on', async () => {
    const t = setup({ absShows: false });
    updateSettings(t.db, {
      audiobooks: { ...getSettings(t.db).audiobooks, arrivalsAbsWaitMinutes: 0 },
    });
    setAudioStageMode(t.db, 7, 'on');
    t.stage7.requestRun();
    t.stage7.maybeStart();
    await drive(t);
    expect(t.stage7.lastRun()!.progress.abs).toMatchObject({ found: 0, missing: 1, nudged: 0 });
    expect(t.calls.some((c) => c.startsWith('POST'))).toBe(false);
    expect(t.stage7.list('review').items.map((r) => (r as { kind: string }).kind)).toEqual([
      'abs_missing',
    ]);

    const u = setup({ absShows: false });
    updateSettings(u.db, {
      audiobooks: {
        ...getSettings(u.db).audiobooks,
        arrivalsAbsWaitMinutes: 0,
        arrivalsAbsNudge: true,
      },
    });
    setAudioStageMode(u.db, 7, 'on');
    u.stage7.requestRun();
    u.stage7.maybeStart();
    await drive(u);
    expect(u.calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/watcher/update']);
    expect(u.stage7.lastRun()!.progress.abs.nudged).toBe(1);
  });

  it('every polled or claimed query of stage 7 uses an index', () => {
    const t = setup({ absShows: true });
    const plan = (sql: string, ...args: unknown[]) =>
      (t.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    for (const [sql, args] of [
      [`SELECT id FROM audio_archives WHERE state = 'new' AND mtime_ms <= ? ORDER BY id`, [0]],
      [
        `SELECT e.*, a.rel FROM audio_archive_entries e JOIN audio_archives a ON a.id = e.archive_id WHERE e.state = 'planned' AND a.state = 'listed' ORDER BY e.archive_id, e.seq LIMIT 1`,
        [],
      ],
      [
        `SELECT * FROM audio_arrival_ops WHERE run_id = ? AND state = 'planned' ORDER BY id LIMIT ?`,
        [1, 50],
      ],
      [
        `SELECT 1 FROM audio_arrival_batches WHERE state = 'claimed' AND lease_until >= ? LIMIT 1`,
        [0],
      ],
      [
        `SELECT kind, COUNT(*) AS n FROM audio_arrival_reviews WHERE resolved_at IS NULL GROUP BY kind`,
        [],
      ],
      [`SELECT state, COUNT(*) AS n FROM audio_arrival_ops WHERE run_id = ? GROUP BY state`, [1]],
      [
        `SELECT unit_key, name FROM audio_arrivals WHERE run_id = ? AND outcome = ? ORDER BY name LIMIT 50`,
        [1, 'new'],
      ],
      [`SELECT progress_json FROM audio_arrival_runs WHERE id = ?`, [1]],
    ] as [string, unknown[]][]) {
      const p = plan(sql, ...args);
      expect(p, sql).not.toMatch(/SCAN audio_arrival|SCAN audio_archive|SCAN e\b|SCAN a\b/);
    }
  });
});

/** The next run's stage 1 would see the new link in the library: put it in audio_files. */
function db_reset_stage1(db: Database.Database, disk: { library: string }) {
  const p = path.join(disk.library, '作者A', '新しい本', '新しい本.m4b');
  const st = fs.lstatSync(p);
  db.prepare(
    `INSERT INTO audio_files (root, rel_path, ext, kind, size, mtime_ms, dev, ino, nlink, first_seen_at, seen_at)
     VALUES ('library', '作者A/新しい本/新しい本.m4b', '.m4b', 'audio', ?, ?, ?, ?, ?, 0, 0)`,
  ).run(st.size, Math.floor(st.mtimeMs), st.dev, st.ino, st.nlink);
}

describe('the page’s E/F/J line (polled)', () => {
  it('reads the stage-5 values only when stage 5 or the AI settings changed, or after 10 minutes', () => {
    const db = freshDb('wp21f-est');
    let now = 1_000_000;
    let reads = 0;
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/FROM ai_values/.test(sql)) reads++;
      return prepare(sql);
    };
    const stage = new AudioStage7({
      db,
      roots: { torrents: '/none', library: '/none', media: null },
      lock: new DiskLock(5),
      reanalyse: () => undefined,
      abs: () => null,
      now: () => now,
    });
    stage.status();
    const once = reads;
    expect(once).toBeGreaterThan(0);
    now += 5 * 60_000;
    stage.status();
    stage.status();
    expect(reads).toBe(once);
    // Stage 5 decided again: computed again.
    db.prepare(`UPDATE audio_stages SET progress_json = ? WHERE stage = 5`).run(
      JSON.stringify({ analysisId: 'x', phase: 'done', decided: 7 }),
    );
    stage.status();
    expect(reads).toBe(2 * once);
    now += 11 * 60_000;
    stage.status();
    expect(reads).toBe(3 * once);
  });
});

describe("Audiobookshelf's values against our metadata.json", () => {
  const ours = {
    title: '新しい本 1',
    authors: ['作者A'],
    narrators: ['読み・手'],
    series: ['シリーズ #1', 'アンソロジー'],
    asin: 'B0AAAAAAA1',
  };
  it("reads ABS's own form (authors as objects, series with sequences); a difference counts", () => {
    const abs = {
      title: '新しい本 1',
      authors: [{ id: 'a', name: '作者A' }],
      narrators: ['読み手'],
      series: [
        { id: 's2', name: 'アンソロジー', sequence: null },
        { id: 's1', name: 'シリーズ', sequence: '1' },
      ],
      asin: 'B0AAAAAAA1',
    };
    expect(absValuesAgree(abs, ours)).toBe(true);
    expect(absValuesAgree({ ...abs, title: '別の題' }, ours)).toBe(false);
    expect(absValuesAgree({ ...abs, series: [{ name: 'シリーズ', sequence: '2' }] }, ours)).toBe(
      false,
    );
    expect(absValuesAgree(null, ours)).toBe(false);
  });
});
