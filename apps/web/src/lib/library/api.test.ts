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
