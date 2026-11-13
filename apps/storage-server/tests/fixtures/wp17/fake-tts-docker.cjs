/**
 * WP17 tests: stands in for `docker` with the TTS program. Calls go to
 * $FAKE_DOCKER_STATE/calls.jsonl. The mode comes from FAKE_TTS_MODE, else the file "mode"
 * in FAKE_DOCKER_STATE (so a browser test can change it between jobs).
 *   info                 ok unless mode "no-docker"
 *   image inspect <img>  ok unless mode "no-tts-image" and <img> is a ttsu-irodori image
 *   kill <name>          kills the run of that container name
 *   run … -v <job>:/work … run --job /work/job.json
 *       ok       every chapter: 0.5 s per sentence plus the chapter pause, as a real FLAC
 *                (ffmpeg), part-NNNN.flac + .json, "TTSU chapter-done"
 *       slow     the same with 1.5 s between chapters (pause and browser tests)
 *       hang     the first chapter, then waits until `kill`
 *       fail     "TTSU error RuntimeError: CUDA out of memory", exit 1
 * A copy of each job.json is kept as $FAKE_DOCKER_STATE/job-<n>.json.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const state = process.env.FAKE_DOCKER_STATE;
const modeFile = state ? path.join(state, 'mode') : null;
const mode =
  process.env.FAKE_TTS_MODE ||
  (modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : '') ||
  'ok';
const args = process.argv.slice(2);
if (state) fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\n');

if (args[0] === 'info') {
  if (mode === 'no-docker') {
    process.stderr.write('error during connect\n');
    process.exit(1);
  }
  process.stdout.write('28.2.2\n');
  process.exit(0);
}
if (args[0] === 'image') {
  const image = args[args.length - 1];
  if (mode === 'no-tts-image' && image.startsWith('ttsu-irodori')) {
    process.stderr.write('Error: No such image\n');
    process.exit(1);
  }
  process.stdout.write('sha256:fake\n');
  process.exit(0);
}
if (args[0] === 'kill') {
  const file = path.join(state, `${args[1]}.pid`);
  try {
    process.kill(Number(fs.readFileSync(file, 'utf8')));
  } catch {
    // gone
  }
  process.exit(0);
}
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1];
  fs.writeFileSync(path.join(state, `${name}.pid`), String(process.pid));
  const mount = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(':/work'));
  const host = mount.slice(0, mount.length - ':/work'.length);
  const job = JSON.parse(fs.readFileSync(path.join(host, 'job.json'), 'utf8'));
  const n = fs.readdirSync(state).filter((f) => /^job-\d+\.json$/.test(f)).length + 1;
  fs.writeFileSync(path.join(state, `job-${n}.json`), JSON.stringify(job, null, 1));
  const say = (line) => process.stdout.write(`TTSU ${line}\n`);
  say('stage downloading');
  say('stage loading');
  if (mode === 'fail') {
    process.stderr.write('Traceback (most recent call last):\n  File "x.py"\n');
    say('error RuntimeError: CUDA out of memory');
    process.exit(1);
  }
  say(`model ${JSON.stringify({ description: true, clip: true })}`);
  say('stage generating');
  const out = path.join(host, 'out');
  fs.mkdirSync(out, { recursive: true });
  const chapters = job.chapters;
  let i = 0;
  const next = () => {
    if (i >= chapters.length) process.exit(0);
    const ch = chapters[i];
    const count = ch.sentences.length;
    say(
      `progress ${JSON.stringify({ chapter: ch.index, chapterNumber: i + 1, chapters: chapters.length, done: 0, total: count })}`,
    );
    const cues = ch.sentences.map((_, k) => [k * 500, k * 500 + 400]);
    const durationMs = count * 500 + (job.pauses.chapterMs || 0);
    const base = path.join(out, `part-${String(ch.index).padStart(4, '0')}`);
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${durationMs / 1000}`,
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'flac',
        '-f',
        'flac',
        `${base}.flac.tmp`,
      ],
      { windowsHide: true },
    );
    fs.renameSync(`${base}.flac.tmp`, `${base}.flac`);
    fs.writeFileSync(
      `${base}.json`,
      JSON.stringify({ durationMs, cues, spoken: ch.sentences.map((s) => s.reading) }),
    );
    say(
      `progress ${JSON.stringify({ chapter: ch.index, chapterNumber: i + 1, chapters: chapters.length, done: count, total: count })}`,
    );
    say(`chapter-done ${JSON.stringify({ index: ch.index, durationMs })}`);
    i += 1;
    if (mode === 'hang') {
      setInterval(() => undefined, 1000);
      return;
    }
    setTimeout(next, mode === 'slow' ? 1500 : 10);
  };
  next();
  return;
}
process.stderr.write(`fake docker: unknown command ${args.join(' ')}\n`);
process.exit(2);
