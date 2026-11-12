/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { LibraryApi, LibraryApiError, normalizeServerUrl, pairDevice } from './api';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('normalizeServerUrl', () => {
  it('accepts what people type', () => {
    expect(normalizeServerUrl('tower:3081')).toBe('http://tower:3081');
    expect(normalizeServerUrl(' http://Tower:3081/ ')).toBe('http://tower:3081');
    expect(normalizeServerUrl('https://nas.example.ts.net/some/path')).toBe(
      'https://nas.example.ts.net'
    );
    expect(() => normalizeServerUrl('  ')).toThrow('Enter the server address');
  });
});

describe('LibraryApi', () => {
  it('sends the token and builds the query', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const api = new LibraryApi('http://s', 'ttsu_x', 0, async (input, init) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization')
      });
      return json(200, { books: [], nextCursor: null });
    });
    await api.books({ q: '薬屋 1', library: 'lib', cursor: 'c' });
    expect(seen).toEqual([
      {
        url: 'http://s/api/v1/books?q=%E8%96%AC%E5%B1%8B+1&library=lib&cursor=c',
        auth: 'Bearer ttsu_x'
      }
    ]);
  });

  it('maps failures to kinds the page can explain', async () => {
    const answer = (status: number, code: string) =>
      new LibraryApi('http://s', 't', 0, async () =>
        json(status, { error: { code, message: code } })
      );
    await expect(answer(401, 'unauthorized').me()).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(answer(503, 'indexer_off').libraries()).rejects.toMatchObject({
      kind: 'server',
      status: 503,
      code: 'indexer_off'
    });
    const down = new LibraryApi('http://s', 't', 0, async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(down.me()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('gives up after the timeout setting', async () => {
    const hang = new LibraryApi('http://s', 't', 0.05, (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
      });
    });
    await expect(hang.me()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports a cancelled request as aborted', async () => {
    const controller = new AbortController();
    const api = new LibraryApi('http://s', 't', 0, (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
        controller.abort();
      });
    });
    await expect(api.me({ signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('streams a download with progress', async () => {
    const api = new LibraryApi(
      'http://s',
      't',
      0,
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Length': '3', ETag: '"e"' }
        })
    );
    const progress: [number, number | null][] = [];
    const { blob, etag } = await api.downloadFile('b', new AbortController().signal, (l, t) =>
      progress.push([l, t])
    );
    expect(blob.size).toBe(3);
    expect(etag).toBe('"e"');
    expect(progress.at(-1)).toEqual([3, 3]);
  });
});

describe('LibraryApi audiobooks', () => {
  it("reads, changes and removes a book's audio link", async () => {
    const seen: { method: string; url: string; body: unknown; type: string | null }[] = [];
    const api = new LibraryApi('http://s', 't', 0, async (input, init) => {
      seen.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        type: new Headers(init?.headers).get('Content-Type')
      });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json(200, { link: { bookId: 'b 1', state: 'none' } });
    });
    expect(await api.audioLink('b 1')).toMatchObject({ state: 'none' });
    await api.putAudioLink('b 1', { audio: { state: 'linked', folderId: 4 } });
    await api.deleteAudioLink('b 1');
    const url = 'http://s/api/v1/books/b%201/audio-link';
    expect(seen).toEqual([
      { method: 'GET', url, body: undefined, type: null },
      {
        method: 'PUT',
        url,
        body: { audio: { state: 'linked', folderId: 4 } },
        type: 'application/json'
      },
      { method: 'DELETE', url, body: undefined, type: null }
    ]);
  });

  it('searches audiobooks and subtitles and asks for suggestions', async () => {
    const urls: string[] = [];
    const api = new LibraryApi('http://s', 't', 0, async (input) => {
      urls.push(String(input));
      return json(200, { audio: [{ id: 1 }], subtitles: [{ id: 2 }], links: [] });
    });
    expect(await api.searchAudiobooks('スパイ 2')).toEqual([{ id: 1 }]);
    expect(await api.searchSubtitles('x')).toEqual([{ id: 2 }]);
    await api.audioCandidates('b', 5);
    expect(await api.audioLinks()).toEqual([]);
    expect(urls).toEqual([
      'http://s/api/v1/audio/search?q=%E3%82%B9%E3%83%91%E3%82%A4+2&kind=audio',
      'http://s/api/v1/audio/search?q=x&kind=subtitle',
      'http://s/api/v1/books/b/audio/candidates?limit=5',
      'http://s/api/v1/audio/links'
    ]);
  });

  it("passes the server's refusal on with its code", async () => {
    const api = new LibraryApi('http://s', 't', 0, async () =>
      json(409, { error: { code: 'missing', message: 'gone' } })
    );
    await expect(
      api.putAudioLink('b', { audio: { state: 'linked', folderId: 1 } })
    ).rejects.toMatchObject({ kind: 'server', status: 409, code: 'missing' });
  });
});

