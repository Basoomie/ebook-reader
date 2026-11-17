/**
 * The real-data dry run of the audiobook cleanup (WP21a): the real stage code against a
 * SCRATCH cleanup database in --out (never the live one), with the disk lock held, writing a
 * report. Run in a one-off container with both roots mounted read-only:
 *
 *   node dist/cli.js cleanup audio-dryrun --stage 1 --out /out
 *   node dist/cli.js cleanup audio-dryrun --stage 0 --out /out --abs-url http://… (key on stdin)
 *
 * Roots: CLEANUP_AUDIO_TORRENTS_DIR and CLEANUP_AUDIO_LIBRARY_DIR. Afterwards the live
 * stage 1 can take over the hashes of unchanged files (`cleanup audio-import-hashes`).
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { openCleanupDatabase } from '../cleanup-db';
import { DiskLock } from '../disk-lock';
import { updateSettings } from '../settings';
import { AbsClient } from './abs-client';
import { progressCsv, saveSnapshot, summarize, takeAbsSnapshot } from './abs-snapshot';
import { setAudioStageMode } from './audio-stages';
import { checkRoots } from './audio-cleanup-service';
import { AudioStage1, identityCounts } from './stage1-identity';
import { AudioStage2, booksCounts } from './stage2-books';

function arg(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function line(m: string): void {
  console.log(`${new Date().toISOString()} ${m}`);
}

export async function runAudioDryRun(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const stage = Number(arg(args, '--stage'));
  const out = arg(args, '--out');
  if (![0, 1, 2].includes(stage) || !out) {
    console.error(
      'Usage: cleanup audio-dryrun --stage 0|1|2 --out <folder> [--abs-url <url>] [--read-mbps N] [--files-per-second N]',
    );
    return 2;
  }
  const outAbs = path.resolve(out);
  for (const root of [env.CLEANUP_AUDIO_TORRENTS_DIR, env.CLEANUP_AUDIO_LIBRARY_DIR]) {
    const r = (root ?? '').trim() ? path.resolve(root!.trim()) : null;
    if (r && (outAbs === r || outAbs.startsWith(r + path.sep))) {
      console.error(`--out is inside one of the audiobook folders (${r}); choose another folder`);
      return 2;
    }
  }
  if (!existsSync(out)) mkdirSync(out, { recursive: true });
  const dbFile = path.join(out, 'cleanup-dryrun.db');
  const db = openCleanupDatabase(dbFile);
  const t0 = Date.now();
  const report: Record<string, unknown> = { stage, startedAt: new Date(t0).toISOString(), dbFile };
  const saveReport = () =>
    writeFileSync(path.join(out, `report-stage${stage}.json`), JSON.stringify(report, null, 2));
  try {
    if (stage === 0) {
      const url = arg(args, '--abs-url');
      if (!url) {
        console.error('--abs-url is needed for stage 0 (the API key comes on stdin)');
        return 2;
      }
      const key = await readStdin();
      if (!key) {
        console.error('No API key on stdin');
        return 2;
      }
      const client = new AbsClient({
        baseUrl: url.replace(/\/$/, ''),
        apiKey: key,
        timeoutMs: 30_000,
      });
      const data = await takeAbsSnapshot(client, url);
      const id = saveSnapshot(db, data);
      writeFileSync(path.join(out, 'abs-snapshot.json'), JSON.stringify(data, null, 2));
      writeFileSync(path.join(out, 'abs-progress.csv'), progressCsv(data));
      report.snapshotId = id;
      report.summary = summarize(data);
      report.problems = data.problems;
      line(`Snapshot: ${JSON.stringify(summarize(data))}`);
      return 0;
    }
    const roots = {
      torrents: (env.CLEANUP_AUDIO_TORRENTS_DIR ?? '').trim(),
      library: (env.CLEANUP_AUDIO_LIBRARY_DIR ?? '').trim(),
    };
    const check = await checkRoots(roots.torrents && roots.library ? roots : null);
    report.roots = { ...roots, check };
    if (!check.ok) {
      line(`Refused: ${check.problem}`);
      return 1;
    }
    const settings: Record<string, number> = {};
    const mbps = arg(args, '--read-mbps');
    const fps = arg(args, '--files-per-second');
    if (mbps !== null) settings.readMbPerSecond = Number(mbps);
    if (fps !== null) settings.healthFilesPerSecond = Number(fps);
    if (Object.keys(settings).length) updateSettings(db, { audiobooks: settings });
    setAudioStageMode(db, stage, 'analyse');
    const lock = new DiskLock();
    const tools = {
      ffprobePath: (env.FFPROBE_PATH ?? '').trim() || 'ffprobe',
      ffmpegPath: (env.FFMPEG_PATH ?? '').trim() || 'ffmpeg',
    };
    const runner =
      stage === 1
        ? new AudioStage1({ db, roots, lock, log: line })
        : new AudioStage2({ db, roots, tools, log: line });
    if (!runner.progress() || runner.progress()!.phase === 'done') runner.restart();
    let stop = false;
    process.on('SIGTERM', () => (stop = true));
    process.on('SIGINT', () => (stop = true));
    let lastLine = 0;
    for (;;) {
      if (stop) {
        line('Stopped; run the same command again to go on where it stopped');
        break;
      }
      const done = await runner.step(() => stop);
      const p = runner.progress() as unknown as Record<string, unknown>;
      if (Date.now() - lastLine > 60_000 || done) {
        lastLine = Date.now();
        const secs = (Date.now() - t0) / 1000;
        if (stage === 1) {
          const mb = Number(p.bytesHashed) / 1e6;
          line(
            `phase=${p.phase} hashed ${p.hashDone}/${p.hashTotal} files, ${(mb / 1000).toFixed(1)} GB in ${Math.round(secs)} s (${(mb / Math.max(1, secs)).toFixed(1)} MB/s), errors ${p.hashErrors}, changed ${p.hashChanged}`,
          );
        } else {
          line(
            `phase=${p.phase} books ${p.books} health ${p.healthDone}/${p.healthTotal} in ${Math.round(secs)} s`,
          );
        }
        report.progress = p;
        saveReport();
      }
      if (done) break;
    }
    const p = runner.progress() as unknown as {
      analysisId: string;
      phase: string;
      error: string | null;
    };
    report.progress = p;
    if (p.phase === 'done' && !p.error) {
      report.counts =
        stage === 1 ? identityCounts(db, p.analysisId) : booksCounts(db, p.analysisId);
    }
    lock.release('dry run');
    return p.error ? 1 : 0;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.seconds = Math.round((Date.now() - t0) / 1000);
    saveReport();
    db.close();
  }
}

/**
 * The live stage 1 takes over the dry run's hashes (decided with the user 2026-11-17): rows
 * with a hash are added to audio_files as "gone" until the live walk sees them; the walk keeps
 * a hash only when root, path, size, mtime, device and inode are all unchanged.
 */
