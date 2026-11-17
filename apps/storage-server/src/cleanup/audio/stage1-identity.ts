/**
 * Audiobook stage 1: identity (WP21a, plan section 3). Which library audio files are byte
 * copies of which torrent files, nothing moved or linked.
 *
 * Phases (resumable; the progress is saved with each step's rows):
 *   walk     inventory of both roots (walk.ts)
 *   hash     full SHA-256, only of audio files whose size occurs on both sides, plus same-size
 *            groups inside /torrents; holds the shared disk lock and gives it back at once when
 *            a Calibre job waits; a file whose inode was already hashed (a hard link) reuses it
 *   classify the classes below, for the current analysis
 *
 * Classes. Library: copy (an identical torrent file exists), linked (already a hard link to a
 * torrent file), library_only (no torrent file of that size), size_only (same size, other
 * bytes), unhashed (the hash failed). Torrents: original (has a library copy), torrent_copy
 * (identical to another torrent file), torrent_only. Archives: archive. ai_original marks
 * library files whose original is under AI/ (and those originals).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings } from '../settings';
import { hashFile, insideRoot, lstatEntry, ReadPacer } from './audio-source-fs';
import { getAudioStage, updateAudioStage } from './audio-stages';
import { walkRoots, type AudioRoots, type WalkResult } from './walk';

export type Stage1Phase = 'walk' | 'hash' | 'classify' | 'done';

export interface AudioStage1Progress {
  analysisId: string;
  phase: Stage1Phase;
  startedAt: number;
  finishedAt: number | null;
  walk: WalkResult | null;
  hashTotal: number;
  hashDone: number;
  hashBytesTotal: number;
  bytesHashed: number;
  hashErrors: number;
  hashChanged: number;
  hashReused: number;
  /** For the time left: when the hash phase (re)started and how many bytes were done then. */
  phaseStartedAt: number;
  phaseStartBytes: number;
  /** Times the hash phase gave the disk to a Calibre job. */
  yields: number;
  counts: Record<string, number> | null;
  error: string | null;
}

export const STAGE1 = 1;
const OWNER = DISK_OWNERS.audio1;

export function emptyStage1(now = Date.now()): AudioStage1Progress {
  return {
    analysisId: randomUUID(),
    phase: 'walk',
    startedAt: now,
    finishedAt: null,
    walk: null,
    hashTotal: 0,
    hashDone: 0,
    hashBytesTotal: 0,
    bytesHashed: 0,
    hashErrors: 0,
    hashChanged: 0,
    hashReused: 0,
    phaseStartedAt: now,
    phaseStartBytes: 0,
    yields: 0,
    counts: null,
    error: null,
  };
}

/**
 * The audio files to hash: sizes that occur on both sides, or more than once in /torrents.
 * Present files only.
 */
const HASH_SET_SQL = `
  WITH present AS (
    SELECT * FROM audio_files WHERE kind = 'audio' AND gone_at IS NULL
  ),
  sizes AS (
    SELECT size FROM present GROUP BY size
    HAVING (SUM(root = 'torrents') > 0 AND SUM(root = 'library') > 0) OR SUM(root = 'torrents') > 1
  )
  SELECT p.* FROM present p JOIN sizes s ON s.size = p.size`;

export interface Stage1Deps {
  db: Database.Database;
  roots: AudioRoots;
  lock: DiskLock;
  log?: (m: string) => void;
}

export class AudioStage1 {
  constructor(private readonly deps: Stage1Deps) {}

