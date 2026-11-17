/**
 * Descriptions (plan section 6, `desc/desc.py` of 2026-11-12, ported in WP20d): which source is
 * this exact book, which copy of the text is used, and the marketing lines removed as whole lines.
 *
 * Fixes from fresh check D (2026-11-13), applied on top of the measured rules (`v: 2`):
 * - `セールスマン` is not a sale (46542: 活字箱伝説とセールスマン伝説);
 * - promotional lines the patterns missed: 累計○万部突破 without シリーズ and with a trailing
 *   。 (34296, 58960), TVアニメ放送開始/決定 (65590, 11162), 重版 (65590), コミックス同日発売
 *   (11162), 連動購入特典 (14709), 【電子特別版】SS特典付属 (6261).
 * The Amazon match in a manga category for a book with text (8671) is rejected before this runs
 * (stage4-rules.ts), so it never offers a description.
 */
import { N, NA, nfkc, pyStrip } from '../title-rules';
import { clean, decide, type RefRecord } from './rules-v3';

const BOILER = [
  'タブレットなど大きいディスプレイ',
  '電子版は紙書籍版と一部異なる',
  '出版社独自のフォント',
  '対象作品を購入後、アプリ',
  '通信状態のよいところ',
  '底本と同じクオリティのカラーイラスト',
  '同じ書名の出版物を底本とし',
  '放送日時は予告なく変更',
  '紙の雑誌と内容が一部異なる',
  'カラーページを含みます',
  'サイン版との重複購入',
  'のお試し版が収録されています',
  'を電子書籍化するにあたり、電子書籍としては不要な情報',
  '＜電子書籍について＞',
  '<電子書籍について>',
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each pattern must match the whole line (after NFKC and strip). */
const DROP_V1: [string, string][] = [
  ['store notice', `[※＊*]?\\s*.*(${BOILER.map(esc).join('|')}).*`],
  [
    'store bonus',
    '(?!.*収録).{0,50}(【[^】]*(特典|限定|SS|ＳＳ)[^】]*】|★[^★]*(特典|限定|SS)[^★]*★|「[^」]{1,10}」|特典|限定).{0,30}(付き|つき|付)[!！]*',
  ],
  ['store bonus', '[※]?(?!.*収録)電子(版|書籍)?(限定|特典)?.{0,30}特別付録つきです。?'],
  ['store bonus', '[【《★][^】》★]*(特典|限定|SS|ＳＳ)[^】》★]*[】》★][!！]*'],
  [
    'store bonus',
    '[※]?\\s*電子(書籍|版)?(には|では|限定で|版には|書籍版)?.{0,30}(特典|書き?下ろし|描き下ろし).{0,70}(収録|付き|つき)(されています|しています|です)?[。!！]?',
  ],
  [
    'cross-promo',
    '(?=.{0,45}$).*(コミカライズ|アニメ|ドラマCD|スピンオフ|重版).*(発売|進行中|決定|配信中|放映中|連載中|重版)[!！]*.*',
  ],
  [
    'cross-promo',
    '.{0,40}(コミカライズ|アニメ化|映画化|ドラマ化|舞台化|ゲーム化)(企画)?(決定|進行中|連載中|好評連載中|放送中|配信中|スタート)[!！]*',
  ],
  ['cross-promo', '.{0,30}(同時発売|好評発売中|絶賛発売中|発売中)[!！]*'],
  [
    'sales claim',
    '.{0,10}(シリーズ)?(累計|発行部数).{0,15}(万部|部)(突破)?[!！]*([（(][^）)]*[）)])?',
  ],
  [
    'price/campaign',
    '.{0,40}(キャンペーン|セール|ポイント還元|限定価格|特別価格|いまなら\\d+円|今なら\\d+円).{0,40}',
  ],
];

/** The check-D fixes (decided 2026-11-13: patterns to add; tuned on D, checked on new arrivals). */
const DROP_V2: [string, string][] = DROP_V1.map(([k, p]): [string, string] =>
  k === 'price/campaign' ? [k, p.replace('|セール|', '|セール(?!スマン)|')] : [k, p],
).concat([
  [
    'sales claim',
    '.{0,12}(累計|発行部数).{0,15}(万部|部)(突破)?[!！。]*(.{0,30}(ベストセラー|話題作|大人気)[!！。]*)?([（(][^）)]*[）)])?',
  ],
  ['cross-promo', '.{0,40}(TV|テレビ)?アニメ(化)?(放送|放映|配信)(開始|決定|中|スタート)[!！]*'],
  ['cross-promo', '.{0,25}(重版|増刷)(出来|決定|御礼|続々)?[!！]*'],
  ['cross-promo', '.{0,30}(コミックス|コミック|漫画|マンガ).{0,10}同日発売[!！]*'],
  ['store bonus', '.{0,60}連動購入特典[!！]*'],
  ['store bonus', '[★☆※]?.{0,20}(SS|ＳＳ)?特典付属[!！。]*'],
]);

const compile = (list: [string, string][]) =>
  list.map(([k, p]) => [k, new RegExp(`^(?:${p})$`, 'u')] as const);
const PATTERNS = { 1: compile(DROP_V1), 2: compile(DROP_V2) };
export const DESC_RULES_VERSION = 2;

const TRAIL = /\s*[【《][^】》]*(特典|限定)[^】》]*[】》]\s*$/u;
const LEAD = /^\s*[【《][^】》]*(特典|限定)[^】》]*[】》][!！]?\s*/u;

export interface RemovedLine {
  kind: string;
  line: string;
}

/** Whole-line marketing removal; returns the cleaned text and what was removed. */
export function cleanDescription(
  text: string,
  version: 1 | 2 = DESC_RULES_VERSION as 2,
): { text: string; removed: RemovedLine[] } {
  const removed: RemovedLine[] = [];
  const keep: string[] = [];
  for (let line of text.split(/(\n)/)) {
    if (line === '\n') {
      keep.push(line);
      continue;
    }
    const l = pyStrip(nfkc(line));
    const hit = l ? PATTERNS[version].find(([, p]) => p.test(l)) : undefined;
    if (hit) {
      removed.push({ kind: hit[0], line: pyStrip(line) });
      continue;
    }
    let m = TRAIL.exec(line);
    if (m && pyStrip(line.slice(0, m.index))) {
      removed.push({ kind: 'trailing marker', line: pyStrip(m[0]) });
      line = line.slice(0, m.index);
    }
    m = LEAD.exec(line);
    if (m && pyStrip(line.slice(m[0].length))) {
      removed.push({ kind: 'leading marker', line: pyStrip(m[0]) });
      line = line.slice(m[0].length);
    }
    keep.push(line);
  }
  return { text: pyStrip(keep.join('').replace(/\n{3,}/g, '\n\n')), removed };
}

export type DescSource =
  | 'bookwalker(=amazon)'
  | 'amazon'
  | 'bookwalker'
  | 'amazon(search)'
  | 'amazon(models)'
  | 'ranobedb';

/** desc.py ident(): the descriptions that belong to this book. */
export function identifyDescriptions(r: RefRecord): {
  amazon?: [string, 'asin' | 'search' | 'models'];
  bookwalker?: [string, 'title'];
  ranobedb?: [string, 'title'];
} {
  const { P } = decide(r);
  const f = r.file;
  const cal = r.calibre;
  const ap = r.amazon?.product || null;
  const rb = r.ranobedb || {};
  const bw = r.bookwalker?.detail || {};
  const ft = (f.opf_title || cal.cal_title) as string;
  const fauth = [
    ...(f.creators || [])
      .filter((x) => x.role === 'aut' || x.role === null || x.role === undefined)
      .map((x) => x.name),
    ...(cal.cal_authors || '').split('&').filter((a) => a && a !== 'Unknown'),
  ];
  const asinHit = ap !== null && !r.amazon?.picked_from_search;
  const out: ReturnType<typeof identifyDescriptions> = {};
  const desc = (ap as { description?: string } | null)?.description;
  if (ap && desc) {
    const au = (ap.authors || []).map((x) => x.name);
    const an = N(clean(ap.title)) ?? '';
    const fn = N(clean(ft)) ?? '';
    const sameT = an === fn;
    const rest = fn && an.startsWith(fn) ? an.slice(fn.length) : null;
    const booktext = N((f.front_text || '') + (f.colophon_text || '')) ?? '';
    const prefix =
      Boolean(rest) &&
      !/^\p{Nd}/u.test(rest!) &&
      [...rest!].length >= 2 &&
      booktext.includes(rest!);
    const fset = new Set(fauth.map((x) => NA(x)));
    const auOk = fauth.length > 0 && au.some((x) => fset.has(NA(x)));
    if (asinHit || (sameT && (fauth.length === 0 || auOk)) || (prefix && auOk) || an === N(P.t)) {
      out.amazon = [desc, asinHit ? 'asin' : 'search'];
    }
  }
  const bdesc = (bw as { description?: string }).description;
  if (bdesc && bw.title && [N(P.t), N(clean(ft))].includes(N(clean(bw.title))))
    out.bookwalker = [bdesc, 'title'];
  const b = rb.book as { description_ja?: string; title_orig?: string | null } | null | undefined;
  if (
    b &&
    b.description_ja &&
    rb.author_match !== false &&
    [N(P.t), N(clean(ft))].includes(N(clean(b.title_orig)))
  ) {
    out.ranobedb = [b.description_ja, 'title'];
  }
  return out;
}

const squash = (s: string) => nfkc(s).replace(/\s+/gu, '');

/** desc.py choose(): BookWalker's copy when it equals Amazon's, then by-ASIN Amazon, BookWalker, searched Amazon, RanobeDB. */
export function chooseDescription(
  r: RefRecord,
  modelsSayAmazon = false,
): { source: DescSource | null; text: string | null } {
  const c = identifyDescriptions(r);
  const desc = (r.amazon?.product as { description?: string } | null | undefined)?.description;
  if (!c.amazon && modelsSayAmazon && desc) c.amazon = [desc, 'models'];
  const a = c.amazon;
  const b = c.bookwalker;
  const d = c.ranobedb;
  if (a && b && squash(a[0]) === squash(b[0])) return { source: 'bookwalker(=amazon)', text: b[0] };
  if (a && a[1] === 'asin') return { source: 'amazon', text: a[0] };
  if (b) return { source: 'bookwalker', text: b[0] };
  if (a) return { source: a[1] === 'models' ? 'amazon(models)' : 'amazon(search)', text: a[0] };
  if (d) return { source: 'ranobedb', text: d[0] };
  return { source: null, text: null };
}
