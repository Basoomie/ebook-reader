/**
 * Audiobook stage 5's rules (WP21d), pure: each field's value from the evidence record and
 * whether the rules are sure (automatic) or the field is open for the models. The rules the
 * user confirmed (audiobook-cleanup.md "Reference sample", 2026-11-18):
 *
 * - Title: Calibre's title rules (store markers out, volume numbers and real subtitles kept,
 *   light width normalization) and Audible's prefixes out ([17巻], [5.5巻], [9巻・短編集], [CD9]);
 *   imprint names out of titles and series (ガガガ文庫, HJ文庫(ホビージャパン), 幻冬舎新書).
 *   The subtitle field stays empty (a real subtitle stays in the title).
 * - Authors: every real author in the source's order; 原作 counts. Translators and supervisors
 *   are never authors, even when Audible lists them without a role (ホモ・デウス 柴田裕之,
 *   源氏物語 与謝野晶子): role markers and the description find some, the models the rest.
 * - Narrators: the store record's; the composer tag is evidence only (stage 4 settled the
 *   differences by sample audio).
 * - Series: Audible's name and reading-order position (sort); the position follows the real
 *   reading order (Audible's can be wrong: 私が殺した少女); fallback the torrent's [NN]; imprints
 *   are never series; drama CDs in "<series> ドラマCD" (numbered) and in the series without a
 *   number; anthology series kept as extra series.
 * - Unknown values are unknown (null), never "none".
 */
import { NA, normalizeName, lightNormalize, cleanTitle, looksLikeMojibake } from '../title-rules';
import type { RulesValue } from '../ai/types';
import type { MetaEvidence, RecordBrief } from './meta-evidence';

export interface SeriesEntry {
  name: string;
  /** Reading-order position; null = in the series without a number. */
  position: number | null;
  /** The printed label (Audible's sequence), for display. */
  label: string | null;
}

/** The fields the models answer. */
export const MODEL_FIELDS = ['record', 'title', 'authors', 'narrators', 'series', 'drama'] as const;
export type ModelField = (typeof MODEL_FIELDS)[number];

export interface MetaRules {
  record: RulesValue<string> | null;
  title: RulesValue<string>;
  authors: RulesValue<string[]>;
  narrators: RulesValue<string[]>;
  series: RulesValue<SeriesEntry[]>;
  drama: RulesValue<boolean>;
}

/** Fields taken from the chosen record by rules alone (no models). */
export interface StoreFields {
  publisher: string | null;
  year: number | null;
  language: string | null;
  storeId: string | null;
  description: string | null;
  cover: string | null;
}

const nfkc = (s: string) => s.normalize('NFKC');

// ---------------------------------------------------------------------------------------------
// titles

/** Imprints the audiobook titles carry without brackets (live and labeled records). */
const BARE_IMPRINT =
  /[\s\u3000]+((?:[^\s\u3000]*?(?:文庫|新書|ノベルス|ノベルズ|ブックス|BOOKS|Books))(?:\s*[(（][^()（）]*[)）])?)\s*$/u;

/** A leading [..] (Audible's [17巻], [CD9], [9巻・短編集]; a scanner's [author]). */
const LEADING_BRACKET = /^\s*[[［][^\]］]*[\]］]\s*/u;
/** A trailing ": （小学館）" (Audible joins title and publisher). */
const COLON_PUBLISHER = /\s*[:：꞉]\s*[(（][^()（）]*[)）]\s*$/u;
/** kikubon's and audiobook.jp's trailing ＜collection＞. */
const ANGLE_TAIL = /\s*[＜<]([^＜＞<>]+)[＞>]\s*$/u;
/** ＜上＞, ＜下＞, ＜2＞: a volume marker, part of the title. */
const VOLUME_MARK = /^\s*(上|中|下|前編|中編|後編|前|後|\d+(\.\d+)?|\d+[巻部])\s*$/u;

function angleTail(s: string): RegExpExecArray | null {
  const m = ANGLE_TAIL.exec(s);
  return m && m.index > 0 && !VOLUME_MARK.test(m[1].normalize('NFKC')) ? m : null;
}

/** The store title cleaned (without the subtitle). */
export function cleanStoreTitle(title: string): string {
  let s = title.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(LEADING_BRACKET, '');
    s = s.replace(COLON_PUBLISHER, '');
    const angle = angleTail(s);
    if (angle) s = s.slice(0, angle.index);
    const imp = BARE_IMPRINT.exec(s);
    if (imp && imp.index > 0) s = s.slice(0, imp.index);
    s = cleanTitle(s);
    if (s === before) break;
  }
  return s.trim();
}

/** The series a kikubon/audiobook.jp title names in ＜…＞ at its end. */
export function angleSeries(title: string): string | null {
  const m = angleTail(title.trim());
  return m ? lightNormalize(m[1]) : null;
}

