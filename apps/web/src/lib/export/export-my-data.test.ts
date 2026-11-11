/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { LibraryApiError } from '$lib/library/api';
import { localStamp } from '$lib/functions/download-blob';
import { exportMyData } from './export-my-data';

const body = JSON.stringify(
  {
    format: 'ttsu-reader-export',
    formatVersion: 1,
    records: { position: [{ id: 'a' }, { id: 'b' }], setting: [{ id: 'global:x' }] }
  },
  null,
  2
);

function deps(api: unknown) {
  const saved: { blob: Blob; name: string }[] = [];
  return {
    saved,
    deps: {
      api: async () => api as never,
      save: (blob: Blob, name: string) => saved.push({ blob, name }),
      now: () => new Date(2026, 10, 10, 9, 5)
    }
  };
}

describe('exportMyData', () => {
  it('saves the server text unchanged under a dated name', async () => {
    const t = deps({ exportMyData: async () => body });
    const result = await exportMyData(t.deps);
    expect(result).toEqual({
      ok: true,
      fileName: 'ttsu-export-2026-11-10.json',
      records: 3,
      bytes: new Blob([body]).size
    });
    expect(t.saved).toHaveLength(1);
    expect(await t.saved[0].blob.text()).toBe(body);
    expect(t.saved[0].blob.type).toBe('application/json');
  });

  it('says so when not connected and saves nothing', async () => {
    const t = deps(null);
    const result = await exportMyData(t.deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/not connected/);
    expect(t.saved).toEqual([]);
  });

  it('reports server errors and refused tokens', async () => {
    const refused = deps({
      exportMyData: async () => {
        throw new LibraryApiError('unauthorized', 'no', 401);
      }
    });
    expect(await exportMyData(refused.deps)).toMatchObject({ ok: false, message: /Pair it again/ });
    const down = deps({
      exportMyData: async () => {
        throw new LibraryApiError('unreachable', 'Could not reach the library server');
      }
    });
    expect(await exportMyData(down.deps)).toMatchObject({
      ok: false,
      message: /Could not get your data: Could not reach/
    });
    expect([...refused.saved, ...down.saved]).toEqual([]);
  });

  it('refuses something that is not an export', async () => {
    const t = deps({ exportMyData: async () => '<html>' });
    expect(await exportMyData(t.deps)).toMatchObject({ ok: false, message: /not an export/ });
    expect(t.saved).toEqual([]);
  });

  it('stamps local dates', () => {
    expect(localStamp(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02');
    expect(localStamp(new Date(2026, 0, 2, 3, 4), true)).toBe('2026-01-02-0304');
  });
});
