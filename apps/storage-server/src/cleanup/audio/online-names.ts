/**
 * What stage 4 (WP21c) reads from a recording's names and tags. Pure.
 *
 * - Search titles come from the torrent file or folder name, never from Audiobookshelf's author
 *   field (the probes found narrators there). `searchTitle` is the reference sample's
 *   `clean_title` (refsample.py) so the same name gives the same request; `titleVariants` its
 *   `variants` plus the other digit width.
 * - Names that say nothing are never searched: "Unknown", "AI", digits only, the source folders.
 * - Authors known from the names: a leading `[著者] ` on a file or folder (TMW's
 *   `[Author] Series/`, Discord's `[小川糸] 食堂かたつむり`), never a `[4巻]`, `[第1弾]`, `[下巻]`
 *   or `[CD]`. From the tags: `artist` names the author when `composer` names the narrator
 *   (measured on the 193 labeled books: composer = narrator in 165 of the 168 files that have
 *   one; artist = author in 172, a narrator in 11 (none of them with a composer), someone else
 *   in 7).
 */
import { decodeMojibake } from './mojibake';

const AUDIO_EXT = /\.(m4b|m4a|mp3|mp4|wav|ogg|opus|flac|aac)$/i;
const ASIN_IN_NAME = /\[(B0[0-9A-Z]{8}|\d{9}[\dX])\]/g;
const STORE_IN_NAME = /\[(audiobook\.jp|kikubon|dwango)\s+(\d+)\]/g;
const KANA_KANJI = /[\u3040-\u30ff\u4e00-\u9fff]/;

/** Imprint labels at the end of a name (refsample's LABELS). */
const LABELS =
  /\s*(ガガガ文庫|HJ文庫|MF文庫J|電撃文庫|角川文庫|講談社文庫|GA文庫|ファミ通文庫|ダッシュエックス文庫|Kラノベブックス|オーバーラップ文庫|角川スニーカー文庫|富士見ファンタジア文庫)\S*$/u;

/** refsample.py's demojibake: a name with no kana/kanji that decodes from CP437 to Shift-JIS. */
function demojibake(s: string): string {
  if (KANA_KANJI.test(s)) return s;
  return decodeMojibake(s) ?? s;
}

/** refsample.py's clean_title: the title to search for, from one file or folder name. */
export function searchTitle(name: string): string {
  let n = demojibake(name);
  let t = AUDIO_EXT.test(n) ? n.slice(0, n.lastIndexOf('.')) : n;
  t = t.replace(ASIN_IN_NAME, '').replace(STORE_IN_NAME, '');
  t = t.replace(/^(Vol [\d.]+|Bonus|CD \d+) - /, '');
  t = t.replace(/^\[\d+\]\s*/, '');
  t = t.replace(/^\[[\d.]+巻[^\]]*\]\s*/, '');
  t = t.replace(/^\[[^\]]+\]\s+/, '');
  t = t.replace(/_?\s*[（(][^)）]*[)）]\s*$/, '');
  t = t.replace(/【[^】]*】/g, '');
  t = t.split('꞉').join('：').split('_').join(' ');
  n = t.replace(/\s+/g, ' ').trim();
  return n;
}

/** A name that says nothing about the book (never searched). */
export function meaningless(q: string): boolean {
  return (
    q.length < 2 ||
    /^[\d\-\s]+$/.test(q) ||
    /^(new|moved|Discord|MAM|_?Unknown|Unknown|AI|audiobooks?)$/i.test(q) ||
    /^TMW Japanese Audiobooks Collection/i.test(q)
  );
}

/** refsample.py's variants (NFKC, a space before the last number, no imprint, no number), plus
 * the other digit width: the variants tried, in order, before the search gives up. */
export function titleVariants(t: string): string[] {
  const out = [t];
  const add = (x: string) => {
    if (x && !out.includes(x)) out.push(x);
  };
  const n = t.normalize('NFKC');
  add(n);
  add(n.replace(/([^\s\d])(\d+)$/u, '$1 $2'));
  add(n.replace(LABELS, ''));
  add(n.replace(/\s*\d+$/, ''));
  // Full-width digits (the store may print "４" where the name has "4", or the reverse).
  add(n.replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0)));
  return out;
}

/** The person in a leading `[著者] ` (not a volume, part, CD or store tag). */
export function authorFromName(name: string): string | null {
  const m = /^\[([^\]]+)\]\s/.exec(demojibake(name).normalize('NFKC'));
  if (!m) return null;
  const v = m[1].trim();
  // Volume, part, edition and store tags, never a name (田中 has 中 but is a name).
  if (
    /\d|巻|弾|CD|kikubon|audiobook|dwango/i.test(v) ||
    /^(上|中|下|前編|後編|新装版|完全版)$/.test(v) ||
    /(編|話|版)$/.test(v)
  )
    return null;
  return KANA_KANJI.test(v) || /^[A-Za-z .'-]{3,}$/.test(v) ? v : null;
}

/** Names in one tag value ("小野 大輔, 杉田 智和"). */
export function tagPeople(v: string | null | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[,、，/／;；]|\s+(?:and|&)\s+|＆/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

/** Lower case, NFKC, no spaces, dots or punctuation: how names are compared. */
export function personKey(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000・･.,，、'"’‐\-ー=＝]/gu, '');
}

export interface FileTags {
  artist?: string;
  album_artist?: string;
  composer?: string;
  album?: string;
  title?: string;
  [k: string]: string | undefined;
}

/** What the tags say about the people: authors only when a composer names the narrators. */
export function peopleFromTags(tags: FileTags | null): { authors: string[]; narrators: string[] } {
  if (!tags) return { authors: [], narrators: [] };
  const narrators = tagPeople(tags.composer);
  const authors = narrators.length ? tagPeople(tags.artist ?? tags.album_artist) : [];
  return { authors, narrators };
}