const NOT_SUBTITLE =
  /文庫|新書|ノベル|ブックス|books|ラノベ|シリーズ|出版|書房|書店|社$|kadokawa|文藝春秋|studios|オーディオ|audible|^\s*[(（].*[)）]\s*$/iu;

/** A subtitle that is a real subtitle (not a publisher, label or series name). */
export function realSubtitle(r: RecordBrief): string | null {
  const sub = r.subtitle?.trim();
  if (!sub) return null;
  const n = nfkc(sub);
  if (NOT_SUBTITLE.test(n)) return null;
  if (r.publisher && (NA(n).includes(NA(r.publisher)) || NA(r.publisher).includes(NA(n))))
    return null;
  if (
    r.series.some((s) => NA(s.name) && (NA(n).includes(NA(s.name)) || NA(s.name).includes(NA(n))))
  )
    return null;
  if (NA(r.title).includes(NA(n))) return null;
  return sub;
}

// ---------------------------------------------------------------------------------------------
// people

const KEEP_ROLES = /^(著|作|著者|作者|原作|原案|文|作・文|編著)$/u;
const ROLE_PREFIX =
  /^\s*(著|作|著者|作者|原作|原案|文|作・文|訳|翻訳|監修|監訳|編|編集|編著|イラスト|絵|画|朗読|解説)\s*[/／:：]\s*/u;
const ROLE_SUFFIX =
  /\s*[（(]\s*(著|作|著者|原作|原案|文|訳|翻訳|監修|監訳|編|編集|編著|イラスト|絵|画|朗読|解説)\s*[)）]\s*$/u;

/** A listed name and the role written with it (null = none written). */
export function nameRole(listed: string): { name: string; role: string | null } {
  const p = ROLE_PREFIX.exec(listed);
  if (p) return { name: listed.slice(p[0].length).trim(), role: p[1] };
  const s = ROLE_SUFFIX.exec(listed);
  if (s) return { name: listed.slice(0, s.index).trim(), role: s[1] };
  return { name: listed.trim(), role: null };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compact = (s: string) => nfkc(s).replace(/[\s\u3000]/gu, '');

/** True when the description names this person as translator or supervisor. */
export function describedAsTranslator(name: string, description: string): boolean {
  const n = compact(name);
  if (n.length < 2 || !description) return false;
  const d = compact(description);
  const e = esc(n);
  return (
    new RegExp(
      `${e}(?:氏)?(?:による|の)?(?:新訳|現代語訳|翻訳|全訳|抄訳|完訳|訳|監修|監訳)`,
      'u',
    ).test(d) ||
    new RegExp(`(?:翻訳|訳者|訳|監修|監訳)(?:者)?[:：/／・]${e}`, 'u').test(d) ||
    new RegExp(`${e}[（(](?:訳|翻訳|監修|監訳)[)）]`, 'u').test(d)
  );
}

const FOREIGN = /^[ァ-ヴー・=＝\s]+$|^[A-Za-z .'-]+$/u;
const JAPANESE = /[一-龥]/u;

export function names(list: string[]): string[] {
  const out: string[] = [];
  for (const x of list) {
    const n = normalizeName(x);
    if (n && !out.some((y) => NA(y) === NA(n))) out.push(n);
  }
  return out;
}

/** The record's authors: roles and translators out (and why the rules are unsure). */
export function recordAuthors(r: RecordBrief): RulesValue<string[]> {
  if (!r.authors.length) return { value: null, auto: false, reason: 'The record lists no authors' };
  const kept: { name: string; role: string | null }[] = [];
  let dropped = 0;
  for (const listed of r.authors) {
    const { name, role } = nameRole(listed);
    if (!name) continue;
    if (role && !KEEP_ROLES.test(role)) {
      dropped++;
      continue;
    }
    if (r.publisher && NA(name) === NA(r.publisher)) {
      dropped++;
      continue;
    }
    if (describedAsTranslator(name, r.description)) {
      dropped++;
      continue;
    }
    kept.push({ name, role });
  }
  const value = names(kept.map((k) => k.name));
  if (!value.length)
    return {
      value: [],
      auto: false,
      reason: 'Every listed name is a translator, editor or company',
    };
  // A Japanese name with no role next to a foreign original author: often the translator,
  // listed as an author without a role (ホモ・デウス, ソクラテスの弁明, ハンガー・ゲーム).
  if (
    kept.length >= 2 &&
    kept.some((k) => FOREIGN.test(nfkc(k.name).trim())) &&
    kept.some((k) => !k.role && JAPANESE.test(k.name) && !FOREIGN.test(nfkc(k.name).trim()))
  )
    return {
      value,
      auto: false,
      reason: 'A Japanese name next to a foreign author: possibly the translator',
    };
  return { value, auto: true, reason: dropped ? null : null };
}

// ---------------------------------------------------------------------------------------------
// series

const IMPRINT_SERIES = /(文庫|新書|ノベルス|ノベルズ|ブックス|BOOKS|レーベル)$/iu;
const DRAMA = /ドラマ\s*CD|ドラマＣＤ|\[CD\d*\]|［CD\d*］/iu;

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(nfkc(String(v)).trim());
  return Number.isFinite(n) ? n : null;
}

/** A printed label that is a plain volume number (5, 5.5, 上, 2 下, 前編). */
function plainSequence(seq: string | null): boolean {
  if (seq === null) return true;
  const s = nfkc(seq).trim();
  return /^\d+(\.\d+)?$/.test(s) || /^(\d+\s*)?(上|中|下|前編|後編|前|後)$/.test(s);
}

/** The torrent's reading-order prefix "[NN] " of the file, and its "[Author] Series" folder. */
export function torrentSeries(paths: string[]): { folder: string | null; nn: number | null } {
  const p = paths[0];
  if (!p) return { folder: null, nn: null };
  const segs = p.split('/');
  const file = segs[segs.length - 1] ?? '';
  const parent = segs.length >= 2 ? segs[segs.length - 2] : '';
  const nnm = /^\s*\[(\d+(?:\.\d+)?)\]\s/u.exec(nfkc(file));
  const fm = /^\s*\[[^\]]+\]\s*(.+)$/u.exec(parent);
  return {
    folder: fm ? lightNormalize(fm[1]).trim() : null,
    nn: nnm ? Number(nnm[1]) : null,
  };
}

