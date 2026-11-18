/**
 * Audiobook stage 3: duplicates, the same recording (WP21b, plan section 5). Analysis only:
 * decisions go into cleanup.db and onto /cleanup; nothing is linked, moved or dropped here
 * (that is WP21e).
 *
 * Phases (resumable; each saves its rows before the next starts):
 *   copies        the copies that compete: one per torrent book unit (a file, or the parts of a
 *                 folder), one per file of a folder that holds full copies, one per library-only
 *                 file. AI books compete only with AI books; files the reader wrote never take part.
 *   candidates    pairs, cheapest test first: identical files (stage 1), same ASIN in the names,
 *                 same ASIN in Audiobookshelf's metadata.json (a candidate only), same title and
 *                 printed volume with a similar length, files of one folder.
 *   fingerprints  Chromaprint windows at the start, the middle and the end of each copy of
 *                 every non-identical pair (small reads, several at once; they wait while a
 *                 Calibre job uses the disk). Kept per stretch of file: never read twice.
 *   compare       scores and a verdict per pair (no reads).
 *   decode        full decodes for rule 0 (ffmpeg, then faad2 to confirm what ffmpeg reports):
 *                 every file stage 2 found damaged, the chosen copy of each group, every copy of
 *                 a review group. Holds the shared disk lock and gives it back at once when a
 *                 Calibre job waits (the file is decoded again later).
 *   decide        groups, the best copy by the decided order, review items; then the gate on the
 *                 labeled pairs.
 *
 * A change to stage 3's settings goes back to `candidates` (no file is read again unless a
 * window it needs isn't stored yet).
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings, type AudiobookSettings } from '../settings';
import { insideRoot } from './audio-source-fs';
import { getAudioStage, updateAudioStage } from './audio-stages';
import { idsInNames, type RootName } from './book-units';
import {
  fingerprintVerdict,
  fpFromBuffer,
  fpToBuffer,
  planWindows,
  scoreWindow,
  type Span,
  type WindowScore,
} from './dup-fingerprint';
import { scoreGate, type GateResult, type LabelsFile } from './dup-gate';
import { groupCopies, groupKey, type DupTest, type Edge } from './dup-groups';
import { printedVolume, titleKey } from './dup-names';
import {
  decideGroup,
  comparePair,
  type CopyFacts,
  type RuleSettings,
  type ChapterSpan,
} from './dup-rules';
import { decodeMojibake } from './mojibake';
import {
  decodeWithFaad,
  decodeWithFfmpeg,
  fingerprintSpans,
  stage3ToolVersions,
  type FileSpan,
  type ToolPaths,
} from './probe';
import type { AudioRoots } from './walk';

export const STAGE3 = 3;
const OWNER = DISK_OWNERS.audio3;
/** Pairs scored per step (the server answers requests between steps). */
const COMPARE_CHUNK = 50;

export type Stage3Phase =
  | 'copies'
  | 'candidates'
  | 'fingerprints'
  | 'compare'
  | 'decode'
  | 'decide'
  | 'done';

export interface PhaseTime {
  ms: number;
  items: number;
}

export interface AudioStage3Progress {
  analysisId: string;
  phase: Stage3Phase;
  startedAt: number;
  finishedAt: number | null;
  stage1Id: string | null;
  stage2Id: string | null;
  copies: number;
  excluded: number;
  pairsByTest: Record<string, number>;
  windowsTotal: number;
  windowsDone: number;
  windowsReused: number;
  windowErrors: number;
  decodesDone: number;
  decodesReused: number;
  /** Times the decode phase gave the disk to a Calibre job. */
  yields: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  /** Per phase: work time (not waiting) and items handled. */
  phaseTimes: Record<string, PhaseTime>;
  /** The settings the pairs and decisions were made with. */
  rulesKey: string | null;
  /** Copies named in the labeled pairs (their windows are read first). */
  gateCopyIds: number[];
  tools: { fpcalc: string | null; faad: string | null; ffmpeg: string | null } | null;
  counts: Record<string, number> | null;
  gate: GateResult | null;
  error: string | null;
}

export function emptyStage3(now = Date.now()): AudioStage3Progress {
  return {
    analysisId: randomUUID(),
    phase: 'copies',
    startedAt: now,
    finishedAt: null,
    stage1Id: null,
    stage2Id: null,
    copies: 0,
    excluded: 0,
    pairsByTest: {},
    windowsTotal: 0,
    windowsDone: 0,
    windowsReused: 0,
    windowErrors: 0,
    decodesDone: 0,
    decodesReused: 0,
    yields: 0,
    phaseStartedAt: now,
    phaseStartDone: 0,
    phaseTimes: {},
    rulesKey: null,
    gateCopyIds: [],
    tools: null,
    counts: null,
    gate: null,
    error: null,
  };
}

export interface Stage3Deps {
  db: Database.Database;
  roots: AudioRoots;
  tools: ToolPaths;
  lock: DiskLock;
  /** True while a Calibre job uses the disk: window reads wait. */
  calibreBusy?: () => boolean;
  /** The labeled pairs (labels.json) as text, or why they can't be read. */
  readLabels?: () => { text: string | null; error: string | null };
  /** Library paths (under the library root) of files the reader wrote (merges): they never compete. */
  readerWrittenFiles?: () => string[];
  log?: (m: string) => void;
}

/** The settings a stage 3 result depends on (a change makes the stage compare again). */
export function stage3SettingsKey(s: AudiobookSettings): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        s.dupWindowSeconds,
        s.dupShiftSeconds,
        s.dupMiddleSearchMinutes,
        s.dupSameScore,
        s.dupCandidatePercent,
        s.dupAsinToleranceSeconds,
        s.dupLengthEqualSeconds,
        s.dupIncompleteSeconds,
        s.dupBitrateMarginPercent,
        s.dupChapterToleranceSeconds,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

function ruleSettings(s: AudiobookSettings): RuleSettings {
  return {
    lengthEqualSeconds: s.dupLengthEqualSeconds,
    incompleteSeconds: s.dupIncompleteSeconds,
    bitrateMarginPercent: s.dupBitrateMarginPercent,
    chapterToleranceSeconds: s.dupChapterToleranceSeconds,
  };
}

/** One file of a copy with what stage 2 found in it. */
export interface CopyFile {
  id: number;
  root: RootName;
  rel: string;
  raw: string | null;
  size: number;
  mtime: number;
  sha256: string | null;
  duration: number | null;
  codec: string | null;
  bitrate: number | null;
  sampleRate: number | null;
  chapters: ChapterSpan[];
  hasCover: boolean;
  startOk: number | null;
  endOk: number | null;
}

export interface LoadedCopy {
  id: number;
  key: string;
  bookKey: string;
  kind: 'file' | 'parts' | 'library_only';
  name: string;
  seconds: number | null;
  ai: boolean;
  titleKey: string | null;
  volume: string | null;
  asins: string[];
  absAsins: string[];
  excluded: string | null;
  files: CopyFile[];
}

/** Stretches of a copy's timeline as stretches of its files (files one after another). */
export function spansOf(
  files: { id: number; duration: number | null }[],
  span: Span,
): { fileId: number; start: number; length: number }[] {
  const out: { fileId: number; start: number; length: number }[] = [];
  let t = 0;
  const end = span.start + span.length;
  for (const f of files) {
    const d = f.duration ?? 0;
    const fs0 = t;
    const fs1 = t + d;
    t = fs1;
    const a = Math.max(span.start, fs0);
    const b = Math.min(end, fs1);
    if (b - a > 0.05) out.push({ fileId: f.id, start: a - fs0, length: b - a });
  }
  return out;
}

