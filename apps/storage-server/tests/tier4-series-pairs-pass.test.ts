/**
 * Tier 4, Part 3: series under a short and a full name, the pass (src/cleanup/series-pairs/
 * pass.ts) on a real cleanup.db with a stand-in library and stand-in batches.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEANUP_SCHEMA_VERSION, openCleanupDatabase } from '../src/cleanup/cleanup-db';
import {
  SeriesPairs,
  seriesPairsAnalysisId,
  type SpFacts,
  type SpLibraryBook,
} from '../src/cleanup/series-pairs/pass';
import { makeTempDir } from './helpers/spawn-server';

const LIB = 'lib1';

describe('series under two names: the pass', () => {
  let dir: string;
  let db: Database.Database;
  let books: SpLibraryBook[];
  let facts: Map<string, SpFacts>;
  let planned: string[];
  let pass: SeriesPairs;
  let wait: string | null;

  const book = (
    calibreId: number,
    title: string,
    series: string,
    index: number,
    authors = ['作者'],
  ): SpLibraryBook => ({
    uuid: `u${calibreId}`,
    calibreId,
    title,
    authors,
    identifiers: {},
    series,
    index,
  });

  const make = () =>
    new SeriesPairs({
      db,
      source: { books: () => books, facts: (_lib, uuid) => facts.get(uuid) ?? null },
      batches: {
        plan: async (_lib: string, o: { analysisId?: string }) => {
          const n = db
            .prepare(
              `UPDATE proposed_changes SET state = 'applied' WHERE analysis_id = ? AND state = 'proposed' AND class = 'auto'`,
            )
            .run(o.analysisId).changes;
          if (!n) return { batch: null, reason: 'Nothing left to write' };
          planned.push(String(o.analysisId));
          return { batch: { id: `b${planned.length}` } as never, reason: null };
        },
      },
      targetLibrary: () => LIB,
      writeWait: () => wait,
    });

  const run = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await pass.step();
      if (r === 'idle' || r === 'wait') return r;
    }
    return 'more';
  };

  const pairOf = (short: string) =>
    db.prepare('SELECT * FROM series_pairs WHERE short_name = ?').get(short) as {
      id: number;
      answer: string;
      rule: string | null;
      held: string | null;
      note: string | null;
      kept_name: string;
    };

  const proposals = () =>
    db
      .prepare(
        `SELECT calibre_uuid, old_json, new_json, state FROM proposed_changes WHERE source = 'series-pairs' ORDER BY calibre_id`,
      )
      .all() as { calibre_uuid: string; old_json: string; new_json: string; state: string }[];

  beforeEach(() => {
    dir = makeTempDir('series-pairs-');
    db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
    planned = [];
    wait = null;
    facts = new Map();
    books = [
      // 十津川警部 / 十津川警部シリーズ: one author, one Amazon series, no clash: merge.
      book(1, '寝台特急殺人事件', '十津川警部', 1, ['西村京太郎']),
      book(2, '終着駅殺人事件', '十津川警部', 2, ['西村京太郎']),
      book(3, '十津川警部捜査行 北海道殺人ガイド', '十津川警部シリーズ', 56, ['西村京太郎']),
      // スパイ教室 / スパイ教室 短編集: a spin-off word: separate.
      book(10, 'スパイ教室01', 'スパイ教室', 1, ['竹町']),
      book(11, 'スパイ教室 短編集01', 'スパイ教室 短編集', 1, ['竹町']),
      // はにとらっ！: one series, but two books on #1: review (held for the clash).
      book(20, 'はにとらっ！ 9', 'はにとらっ！', 1, ['けてる']),
      book(
        21,
        'はにとらっ！～召喚勇者をハメるハニートラップ包囲網～ 1',
        'はにとらっ！～召喚勇者をハメるハニートラップ包囲網～',
        1,
        ['けてる'],
      ),
      // 半沢直樹: a merge, but one book's series is the user's: review.
      book(30, 'オレたちバブル入行組', '半沢直樹', 1, ['池井戸潤']),
      book(31, '銀翼のイカロス', '半沢直樹シリーズ', 4, ['池井戸潤']),
      // ミルク: a merge Claude's check holds for review.
      book(40, 'ミルクナース', 'ミルク', 3, ['神崎美宙']),
      book(41, 'ミルク生徒会長', 'ミルクシリーズ', 5, ['神崎美宙']),
    ];
    for (const b of books.filter((b) => b.series?.startsWith('十津川')))
      facts.set(b.uuid, {
        kind: 'full',
        own: [b.title],
        amazonSeries: '十津川警部シリーズ',
        ranobedbSeries: null,
        bookwalkerUrl: null,
        asin: null,
      });
    for (const b of books.filter((b) => b.series?.startsWith('はにとら')))
      facts.set(b.uuid, {
        kind: 'full',
        own: [b.title],
        amazonSeries: 'はにとらっ！～召喚勇者をハメるハニートラップ包囲網～',
        ranobedbSeries: null,
        bookwalkerUrl: null,
        asin: null,
      });
    db.prepare(
      `INSERT INTO user_fields (library_id, calibre_uuid, field, value_json, source, since) VALUES (?, 'u31', 'series', '{}', 'edit', 0)`,
    ).run(LIB);
    pass = make();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is cleanup.db v31 with its tables, Off by default', async () => {
    expect(CLEANUP_SCHEMA_VERSION).toBeGreaterThanOrEqual(31);
    expect(pass.state().mode).toBe('off');
    expect(await pass.step()).toBe('idle');
    const cols = db.prepare('PRAGMA table_info(series_pair_decisions)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['decided_by', 'note']));
  });

  it('Preview answers every pair and proposes the merges, and writes nothing', async () => {
    pass.setMode('analyse');
    expect(await run()).toBe('idle');
    const p = pass.state().progress;
    expect(p.phase).toBe('write');
    expect(p.pairs).toBe(5);
    expect(pairOf('十津川警部')).toMatchObject({ answer: 'merge', kept_name: '十津川警部' });
    expect(pairOf('スパイ教室')).toMatchObject({ answer: 'separate', rule: 'spinoff-not-omnibus' });
    expect(pairOf('はにとらっ！')).toMatchObject({ answer: 'review', held: 'collision' });
    expect(pairOf('半沢直樹')).toMatchObject({ answer: 'review', held: 'yours' });
    expect(pairOf('ミルク')).toMatchObject({ answer: 'review', held: 'check' });
    expect(pairOf('ミルク').note).toMatch(/adult-content gate/);
    // Only the full name's book moves; its number stays.
    expect(proposals()).toEqual([
      {
        calibre_uuid: 'u3',
        old_json: JSON.stringify({ name: '十津川警部シリーズ', index: 56 }),
        new_json: JSON.stringify({ name: '十津川警部', index: 56 }),
        state: 'proposed',
      },
    ]);
    expect(planned).toEqual([]);
    // The review list shows the three for review, with their books.
    const list = pass.list(LIB, 'review', 0, 20);
    expect(list.total).toBe(3);
    expect(list.pairs.map((x) => x.short).sort()).toEqual(
      ['ミルク', '半沢直樹', 'はにとらっ！'].sort(),
    );
    expect(list.pairs[0].books.short.length + list.pairs[0].books.long.length).toBeGreaterThan(0);
  });

  it('On writes the merges, then the open stage-4 proposals follow the merge', async () => {
    // Stage 4's open review items: one moves a merged book back to the full name with its
    // number (closed), one gives a kept-name book the full name with another number (moved).
    const ins = db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
         evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, ?, ?, 'series', ?, ?, 'decided', '{}', 'review', 'x', 'proposed', 'a1', 0, 0)`,
    );
    ins.run(
      LIB,
      3,
      'u3',
      JSON.stringify({ name: '十津川警部シリーズ', index: 56 }),
      JSON.stringify({ name: '十津川警部シリーズ', index: 56 }),
    );
    ins.run(
      LIB,
      2,
      'u2',
      JSON.stringify({ name: '十津川警部', index: 2 }),
      JSON.stringify({ name: '十津川警部シリーズ', index: 7 }),
    );
    pass.setMode('on');
    await run();
    expect(planned).toEqual([seriesPairsAnalysisId(1)]);
    await run();
    const p = pass.state().progress;
    expect(p.phase).toBe('done');
    expect(proposals()[0].state).toBe('applied');
    const st4 = db
      .prepare(
        `SELECT calibre_uuid, old_json, new_json, state, review_reason FROM proposed_changes WHERE analysis_id = 'a1' ORDER BY calibre_id`,
      )
      .all() as {
      calibre_uuid: string;
      old_json: string;
      new_json: string;
      state: string;
      review_reason: string;
    }[];
    expect(st4[0]).toMatchObject({
      calibre_uuid: 'u2',
      state: 'proposed',
      new_json: JSON.stringify({ name: '十津川警部', index: 7 }),
    });
    expect(st4[1]).toMatchObject({ calibre_uuid: 'u3', state: 'skipped' });
    expect(st4[1].review_reason).toMatch(/Done by the series merge/);
    expect(p.write).toMatchObject({ closed: 1, repointed: 1, writtenAtStart: 0 });
    expect(p.write.startedAt).toBeGreaterThan(0);
    // Recorded as the rules' merge in the one record per pair (shared with the series editor).
    expect(
      db
        .prepare(
          `SELECT decision, decided_by FROM series_pair_decisions WHERE name_a = '十津川警部'`,
        )
        .get(),
    ).toEqual({ decision: 'merged', decided_by: 'rules' });
  });

  it('waits while the write must wait', async () => {
    wait = 'A batch is being applied';
    pass.setMode('on');
    expect(await run()).toBe('wait');
    expect(planned).toEqual([]);
    expect(pass.state().progress.write.waiting).toBe('A batch is being applied');
  });

  it('the review list: Merge, Keep separate, Forget my choice', async () => {
    pass.setMode('analyse');
    await run();
    const hani = pairOf('はにとらっ！');
    // Two books would share #1: Merge is refused.
    expect(() => pass.decidePair(LIB, hani.id, 'merge')).toThrow(/share a number/);
    // A series of yours: Merge is refused (the write would stop halfway).
    expect(() => pass.decidePair(LIB, pairOf('半沢直樹').id, 'merge')).toThrow(/series editor/);
    const milk = pairOf('ミルク');
    const merged = pass.decidePair(LIB, milk.id, 'merge');
    expect(merged.answer).toBe('merge');
    expect(merged.decision).toMatchObject({ decision: 'merged', by: 'you' });
    // The card's counts follow the choice (one more to merge, one fewer to decide).
    expect(pass.state().progress.counts).toEqual({ merge: 2, separate: 1, review: 2 });
    expect(proposals().map((x) => x.calibre_uuid)).toEqual(['u3', 'u41']);
    const kept = pass.decidePair(LIB, milk.id, 'separate');
    expect(kept.answer).toBe('separate');
    expect(proposals().map((x) => x.calibre_uuid)).toEqual(['u3']);
    // The series editor reads the same record: "not the same series".
    expect(
      db.prepare(`SELECT decision FROM series_pair_decisions WHERE name_a = 'ミルク'`).get(),
    ).toEqual({ decision: 'different' });
    const forgot = pass.decidePair(LIB, milk.id, 'clear');
    expect(forgot.decision).toBeNull();
    expect(forgot).toMatchObject({ answer: 'review', held: 'check' });
    expect(pass.list(LIB, 'decided', 0, 20).total).toBe(0);
  });

  it('Analyse again removes the earlier run’s open proposals, and times each phase', async () => {
    pass.setMode('analyse');
    await run();
    expect(pass.state().progress.times?.signals?.n).toBeGreaterThan(0);
    pass.again();
    expect(proposals()).toEqual([]);
    await run();
    expect(
      db
        .prepare(`SELECT DISTINCT analysis_id FROM proposed_changes WHERE source = 'series-pairs'`)
        .all(),
    ).toEqual([{ analysis_id: seriesPairsAnalysisId(2) }]);
  });

  it('a merged book is never proposed again after Undo', async () => {
    pass.setMode('on');
    await run();
    await run();
    db.prepare(`UPDATE proposed_changes SET state = 'undone' WHERE source = 'series-pairs'`).run();
    pass.again();
    await run();
    await run();
    expect(proposals().map((x) => x.state)).toEqual(['undone']);
  });
});
