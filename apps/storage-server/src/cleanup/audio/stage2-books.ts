/**
 * Audiobook stage 2: books and file health (WP21a, plan section 4). Analysis only.
 *
 * Book units come from the torrent side only (user, 2026-11-17). Audiobookshelf's current items
 * (the library folders that hold audio) are only recorded: one evidence record per item, with
 * its files, ABS's metadata.json and the torrent files and books its files are copies of
 * (stage 1); they are never book units. Library files still get the health check.
 *
 * Phases (resumable):
 *   walk      inventory of both roots (walk.ts)
 *   units     book units (book-units.ts) of the current analysis
 *   health    ffprobe + short decodes per audio file (probe.ts), paced; a file is checked again
 *             only when its size or mtime changed. Waits while stage 1 hashes (the service).
 *   classify  parts or copies per multi-file book, and each book's evidence record
 *
 * Small reads only (headers and two short decodes per file), so this stage does not take the
 * shared disk lock (decided with the user 2026-11-17).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { getSettings } from '../settings';
import { insideRoot, readSmall } from './audio-source-fs';
import { getAudioStage, updateAudioStage } from './audio-stages';
import { buildUnits, classifyMulti, folderBooks, idsInNames, type RootName } from './book-units';
import { decodeMojibake, decodePath } from './mojibake';
import {
  checkHealth,
  HEALTH_TAGS_VERSION,
  toolVersion,
  type HealthResult,
  type ToolPaths,
} from './probe';
import { librarySwitched } from './switch-state';
import { walkRoots, type AudioRoots, type WalkResult } from './walk';

export type Stage2Phase = 'walk' | 'units' | 'health' | 'classify' | 'done';

export interface AudioStage2Progress {
  analysisId: string;
  phase: Stage2Phase;
  startedAt: number;
  finishedAt: number | null;
  walk: WalkResult | null;
  books: number;
  /** Audiobookshelf items recorded (library folders that hold audio; not book units). */
  absItems?: number;
  /** Folders whose full-length files became one book each (classify step). */
  splitFolders?: number;
  /** WP21f-1: folders of full-length files kept as one book, named as its parts. */
  namedPartsFolders?: number;
  healthTotal: number;
  healthDone: number;
  healthReused: number;
  /** WP21f-1: checks taken from a hard link's twin (same inode) instead of playing the file. */
  healthTwins?: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  counts: Record<string, number> | null;
  error: string | null;
}

export const STAGE2 = 2;
const HEALTH_CHUNK = 10;
export const EVIDENCE_VERSION = 1;

export function emptyStage2(now = Date.now()): AudioStage2Progress {
  return {
    analysisId: randomUUID(),
    phase: 'walk',
    startedAt: now,
    finishedAt: null,
    walk: null,
    books: 0,
    healthTotal: 0,
    healthDone: 0,
    healthReused: 0,
    phaseStartedAt: now,
    phaseStartDone: 0,
    counts: null,
    error: null,
  };
}

export interface Stage2Deps {
  db: Database.Database;
  roots: AudioRoots;
  tools: ToolPaths;
  /**
   * True while a Calibre job uses the disk (reads or applies a batch): stage 2 then waits,
   * listing and checking nothing; otherwise healthWorkers files at once, unpaced.
   */
  calibreBusy?: () => boolean;
  log?: (m: string) => void;
}

const HEALTH_COLUMNS = [
  'format',
  'format_long',
  'codec',
  'profile',
  'bitrate',
  'sample_rate',
  'channels',
  'duration',
  'chapter_count',
  'chapters_json',
  'has_cover',
  'tags_json',
  'header_ok',
  'start_decode_ok',
  'end_decode_ok',
  'decode_error',
  'error',
  'tool_version',
  'checked_ms',
  'checked_at',
  'tags_version',
];

