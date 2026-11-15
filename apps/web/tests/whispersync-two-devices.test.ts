/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP15c: whispersync's data between two devices through the real storage server
 * (tests/helpers/sync-harness.ts), with whispersync's own rows kept in memory:
 * - position: newest wins, an older save never overwrites a newer one;
 * - saved subtitles: uploaded on A, written into B's subtitle row;
 * - saved match: uploaded on A, B gets the matched text with its backup;
 * - Reset match on A: B restores its backup; a stale upload is refused;
 * - DATA_DIR changes only below .uploads/attachments.
 */
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibraryApi } from '$lib/library/api';
import {
  pushMatch,
  pushPosition,
  pushSubtitles,
  resetMatch,
  syncBook,
  type AudioBookRow,
  type DataRow,
  type SubtitleRow,
  type SyncDeps
} from '$lib/audio/whispersync-sync';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const MATCHED = '<div data-ttu-whispersync-matched-by="a.srt"><span>matched</span></div>';
const ORIGINAL = '<div>original</div>';

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function rows() {
  const audioBook = new Map<string, AudioBookRow>();
  const subtitle = new Map<string, SubtitleRow>();
  const data = new Map<number, DataRow>();
  return {
    audioBook,
    subtitle,
    data,
    local: {
      getAudioBook: async (t: string) => audioBook.get(t),
      putAudioBook: async (r: AudioBookRow) => void audioBook.set(r.title, r),
      getSubtitle: async (t: string) => subtitle.get(t),
      putSubtitle: async (r: SubtitleRow) => void subtitle.set(r.title, r),
      getData: async (id: number) => data.get(id),
      putData: async (r: DataRow) => void data.set(r.id, r)
    }
  };
}

const server = new TestServer();

