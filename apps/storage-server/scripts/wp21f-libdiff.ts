/**
 * WP21f-1 stop 1: the whole-library diff. What the first daily run's stages 1-3 would change for
 * the recordings already in the library, without reading a file:
 *
 *   - a clean working copy of a copy of the live cleanup.db (after the switch: stages 1-5 are the
 *     analyses stage 6 built from, from before the switch);
 *   - stage 1's rows as its next walk will find them: the old library's rows gone, the new
 *     library's (stage 6's and the switch's done links and PDFs: the same inodes as the torrent
 *     files, with their hashes) and the 5 files the switch linked under torrents/_from-library/;
 *   - the real stage 1 classify, stage 2 (units, the twins' health, classify: the parts rule) and
 *     stage 3 (copies → … → decide) on it; the roots are an empty folder and the tools missing,
 *     so a file read shows up as a failure instead of happening;
 *   - each compared with the analysis before: stage 2's books (key, class, files), stage 3's
 *     copies and groups (key, outcome, each member's role).
 *
 * Expected: the 5 _from-library recordings change keys (library-only copies become torrent
 * books), nothing else; 0 books changed by the parts rule.
 *
 *   npx ts-node --transpile-only scripts/wp21f-libdiff.ts --db <copy/cleanup.db> --work <work.db>
 *     --labels <labels.json> --out <report.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAudioStage, updateAudioStage } from '../src/cleanup/audio/audio-stages';
import { AudioStage1 } from '../src/cleanup/audio/stage1-identity';
import { AudioStage2 } from '../src/cleanup/audio/stage2-books';
import {
  classifyArrivals,
  everLinkedInodes,
  loadClassifyInputs,
} from '../src/cleanup/audio/arrivals-classify';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { AudioStage4, type Stage4Deps } from '../src/cleanup/audio/stage4-online';
import { DiskLock } from '../src/cleanup/disk-lock';
import { workingCopy } from './wp21f-copy';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

interface P {
  analysisId: string;
  phase: string;
  stage1Id?: string;
  stage2Id?: string;
  error?: string | null;
}

/** Stage 2's books and stage 3's copies and groups of one set of analyses. */
function snapshot(db: Database.Database, s2: string, s3: string) {
  const books = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT b.book_key, b.unit_kind, b.multi_class, b.root,
              (SELECT group_concat(f.rel_path, '|') FROM audio_book_files bf JOIN audio_files f ON f.id = bf.file_id
               WHERE bf.book_id = b.id ORDER BY bf.position) AS files
       FROM audio_books b WHERE b.analysis_id = ?`,
    )
    .all(s2) as {
    book_key: string;
    unit_kind: string;
    multi_class: string | null;
    files: string;
  }[])
    books.set(r.book_key, `${r.unit_kind}/${r.multi_class ?? '-'}: ${r.files}`);
  const copies = new Map<string, string>();
  const groupOf = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT c.copy_key, c.kind, c.excluded, c.ai, m.role, g.group_key, g.kind AS gkind, g.outcome
       FROM audio_dup_copies c
       LEFT JOIN audio_dup_members m ON m.copy_id = c.id
       LEFT JOIN audio_dup_groups g ON g.id = m.group_id
       WHERE c.analysis_id = ?`,
    )
    .all(s3) as {
    copy_key: string;
    kind: string;
    excluded: unknown;
    ai: number;
    role: string | null;
    group_key: string | null;
    gkind: string | null;
    outcome: string | null;
  }[]) {
    copies.set(
      r.copy_key,
      `${r.kind} excl=${r.excluded ?? ''} ai=${r.ai} ${r.gkind ?? 'single'}/${r.outcome ?? '-'}/${r.role ?? '-'}`,
    );
    if (r.group_key) groupOf.set(r.copy_key, r.group_key);
  }
  const groups = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT g.group_key, g.kind, g.outcome,
              (SELECT group_concat(c.copy_key || '=' || m.role, ' | ') FROM audio_dup_members m
               JOIN audio_dup_copies c ON c.id = m.copy_id WHERE m.group_id = g.id ORDER BY c.copy_key) AS members
       FROM audio_dup_groups g WHERE g.analysis_id = ?`,
    )
    .all(s3) as { group_key: string; kind: string; outcome: string; members: string }[])
    groups.set(r.group_key, `${r.kind}/${r.outcome}: ${r.members}`);
  return { books, copies, groups };
}

function diff(a: Map<string, string>, b: Map<string, string>) {
  const gone: string[] = [];
  const added: string[] = [];
  const changed: { key: string; before: string; after: string }[] = [];
  for (const [k, v] of a) {
    if (!b.has(k)) gone.push(k);
    else if (b.get(k) !== v) changed.push({ key: k, before: v, after: b.get(k)! });
  }
  for (const k of b.keys()) if (!a.has(k)) added.push(k);
  return { gone, added, changed };
}

async function run(stage: { step: (s: () => boolean) => Promise<boolean> }, name: string) {
  const t0 = Date.now();
  for (let i = 0; i < 100000; i++) if (await stage.step(() => false)) break;
  console.log(`${name}: ${Math.round((Date.now() - t0) / 1000)} s`);
}

async function main() {
  const db = workingCopy(arg('db')!, arg('work')!);
  const p = (n: number) => getAudioStage(db, n).progress as unknown as P;
  const before = { s1: p(1).analysisId, s2: p(2).analysisId, s3: p(3).analysisId };
  const snapBefore = snapshot(db, before.s2, before.s3);
  const p6 = p(6).analysisId;

  // --- stage 1's rows after the switch ---------------------------------------------------------
  const now = Date.now();
  const lib = db
    .prepare(`SELECT COUNT(*) AS n FROM audio_files WHERE root = 'library' AND gone_at IS NULL`)
    .get() as { n: number };
  const byInode = new Map<string, { sha: string | null; mtime: number; nlink: number }>();
  for (const r of db
    .prepare(`SELECT dev, ino, sha256, mtime_ms, nlink FROM audio_files WHERE gone_at IS NULL`)
    .all() as {
    dev: number;
    ino: number;
    sha256: string | null;
    mtime_ms: number;
    nlink: number;
  }[]) {
    const k = `${r.dev}:${r.ino}`;
    const cur = byInode.get(k);
    if (!cur || (!cur.sha && r.sha256))
      byInode.set(k, { sha: r.sha256, mtime: r.mtime_ms, nlink: r.nlink });
  }
  const links = [
    ...(db
      .prepare(
        `SELECT dst, kind, size, dev, ino, mtime_ms FROM audio_build_ops WHERE analysis_id = ? AND state = 'done' AND kind IN ('link', 'pdf')`,
      )
      .all(p6) as {
      dst: string;
      kind: string;
      size: number;
      dev: number;
      ino: number;
      mtime_ms: number;
    }[]),
    ...(db
      .prepare(
        `SELECT dst, kind, size, dev, ino, mtime_ms FROM audio_switch_ops WHERE state = 'done' AND kind = 'link'`,
      )
      .all() as {
      dst: string;
      kind: string;
      size: number;
      dev: number;
      ino: number;
      mtime_ms: number;
    }[]),
  ];
  const fromLib = db
    .prepare(
      `SELECT src_rel, dst, size, dev, ino, sha256 FROM audio_switch_ops WHERE state = 'done' AND kind = 'from_library'`,
    )
    .all() as {
    src_rel: string;
    dst: string;
    size: number;
    dev: number;
    ino: number;
    sha256: string | null;
  }[];
  // The switch hashed these (they were never hashed before: no twin of their size); stage 1's
  // next walk hashes them too (their library twin now has their size).
  for (const r of fromLib) {
    const k = `${r.dev}:${r.ino}`;
    const cur = byInode.get(k);
    if (cur && !cur.sha && r.sha256) cur.sha = r.sha256;
  }
  const put = db.prepare(
    `INSERT INTO audio_files (root, rel_path, rel_path_raw, decoded_path, ext, kind, size, mtime_ms, dev, ino,
       nlink, sha256, hashed_at, hash_error, hash_source, first_seen_at, seen_at, gone_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
     ON CONFLICT(root, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
       dev = excluded.dev, ino = excluded.ino, sha256 = excluded.sha256, gone_at = NULL, seen_at = excluded.seen_at`,
  );
  const extOf = (rel: string) => path.extname(rel).toLowerCase();
  let made = 0;
  let mainOnly = 0;
  db.transaction(() => {
    db.prepare(`UPDATE audio_files SET gone_at = ? WHERE root = 'library' AND gone_at IS NULL`).run(
      now,
    );
    for (const r of fromLib) {
      const twin = byInode.get(`${r.dev}:${r.ino}`);
      put.run(
        'torrents',
        r.dst,
        extOf(r.dst),
        'audio',
        r.size,
        twin?.mtime ?? r.size,
        r.dev,
        r.ino,
        (twin?.nlink ?? 1) + 2,
        twin?.sha ?? null,
        twin?.sha ? now : null,
        twin?.sha ? 'same_inode' : null,
        now,
        now,
      );
      made++;
    }
    for (const r of links) {
      // The library root is media/audiobooks/japanese (japanese-generated is not under it).
      if (!r.dst.startsWith('japanese-new/')) continue;
      mainOnly++;
      const rel = r.dst.slice('japanese-new/'.length);
      const twin = byInode.get(`${r.dev}:${r.ino}`);
      const ext = extOf(rel);
      put.run(
        'library',
        rel,
        ext,
        ext === '.pdf' ? 'other' : 'audio',
        r.size,
        twin?.mtime ?? r.mtime_ms,
        r.dev,
        r.ino,
        (twin?.nlink ?? 1) + 1,
        twin?.sha ?? null,
        twin?.sha ? now : null,
        twin?.sha ? 'same_inode' : null,
        now,
        now,
      );
      made++;
    }
  })();
  console.log(
    `stage 1 rows: old library ${lib.n} gone; new library ${mainOnly} (of ${links.length} links/PDFs; the rest are japanese-generated), ${fromLib.length} under _from-library`,
  );

  // --- the real stages 1-3, no file read ------------------------------------------------------------
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wp21f-libdiff-'));
  const roots = { torrents: empty, library: empty };
  // Stand-in tools that start and fail (node itself under their names, refusing their options):
  // a read the real run would do shows up as a failed check, and the stages go on to the end.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wp21f-tools-'));
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const t of ['ffprobe', 'ffmpeg', 'fpcalc', 'faad'])
    fs.copyFileSync(process.execPath, path.join(bin, t + exe));
  const tools = {
    ffprobePath: path.join(bin, 'ffprobe' + exe),
    ffmpegPath: path.join(bin, 'ffmpeg' + exe),
    fpcalcPath: path.join(bin, 'fpcalc' + exe),
    faadPath: path.join(bin, 'faad' + exe),
  };
  const lock = new DiskLock();
  const labels = fs.readFileSync(arg('labels')!, 'utf8');
  const s1 = new AudioStage1({ db, roots, lock });
  const p1 = s1.restart();
  updateAudioStage(db, 1, {
    progress: { ...p1, phase: 'classify' } as unknown as Record<string, unknown>,
  });
  await run(s1, 'stage 1 classify');
  // Stage 2 checks a file whose decode failed once more in each analysis: here that re-check
  // gives the stored result (the stand-in tools would fail it and drop its length).
  const rechecks = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audio_file_health WHERE start_decode_ok = 0 OR end_decode_ok = 0`,
    )
    .get() as { n: number };
  db.prepare('UPDATE audio_file_health SET checked_at = ?').run(now + 365 * 86_400_000);
  const s2 = new AudioStage2({ db, roots, tools });
  const p2 = s2.restart();
  updateAudioStage(db, 2, {
    progress: { ...p2, phase: 'units' } as unknown as Record<string, unknown>,
  });
  await run(s2, 'stage 2 units/health/classify');
  const healthErrors = db
    .prepare(`SELECT COUNT(*) AS n FROM audio_file_health WHERE checked_at >= ? AND checked_at < ?`)
    .get(now, now + 365 * 86_400_000) as { n: number };
  const s3 = new AudioStage3({
    db,
    roots,
    tools,
    lock,
    readLabels: () => ({ text: labels, error: null }),
    readerWrittenFiles: () => [],
  });
  s3.restart();
  await run(s3, 'stage 3');
  // Stage 4's units (database only: the lookups would be answered from the cache) and stage 7's
  // classify on the rows after the switch: every recording must already be in the library.
  const unitsBefore = new Map(
    (
      db
        .prepare('SELECT unit_key, copy_keys FROM audio_online_units WHERE analysis_id = ?')
        .all(p(4).analysisId) as { unit_key: string; copy_keys: string }[]
    ).map((r) => [r.unit_key, r.copy_keys]),
  );
  const s4 = new AudioStage4({
    db,
    stage3: s3,
    readLabels: () => ({ text: labels, error: null }),
  } as unknown as Stage4Deps);
  s4.restart();
  await s4.step(() => false);
  const s4Id = p(4).analysisId;
  const unitsAfter = new Map(
    (
      db
        .prepare('SELECT unit_key, copy_keys FROM audio_online_units WHERE analysis_id = ?')
        .all(s4Id) as { unit_key: string; copy_keys: string }[]
    ).map((r) => [r.unit_key, r.copy_keys]),
  );
  const units = diff(unitsBefore, unitsAfter);
  const input = loadClassifyInputs(
    db,
    { s1: p(1).analysisId, s3: p(3).analysisId, s4: s4Id },
    // japanese-generated (not under the library root): what stage 6 linked there.
    { generatedInodes: everLinkedInodes(db), now: Date.now(), settleMs: 30 * 60_000 },
  );
  const cls = classifyArrivals(input);
  const classify = {
    counts: cls.counts,
    unlinkedKnown: cls.unlinkedKnown,
    notExisting: cls.outcomes
      .filter((o) => o.outcome !== 'existing')
      .map((o) => ({ unit: o.unitKey, name: o.name, outcome: o.outcome, reason: o.reason })),
  };
  console.log(
    `stage 4 units: ${unitsAfter.size} (${units.gone.length} gone, ${units.added.length} new, ${units.changed.length} changed); classify ${JSON.stringify(cls.counts)}, unlinked known ${cls.unlinkedKnown}`,
  );
  const after = { s1: p(1).analysisId, s2: p(2).analysisId, s3: p(3).analysisId };
  console.log(
    `after: stage 1 ${p(1).phase}${p(1).error ? ` (${p(1).error})` : ''}, stage 2 ${p(2).phase}${p(2).error ? ` (${p(2).error})` : ''}, stage 3 ${p(3).phase}${p(3).error ? ` (${p(3).error})` : ''}; ${healthErrors.n} health rows written (a file read)`,
  );
  const snapAfter = snapshot(db, after.s2, after.s3);
  const d = {
    books: diff(snapBefore.books, snapAfter.books),
    copies: diff(snapBefore.copies, snapAfter.copies),
    groups: diff(snapBefore.groups, snapAfter.groups),
  };
  const ident = db
    .prepare(`SELECT class, COUNT(*) AS n FROM audio_identity WHERE analysis_id = ? GROUP BY class`)
    .all(after.s1);
  const gate3 = (getAudioStage(db, 3).progress as { gate?: { passed?: boolean } }).gate;
  // The reads stage 3 would do: fingerprint windows and frame checks not found in the stores.
  const reads = {
    windows: db.prepare(`SELECT COUNT(*) AS n FROM audio_fingerprints WHERE made_at >= ?`).get(now),
    frameChecks: db
      .prepare(
        `SELECT pair_key, substr(result_json, 1, 200) AS r FROM audio_frame_checks WHERE checked_at >= ?`,
      )
      .all(now),
  };
  const report = {
    rows: { oldLibraryGone: lib.n, newLibrary: mainOnly, fromLibrary: fromLib.length, made },
    identity: ident,
    healthRowsWritten: healthErrors.n,
    decodeFailedRechecks: rechecks.n,
    reads,
    units: { gone: units.gone, added: units.added, changed: units.changed },
    classify,
    gate3Passed: gate3?.passed ?? null,
    counts: Object.fromEntries(
      Object.entries(d).map(([k, v]) => [
        k,
        { gone: v.gone.length, added: v.added.length, changed: v.changed.length },
      ]),
    ),
    diff: d,
    stage3: getAudioStage(db, 3).progress,
  };
  fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify({ identity: ident, counts: report.counts, gate3: report.gate3Passed }, null, 1),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
