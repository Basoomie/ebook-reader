/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import { LibraryApiError } from '$lib/library/api';
import { loadGallery, type GallerySources, type GalleryState } from './gallery-source';
import type { LocalGallery } from './local-illustrations';
import type { ServerIllustrationList } from './types';

const picture = {
  beforeToc: false,
  width: 700,
  height: 1000,
  thumbSrc: 'blob:one',
  fullSrc: 'blob:one'
};

function run(sources: Partial<GallerySources>, signal = new AbortController().signal) {
  const states: GalleryState['kind'][] = [];
  let last: GalleryState | undefined;
  const done = loadGallery(
    'book-1',
    {
      local: async () => null,
      server: null,
      absolute: (url) => `https://nas${url}`,
      offline: false,
      pollMs: 1,
      ...sources
    },
    signal,
    (state) => {
      states.push(state.kind);
      last = state;
    }
  );
  return { done, states, last: () => last };
}

describe('loadGallery', () => {
  it("uses this device's copy first, online or offline, and never asks the server", async () => {
    const release = vi.fn();
    const local: LocalGallery = { pictures: [picture], coverSrc: 'blob:cover', release };
    const server = vi.fn();
    for (const offline of [false, true]) {
      const r = run({ local: async () => local, server, offline });
      expect(await r.done).toBe(local);
      expect(r.last()).toEqual({
        kind: 'ready',
        pictures: [picture],
        coverSrc: 'blob:cover',
        local: true
      });
    }
    expect(server).not.toHaveBeenCalled();
  });

  it('asks the server again while it prepares the list, then shows its signed pictures', async () => {
    const answers: ServerIllustrationList[] = [
      { status: 'preparing' },
      { status: 'preparing' },
      {
        status: 'ready',
        items: [{ n: 0, width: 640, height: 960, beforeToc: true, thumbUrl: '/t0', url: '/f0' }]
      }
    ];
    const server = vi.fn(async () => answers.shift()!);
    const r = run({ server });
    expect(await r.done).toBeNull();
    expect(server).toHaveBeenCalledTimes(3);
    expect(r.states).toEqual(['loading', 'preparing', 'preparing', 'ready']);
    expect(r.last()).toEqual({
      kind: 'ready',
      coverSrc: null,
      local: false,
      pictures: [
        {
          beforeToc: true,
          width: 640,
          height: 960,
          thumbSrc: 'https://nas/t0',
          fullSrc: 'https://nas/f0'
        }
      ]
    });
  });

  it('a list the server could not make shows its reason', async () => {
    const r = run({ server: async () => ({ status: 'failed', message: 'damaged EPUB' }) });
    await r.done;
    expect(r.last()).toEqual({ kind: 'failed', message: 'damaged EPUB' });
  });

  it('offline or unreachable: the note; any other server error or no connection: nothing', async () => {
    const offline = run({ server: vi.fn(), offline: true });
    await offline.done;
    expect(offline.last()).toEqual({ kind: 'offline' });

    for (const kind of ['unreachable', 'timeout'] as const) {
      const r = run({
        server: async () => {
          throw new LibraryApiError(kind, 'no answer');
        }
      });
      await r.done;
      expect(r.last()).toEqual({ kind: 'offline' });
    }
    const gone = run({
      server: async () => {
        throw new LibraryApiError('server', 'missing', 410, 'missing');
      }
    });
    await gone.done;
    expect(gone.last()).toEqual({ kind: 'none' });
    const unconnected = run({});
    await unconnected.done;
    expect(unconnected.last()).toEqual({ kind: 'none' });
  });

  it('stops asking when the page leaves (and releases a copy read meanwhile)', async () => {
    const c = new AbortController();
    const server = vi.fn(async (): Promise<ServerIllustrationList> => ({ status: 'preparing' }));
    const r = run({ server, pollMs: 50 }, c.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    c.abort();
    expect(await r.done).toBeNull();
    expect(server).toHaveBeenCalledTimes(1);

    const release = vi.fn();
    const c2 = new AbortController();
    const late = run(
      {
        local: async () => {
          c2.abort();
          return { pictures: [], coverSrc: null, release };
        }
      },
      c2.signal
    );
    expect(await late.done).toBeNull();
    expect(release).toHaveBeenCalled();
  });
});
