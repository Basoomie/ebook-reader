/**
 * WP20c (2026-11-17): a finished stage-3 analysis is classified again when the limits change,
 * without reading any book again; the review's decisions (cli cleanup decide 3) become
 * removals marked as Claude's, with their reason and the file facts the batch check needs, and
 * never replace a decision you made on the page.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader, type Stage3Reader } from '../src/counts/book-text-worker';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { recordReviewDecisions, stage3RulesKey } from '../src/cleanup/stage3';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { chaptersOf, fakeText, makeTextEpub } from './helpers/stage3-fixture';

const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;

class CountingReader implements Stage3Reader {
  texts = 0;
  private readonly inner = new InProcessReader(bundle, IMPORT);
  text(file: string) {
    this.texts++;
    return this.inner.text(file);
  }
  compare(...args: Parameters<Stage3Reader['compare']>) {
    return this.inner.compare(...args);
  }
  index(req: Parameters<Stage3Reader['index']>[0]) {
    return this.inner.index(req);
  }
  close() {}
}

describe('stage 3: classified again, and the review decisions', () => {
  let env: CleanupEnv;
  let user: string;
  let ids: Record<string, number>;
  const reader = new CountingReader();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const made = await makeCleanupEnv({ service: { stage3Reader: reader, counterBuild: 'test' } });
    env = made.env;
    const add = (title: string, chapters: string[]) =>
      env.lib.addBook({ title, authors: ['作者'], epub: makeTextEpub({ title, chapters }) });
    const c = chaptersOf(3);
    // 1,000 extra characters inside each of the 6 chapters: about 2.7 % of the copy.
    const commentary = c.map(
      (ch, i) => ch.slice(0, 3000) + fakeText(77_000 + i, 1000) + ch.slice(3000),
    );
    ids = {
      A1: await add('A', chaptersOf(1)),
      A2: await add('A', chaptersOf(1)),
      C1: await add('C', c),
      C2: await add('C 解説付き', commentary),
      E1: await add('E', chaptersOf(5)),
      E2: await add('E', chaptersOf(5)),
    };
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
      const p = env.service.analysis3?.progress();
      if ((st === 'ready' || st === 'failed') && p && !env.service.analysis3!.needsReclassify(p))
        return st;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('stage 3 analysis did not finish');
  }
  const pair = (x: string, y: string) =>
    env.cleanupDb
      .prepare('SELECT * FROM content_pairs WHERE a_id = ? AND b_id = ? ORDER BY id DESC LIMIT 1')
      .get(Math.min(ids[x], ids[y]), Math.max(ids[x], ids[y])) as {
      id: number;
      a_uuid: string;
      b_uuid: string;
      class: string;
      rule: string;
      reason: string;
    };
  const removals = () =>
    (
      env.cleanupDb
        .prepare(
          "SELECT calibre_id, decided_by, evidence_json FROM proposed_changes WHERE stage = 3 AND state = 'proposed' ORDER BY calibre_id",
        )
        .all() as { calibre_id: number; decided_by: string | null; evidence_json: string }[]
    ).map((r) => ({ id: r.calibre_id, by: r.decided_by, ev: JSON.parse(r.evidence_json) }));

  it('the limits change: the pairs are classified again, no book read again', async () => {
    await request(env.app)
      .put('/api/v1/cleanup/stages/3')
      .set(auth(user))
      .send({ mode: 'analyse' })
      .expect(200);
    expect(await settle()).toBe('ready');
    expect(pair('C1', 'C2').rule).toBe('spread_unset');
    const reads = reader.texts;
    const p0 = env.service.analysis3!.progress()!;
    expect(p0.rulesKey).toBe(stage3RulesKey(getSettings(env.cleanupDb).duplicates));

    const settings = getSettings(env.cleanupDb);
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ duplicates: { ...settings.duplicates, spreadIgnore: 0.01, spreadKeepBoth: 0.02 } })
      .expect(200);
    expect(await settle()).toBe('ready');
    const c = pair('C1', 'C2');
    expect([c.class, c.rule]).toEqual(['keep_both', 'spread_keep_both']);
    expect(reader.texts).toBe(reads);
    const p1 = env.service.analysis3!.progress()!;
    expect(p1.analysisId).toBe(p0.analysisId);
    expect(p1.error).toBeNull();
    // Same text pairs still give their removals.
    // Tied copies: the older record stays.
    expect(removals().map((r) => r.id)).toEqual([ids.A2, ids.E2].sort((x, y) => x - y));

    // Back to "review" for the next test.
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({ duplicates: { ...settings.duplicates, spreadIgnore: null, spreadKeepBoth: null } })
      .expect(200);
    expect(await settle()).toBe('ready');
    expect(pair('C1', 'C2').rule).toBe('spread_unset');
  });

  it("the review's decisions: removals marked as Claude's, with the reason and the file facts; yours stay", async () => {
    // You keep both copies of E on the page.
    const e = pair('E1', 'E2');
    await request(env.app)
      .post(`/api/v1/cleanup/stage3/pairs/${e.id}`)
      .set(auth(user))
      .send({ decision: 'keep_both' })
      .expect(200);
    expect(await settle()).toBe('ready');

    const c = pair('C1', 'C2');
    const note = 'Same book; the copy with commentary has everything the other has';
    const out = recordReviewDecisions(env.cleanupDb, {
      decisions: [
        { aUuid: c.a_uuid, bUuid: c.b_uuid, decision: 'remove_a', note },
        { aUuid: e.a_uuid, bUuid: e.b_uuid, decision: 'remove_a', note: 'should not apply' },
      ],
    });
    expect(out).toMatchObject({ ok: true, recorded: 1, keptYours: 1 });
    expect(await settle()).toBe('ready');

    const r = removals();
    const cRemoved = r.find((x) => x.id === ids.C1)!;
    expect(cRemoved).toBeTruthy();
    expect(cRemoved.by).toBe('claude');
    expect(cRemoved.ev.stage3.decidedBy).toBe('claude');
    expect(cRemoved.ev.stage3.decisionNote).toBe(note);
    expect(cRemoved.ev.stage3.byUser).toBe(false);
    // The batch check compares both files with these hashes.
    expect(cRemoved.ev.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cRemoved.ev.kept.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Your keep-both on E stays.
    expect(r.some((x) => x.id === ids.E1 || x.id === ids.E2)).toBe(false);
    expect(pair('E1', 'E2').class).toBe('keep_both');
  });

  it('a decisions file with a missing note or an unknown pair records nothing', () => {
    const c = pair('C1', 'C2');
    expect(
      recordReviewDecisions(env.cleanupDb, {
        decisions: [{ aUuid: c.a_uuid, bUuid: c.b_uuid, decision: 'keep_both', note: '' }],
      }).ok,
    ).toBe(false);
    expect(
      recordReviewDecisions(env.cleanupDb, {
        decisions: [{ aUuid: 'x', bUuid: 'y', decision: 'keep_both', note: 'n' }],
      }).ok,
    ).toBe(false);
  });
});
