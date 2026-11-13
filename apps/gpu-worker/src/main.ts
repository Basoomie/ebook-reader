/**
 * ッツ Reader GPU worker (WP16), for the user's PC.
 *
 *   node C:\ttsu-worker\app\main.js          run (started at sign-in by a Startup shortcut (start-hidden.vbs))
 *   node C:\ttsu-worker\app\main.js check    test the setup and print what is missing
 *   node C:\ttsu-worker\app\main.js build-tts  build the TTS program's image (WP17), once per
 *                                            Windows account and after each worker update
 *                                            that changes it
 *
 * Settings: C:\ttsu-worker\config.json (see config.example.json). Only one worker runs at
 * a time (a lock file next to the work folder).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ServerApi } from './api';
import { ConfigError, configPath, loadSettings, type WorkerSettings } from './config';
import { fileLogger } from './log';
import { runDocker } from './subplz';
import { Worker, WORKER_VERSION } from './worker';

function lockFile(s: WorkerSettings): string {
  return path.join(path.dirname(s.workDir), 'worker.lock');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the lock, or returns the pid of the worker that holds it. */
function takeLock(file: string): number | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) return pid;
      fs.rmSync(file, { force: true }); // left by a worker that is gone
    }
  }
  return null;
}

async function check(s: WorkerSettings): Promise<boolean> {
  const api = new ServerApi(s);
  let ok = true;
  const line = (good: boolean, what: string, detail = '') => {
    if (!good) ok = false;
    console.log(`${good ? 'OK  ' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`);
  };
  try {
    const h = await api.health();
    line(h.ok === true, 'Server reachable', `${s.serverUrl} (schema ${h.schemaVersion ?? '?'})`);
  } catch (err) {
    line(false, 'Server reachable', `${s.serverUrl}: ${(err as Error).message}`);
  }
  try {
    const hb = await api.heartbeat({
      version: WORKER_VERSION,
      image: s.image,
      problem: null,
      currentJobId: null,
    });
    line(true, 'Worker token accepted', hb.paused ? 'the worker is paused in Settings' : '');
  } catch (err) {
    line(false, 'Worker token accepted', (err as Error).message);
  }
  const docker = (args: string[], timeout = 60_000) =>
    runDocker(s.dockerPath, [...s.dockerPrefixArgs, ...args], timeout);
  let dockerOk = false;
  try {
    const v = (await docker(['info', '--format', '{{.ServerVersion}}'])).trim();
    dockerOk = true;
    line(true, 'Docker Desktop running', `version ${v}`);
  } catch (err) {
    line(false, 'Docker Desktop running', (err as Error).message);
  }
  let imageOk = false;
  if (dockerOk) {
    try {
      await docker(['image', 'inspect', '--format', '{{.Id}}', s.image]);
      imageOk = true;
      line(true, 'SubPlz image on the PC', s.image);
    } catch {
      line(false, 'SubPlz image on the PC', `run: docker pull ${s.image}`);
    }
  }
  if (imageOk) {
    try {
      const out = await docker(
        [
          'run',
          '--rm',
          '--gpus',
          'all',
          '--entrypoint',
          'python',
          s.image,
          '-c',
          'import torch; print(torch.cuda.is_available())',
        ],
        10 * 60_000,
      );
      line(out.trim().endsWith('True'), 'GPU visible to SubPlz', out.trim().split('\n').pop());
    } catch (err) {
      line(false, 'GPU visible to SubPlz', (err as Error).message);
    }
  }
  // WP17: the TTS program (its own image, built on this PC) and the shared models folder.
  let ttsOk = false;
  if (dockerOk) {
    try {
      await docker(['image', 'inspect', '--format', '{{.Id}}', s.ttsImage]);
      ttsOk = true;
      line(true, 'TTS program on the PC', s.ttsImage);
    } catch {
      line(false, 'TTS program on the PC', 'run: node main.js build-tts');
    }
  }
  if (ttsOk) {
    try {
      const out = await docker(['run', '--rm', '--gpus', 'all', s.ttsImage, 'check'], 10 * 60_000);
      line(
        /"cuda": true/.test(out),
        'GPU visible to the TTS program',
        out.trim().split('\n').pop(),
      );
    } catch (err) {
      line(false, 'GPU visible to the TTS program', (err as Error).message);
    }
  }
  try {
    fs.mkdirSync(s.ttsModelsDir, { recursive: true });
    const probe = path.join(s.ttsModelsDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    line(true, 'Models folder', s.ttsModelsDir);
  } catch (err) {
    line(false, 'Models folder', (err as Error).message);
  }
  line(fs.existsSync(s.cacheDir), 'Cache folder', s.cacheDir);
  try {
    fs.mkdirSync(s.workDir, { recursive: true });
    line(true, 'Work folder', s.workDir);
  } catch (err) {
    line(false, 'Work folder', (err as Error).message);
  }
  return ok;
}

/** WP17: builds the TTS program's image from the tts folder next to the app (docker build). */
function buildTts(s: WorkerSettings): Promise<number> {
  const context = path.join(__dirname, 'tts');
  if (!fs.existsSync(path.join(context, 'Dockerfile'))) {
    console.error(`No TTS program folder at ${context} (reinstall the worker)`);
    return Promise.resolve(2);
  }
  console.log(
    `Building ${s.ttsImage} from ${context} (about 10 minutes and 9-10 GB the first time)...`,
  );
  return new Promise((resolve) => {
    const child = spawn(s.dockerPath, [...s.dockerPrefixArgs, 'build', '-t', s.ttsImage, context], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (err) => {
      console.error(err.message);
      resolve(1);
    });
    child.on('close', (code) => {
      console.log(
        code === 0 ? `Built ${s.ttsImage}. Check it with: node main.js check` : 'The build failed.',
      );
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  let settings: WorkerSettings;
  try {
    settings = loadSettings(configPath());
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config problem: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  if (command === 'check') {
    process.exit((await check(settings)) ? 0 : 1);
  }
  if (command === 'build-tts') {
    process.exit(await buildTts(settings));
  }
  if (command !== 'run') {
    console.error('Usage: node main.js [run|check|build-tts]');
    process.exit(2);
  }
  const log = fileLogger(settings.logDir, settings.logMaxMB);
  const lock = lockFile(settings);
  const holder = takeLock(lock);
  if (holder !== null) {
    log.error(`Another GPU worker is already running (process ${holder}); this one exits.`);
    process.exit(0);
  }
  const worker = new Worker({ settings, api: new ServerApi(settings), log });
  const release = () => {
    try {
      if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock);
    } catch {
      // Already gone.
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => {
      log.info(`${sig}: stopping after the current step`);
      worker.stop();
      release();
      // A job in progress is left to its lease on the server; SubPlz is not killed here.
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
  process.on('exit', release);
  await worker.run();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
