/**
 * New arrivals beside existing books (the user, 2026-11-25): the arrivals' series step decides a
 * series whole; a book already in Calibre whose choice changes is proposed under stage 4's own
 * analysis once the run's own changes are written (proposeExisting), never under the run's id.
 */
import { describe, expect, it } from 'vitest';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { emptyArrivalAi, ArrivalStage4Ai } from '../src/cleanup/arrivals/stage4-ai';
import type { SeriesBook } from '../src/cleanup/stage4/series-order';
import { cleanupRunner, makeAiCore } from './helpers/ai-env';
import { makeTempDir } from './helpers/spawn-server';

const NAME = 'ザ・シリーズ';
let id = 0;
function book(p: Partial<SeriesBook> & { title: string }): SeriesBook {
  id++;
  return {
    uuid: `u${id}`,
    calibreId: id,
    name: NAME,
    index: null,
    indexFrom: 'models',
    nameFrom: 'store',
    kind: 'full',
    own: [p.title],
    titleFrom: 'file',
    authors: ['作者'],
    records: [],
    storeSeries: [NAME],
    pool: [],
    date: null,
    ...p,
  };
}

describe('new arrivals: books already in Calibre in the series a run touches', () => {
  it('are proposed under stage 4’s own analysis after the write, the new book under the run', async () => {
    const s = initCleanupDatabase(makeTempDir('arrivals-existing'));
    if (!s.ok) throw new Error(s.error);
    const db = s.db;
    const one = book({ title: `${NAME}1`, index: 1 });
    // Already in Calibre on 2, though its own title prints 3: the series step moves it.
    const three = book({ title: `${NAME}3`, index: 2 });
    const fresh = book({ title: `${NAME}2`, index: 2 });
    // A series the run doesn't touch: never looked at.
    const other = book({
      title: 'べつの話2',
      name: 'べつの話',
      storeSeries: ['べつの話'],
      index: 1,
    });
    const all = [one, three, fresh, other];
    const after = new Map(
      all.map((b) => [b.uuid, { name: b.name, index: b.index, title: b.title, proposed: false }]),
    );
    const calls: { analysisId: string; uuid: string }[] = [];
    const analysis = {
      seriesStateAfterOn: () => after,
      seriesBook: (_p: unknown, uuid: string) => all.find((b) => b.uuid === uuid) ?? null,
      proposeWithAi: async (p: { analysisId: string }, uuid: string) => {
        calls.push({ analysisId: p.analysisId, uuid });
        return true;
      },
    };
    const step = new ArrivalStage4Ai({
      db,
      runner: cleanupRunner(db, makeAiCore().core),
      analysis: analysis as never,
    });
    const view = { analysisId: 'arrivals:7', libraryId: 'lib' } as never;
    const library = { analysisId: 'lib-analysis', libraryId: 'lib' } as never;
    const ai = { ...emptyArrivalAi('E'), phase: 'series' as const };
    expect(await step.step(view, ai, [fresh.uuid], null, () => false)).toBe('done');
    // The run proposes only its own book.
    expect(calls).toEqual([{ analysisId: 'arrivals:7', uuid: fresh.uuid }]);
    expect(ai.series).toMatchObject({
      existingChanged: 1,
      existing: [three.uuid],
      existingDone: 0,
    });
    // After the run's write: the book already in Calibre, under stage 4's own analysis.
    expect(await step.proposeExisting(library, ai.series!, () => false)).toBe(true);
    expect(calls.slice(1)).toEqual([{ analysisId: 'lib-analysis', uuid: three.uuid }]);
    expect(ai.series!.existingDone).toBe(1);
    // Done once: a second call proposes nothing again.
    expect(await step.proposeExisting(library, ai.series!, () => false)).toBe(true);
    expect(calls).toHaveLength(2);
    const row = db
      .prepare('SELECT idx, src FROM stage4_series_order WHERE calibre_uuid = ?')
      .get(three.uuid) as { idx: number; src: string };
    expect(row).toEqual({ idx: 3, src: 'its own title' });
  });
});
