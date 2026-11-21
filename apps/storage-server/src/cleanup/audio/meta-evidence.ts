/**
 * Audiobook stage 5 (WP21d): each recording's evidence record, built from what earlier stages
 * stored in cleanup.db: stage 4's unit (names, the file's title and people, the chosen record
 * or the candidates it left for review), the store records exactly as they came (Audible's
 * product object, kikubon's and audiobook.jp's pages parsed in full), the representative file's
 * tags (stage 2), and stage 3's copies. Nothing is fetched and no file is read.
 *
 * The record is kept (ai_items) so an upgrade asks other models without reading anything again.
 */
import type Database from 'better-sqlite3';
import { plain, type SeriesRef, type StoreRecord } from './online-pages';
import { ungzRecord, type UnitInputs } from './stage4-online';

/** Raised when what the evidence holds changes (the models are asked again). */
export const META_EVIDENCE_VERSION = 1;

/** How long a description may be in the evidence (the rules read it for translators). */
const DESCRIPTION_CHARS = 4000;

export type MetaKind = 'record' | 'no_record' | 'ai' | 'radio';

export interface RecordBrief {
  /** "audible:B0…", "kikubon:19", "audiobookjp:262098". */
  id: string;
  source: string;
  title: string;
  subtitle: string | null;
  /** As the store lists them (roles and all). */
  authors: string[];
  narrators: string[];
  minutes: number | null;
  publisher: string | null;
  releaseDate: string | null;
  language: string | null;
  /** Audible: unabridged / abridged / original_recording. */
  format: string | null;
  categories: string[];
  series: SeriesRef[];
  description: string;
  cover: string | null;
  /** Only a search page's line was read (no product page). */
  fromSearchPage: boolean;
}

export interface CandidateBrief {
  record: RecordBrief;
  /** Stage 4's checks: "pass" or "fail:<checks>". */
  verdict: string;
  via: string;
  sampleScore: number | null;
}

export interface MetaEvidence {
  kind: MetaKind;
  /** The representative copy's name. */
  name: string;
  minutes: number | null;
  files: number;
  /** Copies of the same recording (stage 3). */
  copies: number;
  stage4: { class: string | null; reason: string | null; detail: string | null };
  /** Stage 4's title of the file (its name cleaned) and the other names. */
  title: string;
  otherTitles: string[];
  seriesTitles: string[];
  volume: string | null;
  drama: boolean;
  dramaNumber: string | null;
  /** Authors from the names ([著者] …) and the artist tag (when a composer names narrators). */
  nameAuthors: string[];
  /** Narrators from the composer tag (evidence only). */
  tagNarrators: string[];
  /** The representative files' paths under the torrents (decoded where the name was mojibake). */
  paths: string[];
  tags: Record<string, string> | null;
  /** The record stage 4 chose (auto), or its best guess (review); null for none. */
  record: RecordBrief | null;
  /** Review only: the records a model may choose from (the best guess first). */
  candidates: CandidateBrief[];
}

const TAG_KEYS = [
  'title',
  'artist',
  'album',
  'album_artist',
  'composer',
  'genre',
  'date',
  'publisher',
  'comment',
];

/** The store record as the rules and the models read it. */
export function recordBrief(r: StoreRecord): RecordBrief {
  const x = r.extra ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let description = '';
  if (typeof x.publisher_summary === 'string') description = plain(x.publisher_summary);
  else if (typeof x.merchandising_summary === 'string')
    description = plain(x.merchandising_summary);
  else if (typeof x.description === 'string') description = x.description.trim();
  const categories: string[] = [];
  if (Array.isArray(x.category_ladders)) {
    for (const l of x.category_ladders as { ladder?: { name?: string }[] }[]) {
      const names = (l.ladder ?? []).map((c) => c.name ?? '').filter(Boolean);
      if (names.length) categories.push(names.join(' > '));
    }
  }
  for (const k of ['genre', 'genres']) {
    const v = x[k];
    if (Array.isArray(v))
      for (const g of v) categories.push(Array.isArray(g) ? g.join(' > ') : String(g));
  }
  let cover: string | null = null;
  if (x.product_images && typeof x.product_images === 'object') {
    const imgs = x.product_images as Record<string, string>;
    const best = Object.keys(imgs)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(b) - Number(a))[0];
    cover = best ? imgs[best] : null;
  }
  cover ??= str(x.cover);
  return {
    id: `${r.source}:${r.id}`,
    source: r.source,
    title: r.title,
    subtitle: r.subtitle,
    authors: r.authors,
    narrators: r.narrators,
    minutes: r.seconds === null ? null : Math.round((r.seconds / 60) * 10) / 10,
    publisher: r.publisher,
    releaseDate: r.releaseDate,
    language: str(x.language),
    format: str(x.format_type),
    categories: [...new Set(categories)].slice(0, 6),
    series: r.series,
    description: description.slice(0, DESCRIPTION_CHARS),
    cover,
    fromSearchPage: x.fromSearchPage === true,
  };
}

interface UnitRow {
  id: number;
  unit_key: string;
  name: string;
  seconds: number | null;
  labeled: number;
  kind: 'lookup' | 'none_expected';
  class: string | null;
  source: string | null;
  store_id: string | null;
  review_reason: string | null;
  detail: string | null;
  inputs_json: string;
  copy_keys: string;
}

