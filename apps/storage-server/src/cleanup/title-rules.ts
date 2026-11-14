/**
 * Stage 2 title and name rules (WP20b), ported from the measured rules (`rules_v3.py`:
 * strip_markers, strip_imprint, clean, N, NA and the author name form of rules v2).
 *
 * Two flavours of the title cleaning:
 * - `cleanTitleV3` behaves exactly like rules_v3's clean() without online sources (NFKC on the
 *   output, edition markers removed). Only the reproduction of the measurement uses it.
 * - `cleanTitle` is what stage 2 writes: the same removals, but on the light-normalized title
 *   (full-width Latin letters, digits and spaces become half-width; Japanese punctuation stays
 *   as printed) and edition markers stay in the title (decided 2026-11-13).
 *
 * Python and JavaScript regexes differ in what \s and \d match; the classes below copy
 * Python's (str.isspace / Unicode digits) so the port matches the measurement.
 */

const ch = (...codes: number[]) => String.fromCharCode(...codes);
const range = (from: number, to: number) => `${ch(from)}-${ch(to)}`;

/** Python's \s for str patterns (str.isspace): JS \s plus 0x1c-0x1f and 0x85, minus 0xfeff. */
const PY_WS =
  '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0' +
  ch(0x1680) +
  range(0x2000, 0x200a) +
  ch(0x2028, 0x2029, 0x202f, 0x205f, 0x3000);
const WS = `[${PY_WS}]`;
const IDEOGRAPHIC_SPACE = ch(0x3000);

/** Python's \d (Unicode decimal digits). */
const D = '\\p{Nd}';

const re = (source: string, flags = '') => new RegExp(source, `u${flags}`);

export const nfkc = (s: string | null | undefined): string => (s ?? '').normalize('NFKC');

/** Python's str.strip() (whitespace per str.isspace). */
export function pyStrip(s: string): string {
  return s.replace(re(`^${WS}+|${WS}+$`, 'g'), '');
}

/** rules_v3 N(): the title comparison (ignores spaces, subtitle punctuation, 06 = 6, 6巻 = 6). */
export function N(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  let t = nfkc(s);
  t = t.replace(re(`[\\(（【](${D}+)[\\)）】]`, 'g'), (_m, d: string) => d);
  t = t.replace(re(`(${D}+)巻`, 'g'), (_m, d: string) => d);
  t = t.replace(re(`(?<![${D}.])0+(${D})`, 'g'), (_m, d: string) => d);
  t = t.replace(re(`[${PY_WS}:：~～〜\\-―‐ー!！?？「」『』“”"'・]`, 'g'), '');
  return t.toLowerCase();
}

/** rules_v3 NA(): the name comparison (ignores spaces and parentheses). */
export function NA(s: string | null | undefined): string {
  return nfkc(s)
    .replace(re(`[${PY_WS}()（）]`, 'g'), '')
    .toLowerCase();
}

const MARKER =
  /特典|限定|SS|ＳＳ|書き下ろし|書下ろし|イラスト付|イラスト入|特装|電子|付き|付】|合本|新装版|雑誌/u;
const IMPRINT =
  /文庫|ノベル|ノベルス|ノベルズ|NOVELS|Novels|ブックス|BOOKS|Books|新書|コミックス|COMICS|BOX|NextPublishing|ラノベ|Kiss|キス|ドロップス|ミライデコ|ロマンス|ロイヤル|ルキア|f\)|フェアリー|DIGITAL|レーベル|研究会/u;
/**
 * Edition markers stay in the title (decided 2026-11-13: 新装版, (横書き版), 【電子特別版】,
 * イラスト完全版), and so do omnibus markers (合本版, 総集編), which stage 3 needs.
 */
const EDITION = /特別版|新装版|特装|完全版|横書き|合本|総集編/u;

/**
 * Light normalization (decided 2026-11-13): full-width Latin letters and digits and the
 * ideographic space become half-width, runs of spaces collapse; Japanese punctuation
 * (～ ― 〈〉 「」 ！ ？ ： （） 、) stays as printed.
 */
export function lightNormalize(s: string | null | undefined): string {
  let out = '';
  for (const c of s ?? '') {
    const code = c.codePointAt(0)!;
    if (
      (code >= 0xff10 && code <= 0xff19) ||
      (code >= 0xff21 && code <= 0xff3a) ||
      (code >= 0xff41 && code <= 0xff5a)
    ) {
      out += String.fromCharCode(code - 0xfee0);
    } else if (code === 0x3000) {
      out += ' ';
    } else {
      out += c;
    }
  }
  return pyStrip(out.replace(/ {2,}/gu, ' ').replace(re(`${WS}{2,}`, 'g'), ' '));
}

type Flavour = 'v3' | 'stage2';

function stripMarkers(t: string, flavour: Flavour): string {
  let s = pyStrip(flavour === 'v3' ? nfkc(t) : lightNormalize(t));
  // [author] prefix (the scanners' file titles), half- or full-width brackets.
  s = s.replace(re(`^${WS}*[\\[［][^\\]］]*[\\]］]${WS}*`), '');
  // 【3】 is a volume number, not a marker.
  s = s.replace(re(`【(${D}+)】`, 'g'), (_m, d: string) => ` ${d}`);
  s = s.replace(/【([^】]*)】/gu, (m: string, inner: string) => {
    if (!MARKER.test(inner)) return m;
    if (flavour === 'stage2' && EDITION.test(inner)) return m;
    return '';
  });
  s = s.replace(/[[［](改版|雑誌)[\]］]/gu, '');
  return pyStrip(s.replace(re(`${WS}+`, 'g'), ' '));
}

