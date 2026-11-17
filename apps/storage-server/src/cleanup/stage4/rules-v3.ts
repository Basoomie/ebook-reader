/**
 * rules_v3.py's decide(), the measured stage-4 rule set (plan section 6), ported line by line
 * (WP20d). It reads one evidence record in the reference fetcher's shape (`RefRecord`: the file,
 * Calibre's record, Amazon, RanobeDB, BookWalker) and answers the proposed value of every field
 * (P) and whether the rules would apply it automatically (AU).
 *
 * Proof: scripts/measure-stage4.ts runs it on the 800 stored records and compares every book's
 * P and AU with the Python original's. The decided rules beyond v3 live in stage4-rules.ts;
 * this file stays the plain port.
 */
import { N, NA, PY_SPACE, nfkc, pyStrip, stripMarkersV3 } from '../title-rules';

const S = PY_SPACE;
const re = (source: string, flags = '') => new RegExp(source, `u${flags}`);
const D = '\\p{Nd}';

export interface RefCreator {
  name: string;
  role: string | null;
}

export interface RefRecord {
  calibre: { cal_title: string; cal_authors?: string | null; [k: string]: unknown };
  file: {
    opf_title?: string | null;
    creators?: RefCreator[] | null;
    colophon_text?: string | null;
    front_text?: string | null;
    chars?: number | null;
    images?: number | null;
    error?: string;
    [k: string]: unknown;
  };
  amazon?: {
    product?: {
      title?: string | null;
      authors?: { name: string; role: string }[];
      series?: string | null;
      breadcrumbs?: string[] | null;
      rank_categories?: string[] | null;
      [k: string]: unknown;
    } | null;
    picked_from_search?: boolean;
    [k: string]: unknown;
  } | null;
  ranobedb?: {
    book?: {
      id?: unknown;
      title_orig?: string | null;
      staff?: { name: string; role: string | null }[];
      series?: { id?: unknown; title_orig?: string | null } | null;
      [k: string]: unknown;
    } | null;
    series?: {
      title_orig?: string | null;
      books?: { id?: unknown; sort_order?: number | null; type?: string | null }[];
      [k: string]: unknown;
    } | null;
    author_match?: boolean;
    [k: string]: unknown;
  } | null;
  bookwalker?: {
    detail?: { title?: string | null; keywords?: string | null; [k: string]: unknown } | null;
    [k: string]: unknown;
  } | null;
}

export type Format = 'light novel' | 'novel' | 'manga' | 'nonfiction' | 'image-only';

export interface V3Values {
  t: string;
  au: string[];
  il: string[];
  se: string | null;
  ix: number | null;
  fmt: Format;
}
export type V3Auto = Record<keyof V3Values, boolean>;

/** Everything decide() worked out on the way, for the decided rules and the evidence. */
export interface V3Trace {
  amazonIdentified: boolean;
  amazonByAsin: boolean;
  ranobedbIdentified: boolean;
  lnHint: boolean;
  amazon: AmazonView | null;
  ranobedb: RanobeView | null;
  cleaned: {
    file: string;
    amazon: string | null;
    ranobedb: string | null;
    bookwalker: string | null;
  };
  colophonIllustrators: string[];
  numbered: boolean;
  titleNumber: number | null;
  position: number | null;
  side: boolean;
  imprints: string[];
  keywords: string;
}

interface AmazonView {
  t: string | null | undefined;
  au: string[];
  il: string[];
  other: string[];
  se: string | null;
  ix: number | null;
  bc: string;
  se_present: boolean;
}
interface RanobeView {
  t: string | null | undefined;
  au: string[];
  il: string[];
  se: string | null | undefined;
  ix: number | null;
  sub: boolean;
  single: boolean;
}

export const ROM: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20,
};
export const KAN: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  壱: 1,
  弐: 2,
  参: 3,
  肆: 4,
  伍: 5,
  陸: 6,
  漆: 7,
  捌: 8,
  玖: 9,
};

const IMPRINT =
  /文庫|ノベル|ノベルス|ノベルズ|NOVELS|Novels|ブックス|BOOKS|Books|新書|コミックス|COMICS|BOX|NextPublishing|ラノベ|Kiss|キス|ドロップス|ミライデコ|ロマンス|ロイヤル|ルキア|f\)|フェアリー|DIGITAL|レーベル|研究会/u;

/** Python code-point length and slicing. */
const cps = (s: string) => [...s];
const cpLen = (s: string) => cps(s).length;
const cpFrom = (s: string, n: number) => cps(s).slice(n).join('');

