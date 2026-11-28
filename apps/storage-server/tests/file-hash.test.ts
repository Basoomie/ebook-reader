import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sha256File } from '../src/cleanup/file-hash';
import { makeTempDir } from './helpers/spawn-server';

describe('sha256File', () => {
  it('hashes a file of several chunks and an empty one like crypto does', async () => {
    const dir = makeTempDir('hash-');
    const big = path.join(dir, 'big.bin');
    const data = Buffer.alloc(3 * (1 << 20) + 12345, 7);
    data[5] = 1;
    fs.writeFileSync(big, data);
    expect(await sha256File(big)).toBe(createHash('sha256').update(data).digest('hex'));
    const empty = path.join(dir, 'empty.bin');
    fs.writeFileSync(empty, '');
    expect(await sha256File(empty)).toBe(createHash('sha256').digest('hex'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