/** AI books: AI/<series folder>/<title><number>. */
function aiSeries(ev: MetaEvidence): SeriesEntry[] | null {
  const p = ev.paths[0] ?? '';
  const segs = p.split('/');
  if (segs[0] !== 'AI' || segs.length < 3) return null;
  const name = lightNormalize(segs[1]);
  const m = /(\d+(?:\.\d+)?)\s*$/u.exec(nfkc(ev.title));
  return [{ name, position: m ? Number(m[1]) : null, label: m ? m[1] : null }];
}

export function recordSeries(r: RecordBrief, ev: MetaEvidence): RulesValue<SeriesEntry[]> {
  const out: SeriesEntry[] = [];
  const reasons: string[] = [];
  const t = torrentSeries(ev.paths);
  for (const s of r.series) {
    const raw = nfkc(s.name).trim();
    if (!raw) continue;
    const drama = /^\[CD\]/iu.test(raw) || /ドラマ\s*CD\s*$/iu.test(raw);
    const base = lightNormalize(
      raw.replace(/^\[CD\]\s*/iu, '').replace(/\s*ドラマ\s*CD\s*$/iu, ''),
    );
    if (!base || IMPRINT_SERIES.test(base)) continue;
    const pos = num(s.sort) ?? (plainSequence(s.sequence) ? num(s.sequence) : null);
    if (!plainSequence(s.sequence))
      reasons.push(`Audible's printed label "${s.sequence}" is not a plain volume number`);
    if (compact(base).length <= 2) reasons.push(`A very short series name ("${base}")`);
    if (drama) {
      out.push({ name: `${base} ドラマCD`, position: pos, label: s.sequence });
      if (!out.some((x) => NA(x.name) === NA(base)))
        out.push({ name: base, position: null, label: 'drama' });
    } else if (!out.some((x) => NA(x.name) === NA(base))) {
      out.push({ name: base, position: pos, label: s.sequence });
    }
  }
  if (out.length) {
    const main = out.find((x) => !/ドラマCD$/.test(x.name) && x.position !== null);
    if (
      main &&
      t.nn !== null &&
      t.folder &&
      NA(t.folder).includes(NA(main.name)) &&
      t.nn !== main.position
    )
      reasons.push(`Audible's position ${main.position} differs from the torrent's [${t.nn}]`);
    return { value: out, auto: reasons.length === 0, reason: reasons.join('; ') || null };
  }
  return fallbackSeries(r, ev);
}

/** No series from the record: the torrent's "[Author] Series/[NN] …", kikubon's ＜…＞. */
function fallbackSeries(r: RecordBrief | null, ev: MetaEvidence): RulesValue<SeriesEntry[]> {
  const t = torrentSeries(ev.paths);
  if (t.folder && t.nn !== null)
    return { value: [{ name: t.folder, position: t.nn, label: String(t.nn) }], auto: true };
  const angle = r ? angleSeries(r.title) : null;
  if (angle) return { value: [{ name: angle, position: null, label: null }], auto: true };
  if (r?.source === 'audible' && !r.fromSearchPage) return { value: [], auto: true };
  return { value: null, auto: false, reason: 'The store has no series data' };
}