/** Python's str.rstrip() / strip() on whitespace. */
const rstrip = (s: string) => s.replace(re(`[${S}]+$`), '');

function digits(s: string): number {
  return parseFloat(
    s.replace(/\p{Nd}/gu, (d) => {
      const c = d.codePointAt(0)!;
      let z = c;
      while (z > 0 && /\p{Nd}/u.test(String.fromCodePoint(z - 1))) z -= 1;
      return String((c - z) % 10);
    }),
  );
}

export function stripImprint(
  t: string,
  imprints: readonly (string | null | undefined)[] = [],
): string {
  let s = t;
  const tail = re(`[${S}]*\\(([^()]*(?:\\([^()]*\\)[^()]*)?)\\)[${S}]*$`);
  for (;;) {
    const m = tail.exec(s);
    if (!m) break;
    const inner = pyStrip(m[1]);
    if (IMPRINT.test(inner) || imprints.some((x) => x && N(inner) === N(x)))
      s = pyStrip(s.slice(0, m.index));
    else break;
  }
  return s;
}

/** rules_v3 clean(): an appended series name goes only when a confirming title shows it without. */
export function clean(
  t: string | null | undefined,
  imprints: readonly (string | null | undefined)[] = [],
  confirm: readonly (string | null | undefined)[] = [],
  series: readonly (string | null | undefined)[] = [],
): string | null | undefined {
  if (!t) return t;
  let s = stripImprint(stripMarkersV3(t), imprints);
  s = s.replace(re(`[${S}]*(中公文庫|新潮文庫)$`), '');
  for (const se of series) {
    if (!se) continue;
    const se2 = pyStrip(nfkc(se));
    if (s.endsWith(' ' + se2) && cpLen(s) > cpLen(se2) + 1) {
      const cand = pyStrip(s.slice(0, s.length - se2.length));
      if (confirm.some((c) => c && N(cand) === N(stripImprint(stripMarkersV3(c), imprints))))
        s = cand;
    }
  }
  return s;
}

