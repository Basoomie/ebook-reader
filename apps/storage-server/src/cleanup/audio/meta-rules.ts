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
 *   differences by sample audio). A publisher, a store or a production company is never a
 *   narrator or an author (でじじ, パンローリング; 2026-11-20); what is left, or nothing, is the value.
 * - Series: Audible's name and reading-order position (sort); the position follows the real
 *   reading order (Audible's can be wrong: 私が殺した少女); fallback the torrent's [NN]; imprints
 *   are never series; drama CDs in "<series> ドラマCD" (numbered) and in the series without a
 *   number; anthology series kept as extra series.
 * - Unknown values are unknown (null), never "none". A volume number in the title with no store
 *   series is "unknown" (not "none"), left for the ebook pass (WP21g).
 * - The WP21d follow-up (2026-11-20, from the 50-recording spot check): drama is true only when
 *   the names, title or series say ドラマCD (the models cannot make it true); the rules' title
 *   stands against a model that only drops an edition mark or adds a volume number; no store
 *   record: the artist tag is the author and the composer tag the narrator (artist alone: the
 *   narrators in audiobook.jp's bare tag form, else the author; WP21f-1 stop 2), unconfirmed.
 */
import { NA, normalizeName, lightNormalize, cleanTitle, looksLikeMojibake } from '../title-rules';
import type { RulesValue } from '../ai-decide/types';
import { artistIsNarrator } from './online-names';
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

/**
 * Stores and production labels that stores list as an author, never one. でじじ (digigi) is
 * Pan Rolling's own audiobook store: Audible lists it as the author on 4 recordings of the
 * library (verified 2026-11-19: アイヌ神話 with its author 中田千畝; 竹取物語, an anthology and
 * 日本国憲法 with no author).
 */
const STORE_NAMES = /^(でじじ|digigi)$/iu;

/**
 * Names that are never a narrator or an author: stores, publishers and production companies the
 * stores list in a person's place (the 50-recording spot check, 2026-11-20): でじじ and
 * パンローリング (Pan Rolling's own audiobook store and its publisher: Audible lists them as the
 * narrator of its own titles, and on some as the author), いずみ書房, フロンティアワークス (the
 * publisher of 名作文学(笑)), ジュピタースタジオ (a production company). Matched on the whole
 * name, spaces and width ignored.
 */
const NOT_PEOPLE =
  /^(でじじ|digigi|パンローリング(株式会社)?|panrolling|いずみ書房|フロンティアワークス|ジュピタースタジオ|オトバンク|otobank|audible(studios)?)$/iu;
/** A publisher name that is a company (a person publishing under their own name is not). */
const COMPANY = /株式会社|\(株\)|有限会社|出版|書房|書店|スタジオ|studios?$|社$/iu;

/** True when a listed name is a store, a publisher or a company, not a person. */
export function isNotPerson(listed: string, publisher: string | null): boolean {
  const n = compact(nameRole(listed).name);
  if (!n) return false;
  if (NOT_PEOPLE.test(n)) return true;
  return (
    !!publisher &&
    COMPANY.test(nfkc(publisher)) &&
    n === compact(publisher).replace(/株式会社|\(株\)/gu, '')
  );
}

/** A narrator or author list without the stores and companies. */
export function peopleOnly(list: string[], publisher: string | null): string[] {
  return list.filter((x) => !isNotPerson(x, publisher));
}
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
    if (
      (r.publisher && NA(name) === NA(r.publisher)) ||
      STORE_NAMES.test(nfkc(name).trim()) ||
      isNotPerson(name, r.publisher)
    ) {
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

const IMPRINT_SERIES =
  /(文庫|新書|ノベルス|ノベルズ|ブックス|BOOKS|レーベル|オーディオブックス|朗読全集)$|^小学館の名作文芸朗読/iu;

/**
 * A series name that is an imprint or a publisher's collection, never a series of books: the
 * rules drop it from the store's series, the torrent's folder and the models' answers
 * (幻冬舎新書, 週刊東洋経済eビジネス新書, 星新一オーディオブックス, 吉川英治朗読文庫,
 * 小学館の名作文芸朗読 ~江戸川乱歩~, モバラジ研究会 江戸川乱歩朗読全集; 2026-11-20).
 */
export function isImprintSeries(name: string): boolean {
  const base = lightNormalize(
    nfkc(name)
      .replace(/^\[CD\]\s*/iu, '')
      .replace(/\s*ドラマ\s*CD\s*$/iu, ''),
  );
  return !!base && IMPRINT_SERIES.test(base);
}

/**
 * Edition marks in store titles (counted on the live library, 2026-11-20): 新装版 48, 完全版 25,
 * 新版 8, 新装改訂版 4, 新訳完全版 4, 新訳版 3, 文庫版 3, 特別版 2, 改訂版 2, 【通常版】 1. They stay
 * in the title; a model that only drops one does not change the rules' title.
 */
export const EDITION_MARKS =
  /新装改訂版|新装版|改訂新版|増補改訂版|増補版|改訂版|新訳完全版|新訳版|完全版|決定版|愛蔵版|文庫版|通常版|特別版|デジタル版|新版/gu;

const titleForm = (s: string) =>
  nfkc(s)
    .toLowerCase()
    .replace(/[\s\u3000・:：\-－~～〜〔〕[\]【】()（）〈〉《》<>＜＞「」『』]/gu, '');

/**
 * True when a model's title differs from the rules' only by a dropped edition mark and/or one
 * volume number it added (the rules printed none): "フルメタル・パニック！ 3 … 新装版" →
 * "… 3 …", "バチカン奇跡調査官 闇の黄金" → "バチカン奇跡調査官 3 闇の黄金".
 */
export function onlyEditionOrNumberChange(rules: string, model: string): boolean {
  if (rules === model) return false;
  const rMarks: string[] = nfkc(rules).match(EDITION_MARKS) ?? [];
  const mMarks: string[] = nfkc(model).match(EDITION_MARKS) ?? [];
  // A model may drop marks, never add or change one.
  if (mMarks.some((m) => !rMarks.includes(m))) return false;
  const r = titleForm(nfkc(rules).replace(EDITION_MARKS, ''));
  const strippedModel = nfkc(model).replace(EDITION_MARKS, '');
  if (titleForm(strippedModel) === r) return rMarks.length > mMarks.length;
  // One added number token (3, 10, 1巻), anywhere.
  const re = /\d+(?:\.\d+)?巻?/gu;
  for (const m of strippedModel.matchAll(re)) {
    const without = strippedModel.slice(0, m.index) + strippedModel.slice(m.index! + m[0].length);
    if (titleForm(without) === r) return true;
  }
  return false;
}

/**
 * A title with a printed volume number: the store title starts with "[3巻" (TMW's and Audible's
 * marker), or the cleaned title ends with a 1-3 digit number set off by a space or punctuation
 * (not glued to a word: ラブ&ポップ: トパーズ2, スローターハウス5 stay out), or has one before a
 * 〜 subtitle (主従そろって出稼ぎライフ！ 1 〜…).
 */
export function hasPrintedVolume(storeTitle: string): boolean {
  const raw = nfkc(storeTitle);
  if (/^\s*[[［]\s*\d+(?:\.\d+)?\s*巻/u.test(raw)) return true;
  const t = cleanStoreTitle(storeTitle);
  const n = nfkc(t);
  return (
    /(?<=\S[\s!！?？。…)）」』】])\d{1,3}$/u.test(n) ||
    /(?<=\S[\s!！?？。…)）」』】])\d{1,3}(?=\s*[〜～~])/u.test(n)
  );
}

/** The reason a series is left unknown for a volume number without store series (stage 5 reads it). */
export const VOLUME_NO_SERIES = 'A printed volume number and the store has no series data';
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
  // Reasons that leave Audible's own name and position standing (only the printed label is
  // odd: 第8巻, 2巻・前編, 番外編2巻, ""); any other reason leaves the series to the models.
  let labelOnly = 0;
  let unsorted = false;
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
    if (num(s.sort) === null) unsorted = true;
    if (!plainSequence(s.sequence)) {
      reasons.push(`Audible's printed label "${s.sequence}" is not a plain volume number`);
      labelOnly++;
    }
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
    // Audible's series stands, even against both models, when only its printed label is odd
    // and the torrent's [NN] doesn't contradict its position (user, 2026-11-19, after a random
    // check of 30 unlabeled recordings: Audible right on 22 of the 23 with a reading order; the
    // one error, 史上最強の哲学入門 東洋の哲人たち, is contradicted by its torrent's [02]).
    if (r.source === 'audible' && reasons.length && reasons.length === labelOnly && !unsorted)
      return { value: out, auto: true, final: true, reason: null };
    return { value: out, auto: reasons.length === 0, reason: reasons.join('; ') || null };
  }
  return fallbackSeries(r, ev);
}