/**
 * A window's name: the files' contents (SHA-256 from stage 1, so byte-identical files share
 * their windows) or, without a hash, the file's id; and the seconds read.
 */
export function windowKey(
  spans: { fileId: number; start: number; length: number }[],
  shaOf: (fileId: number) => string | null = () => null,
): string {
  return JSON.stringify(
    spans.map((s) => [
      shaOf(s.fileId) ?? s.fileId,
      Math.round(s.start * 1000),
      Math.round(s.length * 1000),
    ]),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PairRow {
  id: number;
  a_id: number;
  b_id: number;
  test: DupTest;
  verdict: string;
}

export class AudioStage3 {
  private copiesCache: { analysisId: string; byId: Map<number, LoadedCopy> } | null = null;
  private windowsCache: { analysisId: string; rulesKey: string; keys: WindowNeed[] } | null = null;
  private versions: AudioStage3Progress['tools'] = null;

  constructor(private readonly deps: Stage3Deps) {}

  progress(): AudioStage3Progress | null {
    const p = getAudioStage(this.deps.db, STAGE3).progress as unknown as AudioStage3Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: AudioStage3Progress, state?: string): void {
    updateAudioStage(this.deps.db, STAGE3, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(): AudioStage3Progress {
    const p = emptyStage3();
    this.copiesCache = null;
    this.windowsCache = null;
    this.save(p, 'analysing');
    return p;
  }

  /** Back to the candidates (settings changed): nothing is read again that is stored. */
  recompare(): void {
    const p = this.progress();
    if (!p || p.phase === 'copies') return;
    p.phase = 'candidates';
    p.finishedAt = null;
    p.error = null;
    p.gate = null;
    p.counts = null;
    this.windowsCache = null;
    this.save(p, 'analysing');
  }

  /** True while this stage reads the audio files (windows or full decodes). */
  reading(): boolean {
    const p = this.progress();
    return !!p && (p.phase === 'fingerprints' || p.phase === 'decode');
  }

  async step(shouldStop: () => boolean): Promise<boolean> {
    const p = this.progress();
    if (!p || p.phase === 'done') return true;
    const phase = p.phase;
    const t0 = Date.now();
    let items = 0;
    try {
      if (phase === 'copies') items = this.copiesStep(p);
      else if (phase === 'candidates') items = this.candidatesStep(p);
      else if (phase === 'fingerprints') items = await this.fingerprintsStep(p, shouldStop);
      else if (phase === 'compare') items = this.compareStep(p);
      else if (phase === 'decode') items = await this.decodeStep(p, shouldStop);
      else if (phase === 'decide') items = this.decideStep(p);
      const pt = p.phaseTimes[phase] ?? { ms: 0, items: 0 };
      // Waiting for Calibre is not work: a step that handled nothing adds no time.
      if (items > 0 || phase !== 'fingerprints') {
        pt.ms += Date.now() - t0;
        pt.items += items;
      }
      p.phaseTimes[phase] = pt;
      // The step may have moved the phase on.
      const finished = (p.phase as Stage3Phase) === 'done';
      this.save(p, finished ? (p.error ? 'failed' : 'ready') : 'analysing');
      return finished;
    } catch (err) {
      p.error = (err as Error).message ?? String(err);
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.save(p, 'failed');
      return true;
    } finally {
      if (phase !== 'decode') this.deps.lock.release(OWNER);
    }
  }

  private nextPhase(p: AudioStage3Progress, phase: Stage3Phase, done = 0): void {
    p.phase = phase;
    p.phaseStartedAt = Date.now();
    p.phaseStartDone = done;
  }

  // -------------------------------------------------------------------------------------------
  // copies

  private copiesStep(p: AudioStage3Progress): number {
    const db = this.deps.db;
    const s1 = getAudioStage(db, 1).progress as { analysisId?: string; phase?: string };
    const s2 = getAudioStage(db, 2).progress as { analysisId?: string; phase?: string };
    if (s1.phase !== 'done' || s2.phase !== 'done' || !s1.analysisId || !s2.analysisId) {
      throw new Error('Stages 1 and 2 must have finished first');
    }
    p.stage1Id = s1.analysisId;
    p.stage2Id = s2.analysisId;
    const books = db
      .prepare(
        `SELECT id, book_key, unit_rel_path, unit_kind, source, name_raw, name_decoded, multi_class
         FROM audio_books WHERE analysis_id = ? AND root = 'torrents' ORDER BY id`,
      )
      .all(p.stage2Id) as {
      id: number;
      book_key: string;
      unit_rel_path: string;
      unit_kind: string;
      source: string;
      name_raw: string;
      name_decoded: string | null;
      multi_class: string | null;
    }[];
    // Every book's files and every file's length in two reads (one query per book took 1.7 s
    // for the live data on the PC, too long for one step: WP20 lessons (3)).
    const filesByBook = new Map<
      number,
      { id: number; rel_path: string; decoded_path: string | null }[]
    >();
    for (const r of db
      .prepare(
        `SELECT bf.book_id, f.id, f.rel_path, f.decoded_path FROM audio_books b
         JOIN audio_book_files bf ON bf.book_id = b.id JOIN audio_files f ON f.id = bf.file_id
         WHERE b.analysis_id = ? AND b.root = 'torrents' ORDER BY bf.book_id, bf.position`,
      )
      .all(p.stage2Id) as {
      book_id: number;
      id: number;
      rel_path: string;
      decoded_path: string | null;
    }[]) {
      let l = filesByBook.get(r.book_id);
      if (!l) filesByBook.set(r.book_id, (l = []));
      l.push({ id: r.id, rel_path: r.rel_path, decoded_path: r.decoded_path });
    }
    const durations = new Map<number, number | null>();
    for (const r of db.prepare('SELECT file_id, duration FROM audio_file_health').all() as {
      file_id: number;
      duration: number | null;
    }[])
      durations.set(r.file_id, r.duration);
    // ASINs Audiobookshelf has for the torrent files its items are copies of (candidates only).
    const absAsinsByRel = new Map<string, Set<string>>();
    for (const r of db.prepare(`SELECT data FROM audio_evidence WHERE kind = 'abs_item'`).all() as {
      data: string;
    }[]) {
      const d = JSON.parse(r.data) as {
        files?: { originals?: string[] }[];
        absMetadata?: { asin?: unknown } | null;
      };
      const asin = typeof d.absMetadata?.asin === 'string' ? d.absMetadata.asin.trim() : '';
      if (!/^B0[0-9A-Z]{8}$/.test(asin)) continue;
      for (const f of d.files ?? [])
        for (const o of f.originals ?? []) {
          let set = absAsinsByRel.get(o);
          if (!set) absAsinsByRel.set(o, (set = new Set()));
          set.add(asin);
        }
    }
    const rows: {
      key: string;
      bookKey: string;
      kind: 'file' | 'parts' | 'library_only';
      fileIds: number[];
      name: string;
      seconds: number | null;
      ai: boolean;
      titleKey: string | null;
      volume: string | null;
      asins: string[];
      absAsins: string[];
      excluded: string | null;
    }[] = [];
    const lengthOf = (ids: number[]) => {
      let total = 0;
      for (const id of ids) {
        const d = durations.get(id);
        if (typeof d !== 'number') return null;
        total += d;
      }
      return total;
    };
    const baseName = (rel: string) => {
      const n = rel.split('/').pop() ?? rel;
      const i = n.lastIndexOf('.');
      return i > 0 ? n.slice(0, i) : n;
    };
    for (const b of books) {
      const files = filesByBook.get(b.id) ?? [];
      if (files.length === 0) continue;
      const unitName = b.name_decoded ?? b.name_raw;
      const nameOf = (f: { rel_path: string; decoded_path: string | null }) =>
        baseName(f.decoded_path ?? f.rel_path);
      const ai = b.source === 'ai';
      const add = (fs: typeof files, kind: 'file' | 'parts') => {
        const own = kind === 'file' ? nameOf(fs[0]) : unitName;
        const names = [unitName, ...fs.map(nameOf)];
        const abs = new Set<string>();
        for (const f of fs) for (const a of absAsinsByRel.get(f.rel_path) ?? []) abs.add(a);
        const asins = idsInNames(names).asins;
        rows.push({
          key: `${b.book_key}#${fs[0].rel_path}`,
          bookKey: b.book_key,
          kind,
          fileIds: fs.map((f) => f.id),
          name: own,
          seconds: lengthOf(fs.map((f) => f.id)),
          ai,
          titleKey: titleKey(own) || null,
          volume: printedVolume(own),
          asins,
          absAsins: [...abs].filter((a) => !asins.includes(a)),
          excluded: null,
        });
      };
      if (files.length === 1 || b.multi_class === 'parts' || b.multi_class === 'unclear') {
        add(files, files.length === 1 ? 'file' : 'parts');
      } else {
        // A folder of full copies (likely_copies): each file is a copy; the in-folder test
        // decides whether they are the same recording.
        for (const f of files) add([f], 'file');
      }
    }
    // Library files with no torrent original (stage 1's library_only): they become originals
    // in _from-library (WP21e), so they compete too. Files the reader wrote never do.
    const written = new Set(this.deps.readerWrittenFiles?.() ?? []);
    for (const f of db
      .prepare(
        `SELECT f.id, f.rel_path, f.decoded_path, c.ai_original FROM audio_identity c
         JOIN audio_files f ON f.id = c.file_id
         WHERE c.analysis_id = ? AND c.class = 'library_only' AND f.kind = 'audio' AND f.gone_at IS NULL
         ORDER BY f.rel_path`,
      )
      .all(p.stage1Id) as {
      id: number;
      rel_path: string;
      decoded_path: string | null;
      ai_original: number;
    }[]) {
      const own = baseName(f.decoded_path ?? f.rel_path);
      const folder = f.rel_path.split('/').slice(0, -1).join('/');
      const folderName = decodeMojibake(folder.split('/').pop() ?? '') ?? folder.split('/').pop();
      const asins = idsInNames([folderName ?? '', own]).asins;
      rows.push({
        key: `library:${folder}#${f.rel_path}`,
        bookKey: `library:${folder}`,
        kind: 'library_only',
        fileIds: [f.id],
        name: own,
        seconds: lengthOf([f.id]),
        ai: f.ai_original === 1,
        titleKey: titleKey(own) || null,
        volume: printedVolume(own),
        asins,
        absAsins: [],
        excluded: written.has(f.rel_path)
          ? 'written by the reader (a merge): never competes'
          : null,
      });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM audio_dup_copies WHERE analysis_id = ?').run(p.analysisId);
      const put = db.prepare(
        `INSERT INTO audio_dup_copies (analysis_id, copy_key, book_key, kind, file_ids, name,
           seconds, ai, title_key, volume, asins, abs_asins, excluded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        put.run(
          p.analysisId,
          r.key,
          r.bookKey,
          r.kind,
          JSON.stringify(r.fileIds),
          r.name,
          r.seconds,
          r.ai ? 1 : 0,
          r.titleKey,
          r.volume,
          JSON.stringify(r.asins),
          JSON.stringify(r.absAsins),
          r.excluded,
        );
      }
    })();
    p.copies = rows.length;
    p.excluded = rows.filter((r) => r.excluded).length;
    this.copiesCache = null;
    this.nextPhase(p, 'candidates');
    return rows.length;
  }

  /** The current analysis's copies with their files (cached; small: one row per copy). */
  loadCopies(analysisId: string): Map<number, LoadedCopy> {
    if (this.copiesCache?.analysisId === analysisId) return this.copiesCache.byId;
    const db = this.deps.db;
    const files = new Map<number, CopyFile>();
    for (const f of db
      .prepare(
        `SELECT f.id, f.root, f.rel_path, f.rel_path_raw, f.size, f.mtime_ms, f.sha256,
           h.duration, h.codec, h.bitrate, h.sample_rate, h.chapters_json, h.has_cover,
           h.start_decode_ok, h.end_decode_ok
         FROM audio_files f LEFT JOIN audio_file_health h ON h.file_id = f.id
         WHERE f.kind = 'audio' AND f.gone_at IS NULL`,
      )
      .all() as {
      id: number;
      root: RootName;
      rel_path: string;
      rel_path_raw: string | null;
      size: number;
      mtime_ms: number;
      sha256: string | null;
      duration: number | null;
      codec: string | null;
      bitrate: number | null;
      sample_rate: number | null;
      chapters_json: string | null;
      has_cover: number | null;
      start_decode_ok: number | null;
      end_decode_ok: number | null;
    }[]) {
      files.set(f.id, {
        id: f.id,
        root: f.root,
        rel: f.rel_path,
        raw: f.rel_path_raw,
        size: f.size,
        mtime: f.mtime_ms,
        sha256: f.sha256,
        duration: f.duration,
        codec: f.codec,
        bitrate: f.bitrate,
        sampleRate: f.sample_rate,
        chapters: f.chapters_json ? (JSON.parse(f.chapters_json) as ChapterSpan[]) : [],
        hasCover: f.has_cover === 1,
        startOk: f.start_decode_ok,
        endOk: f.end_decode_ok,
      });
    }
    const byId = new Map<number, LoadedCopy>();
    for (const c of db
      .prepare('SELECT * FROM audio_dup_copies WHERE analysis_id = ? ORDER BY id')
      .all(analysisId) as {
      id: number;
      copy_key: string;
      book_key: string;
      kind: 'file' | 'parts' | 'library_only';
      file_ids: string;
      name: string;
      seconds: number | null;
      ai: number;
      title_key: string | null;
      volume: string | null;
      asins: string;
      abs_asins: string;
      excluded: string | null;
    }[]) {
      const ids = JSON.parse(c.file_ids) as number[];
      const fl = ids.map((id) => files.get(id)).filter((f): f is CopyFile => !!f);
      byId.set(c.id, {
        id: c.id,
        key: c.copy_key,
        bookKey: c.book_key,
        kind: c.kind,
        name: c.name,
        seconds: c.seconds,
        ai: c.ai === 1,
        titleKey: c.title_key,
        volume: c.volume,
        asins: JSON.parse(c.asins) as string[],
        absAsins: JSON.parse(c.abs_asins) as string[],
        excluded: c.excluded,
        files: fl,
      });
    }
    this.copiesCache = { analysisId, byId };
    return byId;
  }

  // -------------------------------------------------------------------------------------------
  // candidates

  private candidatesStep(p: AudioStage3Progress): number {
    const db = this.deps.db;
    const s = getSettings(db).audiobooks;
    const copies = [...this.loadCopies(p.analysisId).values()].filter((c) => !c.excluded);
    const pairs = new Map<string, { a: number; b: number; test: DupTest }>();
    const contentOf = (c: LoadedCopy) =>
      c.files.length > 0 && c.files.every((f) => f.sha256)
        ? c.files.map((f) => f.sha256).join(',')
        : null;
    const content = new Map<number, string | null>(copies.map((c) => [c.id, contentOf(c)]));
    const add = (x: LoadedCopy, y: LoadedCopy, test: DupTest) => {
      if (x.id === y.id) return;
      if (x.ai !== y.ai) return; // AI recordings never compete with human ones.
      const a = Math.min(x.id, y.id);
      const b = Math.max(x.id, y.id);
      const k = `${a}:${b}`;
      if (pairs.has(k)) return;
      const cx = content.get(x.id);
      pairs.set(k, { a, b, test: cx && cx === content.get(y.id) ? 'identical' : test });
    };
    const groupsBy = (keyOf: (c: LoadedCopy) => string[]) => {
      const m = new Map<string, LoadedCopy[]>();
      for (const c of copies)
        for (const k of keyOf(c)) {
          let l = m.get(k);
          if (!l) m.set(k, (l = []));
          l.push(c);
        }
      return m;
    };
    // Pairs inside a group of candidates: all of them for small groups, else each copy with
    // the first (the groups join through the first; enough to group, not to cross-check).
    const pairUp = (
      list: LoadedCopy[],
      test: DupTest,
      ok: (x: LoadedCopy, y: LoadedCopy) => boolean,
    ) => {
      if (list.length <= 6) {
        for (let i = 0; i < list.length; i++)
          for (let j = i + 1; j < list.length; j++)
            if (ok(list[i], list[j])) add(list[i], list[j], test);
      } else {
        for (let j = 1; j < list.length; j++) if (ok(list[0], list[j])) add(list[0], list[j], test);
      }
    };
    const any = () => true;
    // 1. identical files
    for (const [k, list] of groupsBy((c) => {
      const x = content.get(c.id);
      return x ? [x] : [];
    })) {
      if (k && list.length > 1) pairUp(list, 'identical', any);
    }
    // 2. same ASIN in the names
    for (const [, list] of groupsBy((c) => c.asins)) if (list.length > 1) pairUp(list, 'asin', any);
    // 3. same ASIN in Audiobookshelf's metadata.json (a candidate only)
    for (const [, list] of groupsBy((c) => [...c.asins, ...c.absAsins])) {
      if (list.length > 1 && list.some((c) => c.absAsins.length)) pairUp(list, 'abs_asin', any);
    }
    // 4. same title and printed volume, similar length
    const near = (x: LoadedCopy, y: LoadedCopy) =>
      x.seconds !== null &&
      y.seconds !== null &&
      Math.abs(x.seconds - y.seconds) <=
        (Math.max(x.seconds, y.seconds) * s.dupCandidatePercent) / 100;
    let tooLarge = 0;
    for (const [, list] of groupsBy((c) =>
      c.titleKey && c.titleKey.length >= 2 ? [`${c.titleKey}|${c.volume ?? ''}`] : [],
    )) {
      if (list.length < 2) continue;
      if (list.length > 40) {
        tooLarge++;
        continue;
      }
      list.sort((x, y) => (x.seconds ?? 0) - (y.seconds ?? 0));
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length && near(list[i], list[j]); j++)
          add(list[i], list[j], 'title');
    }
    // 5. files of one folder that look like full copies
    // (A folder of full copies gave one 'file' copy per file, all with the folder's book key.)
    for (const [, list] of groupsBy((c) => (c.kind === 'file' ? [c.bookKey] : []))) {
      if (list.length > 1) pairUp(list, 'in_folder', any);
    }
    const rows = [...pairs.values()];
    db.transaction(() => {
      db.prepare('DELETE FROM audio_dup_pairs WHERE analysis_id = ?').run(p.analysisId);
      const put = db.prepare(
        `INSERT INTO audio_dup_pairs (analysis_id, a_id, b_id, test, verdict)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of rows)
        put.run(p.analysisId, r.a, r.b, r.test, r.test === 'identical' ? 'same' : 'pending');
    })();
    p.pairsByTest = {};
    for (const r of rows) p.pairsByTest[r.test] = (p.pairsByTest[r.test] ?? 0) + 1;
    p.pairsByTest.title_groups_too_large = tooLarge;
    p.gateCopyIds = this.gateCopyIds(p);
    p.rulesKey = stage3SettingsKey(s);
    this.windowsCache = null;
    const need = this.neededWindows(p);
    p.windowsTotal = need.length;
    p.windowsDone = need.filter((w) => w.stored).length;
    p.windowsReused = p.windowsDone;
    p.windowErrors = 0;
    this.nextPhase(p, 'fingerprints', p.windowsDone);
    return rows.length;
  }

  /** Copies named by the labeled pairs (so the gate can be checked early). */
  private gateCopyIds(p: AudioStage3Progress): number[] {
    const labels = this.labels();
    if (!labels.labels) return [];
    const look = this.gateLookups(p);
    const ids = new Set<number>();
    for (const pair of labels.labels.pairs)
      for (const rel of [pair.fa, pair.fb]) for (const k of look.copyIdsOf(rel)) ids.add(k);
    return [...ids];
  }

  // -------------------------------------------------------------------------------------------
  // fingerprints

  private pendingPairs(p: AudioStage3Progress): PairRow[] {
    return this.deps.db
      .prepare(
        `SELECT id, a_id, b_id, test, verdict FROM audio_dup_pairs
         WHERE analysis_id = ? AND test <> 'identical' ORDER BY id`,
      )
      .all(p.analysisId) as PairRow[];
  }

  /** Every window the non-identical pairs need, gate pairs first, with whether it is stored. */
  private neededWindows(p: AudioStage3Progress): WindowNeed[] {
    const s = getSettings(this.deps.db).audiobooks;
    const key = stage3SettingsKey(s);
    if (this.windowsCache?.analysisId === p.analysisId && this.windowsCache.rulesKey === key) {
      return this.windowsCache.keys;
    }
    const copies = this.loadCopies(p.analysisId);
    const gate = new Set(p.gateCopyIds);
    const seen = new Map<string, WindowNeed>();
    const pairs = this.pendingPairs(p);
    pairs.sort(
      (x, y) =>
        Number(gate.has(y.a_id) || gate.has(y.b_id)) - Number(gate.has(x.a_id) || gate.has(x.b_id)),
    );
    for (const pr of pairs) {
      const a = copies.get(pr.a_id);
      const b = copies.get(pr.b_id);
      if (!a || !b || a.seconds === null || b.seconds === null) continue;
      const { plans } = planWindows(a.seconds, b.seconds, windowSettings(s));
      for (const plan of plans) {
        for (const [c, span] of [
          [a, plan.a],
          [b, plan.b],
        ] as const) {
          const sp = spansOf(c.files, span);
          const k = windowKey(sp, shaOfFiles(c.files));
          if (!seen.has(k)) seen.set(k, { key: k, spans: sp, stored: false, files: c.files });
        }
      }
    }
    const list = [...seen.values()];
    const stored = this.deps.db.prepare(
      'SELECT files_sig FROM audio_fingerprints WHERE win_key = ?',
    );
    for (const w of list) {
      const r = stored.get(w.key) as { files_sig: string } | undefined;
      w.stored = !!r && r.files_sig === filesSig(w);
    }
    this.windowsCache = { analysisId: p.analysisId, rulesKey: key, keys: list };
    return list;
  }

  private async fingerprintsStep(
    p: AudioStage3Progress,
    shouldStop: () => boolean,
  ): Promise<number> {
    const s = getSettings(this.deps.db).audiobooks;
    const need = this.neededWindows(p).filter((w) => !w.stored);
    if (need.length === 0) {
      this.nextPhase(p, 'compare');
      return 0;
    }
    if (this.deps.calibreBusy?.()) {
      await sleep(1000);
      return 0;
    }
    if (!this.versions) this.versions = await stage3ToolVersions(this.deps.tools);
    p.tools = this.versions;
    const put = this.deps.db.prepare(
      `INSERT INTO audio_fingerprints (win_key, files_sig, fp, items, error, tool_version, took_ms, made_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(win_key) DO UPDATE SET files_sig = excluded.files_sig, fp = excluded.fp,
         items = excluded.items, error = excluded.error, tool_version = excluded.tool_version,
         took_ms = excluded.took_ms, made_at = excluded.made_at`,
    );
    const batch = need.slice(0, Math.max(8, s.dupFingerprintWorkers * 4));
    const busy = () => shouldStop() || (this.deps.calibreBusy?.() ?? false);
    let i = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(s.dupFingerprintWorkers, batch.length) }, async () => {
        while (i < batch.length) {
          if (busy()) return;
          const w = batch[i++];
          const t0 = Date.now();
          const spans: FileSpan[] = w.spans.map((sp) => {
            const f = w.files.find((x) => x.id === sp.fileId)!;
            return {
              file: insideRoot(this.deps.roots[f.root], f.rel, f.raw),
              start: sp.start,
              length: sp.length,
            };
          });
          const total = w.spans.reduce((a, x) => a + x.length, 0);
          const r = await fingerprintSpans(spans, this.deps.tools, {
            timeoutMs: Math.max(s.toolTimeoutSeconds * 1000, total * 200),
            shouldStop: busy,
          }).catch((err: Error) => ({ fp: null, error: err.message }));
          if (busy() && !r.fp) return; // stopped mid-window: read again later
          put.run(
            w.key,
            filesSig(w),
            r.fp ? fpToBuffer(r.fp) : null,
            r.fp?.length ?? 0,
            r.error ? r.error.slice(0, 500) : null,
            this.versions?.fpcalc ?? null,
            Date.now() - t0,
            Date.now(),
          );
          w.stored = true;
          if (!r.fp) p.windowErrors++;
          p.windowsDone++;
          done++;
          this.save(p, 'analysing');
        }
      }),
    );
    return done;
  }

  // -------------------------------------------------------------------------------------------
  // compare

  /**
   * Scores pairs in chunks of COMPARE_CHUNK (each pair is up to a few million bit comparisons;
   * the server answers requests between chunks: WP20 lessons (3)).
   */
  private compareStep(p: AudioStage3Progress): number {
    const db = this.deps.db;
    const s = getSettings(db).audiobooks;
    const copies = this.loadCopies(p.analysisId);
    const fpOf = db.prepare('SELECT fp, error FROM audio_fingerprints WHERE win_key = ?');
    const key0 = stage3SettingsKey(s);
    const pairs = db
      .prepare(
        `SELECT id, a_id, b_id, test, verdict FROM audio_dup_pairs
         WHERE analysis_id = ? AND test <> 'identical' AND (rules_key IS NULL OR rules_key <> ?)
         ORDER BY id LIMIT ${COMPARE_CHUNK}`,
      )
      .all(p.analysisId, key0) as PairRow[];
    if (pairs.length === 0) {
      this.nextPhase(p, 'decode');
      return 0;
    }
    const set = db.prepare(
      `UPDATE audio_dup_pairs SET verdict = ?, fp_verdict = ?, scores_json = ?, length_diff = ?,
         detail = ?, rules_key = ? WHERE id = ?`,
    );
    const key = stage3SettingsKey(s);
    const results: unknown[][] = [];
    for (const pr of pairs) {
      const a = copies.get(pr.a_id)!;
      const b = copies.get(pr.b_id)!;
      const diff = a.seconds !== null && b.seconds !== null ? b.seconds - a.seconds : null;
      const scores: WindowScore[] = [];
      let skipped: { name: string; reason: string }[] = [];
      if (a.seconds !== null && b.seconds !== null) {
        const plan = planWindows(a.seconds, b.seconds, windowSettings(s));
        skipped = plan.skipped;
        for (const w of plan.plans) {
          const fa = fpOf.get(windowKey(spansOf(a.files, w.a), shaOfFiles(a.files))) as
            | { fp: Buffer | null }
            | undefined;
          const fb = fpOf.get(windowKey(spansOf(b.files, w.b), shaOfFiles(b.files))) as
            | { fp: Buffer | null }
            | undefined;
          if (!fa?.fp || !fb?.fp) {
            scores.push({ name: w.name, score: null, shiftSeconds: null, reason: 'not read' });
            continue;
          }
          scores.push(scoreWindow(w, fpFromBuffer(fa.fp), fpFromBuffer(fb.fp)));
        }
      }
      const fv = fingerprintVerdict(scores, s.dupSameScore);
      const { verdict, detail } = pairVerdict(pr.test, fv, diff, s);
      results.push([
        verdict,
        fv,
        JSON.stringify({ windows: scores, skipped }),
        diff,
        detail,
        key,
        pr.id,
      ]);
    }
    db.transaction(() => {
      for (const r of results) set.run(...r);
    })();
    return pairs.length;
  }

  // -------------------------------------------------------------------------------------------
  // groups (used by decode and decide)

  private grouping(p: AudioStage3Progress) {
    const db = this.deps.db;
    const copies = this.loadCopies(p.analysisId);
    const ids = [...copies.keys()];
    const index = new Map(ids.map((id, i) => [id, i]));
    const pairs = db
      .prepare(
        `SELECT id, a_id, b_id, test, verdict FROM audio_dup_pairs WHERE analysis_id = ? AND verdict <> 'pending'`,
      )
      .all(p.analysisId) as PairRow[];
    const edges: Edge[] = [];
    for (const pr of pairs) {
      const a = index.get(pr.a_id);
      const b = index.get(pr.b_id);
      if (a === undefined || b === undefined) continue;
      edges.push({ a, b, test: pr.test, verdict: pr.verdict as Edge['verdict'] });
    }
    const g = groupCopies(ids.length, edges);
    return { copies, ids, g, pairs };
  }

  /**
   * The full decodes stored for a file, or for a byte-identical file (same SHA-256): a content
   * is decoded once. Only decodes of files unchanged since (size and mtime) count.
   */
  storedDecodes(f: CopyFile): {
    decoder: string;
    ok: number | null;
    detail: string | null;
    decoded_seconds: number | null;
  }[] {
    return this.deps.db
      .prepare(
        `SELECT d.decoder, d.ok, d.detail, d.decoded_seconds FROM audio_full_decodes d
         JOIN audio_files f2 ON f2.id = d.file_id
         WHERE d.file_id = @id AND d.size = @size AND d.mtime_ms = @mtime
         UNION ALL
         SELECT d.decoder, d.ok, d.detail, d.decoded_seconds FROM audio_files f2
         JOIN audio_full_decodes d ON d.file_id = f2.id
         WHERE @sha IS NOT NULL AND f2.sha256 = @sha AND f2.id <> @id AND f2.size = @size
           AND d.size = f2.size AND d.mtime_ms = f2.mtime_ms`,
      )
      .all({ id: f.id, size: f.size, mtime: f.mtime, sha: f.sha256 }) as {
      decoder: string;
      ok: number | null;
      detail: string | null;
      decoded_seconds: number | null;
    }[];
  }

  /** What rule 0 knows about a copy now (stage 2's plays and the full decodes stored so far). */
  private damageOf(c: LoadedCopy): { damage: CopyFacts['damage']; detail: string | null } {
    let worst: CopyFacts['damage'] = null;
    const details: string[] = [];
    const rank = { ok: 1, suspect: 2, damaged: 3 } as const;
    for (const f of c.files) {
      const rows = this.storedDecodes(f).filter((r) => r.ok !== null);
      const ff = rows.find((r) => r.decoder === 'ffmpeg');
      const fa = rows.find((r) => r.decoder === 'faad');
      let d: CopyFacts['damage'] = null;
      const playFailed = f.startOk === 0 || f.endOk === 0;
      if (ff?.ok === 1) d = 'ok';
      else if (ff?.ok === 0) {
        if (f.codec === 'aac') d = fa ? (fa.ok === 0 ? 'damaged' : 'suspect') : 'suspect';
        else d = 'damaged';
        details.push(
          `${f.rel.split('/').pop()}: ffmpeg ${ff.detail ?? 'errors'}${fa ? `; faad2 ${fa.ok ? 'clean' : (fa.detail ?? 'failed')}` : ''}`,
        );
      } else if (playFailed) {
        d = 'suspect';
        details.push(`${f.rel.split('/').pop()}: the start or the end did not play (stage 2)`);
      }
      if (d && (!worst || rank[d] > rank[worst])) worst = d;
    }
    return { damage: worst, detail: details.length ? details.join('; ').slice(0, 600) : null };
  }

  factsOf(c: LoadedCopy): CopyFacts {
    const codecs = [...new Set(c.files.map((f) => f.codec ?? '?'))];
    let weighted = 0;
    let secs = 0;
    for (const f of c.files) {
      if (f.bitrate && f.duration) {
        weighted += f.bitrate * f.duration;
        secs += f.duration;
      }
    }
    const chapters: ChapterSpan[] = [];
    let t = 0;
    for (const f of c.files) {
      for (const ch of f.chapters) chapters.push({ start: ch.start + t, end: ch.end + t });
      t += f.duration ?? 0;
    }
    const dmg = this.damageOf(c);
    return {
      key: c.key,
      path: c.files[0]?.rel ?? c.key,
      files: c.files.length,
      seconds: c.seconds,
      codec: codecs.length === 1 ? (codecs[0] === '?' ? null : codecs[0]) : 'mixed',
      bitrate: secs > 0 ? weighted / secs : null,
      sampleRate: c.files[0]?.sampleRate ?? null,
      chapters,
      hasCover: c.files[0]?.hasCover ?? false,
      asinInName: c.asins.length > 0,
      damage: dmg.damage,
      damageDetail: dmg.detail,
    };
  }

  // -------------------------------------------------------------------------------------------
  // decode

  /** The next files to fully decode (ffmpeg first; faad2 where ffmpeg reported problems). */
  private decodeQueue(p: AudioStage3Progress): { file: CopyFile; decoder: 'ffmpeg' | 'faad' }[] {
    const db = this.deps.db;
    const s = getSettings(db).audiobooks;
    const rs = ruleSettings(s);
    const { copies, ids, g } = this.grouping(p);
    const has = (f: CopyFile, d: 'ffmpeg' | 'faad') =>
      this.storedDecodes(f).some((r) => r.decoder === d);
    const failed = (f: CopyFile) =>
      this.storedDecodes(f).some((r) => r.decoder === 'ffmpeg' && r.ok === 0);
    const out: { file: CopyFile; decoder: 'ffmpeg' | 'faad' }[] = [];
    const seen = new Set<string>();
    const want = (f: CopyFile) => {
      if (!has(f, 'ffmpeg')) {
        if (!seen.has(`${f.id}:ffmpeg`)) out.push({ file: f, decoder: 'ffmpeg' });
        seen.add(`${f.id}:ffmpeg`);
      } else if (failed(f) && f.codec === 'aac' && !has(f, 'faad')) {
        if (!seen.has(`${f.id}:faad`)) out.push({ file: f, decoder: 'faad' });
        seen.add(`${f.id}:faad`);
      }
    };
    // Every file stage 2 found damaged, in any copy that takes part (the report asks for them).
    for (const c of copies.values()) {
      if (c.excluded) continue;
      for (const f of c.files) if (f.startOk === 0 || f.endOk === 0) want(f);
    }
    // The chosen copy of each group (and the next one when it turns out damaged); every copy
    // of a group that goes to review.
    for (const comp of g.components) {
      const members = comp.members.map((i) => copies.get(ids[i])!);
      const distinct = distinctContents(members);
      if (distinct.length < 2) continue;
      const facts = distinct.map((c) => this.factsOf(c));
      const d = decideGroup(facts, rs);
      if (d.review || comp.conflict) {
        for (const c of distinct) for (const f of c.files) want(f);
      } else {
        const best = distinct.find((c) => c.key === d.best)!;
        for (const f of best.files) want(f);
      }
    }
    for (const e of g.unsure) {
      for (const c of [copies.get(ids[e.a])!, copies.get(ids[e.b])!])
        for (const f of c.files) want(f);
    }
    return out;
  }

  private async decodeStep(p: AudioStage3Progress, shouldStop: () => boolean): Promise<number> {
    const db = this.deps.db;
    const s = getSettings(db).audiobooks;
    const queue = this.decodeQueue(p);
    if (queue.length === 0) {
      this.deps.lock.release(OWNER);
      this.nextPhase(p, 'decide');
      return 0;
    }
    if (!(await this.deps.lock.acquire(OWNER, 'audio', shouldStop))) return 0;
    if (!this.versions) this.versions = await stage3ToolVersions(this.deps.tools);
    p.tools = this.versions;
    const put = db.prepare(
      `INSERT INTO audio_full_decodes (file_id, decoder, size, mtime_ms, ok, error_count,
         decoded_seconds, expected_seconds, detail, tool_version, took_ms, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id, decoder) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
         ok = excluded.ok, error_count = excluded.error_count, decoded_seconds = excluded.decoded_seconds,
         expected_seconds = excluded.expected_seconds, detail = excluded.detail,
         tool_version = excluded.tool_version, took_ms = excluded.took_ms, checked_at = excluded.checked_at`,
    );
    const yieldNow = () => shouldStop() || this.deps.lock.shouldYield(OWNER);
    const batch = queue.slice(0, s.dupDecodeWorkers);
    let done = 0;
    await Promise.all(
      batch.map(async (q) => {
        if (yieldNow()) return;
        const file = insideRoot(this.deps.roots[q.file.root], q.file.rel, q.file.raw);
        const expected = q.file.duration ?? 0;
        const timeoutMs = Math.max(s.toolTimeoutSeconds * 1000, expected * 1000);
        const r =
          q.decoder === 'ffmpeg'
            ? await decodeWithFfmpeg(file, this.deps.tools, { timeoutMs, shouldStop: yieldNow })
            : await decodeWithFaad(file, this.deps.tools, {
                expectedSeconds: expected,
                timeoutMs,
                shouldStop: yieldNow,
              });
        if (r.ok === null && !r.detail) return; // gave the disk away: decoded again later
        put.run(
          q.file.id,
          q.decoder,
          q.file.size,
          q.file.mtime,
          r.ok === null ? null : r.ok ? 1 : 0,
          r.errorCount,
          r.decodedSeconds,
          expected,
          r.detail,
          q.decoder === 'ffmpeg' ? (this.versions?.ffmpeg ?? null) : (this.versions?.faad ?? null),
          r.tookMs,
          Date.now(),
        );
        done++;
        p.decodesDone++;
        this.save(p, 'analysing');
      }),
    );
    if (yieldNow()) {
      p.yields++;
      this.deps.lock.release(OWNER);
    }
    return done;
  }

  // -------------------------------------------------------------------------------------------
  // decide

  private decideStep(p: AudioStage3Progress): number {
    const db = this.deps.db;
    const s = getSettings(db).audiobooks;
    const rs = ruleSettings(s);
    const { copies, ids, g } = this.grouping(p);
    const key = stage3SettingsKey(s);
    const groupRows: {
      key: string;
      kind: 'group' | 'unsure';
      firstTest: string;
      tests: string[];
      members: LoadedCopy[];
      best: LoadedCopy;
      rule: string;
      outcome: 'auto' | 'review';
      review: string | null;
      conflicts: unknown;
      damaged: boolean;
      ranks: { c: LoadedCopy; rank: number; role: 'keep' | 'drop' | 'review'; against: unknown }[];
    }[] = [];
    for (const comp of g.components) {
      const members = comp.members.map((i) => copies.get(ids[i])!);
      const distinct = distinctContents(members);
      const factsByKey = new Map(distinct.map((c) => [c.key, this.factsOf(c)]));
      let best: LoadedCopy;
      let rule: string;
      let review: string | null = null;
      let conflicts: unknown = null;
      const order: LoadedCopy[] = [];
      const against = new Map<string, unknown>();
      if (distinct.length < 2) {
        best = canonical(members);
        rule = 'identical';
        order.push(best, ...members.filter((m) => m !== best));
      } else {
        const d = decideGroup([...factsByKey.values()], rs);
        best = distinct.find((c) => c.key === d.best)!;
        rule = String(d.rule);
        review = d.review;
        conflicts = d.against.map((r) => ({
          other: r.other,
          rule: r.rule,
          conflicts: r.conflicts,
          review: r.review,
        }));
        for (const r of d.against) against.set(r.other, r);
        // Ranked: the best, then the others by how they compare with each other.
        const rest = distinct.filter((c) => c !== best);
        rest.sort((x, y) => {
          const r = comparePair(factsByKey.get(x.key)!, factsByKey.get(y.key)!, rs);
          return r.best === x.key ? -1 : 1;
        });
        // Identical copies sit right after the content they repeat.
        for (const c of [best, ...rest]) {
          order.push(c);
          for (const m of members)
            if (m !== c && !order.includes(m) && sameContent(m, c)) order.push(m);
        }
      }
      if (comp.conflict) {
        review = [review, 'two of these copies were measured as different recordings']
          .filter(Boolean)
          .join('; ');
      }
      const outcome: 'auto' | 'review' = review ? 'review' : 'auto';
      groupRows.push({
        key: groupKey(members.map((m) => m.key)),
        kind: 'group',
        firstTest: comp.firstTest,
        tests: comp.tests,
        members,
        best,
        rule,
        outcome,
        review,
        conflicts,
        damaged: [...factsByKey.values()].some((f) => f.damage === 'damaged'),
        ranks: order.map((c, i) => ({
          c,
          rank: i,
          role: outcome === 'review' ? 'review' : i === 0 ? 'keep' : 'drop',
          against: against.get(c.key) ?? null,
        })),
      });
    }
    const testOf = new Map<string, string>();
    for (const pr of db
      .prepare(
        `SELECT a_id, b_id, test, detail FROM audio_dup_pairs WHERE analysis_id = ? AND verdict = 'unsure'`,
      )
      .all(p.analysisId) as { a_id: number; b_id: number; test: string; detail: string | null }[]) {
      testOf.set(`${pr.a_id}:${pr.b_id}`, `${pr.test}|${pr.detail ?? ''}`);
    }
    for (const e of g.unsure) {
      const a = copies.get(ids[e.a])!;
      const b = copies.get(ids[e.b])!;
      const r = comparePair(this.factsOf(a), this.factsOf(b), rs);
      const best = r.best === a.key ? a : b;
      const other = best === a ? b : a;
      const [test, detail] = (
        testOf.get(`${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`) ?? `${e.test}|`
      ).split('|');
      groupRows.push({
        key: groupKey([a.key, b.key]),
        kind: 'unsure',
        firstTest: test,
        tests: [test],
        members: [a, b],
        best,
        rule: String(r.rule),
        outcome: 'review',
        review: `not sure it is the same recording: ${detail || 'the windows disagree'}`,
        conflicts: [{ other: other.key, rule: r.rule, conflicts: r.conflicts, review: r.review }],
        damaged: false,
        ranks: [
          { c: best, rank: 0, role: 'review', against: null },
          { c: other, rank: 1, role: 'review', against: r },
        ],
      });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM audio_dup_groups WHERE analysis_id = ?').run(p.analysisId);
      const putG = db.prepare(
        `INSERT INTO audio_dup_groups (analysis_id, group_key, kind, first_test, tests_json, members,
           best_copy_id, rule, outcome, review_reason, conflicts_json, damaged, rules_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const putM = db.prepare(
        `INSERT INTO audio_dup_members (group_id, copy_id, rank, role, against_json) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of groupRows) {
        const res = putG.run(
          p.analysisId,
          r.key,
          r.kind,
          r.firstTest,
          JSON.stringify(r.tests),
          r.members.length,
          r.best.id,
          r.rule,
          r.outcome,
          r.review ? r.review.slice(0, 1000) : null,
          r.conflicts === null ? null : JSON.stringify(r.conflicts),
          r.damaged ? 1 : 0,
          key,
        );
        const gid = Number(res.lastInsertRowid);
        for (const m of r.ranks)
          putM.run(gid, m.c.id, m.rank, m.role, m.against ? JSON.stringify(m.against) : null);
      }
    })();
    p.gate = this.evaluateGate(p);
    p.counts = stage3Counts(db, p.analysisId);
    p.rulesKey = key;
    p.phase = 'done';
    p.finishedAt = Date.now();
    this.deps.log?.(`Audiobooks stage 3: done (${JSON.stringify(p.counts)})`);
    return groupRows.length;
  }

  // -------------------------------------------------------------------------------------------
  // gate

  private labels(): { labels: LabelsFile | null; error: string | null } {
    const r = this.deps.readLabels?.() ?? { text: null, error: 'The labeled pairs are not set up' };
    if (!r.text) return { labels: null, error: r.error ?? 'The labeled pairs can’t be read' };
    try {
      const j = JSON.parse(r.text) as { pairs?: unknown };
      if (!Array.isArray(j.pairs))
        return { labels: null, error: 'The labeled pairs file has no "pairs"' };
      return { labels: { pairs: j.pairs as LabelsFile['pairs'] }, error: null };
    } catch (err) {
      return { labels: null, error: `The labeled pairs can’t be read: ${(err as Error).message}` };
    }
  }

  private gateLookups(p: AudioStage3Progress) {
    const db = this.deps.db;
    const copies = this.loadCopies(p.analysisId);
    const byFile = new Map<number, number[]>();
    for (const c of copies.values())
      for (const f of c.files) {
        let l = byFile.get(f.id);
        if (!l) byFile.set(f.id, (l = []));
        l.push(c.id);
      }
    const lib = db.prepare(
      `SELECT f.id, c.class, c.original_file_ids FROM audio_files f
       LEFT JOIN audio_identity c ON c.file_id = f.id AND c.analysis_id = ?
       WHERE f.root = 'library' AND f.rel_path = ? AND f.gone_at IS NULL`,
    );
    const copyIdsOf = (rel: string): number[] => {
      const r = lib.get(p.stage1Id, rel) as
        | { id: number; class: string | null; original_file_ids: string | null }
        | undefined;
      if (!r) return [];
      const files = r.original_file_ids ? (JSON.parse(r.original_file_ids) as number[]) : [r.id];
      return [...new Set(files.flatMap((id) => byFile.get(id) ?? []))];
    };
    return { copies, copyIdsOf };
  }

  private evaluateGate(p: AudioStage3Progress): GateResult {
    const labels = this.labels();
    const empty: GateResult = {
      passed: false,
      checked: 0,
      correct: 0,
      sameChecked: 0,
      sameCorrect: 0,
      bestChecked: 0,
      bestCorrect: 0,
      skipped: 0,
      misses: [],
      results: [],
      error: labels.error,
    };
    if (!labels.labels) return empty;
    const db = this.deps.db;
    const { copies, copyIdsOf } = this.gateLookups(p);
    const member = db.prepare(
      `SELECT g.group_key, g.outcome, g.kind, m.rank FROM audio_dup_members m
       JOIN audio_dup_groups g ON g.id = m.group_id
       WHERE m.copy_id = ? AND g.analysis_id = ?`,
    );
    const keyOf = (id: number) => copies.get(id)?.key ?? String(id);
    const idOfKey = new Map([...copies.values()].map((c) => [c.key, c.id]));
    const result = scoreGate(labels.labels, {
      copiesOf: (rel) => copyIdsOf(rel).map(keyOf),
      groupOf: (k) => {
        const id = idOfKey.get(k);
        if (id === undefined) return null;
        const rows = member.all(id, p.analysisId) as {
          group_key: string;
          outcome: 'auto' | 'review';
          kind: string;
          rank: number;
        }[];
        const r = rows.find((x) => x.kind === 'group');
        return r ? { key: r.group_key, outcome: r.outcome, rank: r.rank } : null;
      },
      unsurePair: (a, b) => {
        const ia = idOfKey.get(a);
        const ib = idOfKey.get(b);
        if (ia === undefined || ib === undefined) return false;
        const ga = (member.all(ia, p.analysisId) as { group_key: string; kind: string }[]).filter(
          (r) => r.kind === 'unsure',
        );
        const gb = new Set(
          (member.all(ib, p.analysisId) as { group_key: string; kind: string }[])
            .filter((r) => r.kind === 'unsure')
            .map((r) => r.group_key),
        );
        return ga.some((r) => gb.has(r.group_key));
      },
    });
    return { ...result, results: result.results };
  }
}