// ---------------------------------------------------------------------------------------------
// all fields

export function isDramaEvidence(ev: MetaEvidence, r: RecordBrief | null): boolean {
  if (ev.drama) return true;
  if (ev.paths.some((p) => DRAMA.test(nfkc(p)))) return true;
  if (!r) return false;
  return (
    DRAMA.test(nfkc(r.title)) ||
    r.series.some((s) => DRAMA.test(nfkc(s.name)) || /^\[CD\]/iu.test(nfkc(s.name)))
  );
}

/** The title of a recording with no store record: the file's own (stage 4's cleaned name). */
function fileTitle(ev: MetaEvidence): string | null {
  const tag = ev.tags?.title;
  const t = tag && !looksLikeMojibake(tag) && NA(tag).length >= 1 ? tag : ev.title;
  const c = cleanStoreTitle(t || ev.name);
  return c || null;
}

/**
 * The rules' values. `record` is the record the fields come from (stage 4's choice, or the one
 * the models picked); `confirmed` = that record is accepted (stage 4 auto, or both models).
 */
export function metaRules(
  ev: MetaEvidence,
  record: RecordBrief | null,
  confirmed: boolean,
): MetaRules {
  const drama: RulesValue<boolean> = { value: isDramaEvidence(ev, record), auto: true };
  const recordRule: RulesValue<string> | null =
    ev.kind === 'record' && ev.record
      ? {
          value: ev.record.id,
          auto: ev.stage4.class === 'auto',
          reason: ev.stage4.class === 'auto' ? null : `Stage 4: ${ev.stage4.reason ?? 'review'}`,
        }
      : null;
  if (ev.kind === 'ai' || ev.kind === 'radio' || !record) {
    const why =
      ev.kind === 'ai'
        ? 'AI audiobook: from the names'
        : ev.kind === 'radio'
          ? 'Radio clip: from the names'
          : 'No store record: from the tags and names';
    const series =
      ev.kind === 'ai' ? aiSeries(ev) : ev.kind === 'radio' ? null : fallbackSeries(null, ev).value;
    const t = torrentSeries(ev.paths);
    return {
      record: recordRule,
      title: { value: fileTitle(ev), auto: false, reason: why },
      authors: {
        value: ev.nameAuthors.length ? names(ev.nameAuthors) : null,
        auto: false,
        reason: why,
      },
      narrators: {
        value: ev.tagNarrators.length ? names(ev.tagNarrators) : null,
        auto: false,
        reason: why,
      },
      series: {
        value: series,
        // The torrent's "[Author] Series/[NN]" is as sure for these as for the others.
        auto: ev.kind === 'no_record' && !!t.folder && t.nn !== null,
        reason: why,
      },
      drama,
    };
  }
  const unsure = confirmed
    ? null
    : `The store record is not confirmed (${ev.stage4.reason ?? 'review'})`;
  // Title
  const base = cleanStoreTitle(record.title);
  const sub = realSubtitle(record);
  const title = sub ? `${base} ${lightNormalize(sub)}` : base;
  let titleReason: string | null = unsure;
  if (!titleReason && (looksLikeMojibake(record.title) || !base))
    titleReason = 'The store title is damaged or empty';
  if (!titleReason && /[[［【＜<]/u.test(base)) titleReason = 'A bracket is left in the title';
  if (!titleReason && sub)
    titleReason = `Audible's subtitle "${sub}" may or may not belong to the title`;
  // Authors, narrators, series
  const authors = recordAuthors(record);
  const narr = names(record.narrators);
  const series = recordSeries(record, ev);
  return {
    record: recordRule,
    title: { value: title || null, auto: !titleReason, reason: titleReason },
    authors: confirmed ? authors : { ...authors, auto: false, reason: unsure },
    narrators: {
      value: narr.length ? narr : null,
      auto: confirmed && narr.length > 0,
      reason: unsure ?? (narr.length ? null : 'The record lists no narrators'),
    },
    series: confirmed ? series : { ...series, auto: false, reason: unsure },
    drama,
  };
}

/** Publisher, year, language, store id, description, cover: the record's, by rules alone. */
export function storeFields(record: RecordBrief | null): StoreFields {
  if (!record)
    return {
      publisher: null,
      year: null,
      language: null,
      storeId: null,
      description: null,
      cover: null,
    };
  const y = record.releaseDate ? /(\d{4})/.exec(nfkc(record.releaseDate)) : null;
  const lang = record.language?.toLowerCase();
  return {
    publisher: record.publisher ? lightNormalize(record.publisher) : null,
    year: y ? Number(y[1]) : null,
    language:
      lang === 'japanese' || lang === 'ja' || record.source !== 'audible'
        ? 'ja'
        : (record.language ?? null),
    storeId: record.id,
    description: record.description || null,
    cover: record.cover,
  };
}
