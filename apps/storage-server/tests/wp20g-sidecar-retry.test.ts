// WP20g run 7: an arrival add survives a dropped connection (the worker's retry), and a refusal
// stays final. Stand-in server and calibredb; the real ArrivalWorker.
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFinal, ServerError } from '../../cleanup-apply/src/api';
import { ArrivalWorker, type ArrivalReport } from '../../cleanup-apply/src/arrivals';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isFinal(err)) throw err;
    }
  }
}

function setup(opts: { downloadFails: number; reportFails: number; refuse?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsu-arr-retry-'));
  dirs.push(root);
  const bytes = Buffer.from('epub bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const reports: ArrivalReport[] = [];
  let downloads = 0;
  let reportFails = opts.reportFails;
  let adds = 0;
  const api = {
    claimArrivals: async () => ({
      batch: {
        id: 1,
        kind: 'add' as const,
        leaseSeconds: 300,
        items: [
          {
            itemId: 7,
            fileId: 70,
            state: 'pending' as const,
            name: 'a.epub',
            size: bytes.length,
            sha256: sha,
            title: 'T',
            calibreId: null,
            uuid: null,
          },
        ],
      },
    }),
    reportArrival: async (_id: number, r: ArrivalReport) => {
      if (reportFails > 0) {
        reportFails--;
        throw new TypeError('fetch failed');
      }
      reports.push(r);
      return { state: r.step };
    },
    finishArrivals: async () => ({}),
    downloadArrival: async (_id: number, file: string) => {
      downloads++;
      if (opts.refuse)
        throw new ServerError(409, 'file', 'The file could not be fetched (HTTP 409)');
      if (downloads <= opts.downloadFails) {
        fs.writeFileSync(file, bytes.subarray(0, 3)); // a partial file left behind
        throw new TypeError('fetch failed');
      }
      fs.writeFileSync(file, bytes, { flag: 'wx' });
      return { sha256: sha };
    },
  };
  const calibredb = {
    idsWithTitle: async () => [],
    ok: async () => {
      adds++;
      return { stdout: 'Added book ids: 99', stderr: '' };
    },
    book: async () => ({ id: 99, uuid: 'u-99' }),
  };
  const quarantine = {
    root,
    createOnce: async (file: string, text: string) => fsp.writeFile(file, text, { flag: 'wx' }),
  };
  const w = new ArrivalWorker({
    api,
    calibredb: calibredb as never,
    quarantine: quarantine as never,
    tmpDir: path.join(root, 'tmp'),
    addWaitSeconds: 0,
    pollSeconds: 0,
    isStopped: () => false,
    retry,
    log: { info: () => {}, error: () => {} },
  });
  return { w, reports, adds: () => adds, downloads: () => downloads };
}

describe('arrival adds through network drops', () => {
  it('a dropped download and dropped reports are tried again; the book is added once', async () => {
    const s = setup({ downloadFails: 2, reportFails: 2 });
    expect(await s.w.cycle({} as never)).toBe(true);
    expect(s.downloads()).toBe(3);
    expect(s.adds()).toBe(1);
    expect(s.reports.map((r) => r.step)).toEqual(['fetched', 'adding', 'added']);
    expect(s.reports[2]).toMatchObject({ calibreId: 99, uuid: 'u-99' });
  });

  it('a refusal (4xx) is final: the item fails, nothing is added', async () => {
    const s = setup({ downloadFails: 0, reportFails: 0, refuse: true });
    await s.w.cycle({} as never);
    expect(s.downloads()).toBe(1);
    expect(s.adds()).toBe(0);
    expect(s.reports.map((r) => r.step)).toEqual(['failed']);
  });
});
