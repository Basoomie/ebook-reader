/**
 * Season 2 Phase 12 session 3: live read-aloud on the PC (decided with the user, 2026-11-16).
 * While the server says a read-aloud session needs the PC, the worker:
 *
 *   1. asks /worker/live/next (held open on the server) for the session and its next batch;
 *   2. loads the session's model in the voice process (engine.ts) if it isn't loaded,
 *      telling the server meanwhile that it is loading (the device shows it);
 *   3. reads each batch with the session's voice and seed and uploads its FLAC and timings;
 *      the server makes the MP3 the device plays;
 *   4. goes back to its queue when the server says no session needs it (the voice stays
 *      loaded for the keep time).
 *
 * A model that can't be loaded or a batch that can't be read is reported on the batch (the
 * device shows why); loading is tried again after a pause.
 */
import fsp from 'fs/promises';
import { type LiveAssignment, type ServerApi } from './api';
import { EngineError, type VoiceEngine } from './engine';
import type { Logger } from './log';

/** How long a /worker/live/next request is held open (s). */
export const LIVE_WAIT_SECONDS = 20;
/** After a model failed to load, wait this long before trying again (ms). */
export const LOAD_RETRY_MS = 30_000;

export interface LiveDeps {
  api: ServerApi;
  engine: VoiceEngine;
  log: Logger;
  /** A batch not read within this long stops the voice process (seconds). */
  readMaxSeconds: number;
  /** Whether the worker is stopping. */
  stopping: () => boolean;
}

export class LiveReader {
  private loadFailedAt = 0;
  private loadError: string | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly d: LiveDeps) {}

  /** Serves read-aloud until no session needs the PC (or the worker stops). */
  async run(): Promise<void> {
    const { api, engine, log } = this.d;
    log.info('Read-aloud: serving');
    let sessionId: string | null = null;
    while (!this.d.stopping()) {
      const ready = (a: LiveAssignment | null) => !!a && engine.readyWith(a.session.model);
      // First only the session (no batch taken until the voice is loaded).
      let next = await api.liveNext({ engine: engine.report(), take: false, wait: 0 });
      if (!next) break;
      if (next.session.id !== sessionId) {
        sessionId = next.session.id;
        log.info(`Read-aloud: session ${sessionId.slice(0, 8)}`);
      }
      if (!ready(next)) {
        await this.load(next);
        continue;
      }
      await this.voice(next.session.voice.sha256);
      next = await api.liveNext({ engine: engine.report(), take: true, wait: LIVE_WAIT_SECONDS });
      if (!next) break;
      if (!next.batch) continue;
      await this.read(next);
    }
    log.info('Read-aloud: no session needs the PC now');
  }

  /** Loads the session's model; while it loads the server hears every few seconds. */
  private async load(a: LiveAssignment): Promise<void> {
    const { api, engine, log } = this.d;
    if (Date.now() - this.loadFailedAt < LOAD_RETRY_MS && this.loadError) {
      // A failed load: the next batch is told why, then wait before trying again.
      const failed = await api.liveNext({ engine: null, take: true, wait: 2 });
      if (failed?.batch) {
        await api
          .liveFail(failed.session.id, failed.batch.seq, this.loadError)
          .catch(() => undefined);
      }
      await sleep(2000);
      return;
    }
    if (!this.loading) {
      this.loading = engine
        .ensure(a.session.model)
        .then(() => {
          this.loadError = null;
        })
        .catch((err: Error) => {
          this.loadFailedAt = Date.now();
          this.loadError =
            err instanceof EngineError
              ? err.message
              : `The voice could not be loaded: ${err.message}`;
          log.error(`Read-aloud: ${this.loadError}`);
        })
        .finally(() => {
          this.loading = null;
        });
    }
    // Report "loading" as soon as the process loads (the device says so), then every 3 s until
    // it is done (or no session needs it any more).
    const loading = this.loading;
    let reported = false;
    while (this.loading === loading && !this.d.stopping()) {
      const done = await Promise.race([
        loading.then(() => true),
        sleep(reported ? 3000 : 150).then(() => false),
      ]);
      if (done) break;
      if (!engine.report()) continue;
      reported = true;
      const still = await api.liveNext({ engine: engine.report(), take: false, wait: 0 });
      if (!still) {
        // Nobody needs it now; the load goes on (the voice is kept for the keep time).
        await loading;
        break;
      }
    }
  }

  /** The session's voice clip in the voice process's folder. */
  private async voice(sha256: string): Promise<void> {
    const { api, engine } = this.d;
    if (await engine.hasVoice(sha256)) return;
    const dest = engine.voiceFile(sha256);
    const tmp = `${dest}.part`;
    await fsp.rm(tmp, { force: true });
    await api.liveVoice(sha256, tmp);
    await fsp.rename(tmp, dest);
  }

  private async read(a: LiveAssignment): Promise<void> {
    const { api, engine, log } = this.d;
    const batch = a.batch!;
    const name = `b-${a.session.id.slice(0, 8)}-${batch.seq}`;
    const last = batch.sentences[batch.sentences.length - 1];
    const started = Date.now();
    log.info(`Read-aloud: reading batch ${batch.seq} (${batch.sentences.length} sentences)`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = engine.read({
        sentences: batch.sentences,
        voiceSha: a.session.voice.sha256,
        caption: null,
        seed: a.session.seed,
        pauses: a.session.pauses,
        whole: false,
        // Batches join with the pause the next sentence would have.
        lastGapMs: last?.paragraphEnd ? a.session.pauses.paragraphMs : a.session.pauses.sentenceMs,
        name,
      });
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `The voice process did not read the sentences within ${this.d.readMaxSeconds} s`,
              ),
            ),
          this.d.readMaxSeconds * 1000,
        );
      });
      let result;
      try {
        result = await Promise.race([reading, limit]);
      } catch (err) {
        if (!(err instanceof EngineError)) {
          // Stuck: the process is stopped; the next batch loads the voice again.
          reading.catch(() => undefined);
          await engine.kill();
        }
        throw err;
      }
      log.info(
        `Read-aloud: batch ${batch.seq} read in ${((Date.now() - started) / 1000).toFixed(1)} s; sending it`,
      );
      await api.liveUpload(a.session.id, batch.seq, result.flac);
      await api.liveDone(a.session.id, batch.seq, {
        durationMs: result.meta.durationMs,
        cues: result.meta.cues,
      });
      log.info(
        `Read-aloud: batch ${batch.seq} (${batch.sentences.length} sentences, ${Math.round(result.meta.durationMs / 1000)} s) in ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );
    } catch (err) {
      const message = (err as Error).message || String(err);
      log.error(`Read-aloud: batch ${batch.seq} failed: ${message}`);
      // The session may have ended meanwhile (409): nothing to tell.
      await api.liveFail(a.session.id, batch.seq, message.slice(0, 500)).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      await engine.forget(name).catch(() => undefined);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