  progress(): AudioStage1Progress | null {
    const p = getAudioStage(this.deps.db, STAGE1).progress as unknown as AudioStage1Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: AudioStage1Progress, state?: string): void {
    updateAudioStage(this.deps.db, STAGE1, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(): AudioStage1Progress {
    const p = emptyStage1();
    this.save(p, 'analysing');
    return p;
  }

  /** Is the hash phase running (stage 2 waits for it)? */
  hashing(): boolean {
    return this.progress()?.phase === 'hash';
  }

  /** One unit of work; true when the analysis is finished or failed. Never throws. */
  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (!p || p.phase === 'done') return true;
    try {
      if (p.phase === 'walk') p = await this.walkStep(p, shouldStop);
      else if (p.phase === 'hash') p = await this.hashStep(p, shouldStop);
      else if (p.phase === 'classify') p = this.classifyStep(p);
      this.save(p, p.phase === 'done' ? (p.error ? 'failed' : 'ready') : 'analysing');
      return p.phase === 'done';
    } catch (err) {
      p.error = (err as Error).message ?? String(err);
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.save(p, 'failed');
      return true;
    } finally {
      if (p?.phase !== 'hash') this.deps.lock.release(OWNER);
    }
  }

  private async walkStep(
    p: AudioStage1Progress,
    shouldStop: () => boolean,
  ): Promise<AudioStage1Progress> {
    const walk = await walkRoots(this.deps.db, this.deps.roots, { shouldStop });
    if (!walk) return p; // stopped: the walk starts again next time
    p.walk = walk;
    if (walk.errors.length)
      this.deps.log?.(`Audiobooks stage 1: walk problems: ${walk.errors.slice(0, 3).join('; ')}`);
    const totals = this.deps.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes,
           SUM(sha256 IS NOT NULL) AS done FROM (${HASH_SET_SQL})`,
      )
      .get() as { n: number; bytes: number; done: number | null };
    const todoBytes = (
      this.deps.db
        .prepare(
          `SELECT COALESCE(SUM(size), 0) AS b FROM (${HASH_SET_SQL}) WHERE sha256 IS NULL AND hash_error IS NULL`,
        )
        .get() as { b: number }
    ).b;
    p.hashTotal = totals.n;
    p.hashDone = totals.done ?? 0;
    p.hashBytesTotal = todoBytes;
    p.phase = 'hash';
    p.phaseStartedAt = Date.now();
    p.phaseStartBytes = p.bytesHashed;
    return p;
  }

  private async hashStep(
    p: AudioStage1Progress,
    shouldStop: () => boolean,
  ): Promise<AudioStage1Progress> {
    const { db, lock } = this.deps;
    const next = db
      .prepare(
        `${HASH_SET_SQL} WHERE p.sha256 IS NULL AND p.hash_error IS NULL
         ORDER BY p.root = 'library', p.rel_path LIMIT 20`,
      )
      .all() as {
      id: number;
      root: 'torrents' | 'library';
      rel_path: string;
      rel_path_raw: string | null;
      size: number;
      mtime_ms: number;
      dev: number;
      ino: number;
    }[];
    if (next.length === 0) {
      p.phase = 'classify';
      lock.release(OWNER);
      return p;
    }
    const stop = () => shouldStop() || lock.shouldYield(OWNER);
    if (!(await lock.acquire(OWNER, 'audio', shouldStop))) return p;
    const pacer = new ReadPacer(getSettings(db).audiobooks.readMbPerSecond * 1024 * 1024);
    const setHash = db.prepare(
      `UPDATE audio_files SET sha256 = ?, hashed_at = ?, hash_error = ?, hash_source = ? WHERE id = ?`,
    );
    const sameInode = db.prepare(
      `SELECT sha256 FROM audio_files WHERE dev = ? AND ino = ? AND sha256 IS NOT NULL
         AND gone_at IS NULL AND id <> ? LIMIT 1`,
    );
    for (const f of next) {
      if (shouldStop()) break;
      if (lock.shouldYield(OWNER)) {
        p.yields++;
        lock.release(OWNER);
        return p;
      }
      // A hard link of a file already hashed: same bytes, nothing to read.
      const twin = sameInode.get(f.dev, f.ino, f.id) as { sha256: string } | undefined;
      if (twin) {
        setHash.run(twin.sha256, Date.now(), null, 'same_inode', f.id);
        p.hashDone++;
        p.hashReused++;
        continue;
      }
      const root = this.deps.roots[f.root];
      try {
        const file = insideRoot(root, f.rel_path, f.rel_path_raw);
        const before = await lstatEntry(file);
        if (
          !before ||
          before.size !== f.size ||
          Math.floor(before.mtimeMs) !== f.mtime_ms ||
          before.ino !== f.ino
        ) {
          setHash.run(null, null, 'changed', null, f.id);
          p.hashChanged++;
          continue;
        }
        const result = await hashFile(file, pacer, stop);
        if (!result) {
          if (lock.shouldYield(OWNER)) {
            p.yields++;
            lock.release(OWNER);
          }
          return p;
        }
        const after = await lstatEntry(file);
        if (
          !after ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino
        ) {
          setHash.run(null, null, 'changed', null, f.id);
          p.hashChanged++;
          continue;
        }
        setHash.run(result.sha256, Date.now(), null, 'read', f.id);
        p.hashDone++;
        p.bytesHashed += result.bytes;
        this.save(p, 'analysing');
      } catch (err) {
        setHash.run(null, null, `hash: ${(err as Error).message}`.slice(0, 300), null, f.id);
        p.hashErrors++;
      }
    }
    return p;
  }

  private classifyStep(p: AudioStage1Progress): AudioStage1Progress {
    const db = this.deps.db;
    const id = p.analysisId;
    db.transaction(() => {
      db.prepare('DELETE FROM audio_identity WHERE analysis_id <> ?').run(id);
      db.prepare('DELETE FROM audio_identity WHERE analysis_id = ?').run(id);
      const put = db.prepare(
        `INSERT INTO audio_identity (analysis_id, file_id, class, ai_original, group_sha256, original_file_ids, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const files = db
        .prepare(
          `SELECT id, root, rel_path, kind, size, dev, ino, sha256, hash_error FROM audio_files
           WHERE gone_at IS NULL AND kind IN ('audio', 'archive')`,
        )
        .all() as {
        id: number;
        root: 'torrents' | 'library';
        rel_path: string;
        kind: string;
        size: number;
        dev: number;
        ino: number;
        sha256: string | null;
        hash_error: string | null;
      }[];
      const audio = files.filter((f) => f.kind === 'audio');
      const torrentsBySize = new Map<number, typeof audio>();
      const torrentsBySha = new Map<string, typeof audio>();
      const torrentByInode = new Map<string, (typeof audio)[number]>();
      const librarySha = new Set<string>();
      for (const f of audio) {
        if (f.root === 'torrents') {
          torrentsBySize.set(f.size, [...(torrentsBySize.get(f.size) ?? []), f]);
          if (f.sha256) torrentsBySha.set(f.sha256, [...(torrentsBySha.get(f.sha256) ?? []), f]);
          torrentByInode.set(`${f.dev}:${f.ino}`, f);
        } else if (f.sha256) librarySha.add(f.sha256);
      }
      const isAi = (rel: string) => rel === 'AI' || rel.startsWith('AI/');
      const aiSha = new Set<string>();
      for (const f of audio)
        if (f.root === 'torrents' && f.sha256 && isAi(f.rel_path)) aiSha.add(f.sha256);
      for (const f of files) {
        if (f.kind === 'archive') {
          put.run(id, f.id, 'archive', 0, null, null, null);
          continue;
        }
        if (f.root === 'library') {
          const linked = torrentByInode.get(`${f.dev}:${f.ino}`);
          if (linked) {
            put.run(
              id,
              f.id,
              'linked',
              isAi(linked.rel_path) ? 1 : 0,
              f.sha256,
              JSON.stringify([linked.id]),
              null,
            );
            continue;
          }
          const sameSize = torrentsBySize.get(f.size) ?? [];
          if (sameSize.length === 0) {
            put.run(id, f.id, 'library_only', 0, null, null, null);
            continue;
          }
          const originals = f.sha256 ? (torrentsBySha.get(f.sha256) ?? []) : [];
          if (originals.length) {
            const ai = originals.some((o) => isAi(o.rel_path)) ? 1 : 0;
            put.run(
              id,
              f.id,
              'copy',
              ai,
              f.sha256,
              JSON.stringify(originals.map((o) => o.id)),
              null,
            );
          } else if (!f.sha256 || sameSize.some((t) => !t.sha256)) {
            put.run(
              id,
              f.id,
              'unhashed',
              0,
              null,
              null,
              f.hash_error ?? sameSize.find((t) => t.hash_error)?.hash_error ?? null,
            );
          } else {
            put.run(
              id,
              f.id,
              'size_only',
              0,
              null,
              null,
              `${sameSize.length} torrent file(s) of the same size, other bytes`,
            );
          }
          continue;
        }
        // torrents
        const group = f.sha256 ? (torrentsBySha.get(f.sha256) ?? []) : [];
        const ai = f.sha256 && aiSha.has(f.sha256) && isAi(f.rel_path) ? 1 : 0;
        if (f.sha256 && librarySha.has(f.sha256)) {
          put.run(id, f.id, 'original', ai, group.length > 1 ? f.sha256 : null, null, null);
        } else if (group.length > 1) {
          put.run(id, f.id, 'torrent_copy', ai, f.sha256, null, null);
        } else {
          put.run(id, f.id, 'torrent_only', ai, null, null, f.hash_error);
        }
      }
    })();
    p.counts = identityCounts(db, id);
    p.phase = 'done';
    p.finishedAt = Date.now();
    this.deps.log?.(`Audiobooks stage 1: done (${JSON.stringify(p.counts)})`);
    return p;
  }
}

