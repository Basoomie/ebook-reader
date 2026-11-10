/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP7b: uploads and Home between devices, against the real storage server with a
 * scratch copy of the Calibre 7.1 fixture (tests/helpers/sync-harness.ts):
 * - an EPUB uploaded on A shows up on B with source "upload" (the "Uploaded" badge);
 * - a copy of a Calibre EPUB is reported as a duplicate (fingerprint), never merged;
 * - B can set a status and add the uploaded book to a collection; A gets both;
 * - a place saved on A puts the uploaded book in B's Continue reading;
 * - Home rows are a per-device setting; uploads and state actions write no stat-day
 *   records, and the Calibre folder is byte-identical; DATA_DIR changes only in .uploads.
 */
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addBooks,
  createCollection,
  getCollectionsView,
  type CollectionsDeps
} from '$lib/collections/collections-service';
import { continueReadingIds } from '$lib/home/continue-reading';
import { LibraryApi } from '$lib/library/api';
import { positionsByBook } from '$lib/library/progress';
import type { StagedUpload } from '$lib/library/types';
import { positionReadThroughId } from '$lib/sync/book-state';
import {
  getAllBookStates,
  getBookState,
  setBookStatus,
  type BookStateDeps
} from '$lib/sync/book-state-service';
import { positionRecordId } from '$lib/sync/record-position';
import { settingScope } from '$lib/sync/settings-registry';
import { Device, tempDir, TestServer } from './helpers/sync-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../storage-server/tests/fixtures/calibre-7.1');
const CALIBRE_EPUB =
  'japanese-test/Ri Xiang Xia/Yao Wu nohitorigoto 1 (1)/Yao Wu nohitorigoto 1 - Ri Xiang Xia.epub';
const UPLOAD_EPUB = path.join(HERE, 'fixtures', 'synthetic-epub3.epub');

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else
        out[path.relative(dir, full)] = createHash('sha1')
          .update(fs.readFileSync(full))
          .digest('hex');
    }
  };
  walk(dir);
  return out;
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 60_000
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const calibreRoot = tempDir('calibre');
fs.cpSync(FIXTURE, calibreRoot, { recursive: true });
const server = new TestServer({
  CALIBRE_DIR: calibreRoot,
  CACHE_DIR: tempDir('cache'),
  CALIBRE_REQUIRE_READONLY: 'false',
  CALIBRE_SETTLE_SECONDS: '0',
  CALIBRE_POLL_SECONDS: '5',
  COUNT_BACKGROUND: 'false'
});

const stateDeps = (d: Device): BookStateDeps => ({
  getEngine: async () => d.engine,
  today: () => '2026-11-10',
  warn: () => {}
});
const collectionsDeps = (d: Device): CollectionsDeps => ({
  getEngine: async () => d.engine,
  warn: () => {}
});

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

