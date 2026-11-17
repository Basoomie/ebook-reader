/**
 * Season 2 Phase 12 session 5 tests: stands in for `docker` with llama.cpp's server (speaker
 * jobs). Calls go to $FAKE_DOCKER_STATE/calls.jsonl; the mode is the file "mode" there.
 *   info                ok
 *   image inspect <i>   ok, unless mode "no-speaker-image" and <i> is the llama.cpp image
 *   pull <i>            ok
 *   run … -d --name N -p 127.0.0.1:P:8080 -v <dir>:/models:ro <image> -m /models/<rel> …
 *       starts fake-llama-server.cjs on port P (a separate process; its pid in N.pid), unless
 *       the model file is missing or mode "load-fail" (the "container" ends at once)
 *   ps -q --filter name=^N$   prints an id while that server runs
 *   rm -f N             stops it
 * Anything else (the TTS program) answers ok with nothing.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const state = process.env.FAKE_DOCKER_STATE;
const modeFile = state ? path.join(state, 'mode') : null;
const mode =
  (modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : '') || 'ok';
const args = process.argv.slice(2);

// The browser tests: every other command goes to the TTS program's fake (FAKE_TTS_DOCKER).
const forSpeakers =
  (args[0] === 'image' && args[1] === 'inspect' && args[args.length - 1].includes('llama.cpp')) ||
  (args[0] === 'run' && args.includes('-p')) ||
  (args[0] === 'ps' && args.join(' ').includes('ttsu-llm-')) ||
  (args[0] === 'rm' && /ttsu-llm-/.test(args[args.length - 1])) ||
  args[0] === 'pull';
if (process.env.FAKE_TTS_DOCKER && !forSpeakers) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [process.env.FAKE_TTS_DOCKER, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status ?? 1);
}
if (state) fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\n');

const pidFile = (name) => path.join(state, `${name}.pid`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (args[0] === 'info') {
  process.stdout.write('28.2.2\n');
} else if (args[0] === 'image' && args[1] === 'inspect') {
  const image = args[args.length - 1];
  if (mode === 'no-speaker-image' && image.includes('llama.cpp')) {
    process.stderr.write(`Error: No such image: ${image}\n`);
    process.exit(1);
  }
  process.stdout.write('sha256:fake\n');
} else if (args[0] === 'run' && args.includes('-p')) {
  const name = args[args.indexOf('--name') + 1];
  const port = args[args.indexOf('-p') + 1].split(':')[1];
  const volume = args[args.indexOf('-v') + 1];
  const dir = volume.slice(0, volume.lastIndexOf(':/models'));
  const rel = args[args.indexOf('-m') + 1].replace(/^\/models\//, '');
  const model = path.join(dir, ...rel.split('/'));
  process.stdout.write('c0ffee\n');
  if (mode === 'load-fail' || !fs.existsSync(model)) process.exit(0);
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-llama-server.cjs'), port], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(pidFile(name), String(child.pid));
} else if (args[0] === 'ps') {
  const filter = args[args.indexOf('--filter') + 1] || '';
  const name = filter.replace(/^name=\^/, '').replace(/\$$/, '');
  const f = pidFile(name);
  if (fs.existsSync(f) && alive(Number(fs.readFileSync(f, 'utf8'))))
    process.stdout.write('c0ffee\n');
} else if (args[0] === 'rm') {
  const name = args[args.length - 1];
  const f = pidFile(name);
  if (fs.existsSync(f)) {
    const pid = Number(fs.readFileSync(f, 'utf8'));
    if (alive(pid)) process.kill(pid);
    fs.rmSync(f);
  }
}