/** Counts per class (files and bytes) and the derived numbers the page and the report show. */
export function identityCounts(db: Database.Database, analysisId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db
    .prepare(
      `SELECT f.root || '.' || c.class AS k, COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS bytes
       FROM audio_identity c JOIN audio_files f ON f.id = c.file_id
       WHERE c.analysis_id = ? GROUP BY k`,
    )
    .all(analysisId) as { k: string; n: number; bytes: number }[]) {
    out[r.k] = r.n;
    out[`${r.k}.bytes`] = r.bytes;
  }
  const ai = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS bytes FROM audio_identity c
       JOIN audio_files f ON f.id = c.file_id
       WHERE c.analysis_id = ? AND c.ai_original = 1 AND f.root = 'library'`,
    )
    .get(analysisId) as { n: number; bytes: number };
  out['library.ai_original'] = ai.n;
  out['library.ai_original.bytes'] = ai.bytes;
  // Torrent-side copies: groups of identical torrent files and the extra files in them.
  const groups = db
    .prepare(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(n - 1), 0) AS extra FROM (
         SELECT f.sha256, COUNT(*) AS n FROM audio_files f
         WHERE f.root = 'torrents' AND f.kind = 'audio' AND f.gone_at IS NULL AND f.sha256 IS NOT NULL
         GROUP BY f.sha256 HAVING COUNT(*) > 1)`,
    )
    .get() as { groups: number; extra: number };
  out['torrents.copy_groups'] = groups.groups;
  out['torrents.copy_extra'] = groups.extra;
  const links = db
    .prepare(`SELECT COUNT(*) AS n FROM audio_files WHERE gone_at IS NULL AND nlink > 1`)
    .get() as { n: number };
  out['files.nlink_gt1'] = links.n;
  return out;
}
