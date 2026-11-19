/**
 * WP21c stop 1: audiobook stage 4 on a copy of the live cleanup.db, with the reference sample's
 * answers standing in for the internet (nothing is fetched). Runs the real stage-4 code: units
 * from stage 3's rows, the lookups through the real fetch queue, the decisions and the gate.
 *
 *   npx vite-node scripts/wp21c-standin.ts -- --db <cleanup.db copy> --standin <dir> --out <dir>
 *
 * --standin holds `raw/` (refsample.py's cache: <sha1(url)[:16]> + .json with the URL) and
 * `probe1/` (the first probe's audiobook.jp product pages with their log.jsonl). Requests the
 * sample has no answer for are answered 404 (the site has no such page) and listed, so a book
 * they affect can only come out as review or unknown, never as a wrong automatic match.
 * The labeled books run first and alone (the gate); then the request counts for the library
 * are estimated from what the labeled books needed (--all also plans every unit).
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { getSettings, AUDIO_FETCH_SITES } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { AudioStage4, stage4Counts, type UnitInputs } from '../src/cleanup/audio/stage4-online';

function arg(name: string, def: string | null = null): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== null) return def;
  throw new Error(`--${name} is required`);
}

const src = arg('db');
const standin = arg('standin');
const out = arg('out');
const labelsFile = arg('labels', path.join(standin, 'labels.json'));
fs.mkdirSync(out, { recursive: true });
const dbFile = path.join(out, 'cleanup.db');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
fs.copyFileSync(src, dbFile);
for (const ext of ['-wal', '-shm'])
  if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, dbFile + ext);
const cacheDir = path.join(out, 'cache');
fs.rmSync(cacheDir, { recursive: true, force: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
const t0 = Date.now();
migrateCleanup(db);
console.log(`migrated to v${db.pragma('user_version', { simple: true })} in ${Date.now() - t0} ms`);

// ---- the stand-in internet
const answers = new Map<string, { status: number; file: string }>();
const raw = path.join(standin, 'raw');
for (const f of fs.readdirSync(raw)) {
  if (!f.endsWith('.json')) continue;
  const m = JSON.parse(fs.readFileSync(path.join(raw, f), 'utf8')) as {
    url: string;
    status: number | null;
  };
  if (m.status) answers.set(m.url, { status: m.status, file: path.join(raw, f.slice(0, -5)) });
}
const probe = path.join(standin, 'probe1');
if (fs.existsSync(path.join(probe, 'log.jsonl'))) {
  for (const line of fs.readFileSync(path.join(probe, 'log.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { url: string; status: number | null; file: string };
    if (m.status && fs.existsSync(path.join(probe, m.file)))
      answers.set(m.url, { status: m.status, file: path.join(probe, m.file) });
  }
}
console.log(`stand-in answers: ${answers.size}`);

const queue = new FetchQueue(db, cacheDir, () => getSettings(db).fetch);
const lock = new DiskLock();
const readLabels = () => ({ text: fs.readFileSync(labelsFile, 'utf8'), error: null });
const roots = { torrents: path.join(out, 'no-torrents'), library: path.join(out, 'no-library') };
const tools = {
  ffprobePath: 'ffprobe',
  ffmpegPath: 'ffmpeg',
  fpcalcPath: 'fpcalc',
  faadPath: 'faad',
};
const stage3 = new AudioStage3({ db, roots, tools, lock, readLabels });
const stage4 = new AudioStage4({ db, roots, tools, lock, queue, stage3, readLabels });

const asked = new Map<string, number>();
const missing: { site: string; url: string }[] = [];
const sites = AUDIO_FETCH_SITES as readonly string[];
const marks = sites.map(() => '?').join(', ');
/** Answers every queued audio request from the stand-in (as the fetcher would, without pace). */
function answerAll(): number {
  const rows = db
    .prepare(
      `SELECT id, site, url FROM fetch_requests WHERE site IN (${marks}) AND state = 'queued'`,
    )
    .all(...sites) as { id: number; site: string; url: string }[];
  for (const r of rows) {
    const token = randomUUID();
    db.prepare(
      `UPDATE fetch_requests SET state = 'leased', lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?`,
    ).run(token, Date.now() + 120_000, Date.now(), r.id);
    const a = answers.get(r.url);
    asked.set(r.site, (asked.get(r.site) ?? 0) + 1);
    if (!a) missing.push({ site: r.site, url: r.url });
    const res = queue.report(r.id, token, {
      status: a ? a.status : 404,
      ms: 1,
      error: null,
      body: a ? fs.readFileSync(a.file) : Buffer.from('not in the reference sample'),
      encoding: 'identity',
    });
    if (!res.accepted) console.log('not accepted', r.id, res.reason);
  }
  return rows.length;
}

