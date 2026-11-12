/**
 * WP16 tests: stands in for `docker`. Every call is appended to $FAKE_DOCKER_STATE/calls.jsonl.
 *   info / image inspect   succeed unless FAKE_DOCKER_MODE is "no-docker" / "no-image"
 *   run ... -v <host>:/sync ... sync -d /sync/book
 *       ok        writes <host>/book/audio.srt (from the EPUB name: proves the files are there)
 *       fail      prints a few lines and exits 1
 *       oom       exits 137
 *       nosrt     exits 0 without a file
 *       hang      prints progress and waits until `kill` (records its pid by container name)
 *       progress  prints 10%..100% bars over ~1 s, then ok
 *       slow      the same over ~8 s (browser tests)
 * The mode comes from FAKE_DOCKER_MODE, else from the file "mode" in FAKE_DOCKER_STATE.
 *   kill <name>  kills the hanging run
 */
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
  const write = () =>
    fs.writeFileSync(path.join(book, 'audio.srt'), `${SRT}\n${files.join(',')}\n`);
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
    let p = 0;
    const t = setInterval(
      () => {
        p += 10;
        process.stderr.write(`${String(p).padStart(3)}%|${'█'.repeat(p / 10)}| ${p}/100\r`);
        if (p >= 100) {
          clearInterval(t);
          write();
          process.exit(0);
        }
      },
      mode === 'slow' ? 800 : 100,
    );
    return;
  }
  write();
  process.exit(0);
}
process.stderr.write(`fake docker: unknown command ${args.join(' ')}\n`);
process.exit(2);