describe('LibraryApi subtitle jobs (WP16)', () => {
  it('queues a job, or returns the archive files offered first', async () => {
    const seen: { method: string; url: string; body: unknown }[] = [];
    let answer: () => Response = () => json(202, { job: { id: 7, state: 'queued' } });
    const api = new LibraryApi('http://s', 't', 0, async (input, init) => {
      seen.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return answer();
    });
    expect(await api.startSubtitleJob('b 1', false)).toEqual({ job: { id: 7, state: 'queued' } });
    answer = () =>
      json(409, {
        error: { code: 'archive_match', message: 'x', candidates: [{ id: 3, name: 'a.srt' }] }
      });
    expect(await api.startSubtitleJob('b 1', false)).toEqual({
      archiveMatches: [{ id: 3, name: 'a.srt' }]
    });
    answer = () => json(409, { error: { code: 'busy', message: 'already' } });
    await expect(api.startSubtitleJob('b 1', true)).rejects.toMatchObject({
      status: 409,
      code: 'busy'
    });
    expect(seen.map((x) => [x.method, x.url, x.body])).toEqual([
      ['POST', 'http://s/api/v1/books/b%201/subtitle-job', { force: false }],
      ['POST', 'http://s/api/v1/books/b%201/subtitle-job', { force: false }],
      ['POST', 'http://s/api/v1/books/b%201/subtitle-job', { force: true }]
    ]);
  });

  it('reads and stops jobs, reads the worker and sets the pause switch', async () => {
    const seen: string[] = [];
    const api = new LibraryApi('http://s', 't', 0, async (input, init) => {
      seen.push(`${init?.method ?? 'GET'} ${String(input)} ${init?.body ?? ''}`.trim());
      return json(200, { job: { id: 7 }, available: true, paused: true });
    });
    expect(await api.subtitleJob('b')).toEqual({ id: 7 });
    expect(await api.cancelSubtitleJob(7)).toEqual({ id: 7 });
    expect(await api.gpuWorker()).toMatchObject({ available: true, paused: true });
    expect(await api.setGpuWorkerPaused(true)).toBe(true);
    expect(seen).toEqual([
      'GET http://s/api/v1/books/b/subtitle-job',
      'POST http://s/api/v1/audio/subtitle-jobs/7/cancel {}',
      'GET http://s/api/v1/gpu-worker',
      'PUT http://s/api/v1/gpu-worker/paused {"paused":true}'
    ]);
  });
});

describe('pairDevice', () => {
  it('returns the token, and a wrong code is not "unauthorized"', async () => {
    const ok = await pairDevice('http://s', 'AAAA-BBBB', {}, async () =>
      json(200, { token: 'ttsu_y', label: 'Boox' })
    );
    expect(ok).toEqual({ token: 'ttsu_y', label: 'Boox' });
    const bad = pairDevice('http://s', 'x', {}, async () =>
      json(401, {
        error: { code: 'invalid_code', message: 'Unknown, used or expired pairing code' }
      })
    );
    await expect(bad).rejects.toBeInstanceOf(LibraryApiError);
    await expect(bad).rejects.toMatchObject({ kind: 'server', code: 'invalid_code' });
  });
});
