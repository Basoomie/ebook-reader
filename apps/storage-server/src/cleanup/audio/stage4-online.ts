/**
 * Audiobook stage 4: online sources (WP21c, plan section 6). Analysis only: lookups go through
 * the shared fetch queue (WP20d's container and its pace), results into cleanup.db; nothing is
 * written to the audiobook folders or to Audiobookshelf. Choosing field values is WP21d's.
 *
 * Phases (resumable; each saves before the next starts):
 *   units    one lookup per recording: the copies stage 3 proved the same recording share one,
 *            every other copy (review groups, unsure pairs, different recordings) has its own.
 *            AI books and the radio clips have no store record by nature: no requests.
 *   lookups  each unit, in the decided order, until a step gives an automatic match:
 *              1. the ASINs in the torrent names (Audible's product API),
 *              2. ASINs in Audiobookshelf's metadata.json (candidates only),
 *              3. Audible's title search: the torrent names' titles and their variants, the
 *                 whole book's title for a recording in several files; a keyword search last,
 *              4. kikubon (its id in the name, else its search) and 5. audiobook.jp (its search;
 *                 an id in the name is one more candidate, a hint only), asked side by side and
 *                 taken in this order,
 *              6. otherwise unknown (not found).
 *            A unit is advanced again from the start whenever one of its requests is answered
 *            (answered requests come straight from the queue's cache), so a restart or a
 *            settings change decides again without fetching anything twice.
 *            Editions that only the narrator or the audio tells apart: the recording's opening
 *            (read under the shared disk lock, giving way to Calibre) is fingerprinted and
 *            compared with each store's sample audio.
 *   gate     the labeled books (labels.json "books").
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings, type AudiobookSettings, AUDIO_FETCH_SITES } from '../settings';
import { LABELED_PRIORITY, type FetchQueue } from '../stage4/queue';
import { insideRoot } from './audio-source-fs';
import { getAudioStage, updateAudioStage } from './audio-stages';
import { idsInNames, type RootName } from './book-units';
import { bestAlignment, fpFromBuffer, fpToBuffer, secondsToItems } from './dup-fingerprint';
import { printedVolume } from './dup-names';
import {
  dramaNumber,
  evaluate,
  hitWorthReading,
  isDrama,
  rankEvaluation,
  reviewReason,
  titlesAgree,
  type Evaluation,
  type MatchSettings,
  type UnitFacts,
} from './online-match';
import {
  authorFromName,
  meaningless,
  peopleFromTags,
  searchTitle,
  titleVariants,
  type FileTags,
} from './online-names';
import {
  parseAbjpProduct,
  parseAbjpSearch,
  parseAudibleProduct,
  parseAudibleSample,
  parseAudibleSearch,
  parseKikubonProduct,
  parseKikubonSearch,
  type SearchHit,
  type StoreRecord,
  type StoreSource,
} from './online-pages';
import {
  abjpProduct,
  abjpSampleAudio,
  abjpSearch,
  audibleProduct,
  audibleSampleAudio,
  audibleSampleInfo,
  audibleSearch,
  kikubonProduct,
  kikubonSearch,
  type OnlineRequest,
} from './online-requests';
import {
  scoreOnlineGate,
  type LabeledBook,
  type OnlineGateResult,
  type UnitOutcome,
} from './online-gate';
import { fingerprintBytes, fingerprintSpans, type FileSpan, type ToolPaths } from './probe';
import { spansOf, windowKey, type AudioStage3, type LoadedCopy } from './stage3-dups';
import type { AudioRoots } from './walk';

export const STAGE4 = 4;
const OWNER = DISK_OWNERS.audio4;
/** Units advanced per step (the server answers requests between steps). */
const ADVANCE_CHUNK = 100;
/** At most this many name ASINs and ABS ASINs are asked per unit. */
const MAX_ASINS = 4;
/** Search titles per unit (refsample.py: 3). */
const MAX_QUERIES = 3;

/**
 * The version of stage 4's rules: raised when a code change can change the decisions, so the
 * stage decides again from the stored answers.
 */
export const STAGE4_RULES_VERSION = 1;

export type Stage4Phase = 'units' | 'lookups' | 'gate' | 'done';

export interface PhaseTime {
  ms: number;
  items: number;
}

export interface AudioStage4Progress {
  analysisId: string;
  phase: Stage4Phase;
  startedAt: number;
  finishedAt: number | null;
  /** The stage-3 analysis the units come from (a new one starts stage 4 over). */
  stage3Id: string | null;
  /** The settings the decisions were made with (a change decides again, nothing re-read). */
  rulesKey: string | null;
  units: number;
  lookupUnits: number;
  noRecordUnits: number;
  labeledUnits: number;
  decided: number;
  openingsRead: number;
  openingErrors: number;
  samplesRead: number;
  sampleErrors: number;
  /** Times the opening reads gave the disk to a Calibre job. */
  yields: number;
  phaseStartedAt: number;
  phaseStartDone: number;
  phaseTimes: Record<string, PhaseTime>;
  counts: Record<string, number> | null;
  gate: OnlineGateResult | null;
  error: string | null;
}

export function emptyStage4(now = Date.now()): AudioStage4Progress {
  return {
    analysisId: randomUUID(),
    phase: 'units',
    startedAt: now,
    finishedAt: null,
    stage3Id: null,
    rulesKey: null,
    units: 0,
    lookupUnits: 0,
    noRecordUnits: 0,
    labeledUnits: 0,
    decided: 0,
    openingsRead: 0,
    openingErrors: 0,
    samplesRead: 0,
    sampleErrors: 0,
    yields: 0,
    phaseStartedAt: now,
    phaseStartDone: 0,
    phaseTimes: {},
    counts: null,
    gate: null,
    error: null,
  };
}

/** The settings stage 4's decisions depend on. */
export function stage4SettingsKey(s: AudiobookSettings): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        STAGE4_RULES_VERSION,
        s.onlineRuntimeMinutes,
        s.onlineTitleScore,
        s.onlineSearchProducts,
        s.onlineStorePages,
        s.onlineOpeningSeconds,
        s.noStoreRecordFolders,
        s.dupSameScore,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

export interface Stage4Deps {
  db: Database.Database;
  roots: AudioRoots;
  tools: ToolPaths;
  lock: DiskLock;
  queue: FetchQueue;
  stage3: AudioStage3;
  calibreBusy?: () => boolean;
  /** labels.json as text, or why it can't be read. */
  readLabels?: () => { text: string | null; error: string | null };
  log?: (m: string) => void;
}

