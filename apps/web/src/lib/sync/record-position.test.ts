/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { CalibreLink } from '$lib/library/library-db';
import { recordPosition, type RecordPositionDeps } from './record-position';
import { openSyncDb } from './sync-db';
import { SyncEngine } from './sync-engine';

const BOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = '11111111-1111-4111-8111-111111111111';

function link(partial: Partial<CalibreLink> = {}): CalibreLink {
  return {
    bookId: BOOK,
    libraryId: 'lib',
    calibreLibraryUuid: null,
    calibreUuid: 'cal-uuid',
    calibreId: 1,
    localId: 7,
    title: '薬屋のひとりごと 1',
    calibreTitle: '薬屋のひとりごと 1',
    characters: 1000,
    fileEtag: null,
    linkedAt: 1,
    how: 'imported',
    ...partial
  };
}

let run = 0;
async function deps(links: CalibreLink[]): Promise<RecordPositionDeps & { warnings: string[] }> {
  run += 1;
  const name = `record-position-${run}`;
  const engine = await SyncEngine.open({ openDb: () => openSyncDb(name), newId: () => DEVICE });
  const warnings: string[] = [];
  return {
    getEngine: async () => engine,
    linksForLocalId: async (id) => links.filter((l) => l.localId === id),
    warn: (m) => warnings.push(m),
    warnings
  };
}

describe('recordPosition', () => {
  it('queues a position record for a linked book, keyed by book and device', async () => {
    const d = await deps([link()]);
    const queued = await recordPosition(
      7,
      '薬屋のひとりごと 1',
      { exploredCharCount: 523.4, progress: 0.52 },
      d
    );
    expect(queued).toBe(true);
    const engine = await d.getEngine();
    expect(await engine.get('position', `${BOOK}:${DEVICE}`)).toMatchObject({
      bookId: BOOK,
      deviceId: DEVICE,
      data: { charPos: 523, progress: 0.52, readThroughId: null }
    });
  });

  it("carries the book's current read-through after a Start over (WP8a)", async () => {
    const d = await deps([link()]);
    const engine = await d.getEngine();
    await engine.put(
      'read-through',
      `${BOOK}:2`,
      {
        number: 2,
        origin: 'start-over',
        startedOn: '2026-11-09',
        finished: false,
        finishedOn: null,
        manual: false,
        charCount: null
      },
      { bookId: BOOK }
    );
    await recordPosition(7, '薬屋のひとりごと 1', { exploredCharCount: 0, progress: 0 }, d);
    expect((await engine.get('position', `${BOOK}:${DEVICE}`))?.data).toEqual({
      charPos: 0,
      progress: 0,
      readThroughId: `${BOOK}:2`
    });
  });

  it('does nothing for books without a Calibre link or with a stale link', async () => {
    const d = await deps([link()]);
    expect(await recordPosition(8, 'Other', { exploredCharCount: 1, progress: 0 }, d)).toBe(false);
    // Same local id but the title changed: the WP6 link is stale.
    expect(await recordPosition(7, 'Renamed', { exploredCharCount: 1, progress: 0 }, d)).toBe(
      false
    );
    expect(await (await d.getEngine()).getAll('position')).toEqual([]);
  });

  it('normalizes odd progress values', async () => {
    const d = await deps([link()]);
    await recordPosition(7, '薬屋のひとりごと 1', { progress: '0.25' }, d);
    const engine = await d.getEngine();
    expect((await engine.get('position', `${BOOK}:${DEVICE}`))?.data).toEqual({
      charPos: 0,
      progress: 0.25,
      readThroughId: null
    });
    await recordPosition(7, '薬屋のひとりごと 1', { exploredCharCount: 5, progress: 'x' }, d);
    expect((await engine.get('position', `${BOOK}:${DEVICE}`))?.data.progress).toBeNull();
    await recordPosition(7, '薬屋のひとりごと 1', { exploredCharCount: 5, progress: 1.4 }, d);
    expect((await engine.get('position', `${BOOK}:${DEVICE}`))?.data.progress).toBe(1);
  });

  it('never throws, whatever fails', async () => {
    const warnings: string[] = [];
    const broken: RecordPositionDeps = {
      getEngine: async () => {
        throw new Error('no indexeddb');
      },
      linksForLocalId: async () => [link()],
      warn: (m) => warnings.push(m)
    };
    await expect(
      recordPosition(7, '薬屋のひとりごと 1', { exploredCharCount: 1, progress: 0 }, broken)
    ).resolves.toBe(false);
    const noLinks: RecordPositionDeps = {
      ...broken,
      linksForLocalId: async () => {
        throw new Error('library db gone');
      }
    };
    await expect(
      recordPosition(7, 't', { exploredCharCount: 1, progress: 0 }, noLinks)
    ).resolves.toBe(false);
    expect(warnings).toHaveLength(2);
  });
});
