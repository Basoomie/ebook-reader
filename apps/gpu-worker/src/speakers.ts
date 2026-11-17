/**
 * Season 2 Phase 12 session 5 (worker 1.4.0): a speaker job. The speaker model (a GGUF file
 * from the reader's list) runs in llama.cpp's server (Docker with the GPU, image pinned in
 * config.ts), listening on 127.0.0.1 only. The server sends one request at a time; this
 * program applies the model's chat template, runs the request and sends the answer back.
 *
 * 1. The model file: `<speakerModelsDir>\<owner>--<repo>\<revision>\<file>` (shared by both
 *    Windows accounts, like the TTS models). Downloaded from Hugging Face when missing
 *    (continued after a break), its size and sha256 checked once (a `.ok` file remembers it).
 * 2. `docker run --rm -d --gpus all --name ttsu-llm-<job> -p 127.0.0.1:<port>:8080
 *    -v <models>:/models:ro <image> -m /models/<…> -c <context> -fa on -lm none --parallel 1
 *    --jinja -rea off`: llama.cpp fits what it can on the GPU (the rest in RAM, `--fit`, its
 *    default), reads the file without mapping it (`-lm none`), thinking off.
 * 3. Waits until it has loaded (`/health`), reporting, for at most speakerLoadMaxMinutes.
 * 4. Requests until the server says the run is complete: `/apply-template` (the model's own
 *    chat format) then `/completion` (temperature 0, the request's grammar or JSON schema,
 *    `n_probs` alternatives per token: how sure the model was).
 * 5. Stop: ends at once. Pause, read-aloud, sentence clips: the container is stopped and the
 *    job released; it continues later from the answers the server has.
 * The container is always removed at the end.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ClaimedJob, ServerApi, SpeakerClaim, SpeakerRequest } from './api';
import type { WorkerSettings } from './config';
import type { Logger } from './log';
import { runDocker } from './subplz';
import { TtsStopped } from './tts';

export const speakerContainer = (jobId: number) => `ttsu-llm-${jobId}`;

/** The model's folder and file under the models folder (`owner--repo/revision/file`). */
export function speakerModelPath(m: { repo: string; revision: string; file: string }): string[] {
  const parts = [m.repo.split('/').join('--'), m.revision, m.file];
  if (parts.some((p) => !/^[\w.+-]+$/.test(p) || p === '..' || p === '.')) {
    throw new Error(`Not a model the PC can store: ${m.repo} ${m.file}`);
  }
  return parts;
}

/** The arguments of the container (also checked by the tests). */
export function speakerArgs(
  s: WorkerSettings,
  jobId: number,
  modelRel: string[],
  contextSize: number,
): string[] {
  return [
    'run',
    '--rm',
    '-d',
    '--gpus',
    'all',
    '--name',
    speakerContainer(jobId),
    '-p',
    `127.0.0.1:${s.speakerPort}:8080`,
    '-v',
    `${s.speakerModelsDir}:/models:ro`,
    s.speakerImage,
    '-m',
    `/models/${modelRel.join('/')}`,
    '-c',
    String(contextSize),
    '-fa',
    'on',
    '-lm',
    'none',
    '--parallel',
    '1',
    '--jinja',
    '-rea',
    'off',
  ];
}

/** A JSON request to llama.cpp's server (node:http: fetch gives up after 300 s). */
function local(
  port: number,
  method: 'GET' | 'POST',
  route: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = { text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(
        new Error(`The speaker model took longer than ${Math.round(timeoutMs / 60000)} minutes`),
      ),
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 }), hash);
  return hash.digest('hex');
}

/**
 * The model file on this PC: downloaded when missing (continuing a `.part`), size and sha256
 * checked once. `report(fraction)` while downloading. Returns its path parts under the
 * models folder.
 */