interface WindowNeed {
  key: string;
  spans: { fileId: number; start: number; length: number }[];
  stored: boolean;
  files: CopyFile[];
}

/** What a stored window was read from: the content when hashed, else the file as it was. */
function filesSig(w: WindowNeed): string {
  return w.spans
    .map((sp) => {
      const f = w.files.find((x) => x.id === sp.fileId)!;
      return f.sha256 ? `sha:${f.sha256}` : `${f.id}:${f.size}:${f.mtime}`;
    })
    .join(',');
}

function shaOfFiles(files: CopyFile[]): (id: number) => string | null {
  return (id) => files.find((f) => f.id === id)?.sha256 ?? null;
}

function windowSettings(s: AudiobookSettings) {
  return {
    windowSeconds: s.dupWindowSeconds,
    shiftSeconds: s.dupShiftSeconds,
    middleSearchMinutes: s.dupMiddleSearchMinutes,
  };
}

/** A pair's verdict from its test, the fingerprints and the lengths. */
export function pairVerdict(
  test: DupTest,
  fv: ReturnType<typeof fingerprintVerdict>,
  lengthDiff: number | null,
  s: Pick<AudiobookSettings, 'dupAsinToleranceSeconds'>,
): { verdict: 'same' | 'different' | 'unsure'; detail: string | null } {
  if (fv === 'same') return { verdict: 'same', detail: null };
  if (test === 'asin') {
    if (fv === 'different') {
      return { verdict: 'unsure', detail: 'same ASIN in the names, but the audio differs' };
    }
    if (
      fv === 'unknown' &&
      lengthDiff !== null &&
      Math.abs(lengthDiff) <= s.dupAsinToleranceSeconds
    ) {
      return { verdict: 'same', detail: 'same ASIN and length (the audio could not be compared)' };
    }
    return {
      verdict: 'unsure',
      detail:
        fv === 'partly'
          ? 'same ASIN, but only some windows match'
          : 'same ASIN, but the audio could not be compared',
    };
  }
  if (fv === 'different') return { verdict: 'different', detail: null };
  return {
    verdict: 'unsure',
    detail: fv === 'partly' ? 'only some windows match' : 'the audio could not be compared',
  };
}