/** A trailing (…) is removed only when it is a known imprint/label (rules v2). */
function stripImprint(t: string, flavour: Flavour): string {
  let s = t;
  const open = flavour === 'v3' ? '\\(' : '[\\(（]';
  const close = flavour === 'v3' ? '\\)' : '[\\)）]';
  const notParen = flavour === 'v3' ? '[^()]' : '[^()（）]';
  const tail = re(
    `${WS}*${open}(${notParen}*(?:${open}${notParen}*${close}${notParen}*)?)${close}${WS}*$`,
  );
  for (;;) {
    const m = tail.exec(s);
    if (!m) break;
    const inner = pyStrip(m[1]);
    // IMPRINT is matched on the NFKC form so full-width labels count the same way.
    if (IMPRINT.test(nfkc(inner)) || (flavour === 'stage2' && IMPRINT.test(inner))) {
      s = pyStrip(s.slice(0, m.index));
    } else {
      break;
    }
  }
  return s;
}

function cleanWith(t: string | null | undefined, flavour: Flavour): string {
  if (!t) return t ?? '';
  let s = stripImprint(stripMarkers(t, flavour), flavour);
  s = s.replace(re(`${WS}*(中公文庫|新潮文庫)$`), '');
  return s;
}

/** rules_v3 clean() with no confirming sources (no appended series removed). */
export function cleanTitleV3(t: string | null | undefined): string {
  return cleanWith(t, 'v3');
}

/**
 * The title stage 2 proposes: rules_v3's removals on the light-normalized title, edition
 * markers kept, and a trailing " - <author>" removed when it names one of the given authors.
 * Appended series names are left (they need the online sources, stage 4).
 */
export function cleanTitle(t: string | null | undefined, authors: readonly string[] = []): string {
  let s = cleanWith(t, 'stage2');
  const m = re(`^(.+?)${WS}+[-‐－―]${WS}+([^-‐－―]+)$`).exec(s);
  if (m) {
    const tail = NA(m[2]);
    if (tail !== '' && authors.some((a) => NA(a) === tail)) s = pyStrip(m[1]);
  }
  return lightNormalize(s);
}

const KATAKANA_NAME = /^[ァ-ヴー]+[\s]+[ァ-ヴー][ァ-ヴー\s]*$/u;
const HAS_KANJI_OR_HIRAGANA = /[一-龥ぁ-ん]/u;

/**
 * The author name form (rules v2, decided): NFKC (full/half-width unified), katakana foreign
 * names with a space get ・ (ウィリアム・シェークスピア), Japanese names lose the space between
 * family and given name, other names keep single spaces.
 */
export function normalizeName(name: string | null | undefined): string {
  const n = pyStrip(nfkc(name).replace(re(WS, 'g'), ' '));
  if (KATAKANA_NAME.test(n)) return n.replace(/\s+/gu, '・');
  if (HAS_KANJI_OR_HIRAGANA.test(n)) return n.replace(/\s+/gu, '');
  return n.replace(/\s{2,}/gu, ' ');
}

/**
 * UTF-8 text that was read as Shift-JIS (seen in both Calibre and files): lead bytes of
 * UTF-8 Japanese turn into a few rare kanji (縺 繧 繝 …) plus half-width katakana and U+FFFD.
 */
export function looksLikeMojibake(s: string | null | undefined): boolean {
  if (!s) return false;
  const chars = [...s];
  let odd = 0;
  for (const c of chars) {
    const code = c.codePointAt(0)!;
    if ('縺繧繝譁蜷荳驕螟遘霑隱莠蟆謨逕諱髮豕逧蠖螂遖郢陦謌'.includes(c)) odd += 1;
    else if (code >= 0xff61 && code <= 0xff9f) odd += 1;
    else if (code === 0xfffd) odd += 1;
  }
  return odd >= 3 && odd / chars.length >= 0.2;
}

/** A creator that is a label/imprint/company rather than a person ("編集部" names are real authors). */
export function looksLikeImprint(name: string | null | undefined): boolean {
  const n = nfkc(name);
  return /(文庫|出版|出版社|書房|書店|ノベルス|ノベルズ|ブックス|レーベル)$|株式会社|有限会社|合同会社/u.test(
    n,
  );
}

export function isUnknownName(name: string | null | undefined): boolean {
  const n = pyStrip(nfkc(name)).toLowerCase();
  return n === '' || n === 'unknown' || n === '不明';
}

/** Characters calibre's title_sort drops at the start (calibre.ebooks.metadata._ignore_starts). */
const IGNORE_STARTS = `'"${ch(0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x2032, 0x2033)}`;

/**
 * calibre's default title_sort (library_order, English articles; Japanese has no article
 * list, so calibre uses the English one): "The X" → "X, The".
 */
export function titleSort(title: string): string {
  let t = pyStrip(title);
  if (t && IGNORE_STARTS.includes(t[0])) t = t.slice(1);
  const m = /^(A\s+|The\s+|An\s+)/iu.exec(t);
  if (m) {
    t = `${t.slice(m[1].length)}, ${m[1]}`;
    if (t && IGNORE_STARTS.includes(t[0])) t = t.slice(1);
  }
  return pyStrip(t);
}

export { IDEOGRAPHIC_SPACE };