/** Builds evidence records for stage 4's units (one builder per pass: it caches records). */
export class EvidenceBuilder {
  private readonly recs = new Map<string, StoreRecord | null>();
  private readonly getRec;
  private readonly getCands;
  private readonly getTags;
  private readonly getDecoded;

  constructor(private readonly db: Database.Database) {
    this.getRec = db.prepare(
      'SELECT record FROM audio_online_records WHERE source = ? AND store_id = ?',
    );
    this.getCands = db.prepare(
      'SELECT source, store_id, via, verdict, sample_score FROM audio_online_candidates WHERE unit_id = ? ORDER BY id',
    );
    this.getTags = db.prepare('SELECT tags_json FROM audio_file_health WHERE file_id = ?');
    this.getDecoded = db.prepare('SELECT decoded_path FROM audio_files WHERE id = ?');
  }

  private record(source: string, id: string): StoreRecord | null {
    const k = `${source}:${id}`;
    if (this.recs.has(k)) return this.recs.get(k)!;
    const row = this.getRec.get(source, id) as { record: Buffer } | undefined;
    let r: StoreRecord | null = null;
    try {
      r = row ? ungzRecord(row.record) : null;
    } catch {
      r = null;
    }
    this.recs.set(k, r);
    return r;
  }

  /** The units of a stage-4 analysis (each once), in a stable order. */
  static units(db: Database.Database, analysisId: string): UnitRow[] {
    return db
      .prepare(
        `SELECT id, unit_key, name, seconds, labeled, kind, class, source, store_id, review_reason,
                detail, inputs_json, copy_keys
         FROM audio_online_units WHERE analysis_id = ? ORDER BY labeled DESC, id`,
      )
      .all(analysisId) as UnitRow[];
  }

  build(u: UnitRow): MetaEvidence {
    const inputs = JSON.parse(u.inputs_json) as UnitInputs;
    const f = inputs.facts;
    const kind: MetaKind =
      u.kind === 'none_expected'
        ? /radio/i.test(u.review_reason ?? '')
          ? 'radio'
          : 'ai'
        : (u.class === 'auto' || u.class === 'review') && u.source && u.store_id
          ? 'record'
          : 'no_record';
    let record: RecordBrief | null = null;
    const candidates: CandidateBrief[] = [];
    if (kind === 'record') {
      const r = this.record(u.source!, u.store_id!);
      record = r ? recordBrief(r) : null;
      if (u.class === 'review') {
        const rows = this.getCands.all(u.id) as {
          source: string;
          store_id: string;
          via: string;
          verdict: string;
          sample_score: number | null;
        }[];
        // The best guess first, then the records that passed every check, then the others.
        rows.sort((a, b) => {
          const rank = (x: typeof a) =>
            x.source === u.source && x.store_id === u.store_id ? 0 : x.verdict === 'pass' ? 1 : 2;
          return rank(a) - rank(b);
        });
        for (const c of rows) {
          if (candidates.length >= 4) break;
          const cr = this.record(c.source, c.store_id);
          if (!cr || candidates.some((x) => x.record.id === `${cr.source}:${cr.id}`)) continue;
          candidates.push({
            record: recordBrief(cr),
            verdict: c.verdict,
            via: c.via,
            sampleScore: c.sample_score,
          });
        }
      }
    }
    const first = inputs.opening[0];
    let tags: Record<string, string> | null = null;
    if (first) {
      const t = this.getTags.get(first.id) as { tags_json: string | null } | undefined;
      try {
        const all = t?.tags_json ? (JSON.parse(t.tags_json) as Record<string, string>) : null;
        if (all) {
          tags = {};
          for (const k of TAG_KEYS)
            if (typeof all[k] === 'string' && all[k].trim()) tags[k] = all[k];
          if (!Object.keys(tags).length) tags = null;
        }
      } catch {
        tags = null;
      }
    }
    const paths = inputs.opening.slice(0, 5).map((o) => {
      const d = this.getDecoded.get(o.id) as { decoded_path: string | null } | undefined;
      return d?.decoded_path ?? o.rel;
    });
    return {
      kind,
      name: u.name,
      minutes: u.seconds === null ? null : Math.round((u.seconds / 60) * 10) / 10,
      files: f.files,
      copies: (JSON.parse(u.copy_keys) as string[]).length,
      stage4: { class: u.class, reason: u.review_reason, detail: u.detail },
      title: f.title,
      otherTitles: f.otherTitles,
      seriesTitles: f.seriesTitles ?? [],
      volume: f.volume,
      drama: f.drama !== null,
      dramaNumber: f.drama?.number ?? null,
      nameAuthors: f.authors,
      // The composer tag's names only: stage 4 also reads audiobook.jp's bare form (the artist
      // tag) as narrators (WP21f-2), which stage 5 reads from `tags` itself (`tagPeopleOf`), so
      // the evidence (and every stored answer for it) stays as it was.
      tagNarrators: f.narratorsFromArtist ? [] : f.narrators,
      paths,
      tags,
      record,
      candidates,
    };
  }
}
