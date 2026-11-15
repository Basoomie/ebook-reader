/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { get as read } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import type { AudioLink } from '$lib/audio/audio-types';
import { LibraryApiError } from '$lib/library/api';
import { AudioDownloads, type DownloadDeps } from './audio-download';
import { AudioOfflineStore, createAudioOfflineDb, type AudioCopy } from './audio-offline-db';

const BOOK = '11111111-1111-4111-8111-111111111111';
const PIECE = 1000;

let dbCount = 0;
function freshStore(): AudioOfflineStore {
  dbCount += 1;
  return new AudioOfflineStore(() => createAudioOfflineDb(`audio-test-${dbCount}-${Date.now()}`));
}

function bytesOf(size: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) % 251;
  return out;
}

/** A stand-in for the storage server's stream route: single ranges, `v`, 206/409/410. */
class RangeServer {
  bytes: Uint8Array<ArrayBuffer>;
  version = 'v1';
  ranges: string[] = [];
  /** Cut the body of request number `n` (1-based) after this many bytes. */
  cutRequest: { n: number; after: number } | null = null;
  /** Never finish the body of request number `n`. */
  stallRequest: number | null = null;
  /** Answer request number `n` with this status. */
  statusFor: { n: number; status: number } | null = null;
  wrongRange = false;
  onRequest: ((n: number) => void) | null = null;

  constructor(size: number) {
    this.bytes = bytesOf(size);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'http://server');
    const range = new Headers(init?.headers).get('Range') ?? '';
    this.ranges.push(range);
    const n = this.ranges.length;
    this.onRequest?.(n);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.statusFor?.n === n) return new Response('{}', { status: this.statusFor.status });
    if (url.searchParams.get('v') !== this.version) return new Response('{}', { status: 409 });
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response(new Blob([this.bytes as Uint8Array<ArrayBuffer>]), { status: 200 });
    const start = +m[1];
    const end = Math.min(+m[2], this.bytes.length - 1);
    const part = this.bytes.slice(start, end + 1);
    const headers = {
      'Content-Type': 'audio/mp4',
      'Content-Range': this.wrongRange
        ? `bytes ${start + 1}-${end}/${this.bytes.length}`
        : `bytes ${start}-${end}/${this.bytes.length}`
    };
    const cut = this.cutRequest?.n === n ? this.cutRequest.after : null;
    const stall = this.stallRequest === n;
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = cut ?? part.length;
        for (let i = 0; i < send; i += 300)
          controller.enqueue(part.slice(i, Math.min(send, i + 300)));
        if (cut !== null) {
          controller.error(new TypeError('network error'));
          return;
        }
        if (stall) {
          signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError'))
          );
          return;
        }
        controller.close();
      }
    });
    return new Response(body, { status: 206, headers });
  };
}

function linkFor(server: RangeServer, over: Partial<AudioLink> = {}): AudioLink {
  return {
    bookId: BOOK,
    state: 'linked',
    folderRelPath: 'japanese/本',
    fileName: '本.m4b',
    subtitleState: 'linked',
    subtitleRelPath: 'japanese-srt/本.srt',
    source: 'library',
    confirmedAt: 1,
    folder: null,
    status: 'ok',
    subtitle: null,
    subtitleStatus: 'ok',
    playable: true,
    file: {
      name: '本.m4b',
      size: server.bytes.length,
      durationSeconds: 60,
      version: server.version
    },
    playUrl: `/api/v1/audio/files/1/0?v=${server.version}&u=u&s=s`,
    ...over
  };
}

function setup(size = 3500, over: Partial<DownloadDeps> = {}) {
  const server = new RangeServer(size);
  const store = freshStore();
  const calls = { published: 0, persisted: 0, subtitles: 0, logs: [] as string[] };
  let link: AudioLink | null = linkFor(server);
  let online = true;
  const deps: DownloadDeps = {
    store,
    link: async () => link,
    subtitle: async () => {
      calls.subtitles += 1;
      return new File(['1\n00:00:00,000 --> 00:00:01,000\nテスト\n'], '本.srt', {
        type: 'text/plain'
      });
    },
    absolute: async (url) => `http://server${url}`,
    fetch: server.fetch,
    stallSeconds: () => 5,
    estimate: async () => null,
    persist: async () => void (calls.persisted += 1),
    published: async () => void (calls.published += 1),
    now: () => 1000,
    isOnline: () => online,
    log: (m) => calls.logs.push(m),
    pieceSize: PIECE,
    ...over
  };
  const downloads = new AudioDownloads(deps);
  return {
    server,
    store,
    deps,
    calls,
    downloads,
    setLink: (l: AudioLink | null) => (link = l),
    setOnline: (v: boolean) => (online = v)
  };
}

