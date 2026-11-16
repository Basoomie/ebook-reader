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
 *
 * Season 2 Phase 12 session 3: rm -f <name> (ok), and the voice kept loaded:
 *   run -i … -v <live>:/work … serve   requests on stdin, one JSON per line:
 *       load   "TTSU loaded {…}" after FAKE_TTS_LOAD_MS (default 300; the file "load-ms" in
 *              the state folder wins); mode "load-fail": "TTSU load-error {…}"
 *       read   every sentence max(600, 100 × characters) ms of tone, then its pause
 *              (sentence / paragraph, lastGapMs after the last); <out>/<name>.flac + .json,
 *              "TTSU read-done {id, durationMs}"; mode "read-fail": "TTSU read-error {…}";
 *              FAKE_TTS_READ_MS (or the file "read-ms") is added before it answers
 *       quit   exits
 *   Each request is kept in $FAKE_DOCKER_STATE/serve.jsonl.
 *
 * Season 2 Phase 12 session 4: a sentence with "segments" is "spoken" as
 * "[<voice key>]<reading>" per segment (so tests see which voice read which run); a segment
 * whose voice's clip isn't in the work folder fails the read like a real missing file.
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

/** What a sentence is "spoken" as: its reading, or its runs with their voice keys. */
function spokenOf(s, voices, hostOf) {
  if (!s.segments || !s.segments.length) return s.reading;
  return s.segments
    .map((g) => {
      const v = voices && voices[g.voice];
      if (!v || !fs.existsSync(hostOf(v.voice))) {
        throw new Error(`FileNotFoundError: no clip for the voice "${g.voice}"`);
      }
      return `[${g.voice}]${g.reading}`;
    })
    .join('');
}
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
if (args[0] === 'rm') {
  process.exit(0);
}
if (args[0] === 'run' && args[args.length - 1] === 'serve') {
  const name = args[args.indexOf('--name') + 1];
  fs.writeFileSync(path.join(state, `${name}.pid`), String(process.pid));
  const mount = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(':/work'));
  const host = mount.slice(0, mount.length - ':/work'.length);
  const say = (line) => process.stdout.write(`TTSU ${line}\n`);
  const fromFile = (file, env, d) => {
    const p = path.join(state, file);
    if (fs.existsSync(p)) return Number(fs.readFileSync(p, 'utf8').trim());
    return Number(process.env[env] || d);
  };
  const currentMode = () =>
    process.env.FAKE_TTS_MODE ||
    (modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : '') ||
    'ok';
  say('stage ready-for-requests');
  let buffered = '';
  let chain = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const handle = async (req) => {
    fs.appendFileSync(path.join(state, 'serve.jsonl'), JSON.stringify(req) + '\n');
    if (req.op === 'quit') {
      say('stage quitting');
      process.exit(0);
    }
    if (req.op === 'load') {
      say('stage loading');
      await sleep(fromFile('load-ms', 'FAKE_TTS_LOAD_MS', 300));
      if (currentMode() === 'load-fail') {
        say(`load-error ${JSON.stringify({ error: 'RuntimeError: CUDA out of memory' })}`);
        return;
      }
      say(`loaded ${JSON.stringify({ description: true, clip: true, loadSeconds: 0.3 })}`);
      return;
    }
    if (req.op === 'read') {
      await sleep(fromFile('read-ms', 'FAKE_TTS_READ_MS', 0));
      if (currentMode() === 'read-fail') {
        say(`read-error ${JSON.stringify({ id: req.id, error: 'RuntimeError: CUDA error' })}`);
        return;
      }
      const sentences = req.sentences;
      let spoken;
      try {
        spoken = sentences.map((x) =>
          spokenOf(x, req.voices, (p) => path.join(host, p.replace(/^\/work\//, ''))),
        );
      } catch (err) {
        say(`read-error ${JSON.stringify({ id: req.id, error: err.message })}`);
        return;
      }
      const cues = [];
      let t = 0;
      sentences.forEach((x, k) => {
        const speech = Math.max(600, 100 * [...x.text].length);
        cues.push([t, t + speech]);
        t += speech;
        const last = k === sentences.length - 1;
        t += last
          ? req.lastGapMs || 0
          : x.paragraphEnd
            ? (req.pauses.paragraphMs ?? 700)
            : (req.pauses.sentenceMs ?? 300);
      });
      const out = path.join(host, 'out');
      fs.mkdirSync(out, { recursive: true });
      const base = path.join(out, req.name);
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=440:duration=${t / 1000}`,
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
      fs.writeFileSync(`${base}.json`, JSON.stringify({ durationMs: t, cues, spoken }));
      say(
        `progress ${JSON.stringify({ id: req.id, done: sentences.length, total: sentences.length })}`,
      );
      say(`read-done ${JSON.stringify({ id: req.id, durationMs: t })}`);
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      const req = JSON.parse(l);
      chain = chain.then(() => handle(req));
    }
  });
  process.stdin.on('end', () => chain.then(() => process.exit(0)));
  return;
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
    let spoken;
    try {
      spoken = ch.sentences.map((s) =>
        spokenOf(s, job.voices, (p) => path.join(host, p.replace(/^\/work\//, ''))),
      );
    } catch (err) {
      say(`error ${err.message}`);
      process.exit(1);
    }
    say(
      `progress ${JSON.stringify({ chapter: ch.index, chapterNumber: i + 1, chapters: chapters.length, done: 0, total: count })}`,
    );
    // A voice sample (one piece) is 3 s, long enough to be kept as a voice.
    const cues = job.whole ? [[0, 2800]] : ch.sentences.map((_, k) => [k * 500, k * 500 + 400]);
    const durationMs = job.whole ? 3000 : count * 500 + (job.pauses.chapterMs || 0);
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
    fs.writeFileSync(`${base}.json`, JSON.stringify({ durationMs, cues, spoken }));
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