/**
 * WP21f-1: a file without a current check that is a hard link of a checked file (same device
 * and inode, same size and mtime: the same bytes) takes that file's row instead of being
 * played again. After the switch every library file is such a link (about 5,000), so this
 * keeps a new analysis from checking them all again. Returns how many rows were taken.
 */
export function reuseTwinHealth(db: Database.Database): number {
  const cols = HEALTH_COLUMNS.join(', ');
  const fromTwin = HEALTH_COLUMNS.map((c) => `h.${c}`).join(', ');
  const update = HEALTH_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ');
  return db
    .prepare(
      `INSERT INTO audio_file_health (file_id, size, mtime_ms, ${cols})
       SELECT f.id, f.size, f.mtime_ms, ${fromTwin}
       FROM audio_files f
       JOIN audio_file_health h ON h.file_id = (
         SELECT t.id FROM audio_files t
         JOIN audio_file_health th ON th.file_id = t.id AND th.size = t.size AND th.mtime_ms = t.mtime_ms
         WHERE t.dev = f.dev AND t.ino = f.ino AND t.id <> f.id AND t.size = f.size
           AND t.mtime_ms = f.mtime_ms AND t.kind = 'audio'
         ORDER BY t.id LIMIT 1)
       LEFT JOIN audio_file_health fh ON fh.file_id = f.id
       WHERE f.kind = 'audio' AND f.gone_at IS NULL
         AND (fh.file_id IS NULL OR fh.size <> f.size OR fh.mtime_ms <> f.mtime_ms)
       ON CONFLICT(file_id) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, ${update}`,
    )
    .run().changes;
}

/** Audio files whose health is missing or stale (size or mtime changed). */
const STALE_SQL = `
  SELECT f.id, f.root, f.rel_path, f.rel_path_raw, f.size, f.mtime_ms FROM audio_files f
  LEFT JOIN audio_file_health h ON h.file_id = f.id
  WHERE f.kind = 'audio' AND f.gone_at IS NULL
    AND (h.file_id IS NULL OR h.size <> f.size OR h.mtime_ms <> f.mtime_ms
      OR ((h.start_decode_ok = 0 OR h.end_decode_ok = 0) AND h.checked_at < @since)
      OR (h.tags_version IS NULL AND f.id IN (
        SELECT bf.file_id FROM audio_book_files bf JOIN audio_books b ON b.id = bf.book_id
        WHERE b.analysis_id = @analysis AND b.file_count > 1)))`;
// A file of a multi-file book checked before its tags held track and disc (WP21f-2) is checked
// once more (183 files in the live library), so its book's story order can use them.
// A file whose play failed is checked again once in every analysis (@since = the analysis's
// start; few files: 77 of 11,651 in the live run), so a change in what counts as a problem
// reaches the results already stored.

export class AudioStage2 {
  private version: string | null | undefined;

  constructor(private readonly deps: Stage2Deps) {}