/** One copy per distinct content (identical files count once). */
function distinctContents(members: LoadedCopy[]): LoadedCopy[] {
  const out: LoadedCopy[] = [];
  for (const m of members) if (!out.some((o) => sameContent(o, m))) out.push(m);
  // The representative of identical copies: the canonical one.
  return out.map((o) => canonical(members.filter((m) => sameContent(m, o))));
}

function sameContent(a: LoadedCopy, b: LoadedCopy): boolean {
  if (a === b) return true;
  if (a.files.length !== b.files.length || a.files.length === 0) return false;
  return a.files.every((f, i) => f.sha256 !== null && f.sha256 === b.files[i].sha256);
}

/** Among identical copies: the one with an ASIN in its name, then the first by path. */
function canonical(list: LoadedCopy[]): LoadedCopy {
  return [...list].sort(
    (x, y) =>
      Number(y.asins.length > 0) - Number(x.asins.length > 0) ||
      (x.files[0]?.rel ?? x.key).localeCompare(y.files[0]?.rel ?? y.key),
  )[0];
}

/** Counts for the page and the report. */
export function stage3Counts(db: Database.Database, analysisId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const one = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0;
  out.copies = one('SELECT COUNT(*) AS n FROM audio_dup_copies WHERE analysis_id = ?', analysisId);
  out.excluded = one(
    'SELECT COUNT(*) AS n FROM audio_dup_copies WHERE analysis_id = ? AND excluded IS NOT NULL',
    analysisId,
  );
  for (const r of db
    .prepare(
      `SELECT test || '.' || verdict AS k, COUNT(*) AS n FROM audio_dup_pairs WHERE analysis_id = ? GROUP BY k`,
    )
    .all(analysisId) as { k: string; n: number }[])
    out[`pairs.${r.k}`] = r.n;
  for (const r of db
    .prepare(
      `SELECT kind || '.' || first_test || '.' || outcome AS k, COUNT(*) AS n, SUM(members) AS m
       FROM audio_dup_groups WHERE analysis_id = ? GROUP BY k`,
    )
    .all(analysisId) as { k: string; n: number; m: number }[]) {
    out[`groups.${r.k}`] = r.n;
    out[`copies_in.${r.k}`] = r.m;
  }
  for (const r of db
    .prepare(
      `SELECT outcome || '.rule.' || COALESCE(rule, '-') AS k, COUNT(*) AS n FROM audio_dup_groups
       WHERE analysis_id = ? AND kind = 'group' GROUP BY k`,
    )
    .all(analysisId) as { k: string; n: number }[])
    out[`decisions.${r.k}`] = r.n;
  out.review = one(
    `SELECT COUNT(*) AS n FROM audio_dup_groups WHERE analysis_id = ? AND outcome = 'review'`,
    analysisId,
  );
  out.dropped = one(
    `SELECT COUNT(*) AS n FROM audio_dup_members m JOIN audio_dup_groups g ON g.id = m.group_id
     WHERE g.analysis_id = ? AND m.role = 'drop'`,
    analysisId,
  );
  out.damaged_groups = one(
    `SELECT COUNT(*) AS n FROM audio_dup_groups WHERE analysis_id = ? AND damaged = 1`,
    analysisId,
  );
  const dec = db
    .prepare(
      `SELECT decoder, SUM(ok = 1) AS ok, SUM(ok = 0) AS bad, COUNT(*) AS n FROM audio_full_decodes GROUP BY decoder`,
    )
    .all() as { decoder: string; ok: number; bad: number; n: number }[];
  for (const d of dec) {
    out[`decodes.${d.decoder}.clean`] = d.ok ?? 0;
    out[`decodes.${d.decoder}.errors`] = d.bad ?? 0;
  }
  return out;
}