describe('whispersync between devices (real server)', () => {
  let a: Device;
  let b: Device;
  let bookId: string;
  const rowsA = rows();
  const rowsB = rows();
  let depsA: SyncDeps;
  let depsB: SyncDeps;
  let dataBefore: string[];
  const TITLE = '本';

  beforeAll(async () => {
    await server.start();
    await server.stop();
    const seed = seedServer(server, 2, { catalog: true });
    bookId = seed.bookId;
    await server.start();
    dataBefore = files(server.dataDir);
    a = new Device('A', seed.tokens[0], server);
    b = new Device('B', seed.tokens[1], server);
    await a.open();
    await b.open();
    await a.sync();
    await b.sync();
    const deps = (device: Device, token: string, r: ReturnType<typeof rows>): SyncDeps => {
      const api = new LibraryApi(server.url, token, 20);
      return {
        engine: device.engine,
        local: r.local,
        api: {
          upload: (id, name, body, modifiedAt) => api.uploadAttachment(id, name, body, modifiedAt),
          download: (id, name) => api.downloadAttachment(id, name)
        }
      };
    };
    depsA = deps(a, seed.tokens[0], rowsA);
    depsB = deps(b, seed.tokens[1], rowsB);
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  const bookA = () => ({ bookId, localId: 1, title: TITLE });
  const bookB = () => ({ bookId, localId: 9, title: TITLE });
  const syncAll = async () => {
    for (const d of [a, b, a, b]) await d.sync();
  };

  it('position: newest wins, never older over newer', async () => {
    const t = Date.now();
    rowsA.audioBook.set(TITLE, { title: TITLE, playbackPosition: 100, lastAudioBookModified: t });
    await pushPosition(depsA, bookA());
    await syncAll();
    expect((await syncBook(depsB, bookB())).changed.position).toBe(true);
    expect(rowsB.audioBook.get(TITLE)?.playbackPosition).toBe(100);

    // B listens on; A had an older save that must not win.
    rowsB.audioBook.set(TITLE, {
      title: TITLE,
      playbackPosition: 250,
      lastAudioBookModified: t + 5000
    });
    await pushPosition(depsB, bookB());
    rowsA.audioBook.set(TITLE, {
      title: TITLE,
      playbackPosition: 150,
      lastAudioBookModified: t + 1000
    });
    await syncAll();
    await pushPosition(depsA, bookA());
    await syncAll();
    await syncBook(depsA, bookA());
    expect(rowsA.audioBook.get(TITLE)?.playbackPosition).toBe(250);
    expect(rowsB.audioBook.get(TITLE)?.playbackPosition).toBe(250);
  });

  it('saved subtitles go from A to B', async () => {
    const subtitleData = { name: 'a.srt', subtitles: [{ id: '1', text: 'テスト' }] };
    rowsA.subtitle.set(TITLE, { title: TITLE, subtitleData, lastSubtitleDataModified: Date.now() });
    expect(await pushSubtitles(depsA, bookA())).toBe('ok');
    await syncAll();
    expect((await syncBook(depsB, bookB())).changed.subtitles).toBe(true);
    expect(rowsB.subtitle.get(TITLE)?.subtitleData).toEqual(subtitleData);
  });

  it('a saved match reaches B with its backup; Reset match on A restores B', async () => {
    const t = Date.now();
    rowsA.data.set(1, {
      id: 1,
      title: TITLE,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: t
    });
    rowsB.data.set(9, {
      id: 9,
      title: TITLE,
      elementHtml: ORIGINAL,
      lastBookModified: t - 100_000
    });
    expect(await pushMatch(depsA, bookA())).toBe('ok');
    await syncAll();
    expect((await syncBook(depsB, bookB())).changed.match).toBe(true);
    expect(rowsB.data.get(9)).toMatchObject({
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: t
    });

    // An older match from elsewhere is refused by the server.
    const stale = await depsB.api.upload(bookId, 'whispersync-match', '{"elementHtml":"x"}', t - 1);
    expect(stale).toBe('stale');

    // Reset match on A: whispersync's own reset, then the shared match goes.
    await new Promise((r) => setTimeout(r, 5));
    rowsA.data.set(1, { id: 1, title: TITLE, elementHtml: ORIGINAL, lastBookModified: Date.now() });
    await resetMatch(depsA, bookA());
    await syncAll();
    expect((await syncBook(depsB, bookB())).changed.match).toBe(true);
    const restored = rowsB.data.get(9)!;
    expect(restored.elementHtml).toBe(ORIGINAL);
    expect(restored.htmlBackup).toBeUndefined();
    // Level: nothing more to do on either device.
    expect((await syncBook(depsB, bookB())).changed).toEqual({
      position: false,
      subtitles: false,
      match: false
    });
    expect((await syncBook(depsA, bookA())).changed.match).toBe(false);
  });

  it('a book first stored on B after A matched picks the match up, also after removing and reopening', async () => {
    // A matches again (after the reset above).
    await new Promise((r) => setTimeout(r, 5));
    const t = Date.now();
    rowsA.data.set(1, {
      id: 1,
      title: TITLE,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: t
    });
    expect(await pushMatch(depsA, bookA())).toBe('ok');
    await syncAll();
    const matchRecord = async () =>
      (await a.engine.get('book-attachment', `${bookId}:whispersync-match`))?.data.modifiedAt;
    expect(await matchRecord()).toBe(t);

    // B stores the book only now: its unmatched copy's save time is after the match.
    rowsB.data.clear();
    rowsB.data.set(11, {
      id: 11,
      title: TITLE,
      elementHtml: ORIGINAL,
      lastBookModified: t + 60_000
    });
    const firstB = { bookId, localId: 11, title: TITLE };
    expect((await syncBook(depsB, firstB)).changed.match).toBe(true);
    expect(rowsB.data.get(11)).toMatchObject({
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: t
    });
    // Level: B uploads nothing, so A's match stays the same record (no notice on A).
    expect((await syncBook(depsB, firstB)).changed.match).toBe(false);
    await syncAll();
    expect(await matchRecord()).toBe(t);
    expect((await syncBook(depsA, bookA())).changed.match).toBe(false);

    // "Remove from this device" on B, then opened again: a new local copy, stored later.
    rowsB.data.clear();
    rowsB.data.set(12, {
      id: 12,
      title: TITLE,
      elementHtml: ORIGINAL,
      lastBookModified: t + 120_000
    });
    const againB = { bookId, localId: 12, title: TITLE };
    expect((await syncBook(depsB, againB)).changed.match).toBe(true);
    expect(rowsB.data.get(12)).toMatchObject({ elementHtml: MATCHED, htmlBackup: ORIGINAL });

    // Reset match on A still applies on B.
    await new Promise((r) => setTimeout(r, 5));
    rowsA.data.set(1, { id: 1, title: TITLE, elementHtml: ORIGINAL, lastBookModified: Date.now() });
    await resetMatch(depsA, bookA());
    await syncAll();
    expect((await syncBook(depsB, againB)).changed.match).toBe(true);
    expect(rowsB.data.get(12)?.elementHtml).toBe(ORIGINAL);
    expect(rowsB.data.get(12)?.htmlBackup).toBeUndefined();
    expect((await syncBook(depsB, againB)).changed.match).toBe(false);
    expect((await syncBook(depsA, bookA())).changed.match).toBe(false);
  });

  it('Season 2: a match is applied only to a copy of the file it was made from', async () => {
    const X = 'a'.repeat(64);
    const Y = 'b'.repeat(64);
    const MATCHED_Y = '<div data-ttu-whispersync-matched-by="b.srt"><span>new text</span></div>';
    const syncMatch = async (deps: SyncDeps, ref: ReturnType<typeof bookA>) => syncBook(deps, ref);

    // A matches its copy of file X.
    await new Promise((r) => setTimeout(r, 5));
    const t = Date.now();
    rowsA.data.set(1, {
      id: 1,
      title: TITLE,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: t
    });
    expect(await pushMatch(depsA, { ...bookA(), fileSha256: X })).toBe('ok');
    await syncAll();

    // B with a copy of file X (stored later) picks it up.
    rowsB.data.clear();
    rowsB.data.set(21, { id: 21, title: TITLE, elementHtml: ORIGINAL, lastBookModified: t + 1000 });
    const bOnX = { bookId, localId: 21, title: TITLE, fileSha256: X };
    expect((await syncMatch(depsB, bOnX)).changed.match).toBe(true);
    expect(rowsB.data.get(21)?.elementHtml).toBe(MATCHED);

    // B with a copy of the changed file Y never gets it, and uploads nothing.
    rowsB.data.set(22, {
      id: 22,
      title: TITLE,
      elementHtml: '<div>new text</div>',
      lastBookModified: t + 2000
    });
    const bOnY = { bookId, localId: 22, title: TITLE, fileSha256: Y };
    const skipped = await syncMatch(depsB, bOnY);
    expect(skipped.changed.match).toBe(false);
    expect(skipped.skippedMatch).toBe(true);
    expect(rowsB.data.get(22)?.elementHtml).toBe('<div>new text</div>');
    await syncAll();
    const record = async () =>
      (await a.engine.get('book-attachment', `${bookId}:whispersync-match`))?.data.modifiedAt;
    expect(await record()).toBe(t);

    // A updates to Y and matches again: B on X skips it, B on Y pulls it.
    await new Promise((r) => setTimeout(r, 5));
    const t2 = Date.now();
    rowsA.data.set(1, {
      id: 1,
      title: TITLE,
      elementHtml: MATCHED_Y,
      htmlBackup: '<div>new text</div>',
      lastBookModified: t2
    });
    expect(await pushMatch(depsA, { ...bookA(), fileSha256: Y })).toBe('ok');
    await syncAll();
    const onX = await syncMatch(depsB, bOnX);
    expect(onX.changed.match).toBe(false);
    expect(rowsB.data.get(21)?.elementHtml).toBe(MATCHED);
    expect((await syncMatch(depsB, bOnY)).changed.match).toBe(true);
    expect(rowsB.data.get(22)?.elementHtml).toBe(MATCHED_Y);
  });

  it('writes only below DATA_DIR/.uploads/attachments', () => {
    const added = files(server.dataDir).filter((f) => !dataBefore.includes(f));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((f) => f.startsWith('.uploads/attachments/'))).toBe(true);
  });
});
