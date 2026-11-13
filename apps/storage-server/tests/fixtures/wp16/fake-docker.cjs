/**
 * WP16 tests: stands in for `docker`. Every call is appended to $FAKE_DOCKER_STATE/calls.jsonl.
 *   info / image inspect   succeed unless FAKE_DOCKER_MODE is "no-docker" / "no-image"
 *   run ... -v <host>:/sync ... sync -d /sync/book
 *       ok        writes <host>/book/<audio name>.srt like SubPlz: the files it found in
 *                 /sync/book (proves they are there), then "transcript: …" from SubPlz's
 *                 cache, <config mount>/cache/<audio file name>.0.tiny.subs ("audio <hash of
 *                 the audio>" when missing, reused when the same name comes again)
 *       fail      prints a few lines and exits 1
 *       oom       exits 137
 *       nosrt     exits 0 without a file
 *       hang      prints progress and waits until `kill` (records its pid by container name)
 *       progress  prints SubPlz-shaped log lines over ~1 s, then ok: two "Transcribe:" bars in
 *                 seconds (the audio's length from its mvhd header, split 40/60), the
 *                 "Transcription successful" line, then matching bars (1/1, then 0/4..4/4)
 *       slow      the same over ~10 s (browser tests)
 * The mode comes from FAKE_DOCKER_MODE, else from the file "mode" in FAKE_DOCKER_STATE.
 *   kill <name>  kills the hanging run
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const state = process.env.FAKE_DOCKER_STATE;
const modeFile = state ? path.join(state, 'mode') : null;
const mode =
  process.env.FAKE_DOCKER_MODE ||
  (modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : '') ||
  'ok';
const args = process.argv.slice(2);
if (state) fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\n');

/** The length in seconds from an MP4's mvhd box, or null. */
function mvhdSeconds(buf) {
  const i = buf.indexOf('mvhd');
  if (i < 0) return null;
  const v = buf[i + 4];
  const scale = v === 1 ? buf.readUInt32BE(i + 24) : buf.readUInt32BE(i + 16);
  const dur = v === 1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20);
  return scale > 0 ? dur / scale : null;
}

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nフェイク\n';

if (args[0] === 'info') {
  if (mode === 'no-docker') {
    process.stderr.write('error during connect: docker daemon is not running\n');
    process.exit(1);
  }
  process.stdout.write('28.2.2\n');
  process.exit(0);
}
if (args[0] === 'image') {
  if (mode === 'no-image') {
    process.stderr.write('Error: No such image\n');
    process.exit(1);
  }
  process.stdout.write('sha256:fake\n');
  process.exit(0);
}
if (args[0] === 'kill') {
  const file = path.join(state, `${args[1]}.pid`);
  const pid = Number(fs.readFileSync(file, 'utf8'));
  try {
    process.kill(pid);
  } catch {
    // gone
  }
  process.exit(0);
}
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  const mount = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(':/sync'));
  const host = mount.slice(0, mount.length - ':/sync'.length);
  const book = path.join(host, 'book');
  const files = fs.readdirSync(book).sort();
  const audio = files.find((f) => f.startsWith('audio'));
  const config = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(':/config'));
  // SubPlz's cache: one transcript per audio file name, reused when the name comes again.
  const transcript = () => {
    if (!audio || !config) return 'none';
    const cache = path.join(config.slice(0, config.length - ':/config'.length), 'cache');
    const file = path.join(cache, `${audio}.0.tiny.subs`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(cache, { recursive: true });
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(book, audio)));
      fs.writeFileSync(file, `audio ${hash.digest('hex').slice(0, 16)}`);
    }
    return fs.readFileSync(file, 'utf8');
  };
  const write = () =>
    fs.writeFileSync(
      path.join(book, `${path.parse(audio || 'audio').name}.srt`),
      `${SRT}\n${files.join(',')}\ntranscript: ${transcript()}\n`,
    );
  if (mode === 'fail') {
    process.stdout.write(
      'Loading model\nTraceback (most recent call last):\nValueError: no text\n',
    );
    process.exit(1);
  }
  if (mode === 'oom') process.exit(137);
  if (mode === 'nosrt') process.exit(0);
  if (mode === 'hang') {
    fs.writeFileSync(path.join(state, `${name}.pid`), String(process.pid));
    process.stderr.write(' 12%|█▏        | 12/100 [00:01<00:09]\r');
    setInterval(() => process.stderr.write(' 13%|█▎        | 13/100\r'), 200);
    return;
  }
  if (mode === 'progress' || mode === 'slow') {
    const seconds = mvhdSeconds(fs.readFileSync(path.join(book, audio))) ?? 1000;
    const chapters = [seconds * 0.4, seconds * 0.6];
    const log = (level, msg) =>
      process.stderr.write(
        `\u001b[32m2026-11-12 20:00:00\u001b[0m | ${level.padEnd(8)} | P:1 | ${msg}\n`,
      );
    const steps = [];
    for (const total of chapters) {
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const n = (total * f).toFixed(2);
        const pct = String(Math.round(f * 100)).padStart(3);
        steps.push(() =>
          log(
            'TQDM',
            `Transcribe: ${pct}%|#####     | ${n}/${total.toFixed(2)} [00:01<00:01, 45.00sec/s]`,
          ),
        );
      }
      steps.push(() => log('TQDM', '[A'));
    }
    steps.push(() => log('SUCCESS', "Transcription successful with model 'tiny' on 'cuda'."));
    steps.push(() => log('TQDM', '100%|##########| 1/1 [00:00<00:00,  5.79it/s]'));
    for (let i = 0; i <= 4; i++) {
      const pct = String(i * 25).padStart(3);
      steps.push(() => log('TQDM', `${pct}%|##        | ${i}/4 [00:02<00:08,  1.46s/it]`));
    }
    let i = 0;
    const t = setInterval(
      () => {
        steps[i++]();
        if (i >= steps.length) {
          clearInterval(t);
          write();
          process.exit(0);
        }
      },
      mode === 'slow' ? 600 : 50,
    );
    return;
  }
  write();
  process.exit(0);
}
process.stderr.write(`fake docker: unknown command ${args.join(' ')}\n`);
process.exit(2);
