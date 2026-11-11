/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBugReport, type BugReportDeps } from './bug-report';
import { REDACTED } from './redact';

const TOKEN = `ttsu_${'Q1w2E3r4T5'.repeat(4)}abc`;

const serverLogs = {
  serverVersion: '1.0.0',
  startedAt: 1,
  maxLines: 2000,
  dropped: 0,
  lines: [{ time: 2, level: 'log' as const, text: 'Database: ready' }]
};

function deps(extra: Partial<BugReportDeps> = {}): BugReportDeps {
  return {
    title: 'Bug Report',
    message: 'Something broke',
    device: () => ({ userAgent: 'Edge', settings: { fontSize: 20 } }),
    log: () => [
      { level: 'warn', args: [`Sync: failed, Authorization: Bearer ${TOKEN}`] },
      { level: 'info', args: ['pairing with code 7K3M-Q9TZ', { code: '7k3m-q9tz' }] },
      { level: 'info', args: ['Opened 薬屋のひとりごと on Boox'] }
    ],
    sync: async () => ({
      deviceId: 'd1',
      pending: 0,
      rejectedChanges: [{ change: { kind: 'x' }, error: { code: 'invalid_data', message: 'm' } }]
    }),
    serverLogs: async () => serverLogs,
    secrets: async () => [TOKEN],
    serverTimeoutSeconds: 5,
    now: () => new Date('2026-11-10T12:00:00Z'),
    ...extra
  };
}

afterEach(() => vi.useRealTimers());

describe('buildBugReport', () => {
  it('bundles this device and the server, secrets removed', async () => {
    const report = await buildBugReport(deps());
    expect(report).toMatchObject({
      format: 'ttsu-bug-report',
      formatVersion: 1,
      createdAt: '2026-11-10T12:00:00.000Z',
      title: 'Bug Report',
      message: 'Something broke',
      device: { userAgent: 'Edge', settings: { fontSize: 20 } },
      sync: { deviceId: 'd1', rejectedChanges: [{ error: { code: 'invalid_data' } }] },
      server: { included: true, serverVersion: '1.0.0', lines: serverLogs.lines }
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain(TOKEN.slice(5));
    expect(text).not.toContain('7K3M-Q9TZ');
    expect(text).not.toContain('7k3m-q9tz');
    expect(text).toContain(`Bearer ${REDACTED}`);
    expect(text).toContain('薬屋のひとりごと on Boox');
  });

  it('says why the server part is missing', async () => {
    expect((await buildBugReport(deps({ serverLogs: async () => null }))).server).toEqual({
      included: false,
      reason: 'This device is not connected to a server'
    });
    const failing = deps({
      serverLogs: async () => {
        throw new Error(`Could not reach http://nas:3001/api?token=${TOKEN}`);
      }
    });
    const server = (await buildBugReport(failing)).server as { reason: string };
    expect(server.reason).toMatch(/^Could not read the server's log: Could not reach/);
    expect(server.reason).not.toContain(TOKEN);
  });

  it('gives up on a server that does not answer and cancels the request', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const pending = buildBugReport(
      deps({
        serverTimeoutSeconds: 3,
        serverLogs: (signal) =>
          new Promise(() => signal.addEventListener('abort', () => (aborted = true)))
      })
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).server).toEqual({
      included: false,
      reason: 'The library server did not answer within 3 seconds'
    });
    expect(aborted).toBe(true);
  });

  it('keeps going when a part fails', async () => {
    const report = await buildBugReport(
      deps({
        sync: async () => {
          throw new Error('no IndexedDB');
        },
        device: () => {
          throw new Error('no window');
        },
        secrets: async () => {
          throw new Error('locked');
        }
      })
    );
    expect(report.sync).toEqual({ unavailable: 'no IndexedDB' });
    expect(report.device).toEqual({ unavailable: 'no window' });
    expect((report.server as { included: boolean }).included).toBe(true);
  });
});
