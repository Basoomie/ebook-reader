#!/usr/bin/env node
// A stand-in for apps/cleanup-apply/helper/calibredb-helper.py (WP20b): the same line
// protocol, running the stand-in calibredb (fake-calibredb.cjs) for each call, so the tests
// see the same Calibre whichever way a call goes.
//
// FAKE_HELPER_FAIL_START=1: exits before it is ready (the sidecar falls back to calibredb).
// FAKE_HELPER_LOG=<file>: one line per call ("<cmd> <book id or ->").
// FAKE_HELPER_DIE_AFTER_WRITES=<n>: the n-th set_metadata is done, then the helper dies
//   without answering (the sidecar must not send it again).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FAKE = path.join(__dirname, 'fake-calibredb.cjs');
if (process.env.FAKE_HELPER_FAIL_START === '1') {
  process.stderr.write('ImportError: no calibre here\n');
  process.exit(1);
}
const send = (o) => process.stdout.write(`@@ttsu ${JSON.stringify(o)}\n`);
process.stdout.write('some start-up noise\n');
send({ ready: true, version: process.env.FAKE_VERSION || '9.18.0' });

let writes = 0;
let buf = '';
process.stdin.setEncoding('utf8').on('data', (d) => {
  buf += d;
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    const cmd = req.args[0];
    if (cmd !== 'list' && cmd !== 'set_metadata') {
      send({ id: req.id, code: 1, stdout: '', stderr: `${cmd} is not allowed` });
      continue;
    }
    if (process.env.FAKE_HELPER_LOG) {
      const id = cmd === 'set_metadata' ? req.args.find((a) => /^\d+$/.test(a)) : '-';
      fs.appendFileSync(process.env.FAKE_HELPER_LOG, `${cmd} ${id}\n`);
    }
    const r = spawnSync(process.execPath, [FAKE, ...req.args], {
      input: `${req.password}\n`,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (cmd === 'set_metadata') {
      writes += 1;
      if (Number(process.env.FAKE_HELPER_DIE_AFTER_WRITES || 0) === writes) process.exit(3);
    }
    send({ id: req.id, code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' });
  }
});