describe('uploads between devices (real server)', () => {
  const tokens: string[] = [];
  let libraryId = '';
  let a: Device;
  let b: Device;
  let apiA: LibraryApi;
  let apiB: LibraryApi;
  let calibreBefore: Record<string, string>;
  let uploadedId = '';

  /** The web app sends the file with XMLHttpRequest; Node has none, so plain fetch here. */
  async function stage(token: string, file: string, name: string): Promise<StagedUpload> {
    const res = await fetch(
      `${server.url}/api/v1/uploads?${new URLSearchParams({ library: libraryId, name })}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/epub+zip' },
        body: fs.readFileSync(file)
      }
    );
    expect(res.status).toBe(201);
    return res.json();
  }

  beforeAll(async () => {
    calibreBefore = hashTree(calibreRoot);
    await server.start();
    for (const label of ['A', 'B']) {
      tokens.push(server.cli('token', 'create', label).trim().split(/\r?\n/).pop()!);
    }
    const libraryLine = await waitFor(async () =>
      server
        .cli('library', 'list')
        .split(/\r?\n/)
        .find((l) => l.includes('folder="japanese-test"'))
    );
    libraryId = libraryLine.split(/\s+/)[0];
    server.cli('library', 'set', libraryId, '--language', 'ja', '--enable');
    apiA = new LibraryApi(server.url, tokens[0], 20);
    apiB = new LibraryApi(server.url, tokens[1], 20);
    await waitFor(async () => (await apiA.books({ limit: 50 })).books.length >= 4);
    a = new Device('A', tokens[0], server);
    b = new Device('B', tokens[1], server);
    await a.open();
    await b.open();
    await syncAll(a, b);
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it('reports a copy of a Calibre EPUB as a duplicate and adds nothing until asked', async () => {
    const before = (await apiA.books({ limit: 50 })).books.length;
    const staged = await stage(tokens[0], path.join(calibreRoot, CALIBRE_EPUB), 'copy.epub');
    expect(staged.duplicates).toEqual([
      expect.objectContaining({
        match: 'fingerprint',
        book: expect.objectContaining({ title: '薬屋のひとりごと 1', source: 'calibre' })
      })
    ]);
    await apiA.discardUpload(staged.uploadId);
    expect((await apiA.books({ limit: 50 })).books.length).toBe(before);
  });

  it('shows a book uploaded on A on B, with the upload badge source', async () => {
    const staged = await stage(tokens[0], UPLOAD_EPUB, 'synthetic.epub');
    expect(staged.duplicates).toEqual([]);
    const { book } = await apiA.addUpload(staged.uploadId);
    uploadedId = book.id;
    expect(book.source).toBe('upload');
    const onB = (await apiB.books({ limit: 50 })).books.find((x) => x.id === uploadedId);
    expect(onB).toMatchObject({ source: 'upload', libraryId });
    const file = await apiB.downloadFile(uploadedId, new AbortController().signal);
    expect(Buffer.from(await file.blob.arrayBuffer()).equals(fs.readFileSync(UPLOAD_EPUB))).toBe(
      true
    );
  });

  it("carries B's status and collection for the uploaded book to A", async () => {
    await setBookStatus(uploadedId, 'reading', stateDeps(b));
    const list = await createCollection({ name: 'Uploads', type: 'manual' }, collectionsDeps(b));
    await addBooks(list, [uploadedId], collectionsDeps(b));
    await syncAll(b, a);
    expect((await getBookState(uploadedId, stateDeps(a))).status).toBe('reading');
    const view = await getCollectionsView(collectionsDeps(a));
    expect(view.items.get(list)?.map((i) => i.bookId)).toEqual([uploadedId]);
  });

  it("puts a book read on A into B's Continue reading", async () => {
    await setBookStatus(uploadedId, 'unread', stateDeps(a));
    const state = await getBookState(uploadedId, stateDeps(a));
    await a.engine.put(
      'position',
      positionRecordId(uploadedId, a.engine.deviceId),
      { charPos: 40, progress: 0.4, readThroughId: positionReadThroughId(state) },
      { bookId: uploadedId }
    );
    await syncAll(a, b);
    const ids = continueReadingIds(
      await getAllBookStates(stateDeps(b)),
      positionsByBook(await b.engine.getAll('position')),
      20
    );
    expect(ids[0]).toBe(uploadedId);
    const { books } = await apiB.lookup(ids);
    expect(books[0]).toMatchObject({ id: uploadedId, source: 'upload' });
  });

  it('keeps Home rows per device and writes no stat-day records', async () => {
    expect(settingScope('homeRows')).toBe('device');
    expect(settingScope('appOpenTarget')).toBe('device');
    expect(settingScope('homeRowLength')).toBe('device');
    for (const device of [a, b]) expect(await device.engine.getAll('stat-day')).toEqual([]);
  });

  it('never touched Calibre and wrote only .uploads in DATA_DIR', () => {
    expect(hashTree(calibreRoot)).toEqual(calibreBefore);
    expect(fs.readdirSync(server.dataDir)).toEqual(['.uploads']);
    expect(fs.readdirSync(path.join(server.dataDir, '.uploads', 'books'))).toEqual([uploadedId]);
    expect(fs.readdirSync(path.join(server.dataDir, '.uploads', 'staging'))).toEqual([]);
  });
});
