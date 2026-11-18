/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// Vitest global setup shared by the web app and the storage server: every test run gets
// its own temp folder, and the run deletes it when it ends.
//
// The tests make their folders with os.tmpdir() (makeTempDir, sync-harness, fixtures,
// spawned servers) and never removed them: 244,000 folders and 46 GB in ten days were
// found in %TEMP% on 2026-11-18. Pointing TEMP/TMP/TMPDIR at one folder per run covers
// all of them at once, including the child processes the tests start, which inherit the
// variables.
//
// A run that is killed can't delete its folder, so each run first removes the folders
// of earlier runs whose process is gone. A folder whose process still runs (another
// test run in parallel, e.g. in another worktree) is never touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'ttsu-test-run-';
const VARS = ['TEMP', 'TMP', 'TMPDIR'];

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

function removeFinishedRuns(base) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const pid = Number(name.slice(PREFIX.length).split('-')[0]);
    if (!Number.isInteger(pid) || pid <= 0 || processAlive(pid)) continue;
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Still locked (a leftover child process): the next run tries again.
    }
  }
}

export default function setup() {
  const base = os.tmpdir();
  removeFinishedRuns(base);

  const runDir = fs.mkdtempSync(path.join(base, `${PREFIX}${process.pid}-`));
  const saved = VARS.map((key) => [key, process.env[key]]);
  for (const key of VARS) process.env[key] = runDir;

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn(`Could not delete the test run's temp folder ${runDir}: ${err.message}`);
    }
  };
}