export function importDryRunHashes(
  live: Database.Database,
  file: string,
): { added: number; skipped: number } {
  const scratch = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = scratch
      .prepare(
        `SELECT root, rel_path, rel_path_raw, decoded_path, ext, kind, size, mtime_ms, dev, ino, nlink,
           sha256, hashed_at FROM audio_files WHERE sha256 IS NOT NULL`,
      )
      .all() as Record<string, unknown>[];
    const now = Date.now();
    const put = live.prepare(
      `INSERT INTO audio_files (root, rel_path, rel_path_raw, decoded_path, ext, kind, size, mtime_ms,
         dev, ino, nlink, sha256, hashed_at, hash_source, first_seen_at, seen_at, gone_at)
       VALUES (@root, @rel_path, @rel_path_raw, @decoded_path, @ext, @kind, @size, @mtime_ms, @dev, @ino,
         @nlink, @sha256, @hashed_at, 'dry_run', @now, 0, @now)
       ON CONFLICT(root, rel_path) DO UPDATE SET sha256 = excluded.sha256,
         hashed_at = excluded.hashed_at, hash_source = 'dry_run'
       WHERE audio_files.sha256 IS NULL AND audio_files.size = excluded.size
         AND audio_files.mtime_ms = excluded.mtime_ms AND audio_files.dev = excluded.dev
         AND audio_files.ino = excluded.ino`,
    );
    let added = 0;
    live.transaction(() => {
      for (const r of rows) added += put.run({ ...r, now }).changes;
    })();
    return { added, skipped: rows.length - added };
  } finally {
    scratch.close();
  }
}