/** One file of the recording whose opening is read (the representative copy's). */
interface OpeningFile {
  id: number;
  root: RootName;
  rel: string;
  raw: string | null;
  size: number;
  mtime: number;
  sha256: string | null;
  duration: number | null;
}

/** What a unit is looked up with (stored as inputs_json). */
export interface UnitInputs {
  facts: UnitFacts;
  queries: string[];
  asins: string[];
  absAsins: string[];
  kikubon: string | null;
  audiobookJp: string | null;
  paths: string[];
  opening: OpeningFile[];
}

export type UnitClass = 'auto' | 'review' | 'unknown' | 'none_expected';

interface Cand {
  rec: StoreRecord;
  via: string;
  requestId: number | null;
  ev: Evaluation;
  sampleScore?: number | null;
}

type Advance =
  | { kind: 'waiting'; waits: { id: number; step: string }[] }
  | { kind: 'needs'; opening: boolean; samples: { id: number; url: string }[] }
  | {
      kind: 'decided';
      cls: Exclude<UnitClass, 'none_expected'>;
      best: Cand | null;
      reason: string | null;
      detail: string | null;
      cands: Cand[];
    };

const recordName = (r: { source: StoreSource; id: string }) => `${r.source}:${r.id}`;

/** A search result as a record (what the search page showed; no product page). */
function hitRecord(h: SearchHit): StoreRecord {
  return {
    source: h.source,
    id: h.id,
    title: h.title,
    subtitle: null,
    authors: h.authors,
    narrators: h.narrators,
    seconds: h.seconds,
    publisher: null,
    releaseDate: null,
    series: [],
    extra: { fromSearchPage: true },
  };
}

function gz(v: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(v), 'utf8'));
}

