/**
 * WP20c: a stage-3 analysis that failed at a step resumes there (cli cleanup resume 3), keeping
 * the books read: the index fails once with the error seen on the NAS (2026-11-17, "Map
 * maximum size exceeded"); resumed, the analysis finishes without reading any book again and
 * gives the same pairs as an analysis that never failed.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader, type Stage3Reader } from '../src/counts/book-text-worker';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { resumeFailedStage3 } from '../src/cleanup/stage3';
import { getStage } from '../src/cleanup/stages';
import { makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { chaptersOf, makeTextEpub } from './helpers/stage3-fixture';

const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;

/** The real in-process reader, counting its reads; its index can be made to fail. */
class CountingReader implements Stage3Reader {
  texts = 0;
  failIndex = 0;
  private readonly inner = new InProcessReader(bundle, IMPORT);
  text(file: string) {
    this.texts++;
    return this.inner.text(file);
  }
  compare(...args: Parameters<Stage3Reader['compare']>) {
    return this.inner.compare(...args);
  }
  index(req: Parameters<Stage3Reader['index']>[0]) {
    if (this.failIndex > 0) {
      this.failIndex--;
      return Promise.resolve({
        ok: false as const,
        code: 'failed',
        message: 'Map maximum size exceeded',
      });
    }
    return this.inner.index(req);
  }
  close() {}
}

describe('stage 3: resuming a failed analysis', () => {
  let env: CleanupEnv;
  let user: string;
  const reader = new CountingReader();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const made = await makeCleanupEnv({ service: { stage3Reader: reader, counterBuild: 'test' } });
    env = made.env;
    const add = (title: string, chapters: string[]) =>
      env.lib.addBook({ title, authors: ['作者'], epub: makeTextEpub({ title, chapters }) });
    await add('A', chaptersOf(1));
    await add('A', chaptersOf(1));
    await add('B', chaptersOf(2));
    await add('B 完全版', [...chaptersOf(2), ...chaptersOf(3)]);
    await add('D', chaptersOf(6));
    await made.setup();
    user = env.userToken();
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  async function settle() {
    for (let i = 0; i < 1200; i++) {
      await env.service.tick();
      const st = getStage(env.cleanupDb, 3).state;
      if (st === 'ready' || st === 'failed') return st;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('stage 3 analysis did not finish');
  }
  const pairs = () =>
    env.cleanupDb
      .prepare(
        `SELECT a_id, b_id, round(a_in_b, 6) x, round(b_in_a, 6) y, class, rule, keep_id
         FROM content_pairs WHERE source = 'index' ORDER BY a_id, b_id`,
      )
      .all();

  it('fails at the index, resumes there without reading a book again, same pairs as a clean run', async () => {
    reader.failIndex = 1;
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'analyse' })
      .expect(200);
    expect(await settle()).toBe('failed');
    const failed = env.service.analysis3!.progress()!;
    expect(failed.error).toBe('The candidate index failed: Map maximum size exceeded');
    expect(failed.failedPhase).toBe('candidates');
    expect(failed.textDone).toBe(5);
    const readsBefore = reader.texts;
    expect(readsBefore).toBe(5);

    // Nothing to resume when it has not failed; then the resume itself.
    const out = resumeFailedStage3(env.cleanupDb);
    expect(out).toMatchObject({ ok: true, phase: 'candidates' });
    expect(resumeFailedStage3(env.cleanupDb).ok).toBe(false);
    expect(await settle()).toBe('ready');
    const resumed = env.service.analysis3!.progress()!;
    expect(resumed.error).toBeNull();
    expect(resumed.analysisId).toBe(failed.analysisId);
    expect(reader.texts).toBe(readsBefore);
    expect(resumed.textDone).toBe(5);
    const afterResume = pairs();
    expect(afterResume.length).toBeGreaterThan(0);

    // A clean analysis of the same library: the same pairs.
    await request(env.app).put('/api/v1/cleanup/stages/3').set(auth(user)).send({ mode: 'off' });
    env.service.analysis3!.restart(resumed.libraryId);
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'analyse' })
      .expect(200);
    expect(await settle()).toBe('ready');
    expect(pairs()).toEqual(afterResume);
  });

  it('a failure recorded before the failed step was kept resumes at the first step not complete', () => {
    const stage = getStage(env.cleanupDb, 3);
    const p = { ...(stage.progress as Record<string, unknown>) };
    // As the NAS's analysis was saved: failed after the text, no index, no failedPhase.
    Object.assign(p, {
      phase: 'done',
      error: 'The candidate index failed: Map maximum size exceeded',
      indexStats: null,
    });
    delete p.failedPhase;
    env.cleanupDb
      .prepare("UPDATE stages SET state = 'failed', progress_json = ? WHERE stage = 3")
      .run(JSON.stringify(p));
    expect(resumeFailedStage3(env.cleanupDb)).toMatchObject({ ok: true, phase: 'candidates' });
  });
});