async function run(): Promise<void> {
  const all = process.argv.includes('--all');
  let p = stage4.restart();
  const ts = Date.now();
  await stage4.step(() => false); // units
  p = stage4.progress()!;
  console.log(
    `units ${p.units} (lookup ${p.lookupUnits}, no record expected ${p.noRecordUnits}, labeled ${p.labeledUnits}) in ${Date.now() - ts} ms`,
  );
  // Library-wide first-step counts (no requests made for them).
  const unitRows = db
    .prepare(`SELECT labeled, kind, inputs_json FROM audio_online_units WHERE analysis_id = ?`)
    .all(p.analysisId) as { labeled: number; kind: string; inputs_json: string }[];
  const lib = {
    lookup: 0,
    nameAsin: 0,
    absOnly: 0,
    searchOnly: 0,
    kikubonId: 0,
    abjpId: 0,
    noQuery: 0,
    drama: 0,
    multiFile: 0,
    narratorTag: 0,
    authorKnown: 0,
  };
  for (const u of unitRows) {
    if (u.kind !== 'lookup') continue;
    const i = JSON.parse(u.inputs_json) as UnitInputs;
    lib.lookup++;
    if (i.asins.length) lib.nameAsin++;
    else if (i.absAsins.length) lib.absOnly++;
    else lib.searchOnly++;
    if (i.kikubon) lib.kikubonId++;
    if (i.audiobookJp) lib.abjpId++;
    if (!i.queries.length) lib.noQuery++;
    if (i.facts.drama) lib.drama++;
    if (i.facts.files > 1) lib.multiFile++;
    if (i.facts.narrators.length) lib.narratorTag++;
    if (i.facts.authors.length) lib.authorKnown++;
  }
  console.log('library units:', lib);
  if (!all) {
    db.prepare(`DELETE FROM audio_online_units WHERE analysis_id = ? AND labeled = 0`).run(
      p.analysisId,
    );
  }
  for (let i = 0; i < 2000; i++) {
    answerAll();
    const done = await stage4.step(() => false);
    if (done) break;
    p = stage4.progress()!;
    if (p.phase === 'lookups' && i % 20 === 0) {
      const open = db
        .prepare(
          `SELECT state, COUNT(*) n FROM audio_online_units WHERE analysis_id = ? GROUP BY state`,
        )
        .all(p.analysisId);
      console.log(`round ${i}:`, JSON.stringify(open));
    }
  }
  p = stage4.progress()!;
  console.log('phase', p.phase, 'error', p.error, 'took', Date.now() - ts, 'ms');
  console.log('counts', stage4Counts(db, p.analysisId));
  console.log('requests asked per site:', Object.fromEntries(asked));
  const g = p.gate!;
  console.log(
    `GATE passed=${g.passed} checked=${g.checked} misses=${g.misses.length} error=${g.error}`,
  );
  console.log('by source:', JSON.stringify(g.bySource, null, 1));
  for (const m of g.misses) console.log('  MISS', JSON.stringify(m));
  fs.writeFileSync(path.join(out, 'gate.json'), JSON.stringify(g, null, 1));
  const byKind = new Map<string, number>();
  for (const m of missing) {
    const u = new URL(m.url);
    const k = `${m.site} ${u.pathname.replace(/\d+/g, 'N').replace(/B0[0-9A-Z]{8}/g, 'ASIN')}${u.searchParams.has('response_groups') ? ' rg=' + (u.searchParams.get('response_groups') ?? '').slice(0, 12) : ''}${u.searchParams.has('keywords') ? ' keywords' : ''}`;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  console.log(
    `requests the sample has no answer for: ${missing.length}`,
    Object.fromEntries(byKind),
  );
  fs.writeFileSync(path.join(out, 'missing.json'), JSON.stringify(missing, null, 1));
  const lab = Math.max(1, p.lookupUnits && !all ? p.labeledUnits : p.lookupUnits);
  const perUnit = Object.fromEntries(
    [...asked].map(([k, v]) => [k, Math.round((v / lab) * 1000) / 1000]),
  );
  console.log('requests per looked-up unit:', perUnit);
  fs.writeFileSync(
    path.join(out, 'summary.json'),
    JSON.stringify(
      { lib, asked: Object.fromEntries(asked), perUnit, counts: stage4Counts(db, p.analysisId) },
      null,
      1,
    ),
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
