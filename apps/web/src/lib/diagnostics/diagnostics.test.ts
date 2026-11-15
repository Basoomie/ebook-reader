/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { SubtitleJob } from '$lib/audio/audio-types';
import { LibraryApiError } from '$lib/library/api';
import { fetchDiagnostics, type DiagnosticsPcWorker } from './diagnostics-api';
import {
  buildDate,
  currentJobText,
  deviceName,
  formatBytes,
  lastSeenText,
  pcWorkerStateText,
  serverErrorText,
  storageUsedText
} from './diagnostics-text';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const worker = (over: Partial<Extract<DiagnosticsPcWorker, { available: true }>> = {}) =>
  ({
    available: true,
    online: true,
    paused: false,
    lastSeenAt: 1000,
    problem: null,
    version: '1.1.1',
    currentJob: null,
    waiting: 0,
    ...over
  }) as DiagnosticsPcWorker;

const job = (over: Partial<SubtitleJob> = {}) =>
  ({ kind: 'sync_subtitles', bookTitle: '羊と鋼の森', progress: 0.423, ...over }) as SubtitleJob;

describe('diagnostics text', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(formatBytes(54 * 1024 ** 3 + 1)).toBe('54 GB');
    expect(formatBytes(NaN)).toBe('0 B');
  });

  it('shows storage used of the quota, or nothing without figures', () => {
    expect(storageUsedText({ usage: 1.2 * 1024 ** 3, quota: 54 * 1024 ** 3 })).toBe(
      '1.2 GB of 54 GB'
    );
    expect(storageUsedText({})).toBeNull();
    expect(storageUsedText({ usage: 1, quota: 0 })).toBeNull();
  });

  it('reads build times from SvelteKit versions and server times', () => {
    expect(buildDate('1763164020000')?.getTime()).toBe(1763164020000);
    expect(buildDate(1763164020000)?.getTime()).toBe(1763164020000);
    expect(buildDate('1.0.0')).toBeNull();
    expect(buildDate(null)).toBeNull();
    expect(buildDate('')).toBeNull();
  });

  it('names unnamed devices and says Never for no time', () => {
    expect(deviceName('Phone')).toBe('Phone');
    expect(deviceName('  ')).toBe('Unnamed device');
    expect(lastSeenText(null, 5)).toBe('Never');
    expect(lastSeenText(0, 5 * 60_000)).toBe('Never');
    expect(lastSeenText(60_000, 6 * 60_000)).toBe('5 min ago');
  });

  it("describes the PC worker's state as Settings > Audiobooks does", () => {
    expect(pcWorkerStateText({ available: false })).toMatch(/^Not set up on the server/);
    expect(pcWorkerStateText(worker({ paused: true, online: false }))).toBe(
      'Paused: the PC takes no new jobs.'
    );
    expect(pcWorkerStateText(worker({ online: false }))).toBe('Off.');
    expect(pcWorkerStateText(worker({ online: false, lastSeenAt: null }))).toBe(
      'Not set up yet: no PC has checked in.'
    );
    expect(pcWorkerStateText(worker({ problem: 'Docker is not running.' }))).toBe(
      'On, but: Docker is not running.'
    );
    expect(pcWorkerStateText(worker())).toBe('On.');
  });

  it('names the running job with its progress', () => {
    expect(currentJobText(worker())).toBe('None');
    expect(currentJobText({ available: false })).toBe('None');
    expect(currentJobText(worker({ currentJob: job() }))).toBe(
      `“羊と鋼の森” · 42${String.fromCharCode(0xa0)}%`
    );
    expect(currentJobText(worker({ currentJob: job({ progress: null }) }))).toBe('“羊と鋼の森”');
  });

  it('explains why the server figures are missing', () => {
    expect(serverErrorText(new LibraryApiError('unreachable', 'x'))).toMatch(/can't be reached/);
    expect(serverErrorText(new LibraryApiError('timeout', 'x'))).toMatch(/can't be reached/);
    expect(serverErrorText(new LibraryApiError('unauthorized', 'x', 401))).toMatch(
      /didn't accept this device/
    );
    expect(serverErrorText(new LibraryApiError('server', 'x', 404))).toMatch(/older version/);
    expect(serverErrorText(new LibraryApiError('server', 'Boom', 500))).toBe('Boom');
  });
});

describe('fetchDiagnostics', () => {
  it('sends the token to /api/v1/diagnostics', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const body = { serverTime: 1, devices: [] };
    const res = await fetchDiagnostics(
      { serverUrl: 'http://s', token: 'ttsu_x' },
      0,
      async (u, i) => {
        seen.push({ url: String(u), auth: new Headers(i?.headers).get('Authorization') });
        return json(200, body);
      }
    );
    expect(res).toEqual(body);
    expect(seen).toEqual([{ url: 'http://s/api/v1/diagnostics', auth: 'Bearer ttsu_x' }]);
  });

  it('turns a refused token and no answer into LibraryApiErrors', async () => {
    const conn = { serverUrl: 'http://s', token: 't' };
    await expect(
      fetchDiagnostics(conn, 0, async () =>
        json(401, { error: { code: 'unauthorized', message: 'no' } })
      )
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(
      fetchDiagnostics(conn, 0, async () => {
        throw new TypeError('Failed to fetch');
      })
    ).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
