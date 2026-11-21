/**
 * WP21f-1 stop 1: the replay test. 30 labeled recordings (labels.json "books", a seeded draw)
 * are taken out of the library stage 6 built and fed through stage 7's arrival path on a clean
 * working copy of the live cleanup.db, with the real code:
 *
 *   1. stage 5 again with the arrivals' design J for the 30 (labeledOnly; the stored E answers
 *      are reused, the stronger pair is asked for real, spending limit = spent + --budget);
 *   2. stage 7's classify (classifyArrivals on loadClassifyInputs) with the 30's files taken out
 *      of the library: every other recording must come out as already in the library;
 *   3. stage 7's plan (planBuildSliced + planArrivals) against the library's folders as stage 6
 *      built them minus the 30's, written as plain folders and metadata.json into --scratch (no
 *      links: each audio file is a small .txt naming its source);
 *   4. compared with the labels (stage 4's gate on the 30: 0 wrong automatic matches; stage 5's
 *      gate on the 30: every field at its bar) and with what stage 6 built for the same books.
 *
 * Honest limit: the file reads (hash, ffprobe, decodes, fingerprints, frames) and the re-check of
 * each source file on disk are the stored results, not the real files; the e2e covers those
 * paths. Nothing outside the working copy and the scratch folder is written.
 *
 *   npx ts-node --transpile-only scripts/wp21f-replay.ts --db <copy/cleanup.db> --main <copy/ttsu.db>
 *     --labels <labels.json> --work <work/cleanup.db> --scratch <dir> --out <report.json>
 *     [--budget 2] [--reuse] [--no-ai]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { AiRunner } from '../src/cleanup/ai/runner';
import { spendNow } from '../src/cleanup/ai/spend';
import { valuesOf } from '../src/cleanup/ai/values';
import {
  classifyArrivals,
  everLinkedInodes,
  loadClassifyInputs,
} from '../src/cleanup/audio/arrivals-classify';
import { planArrivals, type ExistingTree } from '../src/cleanup/audio/arrivals-plan';
import { getAudioStage } from '../src/cleanup/audio/audio-stages';
import { loadPlanInputs, stageIds } from '../src/cleanup/audio/build-inputs';
import { planBuildSliced } from '../src/cleanup/audio/build-plan';
import { AudioStage4, type Stage4Deps } from '../src/cleanup/audio/stage4-online';
import { AudioStage5 } from '../src/cleanup/audio/stage5-meta';
import { SecretStore } from '../src/cleanup/secrets';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { workingCopy } from './wp21f-copy';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toLocaleTimeString();
const SEED = 20261121;
const COUNT = 30;

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const renameArea = (f: string) =>
  f
    .replace(/^japanese-new\//, 'japanese/')
    .replace(/^japanese-generated-new\//, 'japanese-generated/');

interface Label {
  id: string;
  kind: string;
  torrent: string;
  [k: string]: unknown;
}

async function main() {
  const out = arg('work')!;
  const db = has('reuse') ? new Database(out) : workingCopy(arg('db')!, out);
  console.log(
    `working copy v${db.pragma('user_version', { simple: true })}: ${db.pragma('quick_check', { simple: true })}`,
  );
  const labelsAll = JSON.parse(fs.readFileSync(arg('labels')!, 'utf8')) as {
    books: Label[];
  };
  const p4 = getAudioStage(db, 4).progress as { analysisId: string };
  const p6 = getAudioStage(db, 6).progress as { analysisId: string };

  // --- the draw: labeled recordings stage 6 built (seeded) ----------------------------------
  const stage4 = new AudioStage4({ db } as unknown as Stage4Deps);
  const unitOf4 = stage4.unitFinder(p4 as never);
  const built = new Map<
    string,
    { id: number; folder: string; copyKey: string; metadata: Buffer }
  >();
  for (const r of db
    .prepare(
      `SELECT id, unit_key, folder, copy_key, metadata FROM audio_build_books WHERE analysis_id = ? AND state = 'build'`,
    )
    .all(p6.analysisId) as {
    id: number;
    unit_key: string;
    folder: string;
    copy_key: string;
    metadata: Buffer;
  }[])
    built.set(r.unit_key, {
      id: r.id,
      folder: r.folder,
      copyKey: r.copy_key,
      metadata: r.metadata,
    });
  const eligible = labelsAll.books.filter((b) => {
    const u = unitOf4(b.torrent);
    return u && built.has(u.unitKey);
  });
  const rnd = mulberry32(SEED);
  const shuffled = eligible
    .map((b) => ({ b, k: rnd() }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.b);
  // One label per recording (two labels can share a recording).
  const chosen: Label[] = [];
  const chosenUnits = new Set<string>();
  for (const b of shuffled) {
    const u = unitOf4(b.torrent)!.unitKey;
    if (chosenUnits.has(u)) continue;
    chosen.push(b);
    chosenUnits.add(u);
    if (chosen.length === COUNT) break;
  }
  console.log(
    `draw: ${eligible.length} of ${labelsAll.books.length} labels are built books; chose ${chosen.length}: ${chosen.map((b) => b.id).join(' ')}`,
  );

  // E values before (as stage 5 decided them live).
  const before = new Map<string, Record<string, unknown>>();
  for (const u of chosenUnits)
    before.set(
      u,
      Object.fromEntries(
        valuesOf(db, 'audio5', u).map((v) => [
          v.field,
          { value: v.value, flagged: v.flagged, design: v.design },
        ]),
      ),
    );

  // --- 1. stage 5 with J for the 30 ----------------------------------------------------------
  const subsetText = JSON.stringify({ books: chosen });
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const secrets = new SecretStore(db, main);
  const s = getSettings(db);
  const spentBefore = spendNow(db).spentUsd;
  const budget = Number(arg('budget') ?? 2);
  updateSettings(db, {
    ai: {
      ...s.ai,
      spendLimitUsd: Math.round((spentBefore + budget) * 100) / 100,
      labeledOnly: true,
      modes: { anthropic: 'direct', openai: 'direct' },
    },
  });
  db.prepare(`UPDATE audio_stages SET mode = 'analyse' WHERE stage = 5`).run();
  const runner = new AiRunner({ db, secrets, log: (m) => console.log(`${t()} ${m}`) });
  const designs = new Map<string, 'E' | 'F' | 'J'>([...chosenUnits].map((u) => [u, 'J']));
  const stage5 = new AudioStage5({
    db,
    runner,
    readLabels: () => ({ text: subsetText, error: null }),
    designs: () => designs,
    log: (m) => console.log(`${t()} ${m}`),
  });
  const t5 = Date.now();
  if (!has('no-ai')) {
    stage5.restart();
    for (;;) {
      const r = await stage5.step(() => false, p4.analysisId);
      const p = stage5.progress()!;
      if (r === 'done') break;
      if (r === 'wait') {
        const st = getAudioStage(db, 5);
        if (st.pauseReason) {
          console.log(`${t()} stage 5 paused: ${st.pauseDetail}`);
          if (st.pauseReason !== 'ai') break;
        }
        console.log(`${t()} ${p.phase} ${JSON.stringify(p.ai)} ${p.wait ?? ''}`);
        await sleep(5000);
      }
    }
  }
  const p5 = stage5.progress()!;
  const spentAfter = spendNow(db).spentUsd;
  console.log(
    `stage 5: ${p5.phase}, designs ${JSON.stringify(p5.designs)}, upgrade asked ${p5.upgradeAsked}, spent $${(spentAfter - spentBefore).toFixed(3)} in ${Math.round((Date.now() - t5) / 1000)} s`,
  );
  const gate5 = p5.gate;

  // --- 2. classify with the 30 taken out of the library --------------------------------------
  const { ids, problem } = stageIds(db);
  if (!ids) throw new Error(problem ?? 'stages not done');
  const input = loadClassifyInputs(
    db,
    { s1: ids.s1, s3: ids.s3, s4: ids.s4 },
    { generatedInodes: new Set(), now: Date.now(), settleMs: 30 * 60_000 },
  );
  const inode = (f: { dev: number; ino: number }) => `${f.dev}:${f.ino}`;
  const unitFiles = (u: string) => {
    const unit = input.units.find((x) => x.key === u)!;
    return unit.copyKeys
      .map((k) => input.copies.get(k))
      .filter((c) => !!c)
      .flatMap((c) => c!.fileIds.map((id) => input.files.get(id)!).filter(Boolean));
  };
  const outInodes = new Set<string>();
  const outRels = new Set<string>();
  for (const u of chosenUnits)
    for (const f of unitFiles(u)) {
      outInodes.add(inode(f));
      if (f.root === 'torrents') outRels.add(f.rel);
    }
  // The library after the switch: what stage 6 linked, plus the 5 books the switch linked from
  // the old library (their library files: the same inodes), minus the 30.
  const linked = everLinkedInodes(db);
  const pending = db
    .prepare(`SELECT unit_key FROM audio_build_books WHERE analysis_id = ? AND state = 'pending'`)
    .all(p6.analysisId) as { unit_key: string }[];
  for (const r of pending)
    if (input.units.some((x) => x.key === r.unit_key))
      for (const f of unitFiles(r.unit_key)) linked.add(inode(f));
  input.present = new Set([...linked].filter((x) => !outInodes.has(x)));
  input.everLinked = new Set([...input.everLinked].filter((x) => !outInodes.has(x)));
  if (input.baseline) input.baseline = new Set([...input.baseline].filter((r) => !outRels.has(r)));
  const cls = classifyArrivals(input);
  const unexpected = cls.outcomes.filter(
    (o) => !chosenUnits.has(o.unitKey) && o.outcome !== 'existing',
  );
  const ofChosen = cls.outcomes.filter((o) => chosenUnits.has(o.unitKey));
  console.log(
    `classify: ${JSON.stringify(cls.counts)}, unlinked known ${cls.unlinkedKnown}; the 30: ${JSON.stringify(
      ofChosen.reduce<Record<string, number>>(
        (m, o) => ((m[o.outcome] = (m[o.outcome] ?? 0) + 1), m),
        {},
      ),
    )}; others not in the library: ${unexpected.length}`,
  );

  // --- 3. plan against the library's folders as built, minus the 30 --------------------------
  const outFolders = new Set(
    [...chosenUnits]
      .map((u) => built.get(u))
      .filter(Boolean)
      .map((b) => renameArea(b!.folder)),
  );
  const tree: ExistingTree = {
    dirs: new Set(['japanese', 'japanese-generated']),
    bookDirs: new Set(),
    narrators: new Map(),
  };
  const addDirs = (rel: string, isFile: boolean) => {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) tree.dirs.add(parts.slice(0, i).join('/'));
    if (isFile) tree.bookDirs.add(parts.slice(0, -1).join('/'));
  };
  const outOps = new Set<number>();
  for (const r of db
    .prepare(
      `SELECT o.dst, o.kind, b.folder FROM audio_build_ops o LEFT JOIN audio_build_books b ON b.id = o.book_id
       WHERE o.analysis_id = ? AND o.state = 'done'`,
    )
    .all(p6.analysisId) as { dst: string; kind: string; folder: string | null }[]) {
    const book = r.folder ? renameArea(r.folder) : null;
    if (book && outFolders.has(book)) continue;
    const dst = renameArea(r.dst);
    if (r.kind === 'folder') {
      // A folder made only for one of the 30 (its own book folder) goes with it.
      if (outFolders.has(dst)) continue;
      addDirs(dst + '/x', false);
    } else addDirs(dst, true);
  }
  void outOps;
  for (const r of db
    .prepare(`SELECT folder, metadata, state FROM audio_build_books WHERE analysis_id = ?`)
    .all(p6.analysisId) as { folder: string; metadata: Buffer; state: string }[]) {
    const f = renameArea(r.folder);
    if (outFolders.has(f)) continue;
    if (r.state === 'pending') addDirs(f + '/x', true);
    try {
      tree.narrators.set(
        f,
        (JSON.parse(r.metadata.toString('utf8')) as { narrators?: string[] }).narrators?.[0] ??
          null,
      );
    } catch {
      tree.narrators.set(f, null);
    }
  }
  // Folders of the 30's parents that only held them are gone too (an author folder of one book).
  for (const d of [...tree.dirs])
    if (
      ![...tree.bookDirs].some((b) => b === d || b.startsWith(d + '/')) &&
      d.split('/').length > 1
    )
      tree.dirs.delete(d);
  const linkCopies = new Set<string>();
  for (const o of ofChosen) if (o.outcome === 'new') for (const k of o.link) linkCopies.add(k);
  const inputs = await loadPlanInputs(db, ids, { readerWritten: [], libraryFolder: 'japanese' });
  const full = await planBuildSliced(inputs);
  const planned = full.books.filter((b) => linkCopies.has(b.copyKey) && b.state === 'build');
  const plan = planArrivals(planned, tree);
  console.log(`plan: ${JSON.stringify(plan.counts)}`);

  // The scratch tree: folders, metadata.json, and a .txt per link naming its source.
  const scratch = arg('scratch')!;
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const b of plan.books) {
    const dir = path.join(scratch, ...b.folder.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), b.metadata);
    for (const f of [...b.files, ...b.pdfs]) {
      const src = inputs.files.get(f.fileId);
      fs.writeFileSync(
        path.join(scratch, ...f.dst.split('/')) + '.link.txt',
        `${src?.rel ?? '?'}\n${src?.size ?? '?'} bytes\n`,
      );
    }
  }

  // --- 4. compare ------------------------------------------------------------------------------
  const stage4s = new AudioStage4({
    db,
    readLabels: () => ({ text: subsetText, error: null }),
  } as unknown as Stage4Deps);
  const gate4 = stage4s.evaluateGate(getAudioStage(db, 4).progress as never);
  const wrongAuto = gate4.results.filter((r) => r.outcome === 'miss');
  const books = chosen.map((b) => {
    const u = unitOf4(b.torrent)!.unitKey;
    const o = ofChosen.find((x) => x.unitKey === u);
    const pb = plan.books.find((x) => x.unitKey === u);
    const sb = built.get(u)!;
    const meta = (buf: Buffer | undefined) => {
      try {
        return buf ? (JSON.parse(buf.toString('utf8')) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const m6 = meta(sb.metadata);
    const m7 = meta(pb?.metadata);
    const metaDiff: Record<string, { stage6: unknown; stage7: unknown }> = {};
    if (m6 && m7)
      for (const k of new Set([...Object.keys(m6), ...Object.keys(m7)]))
        if (JSON.stringify(m6[k]) !== JSON.stringify(m7[k]))
          metaDiff[k] = { stage6: m6[k], stage7: m7[k] };
    const after = Object.fromEntries(
      valuesOf(db, 'audio5', u).map((v) => [
        v.field,
        { value: v.value, flagged: v.flagged, design: v.design },
      ]),
    );
    const changedByJ = Object.keys(after).filter(
      (f) =>
        JSON.stringify((before.get(u)?.[f] as { value?: unknown })?.value) !==
        JSON.stringify(after[f].value),
    );
    return {
      id: b.id,
      kind: b.kind,
      unitKey: u,
      outcome: o?.outcome ?? 'existing?',
      reason: o?.reason ?? null,
      match: gate4.results.find((r) => r.id === b.id),
      stage6Folder: renameArea(sb.folder),
      stage7Folder: pb?.folder ?? null,
      sameFolder: pb ? pb.folder === renameArea(sb.folder) : false,
      notes: pb?.notes ?? [],
      metaDiff,
      changedByJ,
      before: before.get(u),
      after,
    };
  });
  const report = {
    seed: SEED,
    chosen: chosen.map((b) => b.id),
    ai: {
      spentUsd: Math.round((spentAfter - spentBefore) * 1000) / 1000,
      designs: p5.designs,
      upgradeAsked: p5.upgradeAsked,
      phase: p5.phase,
      error: p5.error,
      models: db
        .prepare(
          `SELECT model, state, COUNT(*) AS n, ROUND(SUM(cost_usd), 4) AS c FROM ai_requests WHERE created_at >= ? GROUP BY model, state`,
        )
        .all(t5),
    },
    classify: {
      counts: cls.counts,
      unlinkedKnown: cls.unlinkedKnown,
      chosen: ofChosen.map((o) => ({ unit: o.unitKey, outcome: o.outcome, reason: o.reason })),
      unexpected: unexpected
        .slice(0, 50)
        .map((o) => ({ unit: o.unitKey, name: o.name, outcome: o.outcome, reason: o.reason })),
      unexpectedCount: unexpected.length,
    },
    plan: plan.counts,
    gate4: { checked: gate4.checked, wrongAuto, bySource: gate4.bySource },
    gate5: gate5
      ? {
          passed: gate5.passed,
          books: gate5.books,
          fields: gate5.fields,
          misses: gate5.misses,
          flaggedWrong: gate5.flaggedWrong,
          notFound: gate5.notFound,
        }
      : null,
    sameFolder: books.filter((b) => b.sameFolder).length,
    books,
  };
  fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify(
      {
        classify30: report.classify.chosen.map((c) => c.outcome).join(','),
        unexpected: unexpected.length,
        wrongAuto: wrongAuto.length,
        gate5: gate5 && { passed: gate5.passed, fields: gate5.fields, misses: gate5.misses.length },
        sameFolder: report.sameFolder,
        planned: plan.books.length,
        spent: report.ai.spentUsd,
      },
      null,
      1,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
