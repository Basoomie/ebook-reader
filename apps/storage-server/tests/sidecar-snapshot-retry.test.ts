/**
 * The apply sidecar's metadata.db snapshot (1.6.5): a download cut off part way leaves its file
 * in the quarantine (nothing there is ever deleted), and the retry went into the same name with
 * EEXIST for ever, holding the batch and every batch behind it, the user's edits included (found
 * live 2026-11-26). Each try now takes the next free name.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { Worker } from '../../cleanup-apply/src/worker';
import { makeTempDir } from './helpers/spawn-server';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const quiet = { info: () => {}, error: () => {} };

describe('the sidecar saves the batch snapshot', () => {
  it('a download cut off part way is tried again under the next free name', async () => {
    const quarantine = makeTempDir('snap-quarantine-');
    dirs.push(quarantine);
    const full = Buffer.from('SQLite format 3\0 the whole snapshot');
    const sha = createHash('sha256').update(full).digest('hex');
    const tries: string[] = [];
    const saved: string[] = [];
    const api = {
      downloadSnapshot: async (_batchId: string, file: string) => {
        tries.push(path.basename(file));
        if (tries.length === 1) {
          // As fetch + pipeline do: the file is made, then the stream breaks.
          fs.writeFileSync(file, full.subarray(0, 5), { flag: 'wx' });
          throw new Error('socket hang up');
        }
        fs.writeFileSync(file, full, { flag: 'wx' });
      },
      snapshotSaved: async (_batchId: string, s: string) => {
        saved.push(s);
      },
    };
    const config = {
      serverUrl: 'http://127.0.0.1:1',
      token: 'ttsu_x',
      quarantineDir: quarantine,
      requestTimeoutSeconds: 5,
    } as unknown as SidecarConfig;
    const w = new Worker({
      config,
      api: api as never,
      log: quiet,
      retryMinMs: 5,
      retryMaxMs: 10,
    } as never);
    // The worker makes the batch folder first (batch.json), as in a real batch.
    fs.mkdirSync(path.join(quarantine, '84281df0-2a8e-4b08-bb64-3eb3b340d3cd'), {
      recursive: true,
    });
    const batch = { id: '84281df0-2a8e-4b08-bb64-3eb3b340d3cd', snapshotSha256: sha } as never;
    await (w as unknown as { saveSnapshot: (b: unknown) => Promise<void> }).saveSnapshot(batch);
    expect(tries).toEqual(['metadata.db', 'metadata-2.db']);
    expect(saved).toEqual([sha]);
    // The cut-off file stays (the quarantine is never deleted from); the whole one is beside it.
    const dir = path.join(quarantine, '84281df0-2a8e-4b08-bb64-3eb3b340d3cd');
    expect(fs.readFileSync(path.join(dir, 'metadata.db')).length).toBe(5);
    expect(fs.readFileSync(path.join(dir, 'metadata-2.db')).equals(full)).toBe(true);
  });
});