async function storedBytes(store: AudioOfflineStore): Promise<Uint8Array> {
  const pieces = await store.pieces(BOOK);
  return new Uint8Array(await new Blob(pieces).arrayBuffer());
}

async function waitUntil(test: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("downloading a book's audio (Season 2 Phase 9)", () => {
  it('downloads the linked file in pieces, with its subtitles, then publishes', async () => {
    const t = setup();
    await t.downloads.start(BOOK);
    const copy = (await t.store.get(BOOK)) as AudioCopy;
    expect(copy).toMatchObject({
      complete: true,
      bytesDone: 3500,
      size: 3500,
      piecesDone: 4,
      version: 'v1',
      fileName: '本.m4b',
      folderRelPath: 'japanese/本',
      contentType: 'audio/mp4',
      stoppedBy: null,
      error: null,
      completedAt: 1000
    });
    expect(t.server.ranges).toEqual([
      'bytes=0-999',
      'bytes=1000-1999',
      'bytes=2000-2999',
      'bytes=3000-3499'
    ]);
    expect(await storedBytes(t.store)).toEqual(t.server.bytes);
    expect(copy.subtitle?.relPath).toBe('japanese-srt/本.srt');
    expect(await copy.subtitle!.blob.text()).toContain('テスト');
    expect(t.calls).toMatchObject({ published: 1, persisted: 1, subtitles: 1 });
    expect(t.downloads.isRunning(BOOK)).toBe(false);

    // Starting again changes nothing.
    await t.downloads.start(BOOK);
    expect(t.server.ranges).toHaveLength(4);
  });

  it('continues after a lost connection from the next piece, by itself when online', async () => {
    const t = setup();
    t.server.cutRequest = { n: 3, after: 400 };
    await t.downloads.start(BOOK);
    const stopped = (await t.store.get(BOOK)) as AudioCopy;
    expect(stopped).toMatchObject({
      complete: false,
      piecesDone: 2,
      bytesDone: 2000,
      stoppedBy: 'error',
      error: 'network'
    });
    expect(await t.store.pieceCount(BOOK)).toBe(2);
    expect(t.calls.published).toBe(0);

    t.downloads.onOnline();
    await waitUntil(() => t.downloads.isRunning(BOOK));
    await waitUntil(() => !t.downloads.isRunning(BOOK));
    expect(t.server.ranges.slice(3)).toEqual(['bytes=2000-2999', 'bytes=3000-3499']);
    expect((await t.store.get(BOOK))?.complete).toBe(true);
    expect(await storedBytes(t.store)).toEqual(t.server.bytes);
    // The subtitles were kept on the first run; not fetched again.
    expect(t.calls.subtitles).toBe(1);
  });

  it('stops when asked and continues only by tap', async () => {
    const t = setup();
    t.server.onRequest = (n) => {
      if (n === 2) t.downloads.stop(BOOK);
    };
    await t.downloads.start(BOOK);
    const stopped = (await t.store.get(BOOK)) as AudioCopy;
    expect(stopped).toMatchObject({ stoppedBy: 'user', piecesDone: 1, complete: false });

    t.downloads.onOnline();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.server.ranges).toHaveLength(2);

    t.server.onRequest = null;
    await t.downloads.start(BOOK);
    expect((await t.store.get(BOOK))?.complete).toBe(true);
    expect(t.server.ranges.slice(2)[0]).toBe('bytes=1000-1999');
    expect(await storedBytes(t.store)).toEqual(t.server.bytes);
  });

  it('stops on a file changed meanwhile (409); Start again downloads the new file', async () => {
    const t = setup();
    t.server.onRequest = (n) => {
      if (n === 2) t.server.version = 'v2';
    };
    await t.downloads.start(BOOK);
    expect(await t.store.get(BOOK)).toMatchObject({
      error: 'changed',
      stoppedBy: 'error',
      piecesDone: 1,
      version: 'v1'
    });

    // The link now names the new version: Continue leaves the old pieces alone.
    t.server.onRequest = null;
    t.server.bytes = bytesOf(2500, 99);
    t.setLink(linkFor(t.server));
    await t.downloads.start(BOOK, 'continue');
    expect(await t.store.get(BOOK)).toMatchObject({ version: 'v1', piecesDone: 1 });

    await t.downloads.start(BOOK, 'replace');
    expect(await t.store.get(BOOK)).toMatchObject({
      version: 'v2',
      complete: true,
      size: 2500
    });
    expect(await storedBytes(t.store)).toEqual(t.server.bytes);
  });

  it('says the file is missing (410/404) or the server answered wrongly', async () => {
    const a = setup();
    a.server.statusFor = { n: 2, status: 410 };
    await a.downloads.start(BOOK);
    expect(await a.store.get(BOOK)).toMatchObject({ error: 'missing', piecesDone: 1 });

    const b = setup();
    b.server.wrongRange = true;
    await b.downloads.start(BOOK);
    expect(await b.store.get(BOOK)).toMatchObject({ error: 'server', piecesDone: 0 });

    const c = setup();
    c.server.statusFor = { n: 1, status: 500 };
    await c.downloads.start(BOOK);
    expect(await c.store.get(BOOK)).toMatchObject({ error: 'server' });

    // No playable link: nothing is stored, the problem is shown.
    const d = setup();
    d.setLink({ ...linkFor(d.server), playable: false, playUrl: null });
    await d.downloads.start(BOOK);
    expect(await d.store.get(BOOK)).toBeUndefined();
    expect(get(d.downloads)[BOOK].problem).toBe('missing');
  });

  it('gives up on a piece when no bytes arrive for the library request time', async () => {
    const t = setup(3500, { stallSeconds: () => 0.05 });
    t.server.stallRequest = 2;
    await t.downloads.start(BOOK);
    expect(await t.store.get(BOOK)).toMatchObject({
      error: 'network',
      stoppedBy: 'error',
      piecesDone: 1
    });
  });

  it('refuses to start without room, and stops when the browser says the disk is full', async () => {
    const a = setup(3500, { estimate: async () => ({ quota: 1000, usage: 400 }) });
    await a.downloads.start(BOOK);
    expect(a.server.ranges).toEqual([]);
    expect(await a.store.get(BOOK)).toMatchObject({
      error: 'space',
      bytesNeeded: 3500 - 600,
      piecesDone: 0
    });

    const b = setup();
    const put = b.store.putPiece.bind(b.store);
    let calls = 0;
    b.store.putPiece = async (copy, index, piece) => {
      calls += 1;
      if (calls === 2) throw new DOMException('full', 'QuotaExceededError');
      return put(copy, index, piece);
    };
    await b.downloads.start(BOOK);
    expect(await b.store.get(BOOK)).toMatchObject({
      error: 'space',
      piecesDone: 1,
      bytesDone: 1000,
      bytesNeeded: 2500
    });
    expect(await b.store.pieceCount(BOOK)).toBe(1);
  });

  it('does not start offline or without the server, and stores nothing', async () => {
    const a = setup();
    a.setOnline(false);
    await a.downloads.start(BOOK);
    expect(a.server.ranges).toEqual([]);
    expect(get(a.downloads)[BOOK].problem).toBe('network');

    const b = setup(3500, {
      link: async () => {
        throw new LibraryApiError('unreachable', 'Failed to fetch');
      }
    });
    await b.downloads.start(BOOK);
    expect(await b.store.get(BOOK)).toBeUndefined();
    expect(get(b.downloads)[BOOK].problem).toBe('network');
  });

  it('never replaces a copy of another file on Continue; Replace does', async () => {
    const t = setup();
    await t.downloads.start(BOOK);
    t.server.bytes = bytesOf(1200, 3);
    t.server.version = 'v9';
    t.setLink(linkFor(t.server, { folderRelPath: 'japanese/別' }));
    await t.downloads.start(BOOK);
    expect(await t.store.get(BOOK)).toMatchObject({ version: 'v1', folderRelPath: 'japanese/本' });
    await t.downloads.start(BOOK, 'replace');
    expect(await t.store.get(BOOK)).toMatchObject({
      version: 'v9',
      folderRelPath: 'japanese/別',
      complete: true
    });
  });

  it('removes the record and every piece; a finished copy publishes the list', async () => {
    const t = setup();
    await t.downloads.start(BOOK);
    expect(t.calls.published).toBe(1);
    await t.downloads.remove(BOOK);
    expect(await t.store.get(BOOK)).toBeUndefined();
    expect(await t.store.pieceCount(BOOK)).toBe(0);
    expect(t.calls.published).toBe(2);
    expect(get(t.downloads)[BOOK].copy).toBeNull();
  });

  it('removes a running download after stopping it', async () => {
    const t = setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const fetchFirst = t.server.fetch;
    t.deps.fetch = async (input, init) => {
      if (t.server.ranges.length === 1) await held;
      return fetchFirst(input, init);
    };
    const running = t.downloads.start(BOOK);
    await waitUntil(() => t.server.ranges.length === 1);
    const removing = t.downloads.remove(BOOK);
    release();
    await Promise.all([running, removing]);
    expect(await t.store.get(BOOK)).toBeUndefined();
    expect(await t.store.pieceCount(BOOK)).toBe(0);
  });
});

function get(downloads: AudioDownloads) {
  return read(downloads.views);
}