/** No series from the record: the torrent's "[Author] Series/[NN] …", kikubon's ＜…＞. */
function fallbackSeries(r: RecordBrief | null, ev: MetaEvidence): RulesValue<SeriesEntry[]> {
  const t = torrentSeries(ev.paths);
  if (t.folder && t.nn !== null && !isImprintSeries(t.folder))
    return { value: [{ name: t.folder, position: t.nn, label: String(t.nn) }], auto: true };
  const angle = r ? angleSeries(r.title) : null;
  if (angle && !isImprintSeries(angle))
    return { value: [{ name: angle, position: null, label: null }], auto: true };
  if (r?.source === 'audible' && !r.fromSearchPage) {
    // A printed volume number with no series in the store is not "no series": it is unknown,
    // left for the ebook pass (WP21g) (user, 2026-11-20).
    if (hasPrintedVolume(r.title)) return { value: null, auto: false, reason: VOLUME_NO_SERIES };
    return { value: [], auto: true };
  }
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

/** A tag's people ("A, B; C"), without "ほか" and the stores and companies. */
function tagPeople(tag: string | undefined): string[] {
  if (!tag) return [];
  return names(
    tag
      .split(/\s*[,;，、；]\s*/u)
      .map((x) => x.trim())
      .filter((x) => x && !/^(ほか|他|その他|and others)$/iu.test(x) && !isNotPerson(x, null)),
  );
}

/**
 * The people of a recording with no store record, from its tags (WP21d follow-up, 2026-11-20;
 * measured on the labeled books: the composer tag was the narrator in 160 of 166, the artist tag
 * the author in 150 of those): with a composer tag the artist is the author and the composer the
 * narrator. With an artist tag alone it depends on the form of the tags (WP21f-1 stop 2,
 * measured on every recording of the library with a store record): in audiobook.jp's bare form
 * (genre "Audiobook", no album_artist, no date) the artist tag lists the narrators (328 of 330),
 * so the authors stay with the names; in every other form it is the author (the app's
 * downloads with genre "オーディオブック" 15 of 15, Audible's form 229 of 229).
 */
export function tagPeopleOf(ev: MetaEvidence): { authors: string[]; narrators: string[] } {
  const artist = tagPeople(ev.tags?.artist);
  const composer = tagPeople(ev.tags?.composer);
  if (composer.length)
    return { authors: artist.length ? artist : names(ev.nameAuthors), narrators: composer };
  if (artist.length && !artistIsNarrator(ev.tags))
    return { authors: artist, narrators: names(ev.tagNarrators) };
  return {
    authors: names(ev.nameAuthors),
    narrators: artist.length ? artist : names(ev.tagNarrators),
  };
}

/** audiobook.jp's bare tag form: shared with stage 4 (`online-names.ts`). */
export { artistIsNarrator };

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
  // True only when the names, title or series say ドラマCD; the models cannot make it true
  // (user, 2026-11-20: 43 cast-read novels were guessed true).
  const drama: RulesValue<boolean> = {
    value: isDramaEvidence(ev, record),
    auto: true,
    final: true,
  };
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
    const tagged =
      ev.kind === 'no_record'
        ? tagPeopleOf(ev)
        : { authors: names(ev.nameAuthors), narrators: names(ev.tagNarrators) };
    return {
      record: recordRule,
      title: { value: fileTitle(ev), auto: false, reason: why },
      authors: {
        value: tagged.authors.length ? tagged.authors : null,
        auto: false,
        reason: why,
      },
      narrators: {
        value: tagged.narrators.length ? tagged.narrators : null,
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
  // A bracket that only holds an edition mark ([新版], 【通常版】) is part of the title.
  const unmarked = base.replace(
    new RegExp(String.raw`[\[［【〔]\s*(?:${EDITION_MARKS.source})\s*[\]］】〕]`, 'gu'),
    '',
  );
  if (!titleReason && /[[［【＜<]/u.test(unmarked)) titleReason = 'A bracket is left in the title';
  if (!titleReason && sub)
    titleReason = `Audible's subtitle "${sub}" may or may not belong to the title`;
  // Authors, narrators, series
  const authors = recordAuthors(record);
  const narr = names(peopleOnly(record.narrators, record.publisher));
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
    series: confirmed ? series : { ...series, auto: false, final: false, reason: unsure },
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