export async function ensureSpeakerModel(
  s: WorkerSettings,
  model: SpeakerClaim['speakers']['model'],
  report: (fraction: number | null, message: string) => Promise<void>,
  log: Logger,
  signal?: AbortSignal,
): Promise<string[]> {
  const rel = speakerModelPath(model);
  const file = path.join(s.speakerModelsDir, ...rel);
  const ok = `${file}.ok`;
  const marker = `${model.size ?? '?'} ${model.sha256 ?? '?'}`;
  const checked = async () => (await fsp.readFile(ok, 'utf8').catch(() => '')).trim() === marker;
  if (fs.existsSync(file) && (await checked())) return rel;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const part = `${file}.part`;
    const have = (await fsp.stat(part).catch(() => null))?.size ?? 0;
    const url = `${s.huggingFaceUrl}/${model.repo}/resolve/${model.revision}/${encodeURIComponent(model.file)}`;
    log.info(
      `Downloading the speaker model ${model.repo}/${model.file}${have ? ` (from ${have} bytes)` : ''}`,
    );
    const res = await fetch(url, {
      headers: have ? { Range: `bytes=${have}-` } : {},
      signal,
      redirect: 'follow',
    });
    if (!res.ok || !res.body) throw new Error(`The model download failed: HTTP ${res.status}`);
    const resumed = res.status === 206;
    const total =
      model.size ?? (Number(res.headers.get('content-length')) + (resumed ? have : 0) || null);
    let received = resumed ? have : 0;
    let last = 0;
    const source = Readable.fromWeb(res.body as import('stream/web').ReadableStream<Uint8Array>);
    source.on('data', (c: Buffer) => {
      received += c.length;
      if (Date.now() - last > s.reportSeconds * 1000) {
        last = Date.now();
        void report(
          total ? received / total : null,
          `Downloading the speaker model (${Math.round(received / 1e6)} MB${total ? ` of ${Math.round(total / 1e6)} MB` : ''})`,
        ).catch(() => undefined);
      }
    });
    await pipeline(source, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
    await fsp.rename(part, file);
  }
  const st = await fsp.stat(file);
  if (model.size !== null && st.size !== model.size) {
    await fsp.rm(file, { force: true });
    throw new Error(
      `The speaker model's file has the wrong size (${st.size} bytes, expected ${model.size}); it will be downloaded again`,
    );
  }
  if (model.sha256) {
    await report(null, 'Checking the speaker model file');
    const sha = await sha256Of(file);
    if (sha !== model.sha256) {
      await fsp.rm(file, { force: true });
      throw new Error(
        "The speaker model's file is damaged (sha256 differs); it will be downloaded again",
      );
    }
  }
  await fsp.writeFile(ok, marker);
  return rel;
}

/** Deletes the folders of speaker models removed from the list in the reader. */
export async function removeDeletedSpeakerModels(
  api: ServerApi,
  dir: string,
  log: Logger,
): Promise<void> {
  let removed: { dir: string }[];
  try {
    removed = (await api.speakerModels()).removed;
  } catch {
    return;
  }
  for (const m of removed) {
    const parts = m.dir.split('/');
    if (parts.length !== 2 || parts.some((p) => !/^[\w.+-]+$/.test(p) || p === '..')) continue;
    const target = path.join(dir, ...parts);
    if (!fs.existsSync(target)) continue;
    await fsp.rm(target, { recursive: true, force: true });
    log.info(`Removed the speaker model ${m.dir} (taken off the list in the reader)`);
    await fsp.rmdir(path.dirname(target)).catch(() => undefined);
  }
}