  progress(): AudioStage2Progress | null {
    const p = getAudioStage(this.deps.db, STAGE2).progress as unknown as AudioStage2Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: AudioStage2Progress, state?: string): void {
    updateAudioStage(this.deps.db, STAGE2, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(): AudioStage2Progress {
    const p = emptyStage2();
    this.save(p, 'analysing');
    return p;
  }

  async step(shouldStop: () => boolean): Promise<boolean> {
    let p = this.progress();
    if (!p || p.phase === 'done') return true;
    try {
      if (p.phase === 'walk') p = await this.walkStep(p, shouldStop);
      else if (p.phase === 'units') p = this.unitsStep(p);
      else if (p.phase === 'health') p = await this.healthStep(p, shouldStop);
      else if (p.phase === 'classify') p = await this.classifyStep(p);
      this.save(p, p.phase === 'done' ? (p.error ? 'failed' : 'ready') : 'analysing');
      return p.phase === 'done';
    } catch (err) {
      p.error = (err as Error).message ?? String(err);
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.save(p, 'failed');
      return true;
    }
  }

  private async walkStep(
    p: AudioStage2Progress,
    shouldStop: () => boolean,
  ): Promise<AudioStage2Progress> {
    const walk = await walkRoots(this.deps.db, this.deps.roots, {
      shouldStop,
      shouldPause: () => this.deps.calibreBusy?.() ?? false,
    });
    if (!walk) return p;
    p.walk = walk;
    p.phase = 'units';
    return p;
  }

  private unitsStep(p: AudioStage2Progress): AudioStage2Progress {
    const db = this.deps.db;
    const files = db
      .prepare(
        `SELECT id, root, rel_path FROM audio_files WHERE kind = 'audio' AND gone_at IS NULL`,
      )
      .all() as { id: number; root: RootName; rel_path: string }[];
    db.transaction(() => {
      db.prepare('DELETE FROM audio_books WHERE analysis_id <> ?').run(p.analysisId);
      db.prepare('DELETE FROM audio_books WHERE analysis_id = ?').run(p.analysisId);
      const putBook = db.prepare(
        `INSERT INTO audio_books (analysis_id, book_key, root, unit_rel_path, unit_kind, source,
           name_raw, name_decoded, file_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const putFile = db.prepare(
        'INSERT INTO audio_book_files (book_id, file_id, position, disc) VALUES (?, ?, ?, ?)',
      );
      let n = 0;
      for (const root of ['torrents'] as const) {
        const units = buildUnits(
          root,
          files.filter((f) => f.root === root).map((f) => ({ fileId: f.id, rel: f.rel_path })),
        );
        for (const u of units) {
          const r = putBook.run(
            p.analysisId,
            u.bookKey,
            u.root,
            u.unitRelPath,
            u.unitKind,
            u.source,
            u.nameRaw,
            decodeMojibake(u.nameRaw),
            u.files.length,
          );
          const bookId = Number(r.lastInsertRowid);
          for (const f of u.files) putFile.run(bookId, f.fileId, f.position, f.disc);
          n++;
        }
      }
      p.books = n;
    })();
    p.healthTwins = reuseTwinHealth(db);
    const stale = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM (${STALE_SQL})`)
        .get({ since: p.startedAt, analysis: p.analysisId }) as {
        n: number;
      }
    ).n;
    const all = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM audio_files WHERE kind = 'audio' AND gone_at IS NULL`)
        .get() as { n: number }
    ).n;
    p.healthTotal = all;
    p.healthDone = all - stale;
    p.healthReused = all - stale;
    p.phase = 'health';
    p.phaseStartedAt = Date.now();
    p.phaseStartDone = p.healthDone;
    return p;
  }

  private async healthStep(
    p: AudioStage2Progress,
    shouldStop: () => boolean,
  ): Promise<AudioStage2Progress> {
    const db = this.deps.db;
    const s = getSettings(db).audiobooks;
    const next = db
      .prepare(
        `${STALE_SQL} ORDER BY f.root, f.rel_path LIMIT ${Math.max(HEALTH_CHUNK, s.healthWorkers * 4)}`,
      )
      .all({ since: p.startedAt, analysis: p.analysisId }) as {
      id: number;
      root: RootName;
      rel_path: string;
      rel_path_raw: string | null;
      size: number;
      mtime_ms: number;
    }[];
    if (next.length === 0) {
      p.phase = 'classify';
      return p;
    }
    if (this.version === undefined) this.version = await toolVersion(this.deps.tools);
    const put = db.prepare(
      `INSERT INTO audio_file_health (file_id, size, mtime_ms, format, format_long, codec, profile,
         bitrate, sample_rate, channels, duration, chapter_count, chapters_json, has_cover, tags_json,
         header_ok, start_decode_ok, end_decode_ok, decode_error, error, tool_version, checked_ms, checked_at,
         tags_version)
       VALUES (@file_id, @size, @mtime_ms, @format, @format_long, @codec, @profile, @bitrate,
         @sample_rate, @channels, @duration, @chapter_count, @chapters_json, @has_cover, @tags_json,
         @header_ok, @start_ok, @end_ok, @decode_error, @error, @tool_version, @checked_ms, @checked_at,
         @tags_version)
       ON CONFLICT(file_id) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
         format = excluded.format, format_long = excluded.format_long, codec = excluded.codec,
         profile = excluded.profile, bitrate = excluded.bitrate, sample_rate = excluded.sample_rate,
         channels = excluded.channels, duration = excluded.duration,
         chapter_count = excluded.chapter_count, chapters_json = excluded.chapters_json,
         has_cover = excluded.has_cover, tags_json = excluded.tags_json,
         header_ok = excluded.header_ok, start_decode_ok = excluded.start_decode_ok,
         end_decode_ok = excluded.end_decode_ok, decode_error = excluded.decode_error,
         error = excluded.error, tool_version = excluded.tool_version,
         checked_ms = excluded.checked_ms, checked_at = excluded.checked_at,
         tags_version = excluded.tags_version`,
    );
    const busy = () => this.deps.calibreBusy?.() ?? false;
    const checkOne = async (f: (typeof next)[number]): Promise<number> => {
      const t0 = Date.now();
      const file = insideRoot(this.deps.roots[f.root], f.rel_path, f.rel_path_raw);
      const h: HealthResult | null = await checkHealth(file, this.deps.tools, {
        decodeSeconds: s.decodeSeconds,
        timeoutMs: s.toolTimeoutSeconds * 1000,
      }).catch(() => null);
      const took = Date.now() - t0;
      put.run({
        file_id: f.id,
        size: f.size,
        mtime_ms: f.mtime_ms,
        format: h?.format ?? null,
        format_long: h?.formatLong ?? null,
        codec: h?.codec ?? null,
        profile: h?.profile ?? null,
        bitrate: h?.bitrate ?? null,
        sample_rate: h?.sampleRate ?? null,
        channels: h?.channels ?? null,
        duration: h?.duration ?? null,
        chapter_count: h ? h.chapters.length : null,
        chapters_json: h ? JSON.stringify(h.chapters) : null,
        has_cover: h ? (h.hasCover ? 1 : 0) : null,
        tags_json: h
          ? JSON.stringify({ ...h.tags, ...(h.invalidUtf8 ? { _invalidUtf8: 'yes' } : {}) })
          : null,
        header_ok: h?.headerOk ? 1 : 0,
        start_ok: h?.startDecodeOk === null || !h ? null : h.startDecodeOk ? 1 : 0,
        end_ok: h?.endDecodeOk === null || !h ? null : h.endDecodeOk ? 1 : 0,
        decode_error: h?.decodeError ?? null,
        error: h ? h.error : 'The file could not be opened',
        tool_version: this.version ?? null,
        checked_ms: took,
        checked_at: Date.now(),
        tags_version: h ? HEALTH_TAGS_VERSION : null,
      });
      p.healthDone++;
      this.save(p, 'analysing');
      return took;
    };
    if (busy()) {
      // A Calibre job uses the disk: wait (the next step looks again).
      await new Promise((r) => setTimeout(r, 1000));
      return p;
    }
    // The disk is free of Calibre jobs: several files at once, unpaced. Each worker stops taking
    // new files as soon as a Calibre job starts using the disk (the rest wait for the next step).
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(s.healthWorkers, next.length) }, async () => {
        while (i < next.length) {
          if (shouldStop() || busy()) return;
          await checkOne(next[i++]);
        }
      }),
    );
    return p;
  }

  /**
   * Folders whose files are each full length become one book per file (`folderBooks`). Returns
   * the folders kept as one book although their lengths are mixed (shown as unclear).
   */
  private splitFullLengthFolders(p: AudioStage2Progress, fullMinutes: number): Set<number> {
    const db = this.deps.db;
    const folders = db
      .prepare(
        `SELECT id, book_key, root, unit_rel_path, source FROM audio_books
         WHERE analysis_id = ? AND unit_kind = 'folder' AND file_count > 1`,
      )
      .all(p.analysisId) as {
      id: number;
      book_key: string;
      root: RootName;
      unit_rel_path: string;
      source: string;
    }[];
    const filesOf = db.prepare(
      `SELECT f.id, f.rel_path, h.duration, bf.disc FROM audio_book_files bf
       JOIN audio_files f ON f.id = bf.file_id LEFT JOIN audio_file_health h ON h.file_id = f.id
       WHERE bf.book_id = ? ORDER BY bf.position`,
    );
    const putBook = db.prepare(
      `INSERT INTO audio_books (analysis_id, book_key, root, unit_rel_path, unit_kind, source,
         name_raw, name_decoded, file_count) VALUES (?, ?, ?, ?, 'file', ?, ?, ?, 1)`,
    );
    const putFile = db.prepare(
      'INSERT INTO audio_book_files (book_id, file_id, position, disc) VALUES (?, ?, 0, NULL)',
    );
    const mixed = new Set<number>();
    let split = 0;
    db.transaction(() => {
      for (const b of folders) {
        const files = filesOf.all(b.id) as {
          id: number;
          rel_path: string;
          duration: number | null;
          disc: string | null;
        }[];
        const how = folderBooks(
          files.map((f) => {
            const base = (f.rel_path.split('/').pop() ?? f.rel_path).replace(/\.[^.]+$/, '');
            return { seconds: f.duration, disc: f.disc, name: decodeMojibake(base) ?? base };
          }),
          fullMinutes,
        );
        if (how === 'mixed') mixed.add(b.id);
        if (how === 'named_parts') this.namedParts.add(b.id);
        if (how !== 'split') continue;
        // ON DELETE CASCADE removes the folder's file rows.
        db.prepare('DELETE FROM audio_books WHERE id = ?').run(b.id);
        db.prepare(`DELETE FROM audio_evidence WHERE book_key = ? AND kind = 'files'`).run(
          b.book_key,
        );
        for (const f of files) {
          const name = (f.rel_path.split('/').pop() ?? f.rel_path).replace(/\.[^.]+$/, '');
          const r = putBook.run(
            p.analysisId,
            `${b.root}:${f.rel_path}`,
            b.root,
            f.rel_path,
            b.source,
            name,
            decodeMojibake(name),
          );
          putFile.run(Number(r.lastInsertRowid), f.id);
        }
        split++;
      }
    })();
    p.splitFolders = split;
    p.books = (
      db
        .prepare('SELECT COUNT(*) AS n FROM audio_books WHERE analysis_id = ?')
        .get(p.analysisId) as {
        n: number;
      }
    ).n;
    return mixed;
  }

  /** Folders the parts rule kept as one book (filled by splitFullLengthFolders). */
  private namedParts = new Set<number>();

  private async classifyStep(p: AudioStage2Progress): Promise<AudioStage2Progress> {
    const db = this.deps.db;
    const s = getSettings(db).audiobooks;
    this.namedParts = new Set();
    const mixed = this.splitFullLengthFolders(p, s.fullBookMinutes);
    p.namedPartsFolders = this.namedParts.size;
    const books = db
      .prepare('SELECT * FROM audio_books WHERE analysis_id = ? ORDER BY id')
      .all(p.analysisId) as {
      id: number;
      book_key: string;
      root: RootName;
      unit_rel_path: string;
      unit_kind: string;
      source: string;
      name_raw: string;
      name_decoded: string | null;
    }[];
    const filesOf = db.prepare(
      `SELECT f.id, f.rel_path, f.decoded_path, f.size, h.duration, h.format, h.codec, h.tags_json,
         h.chapter_count, h.has_cover, bf.disc
       FROM audio_book_files bf JOIN audio_files f ON f.id = bf.file_id
       LEFT JOIN audio_file_health h ON h.file_id = f.id
       WHERE bf.book_id = ? ORDER BY bf.position`,
    );
    const setClass = db.prepare(
      'UPDATE audio_books SET total_seconds = ?, multi_class = ?, class_reason = ? WHERE id = ?',
    );
    const putEvidence = db.prepare(
      `INSERT INTO audio_evidence (book_key, kind, version, data, created_at) VALUES (?, 'files', ?, ?, ?)
       ON CONFLICT(book_key, kind) DO UPDATE SET version = excluded.version, data = excluded.data,
         created_at = excluded.created_at`,
    );
    const rows: {
      id: number;
      total: number | null;
      cls: string;
      reason: string;
      key: string;
      evidence: string;
    }[] = [];
    for (const b of books) {
      const files = filesOf.all(b.id) as {
        id: number;
        rel_path: string;
        decoded_path: string | null;
        size: number;
        duration: number | null;
        format: string | null;
        codec: string | null;
        tags_json: string | null;
        chapter_count: number | null;
        has_cover: number | null;
        disc: string | null;
      }[];
      const durations = files.map((f) => f.duration);
      const multi = mixed.has(b.id)
        ? {
            cls: 'unclear' as const,
            reason: `Some files are full length and some are short: one book in parts, or several books? (${files.length} files)`,
          }
        : this.namedParts.has(b.id)
          ? {
              cls: 'parts' as const,
              reason: `${files.length} full-length files named as parts of one book (Part, Disc, CD or track numbers, no store id of their own)`,
            }
          : classifyMulti(durations, s.copyHintMinMinutes, s.copyHintPercent);
      const { cls, reason } = multi;
      const total = durations.every((d) => typeof d === 'number')
        ? durations.reduce<number>((a, d) => a + (d ?? 0), 0)
        : null;
      const names = [
        ...b.unit_rel_path.split('/'),
        ...files.map((f) => f.rel_path.split('/').pop() ?? ''),
      ];
      const decodedNames = names.map((n) => decodeMojibake(n) ?? n);
      const first = files[0];
      const evidence = {
        root: b.root,
        unit: b.unit_rel_path,
        unitDecoded: b.name_decoded
          ? decodedNames.slice(0, b.unit_rel_path.split('/').length).join('/')
          : null,
        source: b.source,
        ids: idsInNames(decodedNames),
        files: files.map((f) => ({
          name: f.rel_path.split('/').pop(),
          decoded: f.decoded_path ? f.decoded_path.split('/').pop() : null,
          size: f.size,
          seconds: f.duration,
          format: f.format,
          codec: f.codec,
          chapters: f.chapter_count,
          cover: f.has_cover === 1,
          disc: f.disc,
        })),
        tags: first?.tags_json ? (JSON.parse(first.tags_json) as unknown) : null,
        multi: { cls, reason },
      };
      rows.push({
        id: b.id,
        total,
        cls,
        reason,
        key: b.book_key,
        evidence: JSON.stringify(evidence),
      });
    }
    const now = Date.now();
    db.transaction(() => {
      for (const r of rows) {
        setClass.run(r.total, r.cls, r.reason, r.id);
        putEvidence.run(r.key, EVIDENCE_VERSION, r.evidence, now);
      }
    })();
    p.absItems = await this.recordAbsItems(p.analysisId);
    p.counts = booksCounts(db, p.analysisId);
    p.phase = 'done';
    p.finishedAt = Date.now();
    this.deps.log?.(`Audiobooks stage 2: done (${JSON.stringify(p.counts)})`);
    return p;
  }

  /**
   * Records Audiobookshelf's current items: each library folder that holds audio (Disc/CD
   * subfolders belong to it, as ABS groups them). Not book units: one evidence record each
   * (kind abs_item), with its files, ABS's metadata.json (read only), and for each file the
   * torrent files it is a byte copy of and their torrent books (from stage 1's current
   * analysis, when there is one). Returns how many items were recorded.
   */
  private async recordAbsItems(analysisId: string): Promise<number> {
    const db = this.deps.db;
    // WP21f-1: after the switch the library's metadata.json files are the cleanup's own output
    // (stage 5's values). Reading them back would make stage 3 and 4 use our own decisions as
    // "what Audiobookshelf had" (ABS ASINs), so the old library's items stay as recorded.
    if (librarySwitched(db))
      return (
        db.prepare(`SELECT COUNT(*) AS n FROM audio_evidence WHERE kind = 'abs_item'`).get() as {
          n: number;
        }
      ).n;
    const files = db
      .prepare(
        `SELECT f.id, f.rel_path, f.decoded_path, f.size, h.duration, h.format, h.codec,
           h.chapter_count, h.has_cover
         FROM audio_files f LEFT JOIN audio_file_health h ON h.file_id = f.id
         WHERE f.root = 'library' AND f.kind = 'audio' AND f.gone_at IS NULL`,
      )
      .all() as AbsItemFile[];
    const byId = new Map(files.map((f) => [f.id, f]));
    const items = buildUnits(
      'library',
      files.map((f) => ({ fileId: f.id, rel: f.rel_path })),
    );
    const s1 = getAudioStage(db, 1).progress as { analysisId?: string; phase?: string };
    const stage1Id = s1.phase === 'done' && s1.analysisId ? s1.analysisId : null;
    const identity = db.prepare(
      'SELECT class, original_file_ids FROM audio_identity WHERE analysis_id = ? AND file_id = ?',
    );
    const original = db.prepare(
      `SELECT f.rel_path, b.book_key FROM audio_files f
       LEFT JOIN audio_book_files bf ON bf.file_id = f.id
       LEFT JOIN audio_books b ON b.id = bf.book_id AND b.analysis_id = ?
       WHERE f.id = ?`,
    );
    const records: { key: string; data: string }[] = [];
    for (const item of items) {
      let abs: unknown = null;
      const raw = await readSmall(
        insideRoot(this.deps.roots.library, `${item.unitRelPath}/metadata.json`),
        1024 * 1024,
      );
      if (raw) {
        try {
          abs = JSON.parse(raw.toString('utf8'));
        } catch {
          abs = { unreadable: true };
        }
      }
      const torrentBooks = new Set<string>();
      const itemFiles = item.files.map((uf) => {
        const f = byId.get(uf.fileId)!;
        const id = stage1Id
          ? (identity.get(stage1Id, f.id) as
              | { class: string; original_file_ids: string | null }
              | undefined)
          : undefined;
        const originals = id?.original_file_ids
          ? (JSON.parse(id.original_file_ids) as number[])
              .map(
                (oid) =>
                  original.get(analysisId, oid) as
                    | { rel_path: string; book_key: string | null }
                    | undefined,
              )
              .filter((o): o is { rel_path: string; book_key: string | null } => !!o)
          : [];
        for (const o of originals) if (o.book_key) torrentBooks.add(o.book_key);
        return {
          name: f.rel_path.split('/').pop(),
          decoded: f.decoded_path ? f.decoded_path.split('/').pop() : null,
          disc: uf.disc,
          size: f.size,
          seconds: f.duration,
          format: f.format,
          codec: f.codec,
          chapters: f.chapter_count,
          cover: f.has_cover === 1,
          identity: id?.class ?? null,
          originals: originals.map((o) => o.rel_path),
        };
      });
      records.push({
        key: item.bookKey,
        data: JSON.stringify({
          folder: item.unitRelPath,
          folderDecoded: decodePath(item.unitRelPath),
          files: itemFiles,
          torrentBooks: [...torrentBooks],
          absMetadata: abs,
        }),
      });
    }
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`DELETE FROM audio_evidence WHERE kind = 'abs_item'`).run();
      const put = db.prepare(
        `INSERT INTO audio_evidence (book_key, kind, version, data, created_at)
         VALUES (?, 'abs_item', ?, ?, ?)`,
      );
      for (const r of records) put.run(r.key, EVIDENCE_VERSION, r.data, now);
    })();
    return records.length;
  }
}

/** The files of one recorded ABS item, with what stage 2 found in them. */
interface AbsItemFile {
  id: number;
  rel_path: string;
  decoded_path: string | null;
  size: number;
  duration: number | null;
  format: string | null;
  codec: string | null;
  chapter_count: number | null;
  has_cover: number | null;
}

/** Counts for the page and the report. */
export function booksCounts(db: Database.Database, analysisId: string): Record<string, number> {
  const out: Record<string, number> = {};
  // Audiobookshelf's items: recorded, not book units.
  const abs = db
    .prepare(
      `SELECT COUNT(*) AS items,
         COALESCE(SUM(json_array_length(data, '$.files') > 1), 0) AS multi,
         COALESCE(SUM(json_array_length(data, '$.torrentBooks') = 0), 0) AS no_torrent_book
       FROM audio_evidence WHERE kind = 'abs_item'`,
    )
    .get() as { items: number; multi: number; no_torrent_book: number };
  out['library.abs_items'] = abs.items;
  out['library.abs_items.multi'] = abs.multi;
  out['library.abs_items.no_torrent_book'] = abs.no_torrent_book;
  for (const r of db
    .prepare(
      `SELECT root || '.' || COALESCE(multi_class, 'none') AS k, COUNT(*) AS n FROM audio_books
       WHERE analysis_id = ? GROUP BY k`,
    )
    .all(analysisId) as { k: string; n: number }[]) {
    out[r.k] = r.n;
  }
  for (const r of db
    .prepare(
      `SELECT root || '.source.' || source AS k, COUNT(*) AS n FROM audio_books WHERE analysis_id = ? GROUP BY k`,
    )
    .all(analysisId) as { k: string; n: number }[]) {
    out[r.k] = r.n;
  }
  out['books.decoded_names'] = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM audio_books WHERE analysis_id = ? AND name_decoded IS NOT NULL`,
      )
      .get(analysisId) as { n: number }
  ).n;
  const h = db
    .prepare(
      `SELECT f.root AS root,
         COUNT(*) AS files,
         SUM(h.header_ok = 0) AS unreadable,
         SUM(h.header_ok = 1 AND (h.start_decode_ok = 0 OR h.end_decode_ok = 0)) AS damaged,
         SUM(h.format = 'mp4' AND COALESCE(h.chapter_count, 0) = 0) AS mp4_no_chapters,
         SUM(h.has_cover = 0 AND h.header_ok = 1) AS no_cover,
         SUM(h.header_ok = 1 AND f.ext <> '.' || h.format AND NOT (h.format = 'mp4' AND f.ext IN ('.m4b', '.m4a', '.mp4', '.aac'))) AS ext_mismatch,
         SUM(h.tags_json LIKE '%_invalidUtf8%') AS invalid_utf8
       FROM audio_files f JOIN audio_file_health h ON h.file_id = f.id
       WHERE f.kind = 'audio' AND f.gone_at IS NULL GROUP BY f.root`,
    )
    .all() as Record<string, number | string>[];
  for (const r of h) {
    for (const [k, v] of Object.entries(r))
      if (k !== 'root') out[`${r.root}.health.${k}`] = Number(v ?? 0);
  }
  for (const r of db
    .prepare(
      `SELECT f.root || '.format.' || COALESCE(h.format, 'unknown') || '/' || COALESCE(h.codec, '-') AS k, COUNT(*) AS n
       FROM audio_files f JOIN audio_file_health h ON h.file_id = f.id
       WHERE f.kind = 'audio' AND f.gone_at IS NULL GROUP BY k`,
    )
    .all() as { k: string; n: number }[]) {
    out[r.k] = r.n;
  }
  return out;
}