export function titleNumber(
  t: string | null | undefined,
  series: string | null | undefined,
): number | null {
  if (!t || !series) return null;
  const s = nfkc(t).replace(re(`[${S}\u3000]`, 'g'), '');
  const se = nfkc(series).replace(re(`[${S}\u3000]`, 'g'), '');
  if (!s.startsWith(se)) return null;
  const rest = s.slice(se.length);
  let m = re(
    `^[\\(:：]?(?:第|Vol\\.?|vol\\.?|その|Note-|part|Part|level\\.?|Level\\.?)?(${D}+(?:\\.${D}+)?)`,
  ).exec(rest);
  if (m) return digits(m[1]);
  m =
    /^(XVIII|XVII|XIII|XVI|XIV|XIX|VIII|VII|III|XII|XV|XI|XX|IV|IX|VI|II|X|V|I)(?![A-Za-z])/u.exec(
      rest,
    );
  if (m) return ROM[m[1]];
  m = /^[(]?(?:その|第)?([一二三四五六七八九十壱弐参肆伍陸漆捌玖])(?:巻|$|[^一-龥])/u.exec(rest);
  if (m) return KAN[m[1]];
  return null;
}

export function hasVolumeNumber(t: string): boolean {
  let s = nfkc(t);
  s = s.replace(re(`${D}+[：:]${D}+`, 'g'), '');
  s = s.replace(/第[一二三四五六七八九十]+(王子|皇子|王女|部|話)/gu, '');
  if (re(`[\\(（〈]?(上|中|下|前編|中編|後編)[\\)）〉]?[${S}]*$|[一二三四五六七八九十]部`).test(s))
    return true;
  return (
    re(
      `(${D}+|[IVX]{1,4}(?![A-Za-z])|その[一二三四五六七八九十]|[①-⑳])[${S}]*([^${S}]{0,30})$`,
    ).test(s) && !re(`${D}+(年|歳|の|つ|人|日|カ|ヶ|%|冊|話)`).test(s)
  );
}

export function amzSeries(series: string | null | undefined): [string | null, number | null] {
  const s = series || '';
  let m = re(`全${D}+[冊巻]中(?:第)?(${D}+)(?:番目の本|巻)[${S}]+(.*)`).exec(s);
  if (m) return [pyStrip(m[2]), digits(m[1])];
  m = re(`シリーズ:[${S}]*(.*?)[${S}]{2,}`).exec(s + '  ');
  if (m && pyStrip(m[1])) return [pyStrip(m[1]), null];
  return [null, null];
}

const JA = /[ぁ-んァ-ン一-龥]/u;

/** A trailing シリーズ is dropped only when the stem starts the title (decided). */
export function seriesName(
  se: string | null | undefined,
  title: string,
): string | null | undefined {
  if (!se) return se;
  const s = pyStrip(stripMarkersV3(se).replace(/【[^】]*】/gu, ''));
  if (/(文庫|ノベルス|ノベルズ|新書|ブックス)$/u.test(s)) return null;
  if (JA.test(nfkc(title)) && !JA.test(s) && !(N(title) ?? '').startsWith(N(s) ?? '')) return null;
  if (s.endsWith('シリーズ')) {
    const stem = pyStrip(s.slice(0, -4));
    if (stem && (N(title) ?? '').startsWith(N(stem) ?? '')) return stem;
  }
  return s;
}

export function colophonIllustrators(f: RefRecord['file']): string[] {
  const txt = nfkc((f.colophon_text || '') + '\n' + (f.front_text || ''));
  const out: string[] = [];
  for (const m of txt.matchAll(
    re(
      `(?:カバー・口絵・本文イラスト|カバー・本文イラスト|本文イラスト|イラストレーション|イラスト|挿絵|挿 絵)[${S}]*[／/:：…]+[${S}]*([^${S}／/、,。]{1,12})`,
      'g',
    ),
  )) {
    out.push(m[1]);
  }
  for (const m of txt.matchAll(re(`^イラスト[${S}]+([^${S}]{1,12})[${S}]*$`, 'gm'))) out.push(m[1]);
  return [...new Set(out)];
}

/** rules_v2/v3 fix_name: katakana foreign names get ・, Japanese names lose the space. */
export function fixName(name: string): string {
  const n = pyStrip(nfkc(name));
  if (re(`^[ァ-ヴー]+[${S}\u3000]+[ァ-ヴー][ァ-ヴー${S}\u3000]*$`).test(n))
    return n.replace(re(`[${S}\u3000]+`, 'g'), '・');
  return /[一-龥ぁ-ん]/u.test(n) ? n.replace(re(`[${S}\u3000]+`, 'g'), '') : n;
}

const nameSet = (xs: readonly string[]) => new Set(xs.map((x) => NA(x)));
const overlap = (a: readonly string[], b: readonly string[]) => {
  const sb = nameSet(b);
  return a.some((x) => sb.has(NA(x)));
};
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

export function decide(r: RefRecord): { P: V3Values; AU: V3Auto; trace: V3Trace } {
  const f = r.file;
  const cal = r.calibre;
  const ap = r.amazon?.product || null;
  const rb = r.ranobedb || {};
  const bw = r.bookwalker?.detail || {};
  const ft = (f.opf_title || cal.cal_title) as string;
  const creators = f.creators || [];
  const fauth = [
    ...creators
      .filter((x) => x.role === 'aut' || x.role === null || x.role === undefined)
      .map((x) => x.name),
    ...(cal.cal_authors || '').split('&').filter((a) => a && a !== 'Unknown'),
  ];
  const imprints: string[] = [];
  if (ap)
    imprints.push(
      ...(ap.rank_categories || []).filter((x) => !x.includes('Kindle') && !x.includes('売れ筋')),
    );
  let kw = bw.keywords || '';
  const faN = nameSet(creators.map((x) => x.name));
  if (
    bw.title &&
    N(clean(bw.title)) !== N(clean(ft)) &&
    !kw.split(',').some((x) => faN.has(NA(x)))
  ) {
    kw = '';
  }
  imprints.push(...kw.split(',').slice(3, 6));

  let A: AmazonView | null = null;
  if (ap) {
    const authors = ap.authors || [];
    const [se, ix] = amzSeries(ap.series);
    A = {
      t: ap.title,
      au: authors
        .filter((x) => pyStrip(x.role.split(',')[0]) === '著' && !x.role.includes('イラスト'))
        .map((x) => x.name),
      il: authors.filter((x) => x.role.includes('イラスト')).map((x) => x.name),
      other: authors.filter((x) => x.role === 'その他').map((x) => x.name),
      se,
      ix,
      bc: (ap.breadcrumbs || []).join(' '),
      se_present: Boolean(ap.series),
    };
  }
  let Dv: RanobeView | null = null;
  if (rb.book && rb.author_match !== false) {
    const b = rb.book;
    const sr = rb.series || {};
    let pos: number | null = null;
    let btype: string | null | undefined = null;
    for (const x of sr.books || []) {
      if (x.id === b.id) {
        pos = (x.sort_order ?? null) as number | null;
        btype = x.type;
      }
    }
    const staff = b.staff || [];
    Dv = {
      t: b.title_orig,
      au: staff.filter((x) => x.role === 'author').map((x) => x.name),
      il: staff.filter((x) => x.role === 'artist').map((x) => x.name),
      se: sr.title_orig || (b.series || {}).title_orig,
      ix: pos,
      sub: btype === 'sub',
      single: (sr.books || []).length <= 1,
    };
  }
  const asinHit = A !== null && !r.amazon?.picked_from_search;
  const confirm = [ft, bw.title, Dv ? Dv.t : null];
  const ser = [A ? A.se : null, Dv ? Dv.se : null];
  const ctFile = clean(ft, imprints, confirm, ser) as string;
  const ctAmz = A ? clean(A.t, imprints, confirm, ser) : null;
  const ctRdb = Dv ? clean(Dv.t, imprints, confirm, ser) : null;
  const ctBw = bw.title ? clean(bw.title, imprints, confirm, ser) : null;

  const aId =
    A !== null &&
    (asinHit ||
      (N(ctAmz) === N(ctFile) && (fauth.length === 0 || overlap([...A.au, ...A.il], fauth))));
  // (N(ct_file), N(ct_amz) if a_id else None): a missing RanobeDB title matches the None.
  const dId = Dv !== null && [N(ctFile), aId ? N(ctAmz) : null].includes(N(ctRdb));

  const P = {} as V3Values;
  const AU = {} as V3Auto;
  // title
  let t: string = ctFile;
  let fromFile = true;
  if (
    aId &&
    asinHit &&
    ctAmz &&
    (N(ctAmz) ?? '').startsWith(N(ctFile) ?? '') &&
    N(ctAmz) !== N(ctFile)
  ) {
    t = ctAmz;
    fromFile = false;
  }
  const colt = [...nfkc(f.colophon_text || '').matchAll(/[『「]([^』」]{2,80})[』」]/gu)].map(
    (m) => m[1],
  );
  for (const c of [ctBw, dId ? ctRdb : null, ...colt]) {
    if (!c) continue;
    const nt = N(t) ?? '';
    const nc = N(c) ?? '';
    if (!(nt.startsWith(nc) && nt !== nc)) continue;
    const after = cpFrom(nfkc(t), cpLen(rstrip(nfkc(c))));
    if (!after.startsWith(' ')) continue;
    const rest = pyStrip(after);
    if (
      /シリーズ|コレクション|叢書/u.test(rest) ||
      nc.includes(N(rest) ?? '') ||
      ser.some((x) => x && N(rest) === N(x))
    ) {
      t = c;
      fromFile = false;
      break;
    }
  }
  const agree = [aId ? ctAmz : null, dId ? ctRdb : null, ctBw].filter((x) => x && N(x) === N(t));
  P.t = t;
  AU.t = agree.length >= 1 && (aId || dId);
  const nt = nfkc(t);
  const tm = re(`[${S}]([^${S}]+)$`).exec(nt);
  if (
    tm &&
    (/シリーズ|コレクション|叢書/u.test(tm[1]) ||
      (cpLen(tm[1]) >= 3 && (N(nt.slice(0, tm.index)) ?? '').includes(N(tm[1]) ?? '')))
  ) {
    AU.t = false;
  }
  if (!fromFile && !(dId || (ctBw && N(ctBw) === N(t)))) AU.t = false;

  // format hint
  const lnHint =
    (aId && A!.bc.includes('ライトノベル')) ||
    dId ||
    kw.includes('ライトノベル') ||
    kw.includes('新文芸');
  if (A && A.bc.includes('ライトノベル') && A.il.length === 0 && A.other.length > 0) A.il = A.other;

  // authors
  if (aId && A!.au.length) {
    let au = [...A!.au];
    if (Dv && dId && Dv.il.length) {
      const dil = nameSet(Dv.il);
      const kept = au.filter((x) => !dil.has(NA(x)));
      au = kept.length ? kept : au;
    }
    P.au = au;
    const twoNoIl = au.length >= 2 && A!.il.length === 0;
    AU.au =
      (!dId || sameSet(nameSet(au), nameSet(Dv!.au))) &&
      (asinHit || overlap(au, fauth)) &&
      !(twoNoIl && !dId);
  } else if (dId) {
    P.au = Dv!.au;
    AU.au = overlap(Dv!.au, fauth);
  } else {
    P.au = fauth.slice(0, 1);
    AU.au = false;
  }
  P.au = P.au.map((x) => fixName(x));

  // illustrators
  const col = colophonIllustrators(f);
  const cands: string[][] = [];
  if (aId) cands.push(A!.il);
  if (dId) cands.push(Dv!.il);
  if (cands.length) {
    P.il = dId && Dv!.il.length ? Dv!.il : aId ? A!.il : [];
    const same = cands.every((c) => sameSet(nameSet(c), nameSet(P.il)));
    AU.il = same && (P.il.length > 0 || !lnHint) && !(P.il.length === 0 && col.length > 0);
    if (P.il.length && col.length && !overlap(P.il, col)) AU.il = false;
    const extra = fauth.filter((x) => aId && !overlap([x], [...A!.au, ...A!.il]));
    if (P.il.length === 0 && extra.length) AU.il = false;
    if (aId && A!.au.length >= 2 && A!.il.length === 0) AU.il = false;
  } else {
    P.il = col;
    AU.il = false;
  }

  // series / number
  const rawSe = aId && A!.se ? A!.se : dId && !Dv!.single ? Dv!.se : null;
  const se = seriesName(rawSe, t);
  P.se = se ?? null;
  let tn = se ? titleNumber(t, se) : null;
  if (se && tn === null && dId && Dv!.se) tn = titleNumber(t, Dv!.se);
  const pos = aId && A!.ix ? A!.ix : dId ? Dv!.ix : null;
  P.ix = tn !== null ? tn : pos;
  const numbered = hasVolumeNumber(t);
  let side = false;
  if (se === null || se === undefined) {
    P.ix = null;
    AU.se = aId && !A!.se_present && !(Dv && dId && !Dv.single) && !numbered;
    AU.ix = AU.se;
  } else {
    const rdbAgree = Boolean(dId && Dv!.se && N(seriesName(Dv!.se, t)) === N(se));
    AU.se = (aId && (rdbAgree || !dId)) || (rdbAgree && !aId);
    side = dId && Dv!.sub;
    if (tn === null && numbered) side = true;
    AU.ix =
      AU.se &&
      !side &&
      ((tn !== null && (tn === pos || (dId && Dv!.ix === tn))) ||
        (tn === null && pos !== null && (!dId || Dv!.ix === pos)));
  }

  // format
  const bc = aId ? A!.bc : '';
  const bwcat = (kw.match(/,/g) || []).length >= 2 ? kw.split(',').slice(-2)[0] : '';
  const bcs = pyStrip(bc);
  if (bc.includes('ライトノベル')) P.fmt = 'light novel';
  else if (
    ['小説・文芸', 'ボーイズラブ', '児童書', '外国文学', '日本文学', '詩歌'].some((x) =>
      bc.includes(x),
    ) ||
    bc.endsWith('文学・評論')
  )
    P.fmt = 'novel';
  else if (
    ['マンガ', 'コミック ', ' コミック'].some((x) => bc.includes(x)) ||
    bc.endsWith('コミック')
  )
    P.fmt = 'manga';
  else if (bcs && !['Kindleストア Kindle本', '本'].includes(bcs)) P.fmt = 'nonfiction';
  else if (lnHint) P.fmt = 'light novel';
  else if (['実用', '新書', 'ビジネス', '学術・語学', '趣味・実用'].includes(bwcat))
    P.fmt = 'nonfiction';
  else P.fmt = 'novel';
  AU.fmt = Boolean(aId && bcs && !['Kindleストア Kindle本', '本'].includes(bcs));
  if ((f.chars || 0) < 5000 && (f.images || 0) > 10 && P.fmt !== 'manga') {
    P.fmt =
      kw.split(',').slice(-2, -1).includes('マンガ') || nfkc(ft).includes('コミック')
        ? 'manga'
        : 'image-only';
  }
  for (const k of Object.keys(AU) as (keyof V3Auto)[]) AU[k] = Boolean(AU[k]);
  return {
    P,
    AU,
    trace: {
      amazonIdentified: aId,
      amazonByAsin: asinHit,
      ranobedbIdentified: dId,
      lnHint: Boolean(lnHint),
      amazon: A,
      ranobedb: Dv,
      cleaned: {
        file: ctFile,
        amazon: ctAmz ?? null,
        ranobedb: ctRdb ?? null,
        bookwalker: ctBw ?? null,
      },
      colophonIllustrators: col,
      numbered,
      titleNumber: tn,
      position: pos,
      side,
      imprints,
      keywords: kw,
    },
  };
}
