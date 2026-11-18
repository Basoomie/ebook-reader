import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from './helpers/spawn-server';

// tools/vitest-temp-dir.mjs gives each run its own temp folder and deletes it at the end,
// so test folders no longer pile up in the system temp folder.
describe('test run temp folder', () => {
  const runDir = os.tmpdir();

  it('points the temp folder at this run', () => {
    expect(path.basename(runDir)).toMatch(/^ttsu-test-run-\d+-/);
  });

  it('puts helper folders inside it', () => {
    expect(path.dirname(makeTempDir('check'))).toBe(runDir);
  });

  it('is inherited by child processes such as spawned servers', () => {
    const childTmp = execFileSync(process.execPath, [
      '-e',
      'process.stdout.write(require("os").tmpdir())',
    ]).toString();
    expect(childTmp).toBe(runDir);
  });
});