export function ungzRecord(b: Buffer): StoreRecord {
  return JSON.parse(gunzipSync(b).toString('utf8')) as StoreRecord;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The opening's fingerprint key: the files read (by content) and the seconds. */
function openingKey(files: OpeningFile[], seconds: number): string {
  const spans = spansOf(files, { start: 0, length: seconds });
  return `opening:${windowKey(spans, (id) => files.find((f) => f.id === id)?.sha256 ?? null)}`;
}

function openingSig(files: OpeningFile[]): string {
  return JSON.stringify(files.map((f) => [f.id, f.size, f.mtime]));
}

const sampleKey = (url: string) => `sample:${url}`;

export class AudioStage4 {
  /** Parsed answers by request id (the cache files are brotli: parse each once). */
  private parsed = new Map<number, unknown>();
  private labelsCache: { at: number; books: LabeledBook[] | null; error: string | null } | null =
    null;

  constructor(private readonly deps: Stage4Deps) {}

  private get db(): Database.Database {
    return this.deps.db;
  }

  progress(): AudioStage4Progress | null {
    const p = getAudioStage(this.db, STAGE4).progress as unknown as AudioStage4Progress;
    return p && typeof p.analysisId === 'string' ? p : null;
  }

  private save(p: AudioStage4Progress, state?: string): void {
    updateAudioStage(this.db, STAGE4, {
      progress: p as unknown as Record<string, unknown>,
      ...(state ? { state } : {}),
    });
  }

  restart(): AudioStage4Progress {
    const p = emptyStage4();
    this.parsed.clear();
    this.save(p, 'analysing');
    return p;
  }

  /** Back to the lookups (settings changed): every unit is advanced again from its answers. */
  redecide(): void {
    const p = this.progress();
    if (!p || p.phase === 'units') return;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE audio_online_units SET state = 'planned', class = NULL, source = NULL, store_id = NULL,
           review_reason = NULL, detail = NULL, updated_at = ? WHERE analysis_id = ? AND kind = 'lookup'`,
      )
      .run(now, p.analysisId);
    p.phase = 'lookups';
    p.finishedAt = null;
    p.gate = null;
    p.counts = null;
    p.decided = this.count(p, `kind = 'none_expected'`);
    p.rulesKey = stage4SettingsKey(getSettings(this.db).audiobooks);
    this.nextPhase(p, 'lookups');
  }

  /** True while the stage reads the audio files (openings for the sample comparison). */
  reading(): boolean {
    return this.deps.lock.holds(OWNER);
  }

  private nextPhase(p: AudioStage4Progress, phase: Stage4Phase): void {
    p.phase = phase;
    p.phaseStartedAt = Date.now();
    p.phaseStartDone = phase === 'lookups' ? p.decided : 0;
    this.save(p, phase === 'done' ? 'ready' : 'analysing');
  }

  private addTime(p: AudioStage4Progress, phase: string, ms: number, items: number): void {
    const t = (p.phaseTimes[phase] ??= { ms: 0, items: 0 });
    t.ms += ms;
    t.items += items;
  }

  private count(p: AudioStage4Progress, where: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audio_online_units WHERE analysis_id = ? AND ${where}`)
        .get(p.analysisId) as { n: number }
    ).n;
  }

  /** One step of work; true when the analysis is done. */
  async step(shouldStop: () => boolean): Promise<boolean> {
    const p = this.progress();
    if (!p || p.phase === 'done') return true;
    const t0 = Date.now();
    try {
      if (p.phase === 'units') {
        const n = await this.unitsStep(p);
        this.addTime(p, 'units', Date.now() - t0, n);
        this.nextPhase(p, 'lookups');
        return false;
      }
      if (p.phase === 'lookups') {
        const r = await this.lookupsStep(p, shouldStop);
        this.addTime(p, 'lookups', r.ms, r.items);
        if (r.finished) {
          p.counts = stage4Counts(this.db, p.analysisId);
          this.nextPhase(p, 'gate');
        } else this.save(p, 'analysing');
        return false;
      }
      if (p.phase === 'gate') {
        p.gate = this.evaluateGate(p);
        p.counts = stage4Counts(this.db, p.analysisId);
        p.finishedAt = Date.now();
        this.addTime(p, 'gate', Date.now() - t0, p.gate.checked);
        this.nextPhase(p, 'done');
        this.deps.log?.(`Audiobooks stage 4: done (${JSON.stringify(p.counts)})`);
        return true;
      }
      return true;
    } catch (err) {
      p.error = (err as Error).message.slice(0, 500);
      p.finishedAt = Date.now();
      this.nextPhase(p, 'done');
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // units

  private labeledPaths(): string[] {
    const l = this.labels();
    return (l.books ?? []).map((b) => b.torrent).filter((t) => typeof t === 'string' && t);
  }

  /**
   * Builds the units. Library-sized (about 6,000 copies): the server answers requests between
   * slices of about 30 ms, and the rows are written in transactions of 500 (WP20 lessons (3):
   * no long synchronous step). Repeating it after a restart writes the same rows (keys).
   */
  private async unitsStep(p: AudioStage4Progress): Promise<number> {
    let slice = Date.now();
    const breathe = async () => {
      if (Date.now() - slice > 30) {
        await new Promise((r) => setImmediate(r));
        slice = Date.now();
      }
    };
    const db = this.db;
    const s3 = this.deps.stage3.progress();
    if (!s3 || s3.phase !== 'done' || s3.error) throw new Error('Stage 3 must have finished first');
    p.stage3Id = s3.analysisId;
    const s = getSettings(db).audiobooks;
    p.rulesKey = stage4SettingsKey(s);
    const copies = this.deps.stage3.loadCopies(s3.analysisId);
    // Copies proven the same recording: one unit each group.
    const groupOf = new Map<number, number>();
    for (const r of db
      .prepare(
        `SELECT m.copy_id, g.id AS gid FROM audio_dup_members m JOIN audio_dup_groups g ON g.id = m.group_id
         WHERE g.analysis_id = ? AND g.kind = 'group' AND g.outcome = 'auto'`,
      )
      .all(s3.analysisId) as { copy_id: number; gid: number }[])
      groupOf.set(r.copy_id, r.gid);
    const keepOf = new Map<number, number>();
    for (const r of db
      .prepare(
        `SELECT g.id AS gid, g.best_copy_id FROM audio_dup_groups g
         WHERE g.analysis_id = ? AND g.kind = 'group' AND g.outcome = 'auto'`,
      )
      .all(s3.analysisId) as { gid: number; best_copy_id: number | null }[])
      if (r.best_copy_id !== null) keepOf.set(r.gid, r.best_copy_id);
    const units = new Map<string, LoadedCopy[]>();
    for (const c of copies.values()) {
      if (c.excluded) continue;
      const g = groupOf.get(c.id);
      const key = g !== undefined ? `g${g}` : `c${c.id}`;
      let l = units.get(key);
      if (!l) units.set(key, (l = []));
      l.push(c);
    }
    const tagsOf = db.prepare('SELECT tags_json FROM audio_file_health WHERE file_id = ?');
    const decodedOf = db.prepare('SELECT decoded_path FROM audio_files WHERE id = ?');
    const labeled = new Set(this.labeledPaths());
    const noRecord = s.noStoreRecordFolders.map((f) => f.replace(/\/+$/, '') + '/');
    const rows: {
      key: string;
      copyKeys: string[];
      bookKeys: string[];
      name: string;
      seconds: number | null;
      labeled: boolean;
      kind: 'lookup' | 'none_expected';
      inputs: UnitInputs;
      reason: string | null;
    }[] = [];
    for (const [gkey, cs] of units) {
      await breathe();
      cs.sort((a, b) => a.key.localeCompare(b.key));
      const gid = gkey.startsWith('g') ? Number(gkey.slice(1)) : null;
      const rep =
        (gid !== null ? cs.find((c) => c.id === keepOf.get(gid)) : undefined) ??
        cs.find((c) => c.kind !== 'library_only') ??
        cs[0];
      const paths = cs.flatMap((c) => c.files.map((f) => `${f.root}:${f.rel}`));
      // Titles: each copy's own name (a file's, or the folder of a recording in parts), then
      // the folder a single file sits in when that folder is the book's own (not a TMW
      // "[Author] Series" folder, which names a series). Ids and authors: also two folders up
      // (a drama CD's ASIN may be on its folder only).
      const names: string[] = [];
      const add = (list: string[], n: string | null | undefined) => {
        if (n && !list.includes(n)) list.push(n);
      };
      const bookFolders: string[] = [];
      const upper: string[] = [];
      for (const c of [rep, ...cs.filter((x) => x !== rep)]) {
        add(names, c.name);
        for (const f of c.files) {
          const decoded = (decodedOf.get(f.id) as { decoded_path: string | null } | undefined)
            ?.decoded_path;
          const segs = (decoded ?? f.rel).split('/');
          if (c.kind !== 'parts') add(names, segs[segs.length - 1].replace(/\.[^.]+$/, ''));
          const parent = segs.length >= 2 ? segs[segs.length - 2] : null;
          if (parent && c.kind !== 'parts' && !/^\[[^\]]+\]\s/.test(parent))
            add(bookFolders, parent);
          for (const seg of segs.slice(Math.max(0, segs.length - 3), -1)) add(upper, seg);
        }
      }
      const queries: string[] = [];
      for (const n of [...names, ...bookFolders]) {
        const q = searchTitle(n);
        if (!meaningless(q) && !queries.includes(q)) queries.push(q);
      }
      const folders = [...bookFolders, ...upper.filter((x) => !bookFolders.includes(x))];
      const ids = idsInNames([...names, ...folders]);
      const absAsins = [...new Set(cs.flatMap((c) => c.absAsins))].filter(
        (a) => !ids.asins.includes(a),
      );
      const tags = (() => {
        const f = rep.files[0];
        const t = f ? (tagsOf.get(f.id) as { tags_json: string | null } | undefined) : undefined;
        try {
          return t?.tags_json ? (JSON.parse(t.tags_json) as FileTags) : null;
        } catch {
          return null;
        }
      })();
      const people = peopleFromTags(tags);
      const nameAuthors = [...names, ...folders]
        .map(authorFromName)
        .filter((a): a is string => !!a);
      const title = searchTitle(rep.name);
      const drama = [...names, ...folders].some(isDrama) ? { number: dramaNumber(rep.name) } : null;
      const facts: UnitFacts = {
        title,
        otherTitles: [...new Set([...names, ...bookFolders].map(searchTitle))].filter(
          (t) => t !== title && !meaningless(t),
        ),
        authors: [...new Set([...nameAuthors, ...people.authors])],
        narrators: people.narrators,
        volume: printedVolume(rep.name),
        drama,
        seconds: rep.seconds,
        files: rep.files.length,
      };
      const isLabeled = paths.some((pth) => {
        const rel = pth.slice(pth.indexOf(':') + 1);
        for (const l of labeled) if (rel === l || rel.startsWith(l + '/')) return true;
        return false;
      });
      const radio = cs.every((c) =>
        c.files.some((f) => noRecord.some((nr) => f.rel.startsWith(nr))),
      );
      const ai = cs.every((c) => c.ai);
      rows.push({
        // Stable while the same copies form the recording (a new analysis keeps the key).
        key: `u:${createHash('sha1')
          .update(cs.map((c) => c.key).join('\n'))
          .digest('hex')
          .slice(0, 24)}`,
        copyKeys: cs.map((c) => c.key),
        bookKeys: [...new Set(cs.map((c) => c.bookKey))],
        name: rep.name,
        seconds: rep.seconds,
        labeled: isLabeled,
        kind: ai || radio ? 'none_expected' : 'lookup',
        reason: ai ? 'AI audiobook' : radio ? 'radio bonus clip' : null,
        inputs: {
          facts,
          queries: queries.slice(0, MAX_QUERIES),
          asins: ids.asins,
          absAsins,
          kikubon: ids.kikubon,
          audiobookJp: ids.audiobookJp,
          paths: paths.slice(0, 20),
          opening: rep.files.map((f) => ({
            id: f.id,
            root: f.root,
            rel: f.rel,
            raw: f.raw,
            size: f.size,
            mtime: f.mtime,
            sha256: f.sha256,
            duration: f.duration,
          })),
        },
      });
    }
    const now = Date.now();
    // Earlier analyses' units go (their requests and answers stay in the queue), 500 at a time.
    for (;;) {
      const old = db
        .prepare('SELECT id FROM audio_online_units WHERE analysis_id <> ? LIMIT 500')
        .all(p.analysisId) as { id: number }[];
      if (!old.length) break;
      db.transaction(() => {
        const delC = db.prepare('DELETE FROM audio_online_candidates WHERE unit_id = ?');
        const delU = db.prepare('DELETE FROM audio_online_units WHERE id = ?');
        for (const o of old) {
          delC.run(o.id);
          delU.run(o.id);
        }
      })();
      await new Promise((r) => setImmediate(r));
    }
    db.prepare('DELETE FROM audio_fetch_waiters').run();
    for (let at = 0; at < rows.length; at += 500) {
      const chunk = rows.slice(at, at + 500);
      await new Promise((r) => setImmediate(r));
      db.transaction(() => {
        const put = db.prepare(
          `INSERT INTO audio_online_units (analysis_id, unit_key, copy_keys, book_keys, name, seconds,
           labeled, kind, state, inputs_json, class, review_reason, rules_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(analysis_id, unit_key) DO NOTHING`,
        );
        for (const r of chunk) {
          put.run(
            p.analysisId,
            r.key,
            JSON.stringify(r.copyKeys),
            JSON.stringify(r.bookKeys),
            r.name,
            r.seconds,
            r.labeled ? 1 : 0,
            r.kind,
            r.kind === 'lookup' ? 'planned' : 'decided',
            JSON.stringify(r.inputs),
            r.kind === 'lookup' ? null : 'none_expected',
            r.reason,
            p.rulesKey,
            now,
          );
        }
      })();
    }
    p.units = rows.length;
    p.lookupUnits = rows.filter((r) => r.kind === 'lookup').length;
    p.noRecordUnits = rows.length - p.lookupUnits;
    p.labeledUnits = rows.filter((r) => r.labeled).length;
    p.decided = p.noRecordUnits;
    return rows.length;
  }

  // -------------------------------------------------------------------------------------------
  // lookups

  private settingsNow(): { s: AudiobookSettings; m: MatchSettings } {
    const s = getSettings(this.db).audiobooks;
    return { s, m: { runtimeMinutes: s.onlineRuntimeMinutes, titleScore: s.onlineTitleScore } };
  }

  /**
   * One round: switched-off sites give up their queued requests; planned units and units whose
   * requests were answered are advanced (labeled first); units waiting for the disk read their
   * openings. Finished when no unit is left undecided.
   */
  private async lookupsStep(
    p: AudioStage4Progress,
    shouldStop: () => boolean,
  ): Promise<{ finished: boolean; ms: number; items: number }> {
    const db = this.db;
    const t0 = Date.now();
    const fetch = getSettings(db).fetch;
    for (const site of AUDIO_FETCH_SITES) {
      if (!fetch.sites[site]?.enabled) this.deps.queue.giveUpQueued(site);
    }
    // Units with an answered request become ready; planned ones are advanced first time.
    db.prepare(
      `UPDATE audio_online_units SET state = 'ready' WHERE analysis_id = ? AND state = 'waiting'
         AND unit_key IN (SELECT unit_key FROM audio_fetch_waiters WHERE ready = 1)`,
    ).run(p.analysisId);
    const todo = db
      .prepare(
        `SELECT id, unit_key, labeled, inputs_json FROM audio_online_units
         WHERE analysis_id = ? AND state IN ('planned', 'ready') ORDER BY labeled DESC, id LIMIT ?`,
      )
      .all(p.analysisId, ADVANCE_CHUNK) as {
      id: number;
      unit_key: string;
      labeled: number;
      inputs_json: string;
    }[];
    let items = 0;
    let slice = Date.now();
    for (const u of todo) {
      if (shouldStop()) break;
      const inputs = JSON.parse(u.inputs_json) as UnitInputs;
      try {
        this.applyAdvance(p, u.id, u.unit_key, this.advance(u.unit_key, inputs, u.labeled === 1));
      } catch (err) {
        // One unit's problem is its own: listed, never stopping the others.
        db.prepare(
          `UPDATE audio_online_units SET state = 'error', error = ?, updated_at = ? WHERE id = ?`,
        ).run((err as Error).message.slice(0, 300), Date.now(), u.id);
      }
      items++;
      if (Date.now() - slice > 30) {
        await new Promise((res) => setImmediate(res));
        slice = Date.now();
      }
    }
    const ms = Date.now() - t0;
    // The disk part (openings; samples come from the fetch cache) for units that need it.
    const needDisk = db
      .prepare(
        `SELECT id, unit_key, labeled, inputs_json FROM audio_online_units
         WHERE analysis_id = ? AND state = 'audio' ORDER BY labeled DESC, id LIMIT 4`,
      )
      .all(p.analysisId) as {
      id: number;
      unit_key: string;
      labeled: number;
      inputs_json: string;
    }[];
    let diskItems = 0;
    for (const u of needDisk) {
      if (shouldStop()) break;
      const inputs = JSON.parse(u.inputs_json) as UnitInputs;
      const done = await this.readAudio(p, u.unit_key, inputs, u.labeled === 1, shouldStop);
      if (!done) break;
      db.prepare(
        `UPDATE audio_online_units SET state = 'ready', updated_at = ? WHERE id = ? AND state = 'audio'`,
      ).run(Date.now(), u.id);
      diskItems++;
    }
    p.decided = this.count(p, `state = 'decided'`);
    const open = this.count(p, `state NOT IN ('decided', 'error')`);
    // Nothing to do but wait (for answers, or for Calibre to give the disk back).
    if (!todo.length && !diskItems && open > 0) await sleep(1000);
    return { finished: open === 0, ms, items: items + diskItems };
  }

  /** True while units wait to read audio and a Calibre job uses the disk (for the page). */
  waitingForDisk(): boolean {
    const p = this.progress();
    if (!p || p.phase !== 'lookups') return false;
    return this.count(p, `state = 'audio'`) > 0 && !this.deps.lock.holds(OWNER);
  }

  private applyAdvance(p: AudioStage4Progress, id: number, unitKey: string, r: Advance): void {
    const db = this.db;
    const now = Date.now();
    db.transaction(() => {
      db.prepare('DELETE FROM audio_fetch_waiters WHERE unit_key = ? AND ready = 1').run(unitKey);
      if (r.kind === 'waiting') {
        const put = db.prepare(
          `INSERT INTO audio_fetch_waiters (request_id, unit_key, step, ready) VALUES (?, ?, ?, 0)
           ON CONFLICT DO NOTHING`,
        );
        for (const w of r.waits) put.run(w.id, unitKey, w.step);
        // An answer that arrived between the check and now makes the unit ready at once.
        const answered = r.waits.some((w) => {
          const st = (
            db.prepare('SELECT state FROM fetch_requests WHERE id = ?').get(w.id) as
              | { state: string }
              | undefined
          )?.state;
          return st === 'done' || st === 'gone' || st === 'failed';
        });
        db.prepare(
          `UPDATE audio_online_units SET state = ?, pending = ?, error = NULL, updated_at = ? WHERE id = ?`,
        ).run(answered ? 'ready' : 'waiting', r.waits.length, now, id);
        return;
      }
      if (r.kind === 'needs') {
        db.prepare(
          `UPDATE audio_online_units SET state = 'audio', error = NULL, pending = 0, updated_at = ?
           WHERE id = ?`,
        ).run(now, id);
        return;
      }
      db.prepare('DELETE FROM audio_fetch_waiters WHERE unit_key = ?').run(unitKey);
      db.prepare('DELETE FROM audio_online_candidates WHERE unit_id = ?').run(id);
      const putC = db.prepare(
        `INSERT INTO audio_online_candidates (unit_id, source, store_id, via, checks_json, verdict, sample_score)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      const putR = db.prepare(
        `INSERT INTO audio_online_records (source, store_id, request_id, record, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, store_id) DO UPDATE SET request_id = COALESCE(excluded.request_id, request_id),
           record = CASE WHEN excluded.request_id IS NOT NULL OR request_id IS NULL THEN excluded.record ELSE record END,
           fetched_at = excluded.fetched_at`,
      );
      for (const c of r.cands) {
        putC.run(
          id,
          c.rec.source,
          c.rec.id,
          c.via,
          JSON.stringify({ checks: c.ev.checks, failed: c.ev.failed, fraction: c.ev.fraction }),
          c.ev.pass ? 'pass' : `fail:${c.ev.failed.join(',')}`,
          c.sampleScore ?? null,
        );
        putR.run(c.rec.source, c.rec.id, c.requestId, gz(c.rec), now);
      }
      db.prepare(
        `UPDATE audio_online_units SET state = 'decided', pending = 0, class = ?, source = ?, store_id = ?,
           review_reason = ?, detail = ?, rules_key = ?, error = NULL, updated_at = ? WHERE id = ?`,
      ).run(
        r.cls,
        r.best?.rec.source ?? null,
        r.best?.rec.id ?? null,
        r.reason,
        r.detail,
        p.rulesKey,
        now,
        id,
      );
    })();
  }

  /** A request's state and, once answered, its body (parsed once per request id). */
  private need(
    ctx: { waits: { id: number; step: string }[]; prio: number },
    r: OnlineRequest,
    step: string,
  ): { pending: true } | { pending: false; id: number; ok: boolean } {
    const q = this.deps.queue.enqueue(
      { site: r.site, key: r.url, url: r.url, accept: r.accept, priority: ctx.prio },
      null,
    );
    if (q.state === 'done' || q.state === 'gone' || q.state === 'failed') {
      return { pending: false, id: q.id, ok: q.state === 'done' };
    }
    if (!ctx.waits.some((w) => w.id === q.id)) ctx.waits.push({ id: q.id, step });
    return { pending: true };
  }

  private body(id: number): Buffer | null {
    return this.deps.queue.readAnswer(id);
  }

  private parse<T>(id: number, f: (b: Buffer) => T): T | null {
    if (this.parsed.has(id)) return this.parsed.get(id) as T;
    const b = this.body(id);
    const v = b ? f(b) : null;
    if (this.parsed.size > 5000) this.parsed.clear();
    this.parsed.set(id, v);
    return v;
  }

  /**
   * Walks a unit's lookups in the decided order from the start, with what the queue has
   * answered so far: asks for the next request(s) it needs, or decides.
   */
  advance(unitKey: string, inputs: UnitInputs, labeled: boolean): Advance {
    const { s, m } = this.settingsNow();
    const ctx = {
      waits: [] as { id: number; step: string }[],
      prio: labeled ? LABELED_PRIORITY : 0,
    };
    const cands: Cand[] = [];
    const have = new Set<string>();
    const facts = inputs.facts;
    const add = (rec: StoreRecord, via: string, requestId: number | null) => {
      const k = recordName(rec);
      if (have.has(k)) return;
      have.add(k);
      cands.push({
        rec,
        via,
        requestId,
        ev: evaluate(facts, rec, m, { viaNameAsin: via === 'asin_name' }),
      });
    };
    const waiting = (): Advance => ({ kind: 'waiting', waits: ctx.waits });
    const product = (asin: string, via: string, fallback?: StoreRecord) => {
      const r = this.need(ctx, audibleProduct(asin), via);
      if (r.pending) return;
      const rec = r.ok ? this.parse(r.id, parseAudibleProduct) : null;
      if (rec) add(rec, via, r.id);
      else if (fallback) add(fallback, via, null);
    };

    // 1. ASINs in the names.
    for (const a of inputs.asins.slice(0, MAX_ASINS)) product(a, 'asin_name');
    if (ctx.waits.length) return waiting();
    let d = this.decide(unitKey, inputs, cands, ctx, false, s);
    if (d) return d;

    // 2. ASINs in Audiobookshelf's data (candidates only).
    for (const a of inputs.absAsins.slice(0, MAX_ASINS)) product(a, 'abs_asin');
    if (ctx.waits.length) return waiting();
    d = this.decide(unitKey, inputs, cands, ctx, false, s);
    if (d) return d;

    // 3. Audible's title search: variants in order until one finds something worth reading.
    const queries = inputs.queries;
    let matched = false;
    const readHits = (hits: SearchHit[], via: string): boolean => {
      const worth = hits
        .filter((h) => !have.has(recordName(h)) && hitWorthReading(facts, h, m))
        .slice(0, s.onlineSearchProducts);
      for (const h of worth) product(h.id, via, h.record);
      return worth.length > 0;
    };
    outer: for (const q of queries) {
      for (const v of titleVariants(q)) {
        const r = this.need(ctx, audibleSearch(v), 'search');
        if (r.pending) return waiting();
        const hits = r.ok ? (this.parse(r.id, parseAudibleSearch) ?? []) : [];
        if (readHits(hits, `search:${v}`)) {
          matched = true;
          break outer;
        }
      }
    }
    if (!matched && queries.length) {
      const r = this.need(ctx, audibleSearch(queries[0], true), 'keyword');
      if (r.pending) return waiting();
      const hits = r.ok ? (this.parse(r.id, parseAudibleSearch) ?? []) : [];
      readHits(hits, `keywords:${queries[0]}`);
    }
    if (ctx.waits.length) return waiting();
    d = this.decide(unitKey, inputs, cands, ctx, false, s);
    if (d) return d;

    // 4 and 5. kikubon and audiobook.jp, asked side by side, taken in this order.
    const q0 = queries[0] ?? null;
    if (inputs.kikubon) {
      const r = this.need(ctx, kikubonProduct(inputs.kikubon), 'kikubon');
      if (!r.pending && r.ok) {
        const rec = this.parse(r.id, (b) => parseKikubonProduct(b, inputs.kikubon!));
        if (rec) add(rec, 'name_id', r.id);
      }
    } else if (q0) {
      const r = this.need(ctx, kikubonSearch(q0), 'kikubon');
      if (!r.pending) {
        const hits = r.ok ? (this.parse(r.id, parseKikubonSearch) ?? []) : [];
        const worth = hits
          .filter((h) => titlesAgree([facts.title, ...facts.otherTitles], h.title, m.titleScore).ok)
          .slice(0, s.onlineStorePages);
        for (const h of worth) {
          const rp = this.need(ctx, kikubonProduct(h.id), 'kikubon-product');
          if (rp.pending || !rp.ok) continue;
          const rec = this.parse(rp.id, (b) => parseKikubonProduct(b, h.id));
          if (rec) add(rec, 'kikubon_search', rp.id);
        }
      }
    }
    if (q0) {
      const r = this.need(ctx, abjpSearch(q0), 'audiobookjp');
      if (!r.pending) {
        const hits = r.ok ? (this.parse(r.id, parseAbjpSearch) ?? []) : [];
        const worth = hits.filter((h) => hitWorthReading(facts, h, m)).slice(0, s.onlineStorePages);
        for (const h of worth) {
          const rp = this.need(ctx, abjpProduct(h.id), 'audiobookjp-product');
          if (rp.pending) continue;
          const rec = rp.ok ? this.parse(rp.id, (b) => parseAbjpProduct(b, h.id)) : null;
          // Its search result has what the checks read when the product page can't be read.
          if (rec) add(rec, 'abjp_search', rp.id);
          else add(hitRecord(h), 'abjp_search', r.id);
        }
      }
    }
    if (inputs.audiobookJp) {
      const r = this.need(ctx, abjpProduct(inputs.audiobookJp), 'audiobookjp-product');
      if (!r.pending && r.ok) {
        const rec = this.parse(r.id, (b) => parseAbjpProduct(b, inputs.audiobookJp!));
        if (rec) add(rec, 'name_id', r.id);
      }
    }
    if (ctx.waits.length) return waiting();
    return this.decide(unitKey, inputs, cands, ctx, true, s)!;
  }

  /**
   * The decision once a step is complete. Per source in the lookup order: one record passing
   * every check is the match; several passing are editions (the samples decide). After the last
   * step: records failing only the narrator are compared by sample audio too; otherwise the best
   * candidate goes to review, or the unit is unknown.
   */
  private decide(
    unitKey: string,
    inputs: UnitInputs,
    cands: Cand[],
    ctx: { waits: { id: number; step: string }[]; prio: number },
    final: boolean,
    s: AudiobookSettings,
  ): Advance | null {
    for (const src of ['audible', 'kikubon', 'audiobookjp'] as StoreSource[]) {
      const pass = cands.filter((c) => c.rec.source === src && c.ev.pass);
      if (pass.length === 1) {
        return {
          kind: 'decided',
          cls: 'auto',
          best: pass[0],
          reason: null,
          detail: pass[0].via,
          cands,
        };
      }
      if (pass.length > 1) return this.bySamples(inputs, pass, cands, ctx, 'editions', s);
    }
    if (!final) return null;
    const narratorOnly = cands.filter(
      (c) => c.ev.failed.length === 1 && c.ev.failed[0] === 'narrator',
    );
    if (narratorOnly.length) return this.bySamples(inputs, narratorOnly, cands, ctx, 'narrator', s);
    // A record whose title disagrees is another book (a wrong id in a name, a search's
    // neighbour): shown for review only when the ASIN in the file's name chose it.
    const plausible = cands.filter((c) => c.ev.checks.title.ok || c.via === 'asin_name');
    if (!plausible.length) {
      return {
        kind: 'decided',
        cls: 'unknown',
        best: null,
        reason: 'not found',
        detail: cands.length ? `${cands.length} other record(s) rejected` : null,
        cands,
      };
    }
    const best = [...plausible].sort((a, b) => rankEvaluation(a.ev) - rankEvaluation(b.ev))[0];
    return {
      kind: 'decided',
      cls: 'review',
      best,
      reason: reviewReason(best.ev),
      detail: best.via,
      cands,
    };
  }

  /** The store's sample audio of a candidate: its request, or why there is none. */
  private sampleOf(
    c: Cand,
    ctx: { waits: { id: number; step: string }[]; prio: number },
  ): { pending: true } | { url: string; id: number | null; ok: boolean } | null {
    let url: string | null = null;
    if (c.rec.source === 'audible') {
      const r = this.need(ctx, audibleSampleInfo(c.rec.id), 'sample-info');
      if (r.pending) return { pending: true };
      url = r.ok ? this.parse(r.id, parseAudibleSample) : null;
      const req = url ? audibleSampleAudio(url) : null;
      if (!req) return null;
      const a = this.need(ctx, req, 'sample');
      if (a.pending) return { pending: true };
      return { url: req.url, id: a.id, ok: a.ok };
    }
    if (c.rec.source === 'audiobookjp') {
      url = typeof c.rec.extra.sampleUrl === 'string' ? c.rec.extra.sampleUrl : null;
      const req = url ? abjpSampleAudio(url) : null;
      if (!req) return null;
      const a = this.need(ctx, req, 'sample');
      if (a.pending) return { pending: true };
      return { url: url!, id: a.id, ok: a.ok };
    }
    // kikubon: only its search and product pages are ever read (user, 2026-11-19).
    return null;
  }

  private fpOf(key: string): Uint32Array | null | undefined {
    const r = this.db.prepare('SELECT fp FROM audio_fingerprints WHERE win_key = ?').get(key) as
      | { fp: Buffer | null }
      | undefined;
    if (!r) return undefined;
    return r.fp ? fpFromBuffer(r.fp) : null;
  }

  /**
   * How much of the opening is read: the setting, but at least 6 minutes (Audible's samples
   * are up to 5 minutes, checked 2026-11-19: 30 s and 300 s; audiobook.jp's 60 s), and never
   * more than the recording.
   */
  private openingSeconds(inputs: UnitInputs, s: AudiobookSettings): number {
    const total = inputs.opening.reduce((a, f) => a + (f.duration ?? 0), 0);
    const want = Math.max(s.onlineOpeningSeconds, 360);
    return total > 0 ? Math.min(total, want) : want;
  }

  private bySamples(
    inputs: UnitInputs,
    set: Cand[],
    cands: Cand[],
    ctx: { waits: { id: number; step: string }[]; prio: number },
    why: 'editions' | 'narrator',
    s: AudiobookSettings,
  ): Advance {
    const samples: { c: Cand; url: string | null; id: number | null; ok: boolean }[] = [];
    for (const c of set) {
      const r = this.sampleOf(c, ctx);
      if (r && 'pending' in r) continue;
      samples.push({ c, url: r?.url ?? null, id: r?.id ?? null, ok: r?.ok ?? false });
    }
    if (ctx.waits.length) return { kind: 'waiting', waits: ctx.waits };
    const seconds = this.openingSeconds(inputs, s);
    const oKey = openingKey(inputs.opening, seconds);
    const opening = this.fpOf(oKey);
    const missingSamples = samples
      .filter((x) => x.url && x.id !== null && x.ok && this.fpOf(sampleKey(x.url)) === undefined)
      .map((x) => ({ id: x.id!, url: x.url! }));
    if (opening === undefined || missingSamples.length) {
      return { kind: 'needs', opening: opening === undefined, samples: missingSamples };
    }
    const minOverlap = secondsToItems(20);
    for (const x of samples) {
      const fp = x.url ? this.fpOf(sampleKey(x.url)) : null;
      if (!opening || !fp) {
        x.c.sampleScore = null;
        continue;
      }
      const a = bestAlignment(
        fp,
        opening,
        -(fp.length - minOverlap),
        opening.length - minOverlap,
        Math.min(minOverlap, fp.length, opening.length),
      );
      x.c.sampleScore = a.score === null ? null : Math.round(a.score * 1000) / 1000;
    }
    const scored = samples.filter((x) => typeof x.c.sampleScore === 'number');
    const same = scored.filter((x) => (x.c.sampleScore as number) >= s.dupSameScore);
    const detail = samples
      .map(
        (x) =>
          `${recordName(x.c.rec)} ${x.c.sampleScore === null || x.c.sampleScore === undefined ? (x.url ? 'sample unreadable' : 'no sample') : x.c.sampleScore}`,
      )
      .join('; ');
    if (same.length === 1) {
      return {
        kind: 'decided',
        cls: 'auto',
        best: same[0].c,
        reason: null,
        detail: `sample audio: ${detail}`,
        cands,
      };
    }
    const best = [...set].sort((a, b) => (b.sampleScore ?? -1) - (a.sampleScore ?? -1))[0];
    if (same.length > 1) {
      return {
        kind: 'decided',
        cls: 'review',
        best,
        reason: 'editions',
        detail: `several samples match: ${detail}`,
        cands,
      };
    }
    if (why === 'narrator' && opening && scored.length === samples.length && samples.length > 0) {
      // Every edition's sample was compared and none is this recording.
      return {
        kind: 'decided',
        cls: 'unknown',
        best,
        reason: 'editions compared',
        detail: `no store edition is this recording: ${detail}`,
        cands,
      };
    }
    return {
      kind: 'decided',
      cls: 'review',
      best,
      reason: why === 'narrator' ? 'narrator' : 'editions',
      detail: `samples didn't decide: ${detail}`,
      cands,
    };
  }

  /**
   * Reads what a unit's sample comparison needs: the recording's opening (under the shared disk
   * lock, given back at once when Calibre waits) and the samples (from the fetch cache; no
   * disk1 read). True when everything was read (or failed for good).
   */
  private async readAudio(
    p: AudioStage4Progress,
    unitKey: string,
    inputs: UnitInputs,
    labeled: boolean,
    shouldStop: () => boolean,
  ): Promise<boolean> {
    const { s } = this.settingsNow();
    const r = this.advance(unitKey, inputs, labeled);
    if (r.kind !== 'needs') return true;
    const put = this.db.prepare(
      `INSERT INTO audio_fingerprints (win_key, files_sig, fp, items, error, tool_version, took_ms, made_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(win_key) DO UPDATE SET files_sig = excluded.files_sig, fp = excluded.fp,
         items = excluded.items, error = excluded.error, took_ms = excluded.took_ms, made_at = excluded.made_at`,
    );
    const timeoutMs = Math.max(s.toolTimeoutSeconds * 1000, 60_000);
    for (const smp of r.samples) {
      const t0 = Date.now();
      const body = this.body(smp.id);
      const fp = body
        ? await fingerprintBytes(body, this.deps.tools, { timeoutMs, seconds: 900 }).catch(
            (err: Error) => ({ fp: null, error: err.message }),
          )
        : { fp: null, error: 'the sample is not in the fetch cache' };
      put.run(
        sampleKey(smp.url),
        'sample',
        fp.fp ? fpToBuffer(fp.fp) : null,
        fp.fp?.length ?? 0,
        fp.error?.slice(0, 500) ?? null,
        Date.now() - t0,
        Date.now(),
      );
      if (fp.fp) p.samplesRead++;
      else p.sampleErrors++;
    }
    if (r.opening) {
      // Calibre first: while one of its jobs uses the disk nothing is read (the step ends and
      // the unit is read later); a wait for the lock gives up as soon as Calibre wants the disk.
      const calibreBusy = () => this.deps.calibreBusy?.() ?? this.deps.lock.calibreBusy();
      if (calibreBusy()) return false;
      if (!(await this.deps.lock.acquire(OWNER, 'audio', () => shouldStop() || calibreBusy())))
        return false;
      try {
        const seconds = this.openingSeconds(inputs, s);
        const key = openingKey(inputs.opening, seconds);
        const spans: FileSpan[] = spansOf(inputs.opening, { start: 0, length: seconds }).map(
          (sp) => {
            const f = inputs.opening.find((x) => x.id === sp.fileId)!;
            return {
              file: insideRoot(this.deps.roots[f.root], f.rel, f.raw),
              start: sp.start,
              length: sp.length,
            };
          },
        );
        const yieldNow = () => shouldStop() || this.deps.lock.shouldYield(OWNER);
        const t0 = Date.now();
        const res = spans.length
          ? await fingerprintSpans(spans, this.deps.tools, {
              timeoutMs,
              shouldStop: yieldNow,
            }).catch((err: Error) => ({ fp: null, error: err.message }))
          : { fp: null, error: 'the length of the files is unknown' };
        if (yieldNow() && !res.fp) {
          p.yields++;
          return false; // read again later
        }
        put.run(
          key,
          openingSig(inputs.opening),
          res.fp ? fpToBuffer(res.fp) : null,
          res.fp?.length ?? 0,
          res.error?.slice(0, 500) ?? null,
          Date.now() - t0,
          Date.now(),
        );
        if (res.fp) p.openingsRead++;
        else p.openingErrors++;
      } finally {
        this.deps.lock.release(OWNER);
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // gate

  labels(): { books: LabeledBook[] | null; error: string | null } {
    const now = Date.now();
    if (this.labelsCache && now - this.labelsCache.at < 60_000)
      return { books: this.labelsCache.books, error: this.labelsCache.error };
    const r = this.deps.readLabels?.() ?? { text: null, error: 'The labeled books are not set up' };
    let books: LabeledBook[] | null = null;
    let error: string | null = r.error;
    if (r.text) {
      try {
        const j = JSON.parse(r.text) as { books?: unknown };
        if (Array.isArray(j.books)) books = j.books as LabeledBook[];
        else error = 'The labels file has no "books"';
      } catch (err) {
        error = `The labels file can't be read: ${(err as Error).message}`;
      }
    } else error ??= "The labels file can't be read";
    this.labelsCache = { at: now, books, error: books ? null : error };
    return { books, error: books ? null : error };
  }

  /** The unit a torrent file or folder (a label's `torrent`) belongs to. */
  unitFinder(p: AudioStage4Progress): (torrent: string) => UnitOutcome | null {
    const rows = this.db
      .prepare(
        `SELECT unit_key, kind, class, source, store_id, review_reason, inputs_json FROM audio_online_units
         WHERE analysis_id = ?`,
      )
      .all(p.analysisId) as {
      unit_key: string;
      kind: 'lookup' | 'none_expected';
      class: UnitOutcome['class'];
      source: string | null;
      store_id: string | null;
      review_reason: string | null;
      inputs_json: string;
    }[];
    const byPath = new Map<string, UnitOutcome>();
    for (const r of rows) {
      const inputs = JSON.parse(r.inputs_json) as UnitInputs;
      const o: UnitOutcome = {
        unitKey: r.unit_key,
        kind: r.kind,
        class: r.class,
        record: r.source && r.store_id ? `${r.source}:${r.store_id}` : null,
        reason: r.review_reason,
      };
      for (const f of inputs.opening) if (f.root === 'torrents') byPath.set(f.rel, o);
      for (const pth of inputs.paths) {
        const rel = pth.slice(pth.indexOf(':') + 1);
        if (pth.startsWith('torrents:') && !byPath.has(rel)) byPath.set(rel, o);
      }
    }
    return (torrent: string) => {
      const exact = byPath.get(torrent);
      if (exact) return exact;
      for (const [rel, o] of byPath) if (rel.startsWith(torrent + '/')) return o;
      return null;
    };
  }

  evaluateGate(p: AudioStage4Progress): OnlineGateResult {
    const l = this.labels();
    if (!l.books) {
      return { passed: false, checked: 0, misses: [], bySource: {}, results: [], error: l.error };
    }
    return scoreOnlineGate(l.books, this.unitFinder(p));
  }
}

/** Units per class and source, and review items per reason. */
export function stage4Counts(db: Database.Database, analysisId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db
    .prepare(
      `SELECT kind, state, class, source, review_reason, COUNT(*) AS n FROM audio_online_units
       WHERE analysis_id = ? GROUP BY kind, state, class, source, review_reason`,
    )
    .all(analysisId) as {
    kind: string;
    state: string;
    class: string | null;
    source: string | null;
    review_reason: string | null;
    n: number;
  }[]) {
    out.units = (out.units ?? 0) + r.n;
    if (r.state !== 'decided') {
      out.open = (out.open ?? 0) + r.n;
      continue;
    }
    const c = r.class ?? 'unknown';
    out[c] = (out[c] ?? 0) + r.n;
    if (c === 'auto' && r.source) out[`auto:${r.source}`] = (out[`auto:${r.source}`] ?? 0) + r.n;
    if (c === 'review') {
      out[`review:${r.review_reason ?? '?'}`] =
        (out[`review:${r.review_reason ?? '?'}`] ?? 0) + r.n;
      if (r.source)
        out[`review_source:${r.source}`] = (out[`review_source:${r.source}`] ?? 0) + r.n;
    }
    if (c === 'unknown')
      out[`unknown:${r.review_reason ?? '?'}`] =
        (out[`unknown:${r.review_reason ?? '?'}`] ?? 0) + r.n;
  }
  return out;
}