/** Runs one speaker job. Throws TtsStopped when stopped from the reader. */
export async function runSpeakerJob({
  job,
  s,
  api,
  log,
}: {
  job: ClaimedJob;
  s: WorkerSettings;
  api: ServerApi;
  log: Logger;
}): Promise<void> {
  const claim = job.tts as unknown as SpeakerClaim;
  if (!claim?.speakers?.model) throw new Error('The job has no speaker model');
  const docker = (args: string[], timeoutMs = 120_000) =>
    runDocker(s.dockerPath, [...s.dockerPrefixArgs, ...args], timeoutMs);
  const name = speakerContainer(job.id);
  let made = false;
  /** The queue's answer: stop now, or make way (pause / read-aloud / clips). */
  const decide = async (flags: { cancel: boolean; pause?: boolean; yield?: boolean }) => {
    if (flags.cancel) throw new TtsStopped('Stopped from the reader');
    if (flags.pause || flags.yield) return 'release';
    return null;
  };
  const report = async (fraction: number | null, message: string) =>
    decide(await api.progress(job.id, { stage: 'preparing', progress: fraction, message }));
  try {
    const rel = await ensureSpeakerModel(
      s,
      claim.speakers.model,
      async (f, m) => {
        if ((await report(f, m)) === 'release') throw new TtsStopped('release');
      },
      log,
    );
    await docker(['rm', '-f', name]).catch(() => undefined);
    await docker(speakerArgs(s, job.id, rel, claim.speakers.contextSize));
    made = true;
    log.info(`Job ${job.id}: loading ${claim.speakers.model.label}`);
    // Loading: llama.cpp answers /health with 503 until the model is in memory.
    const loadUntil = Date.now() + s.speakerLoadMaxMinutes * 60_000;
    let lastReport = 0;
    for (;;) {
      const h = await local(s.speakerPort, 'GET', '/health', undefined, 5_000).catch(() => null);
      if (h?.status === 200) break;
      const running = (
        await docker(['ps', '-q', '--filter', `name=^${name}$`]).catch(() => '')
      ).trim();
      if (!running) {
        throw new Error(
          'The speaker program stopped while loading the model (not enough memory on the PC?)',
        );
      }
      if (Date.now() > loadUntil) {
        throw new Error(`The speaker model did not load within ${s.speakerLoadMaxMinutes} minutes`);
      }
      if (Date.now() - lastReport > s.reportSeconds * 1000) {
        lastReport = Date.now();
        if (
          (await report(null, `Loading the speaker model (${claim.speakers.model.label})`)) ===
          'release'
        ) {
          throw new TtsStopped('release');
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    log.info(`Job ${job.id}: the speaker model is loaded`);
    const timeoutMs = s.speakerRequestMaxMinutes * 60_000;
    for (;;) {
      const { request } = await api.speakersNext(job.id);
      if (!request) break;
      const answer = await ask(s.speakerPort, request, timeoutMs);
      const flags = await api.speakersAnswer(job.id, request.seq, answer);
      if ((await decide(flags)) === 'release') throw new TtsStopped('release');
    }
    log.info(`Job ${job.id}: the speakers are worked out`);
  } catch (err) {
    if (err instanceof TtsStopped && err.message === 'release') {
      await api.speakersRelease(job.id).catch(() => undefined);
      log.info(`Job ${job.id}: made way; it continues later`);
      return;
    }
    throw err;
  } finally {
    if (made) await docker(['rm', '-f', name]).catch(() => undefined);
  }
}

/** One request: the model's chat format, then the completion with its grammar. */
async function ask(
  port: number,
  r: SpeakerRequest,
  timeoutMs: number,
): Promise<{ content: string; probs?: unknown; ms: number }> {
  const t0 = Date.now();
  const tpl = await local(
    port,
    'POST',
    '/apply-template',
    {
      messages: r.messages,
      ...(r.think ? { chat_template_kwargs: { enable_thinking: true } } : {}),
    },
    60_000,
  );
  const prompt = (tpl.json as { prompt?: unknown })?.prompt;
  if (tpl.status !== 200 || typeof prompt !== 'string') {
    throw new Error(`The speaker program could not format a request (HTTP ${tpl.status})`);
  }
  const body: Record<string, unknown> = {
    prompt,
    n_predict: r.nPredict,
    temperature: 0,
    cache_prompt: true,
    n_probs: r.nProbs,
  };
  if (r.grammar) body.grammar = r.grammar;
  if (r.jsonSchema) body.json_schema = r.jsonSchema;
  const out = await local(port, 'POST', '/completion', body, timeoutMs);
  const json = out.json as {
    content?: unknown;
    completion_probabilities?: unknown;
    error?: { message?: string };
  };
  if (out.status !== 200 || typeof json?.content !== 'string') {
    throw new Error(`The speaker model failed: ${json?.error?.message ?? `HTTP ${out.status}`}`);
  }
  return {
    content: json.content,
    ...(r.nProbs > 0 ? { probs: json.completion_probabilities } : {}),
    ms: Date.now() - t0,
  };
}
