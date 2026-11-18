/**
 * WP20d: "Amazon where needed" on the 800 labeled books' stored records.
 *
 *   node -r ts-node/register/transpile-only scripts/measure-stage4-bw.ts <cleanup-reference dir>
 *
 * BookWalker's book page is turned into the shape rules v3 reads from Amazon (title, people,
 * series, category as breadcrumbs, label), and stage 4's unchanged rules decide. Policies choose
 * per book whether the real Amazon data or BookWalker's stands in, and count the Amazon requests
 * each needs. Per field: share right when filled automatically and share filled, for the 600
 * and check D, beside all Amazon. Reads only.
 */
import fs from 'fs';
import path from 'path';
import {
  clean,
  colophonIllustrators,
  seriesName,
  type RefRecord,
} from '../src/cleanup/stage4/rules-v3';
import { fieldRight } from '../src/cleanup/stage4/score';
import * as prod from '../src/cleanup/stage4/bw-standin';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import {
  SCORED_FIELDS,
  addScore,
  emptyScores,
  percent,
  type ScoredField,
  type Stage4Gold,
} from '../src/cleanup/stage4/score';
import { N, NA, nfkc } from '../src/cleanup/title-rules';

const refDir = process.argv[2];
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  Stage4Gold
>;
type Rec = RefRecord & {
  amazon?: Record<string, unknown>;
  bookwalker?: {
    detail?: { title?: string; keywords?: string; description?: string; image?: string };
    series_candidates?: [string, string][];
  };
};
const records = Object.fromEntries(
  Object.keys(gold).map((id) => [
    id,
    JSON.parse(fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8')) as Rec,
  ]),
);

const CATEGORY: Record<string, string[]> = {
  ライトノベル: ['本', 'ライトノベル'],
  新文芸: ['本', 'ライトノベル'],
  '文芸・小説': ['本', '小説・文芸'],
  マンガ: ['本', 'マンガ'],
  実用: ['本', '実用'],
  新書: ['本', '新書'],
};

function fileAuthors(r: Rec): string[] {
  return [
    ...(r.file.creators || [])
      .filter((x) => x.role === 'aut' || x.role === null || x.role === undefined)
      .map((x) => x.name),
    ...(r.calibre.cal_authors || '').split('&').filter((a) => a && a !== 'Unknown'),
  ];
}

/** The volume number in BookWalker's kana reading (…01…, …013…). */
function kanaNumber(kana: string): number | null {
  const m = /(\d{2,3})/.exec(nfkc(kana));
  return m ? Number(m[1]) : null;
}

const OPEN = '(（[［【〈《「『<＜';
const CLOSE = ')）]］】〉》」』>＞';
/** Cuts a name back to before an unclosed bracket and drops trailing 第 / の / vol. and spaces. */
function tidy(p: string): string {
  let s = p;
  for (;;) {
    let cut = -1;
    for (let i = 0; i < OPEN.length; i++) {
      const o = s.lastIndexOf(OPEN[i]);
      if (o >= 0 && s.indexOf(CLOSE[i], o) < 0) cut = Math.max(cut, o);
    }
    if (cut < 0) break;
    s = s.slice(0, cut);
  }
  return s.replace(/(?:[\s・\-‐―~～:：]|第|の|vol\.?|Vol\.?)+$/u, '').trim();
}
/** The book's title up to its volume number (or the whole title when it has none). */
function titleStem(title: string): string {
  const t = nfkc(title).replace(/【[^】]*】/gu, '');
  const m =
    /^(.*?)[\s\u3000]*(?:第?\d+(?:巻|部)?|[IVX]+|[Ⅰ-Ⅻ]|[上中下]|\(\d+\))(?:[\s\u3000~～\-―(（【].*)?$/u.exec(
      t,
    );
  return tidy(m ? m[1] : t);
}
/**
 * The series name: the book's own title up to its volume number when most of the series'
 * volumes start with it, else the volumes' common start (cut back to a whole word).
 */
function commonSeries(titles: string[], fileTitle: string): string | null {
  if (titles.length < 2) return null;
  const vols = titles.map(nfkc);
  const stem = titleStem(fileTitle);
  if (stem.length >= 2 && vols.filter((v) => v.startsWith(stem)).length * 2 >= vols.length)
    return stem;
  let p = vols[0];
  for (const t of vols.slice(1)) {
    let i = 0;
    while (i < p.length && i < t.length && p[i] === t[i]) i++;
    p = p.slice(0, i);
  }
  p = tidy(p.replace(/[\s\d０-９]+$/u, ''));
  return p.length >= 2 ? p : null;
}

/** BookWalker's page in the shape rules v3 reads from Amazon, or null when it has none. */
function bwAsAmazon(r: Rec): Record<string, unknown> | null {
  const d = r.bookwalker?.detail;
  if (!d?.title) return null;
  const kw = (d.keywords || '').split(',');
  const people = kw.length >= 5 ? kw.slice(2, -3) : [];
  const label = kw.length >= 5 ? kw[kw.length - 3] : '';
  const category = kw.length >= 3 ? kw[kw.length - 2] : '';
  const fa = new Set(fileAuthors(r).map((x) => NA(x)));
  // BookWalker lists the author(s) first and a light novel's illustrator last; EPUB files often
  // list the illustrator as an author too, so the file can't tell them apart.
  const ln = category === 'ライトノベル' || category === '新文芸';
  const authors = people.map((name, i) => ({
    name,
    role:
      ln && people.length >= 2
        ? i === people.length - 1
          ? 'イラスト'
          : '著'
        : fa.size
          ? fa.has(NA(name))
            ? '著'
            : 'イラスト'
          : i === 0
            ? '著'
            : 'イラスト',
  }));
  const vols = (r.bookwalker?.series_candidates || []).map((c) => c[1]);
  const se = commonSeries(vols, (r.file.opf_title || r.calibre.cal_title) as string);
  const ix = kanaNumber(kw[1] || '');
  // Without a volume number in the kana reading, the series alone (rules v3 reads no number).
  const series = se
    ? ix !== null
      ? `全${vols.length}冊中${ix}番目の本   ${se}`
      : `シリーズ: ${se}  `
    : null;
  return {
    picked_from_search: true,
    product: {
      title: d.title,
      asin: null,
      authors,
      description: d.description || null,
      series,
      breadcrumbs: CATEGORY[category] || [],
      rank_categories: label ? [label] : [],
      cover_url: d.image || null,
      publisher: null,
    },
  };
}

/**
 * What BookWalker can't settle alone: its illustrator (the last person of a light novel, or a
 * person who isn't a file author) counts only when RanobeDB's artist or the colophon names
 * them; its series name counts when it is the book's own title stem shared by most volumes,
 * or when RanobeDB's series agrees. Otherwise the book asks Amazon, as today.
 */
function bwUnsettled(r: Rec): { il: boolean; se: boolean } {
  const p = bwAsAmazon(r)?.product as
    | { authors: { name: string; role: string }[]; series: string | null }
    | undefined;
  if (!p) return { il: true, se: true };
  const bwIl = p.authors.filter((x) => x.role === 'イラスト').map((x) => NA(x.name));
  const rb = (
    r as unknown as {
      ranobedb?: {
        book?: { staff?: { name: string; role: string }[]; series?: { title_orig?: string } };
        author_match?: boolean;
        series?: { title_orig?: string };
      };
    }
  ).ranobedb;
  const rdbOk = Boolean(rb?.book && rb.author_match !== false);
  const known = new Set([
    ...(rdbOk
      ? (rb!.book!.staff || []).filter((x) => x.role === 'artist').map((x) => NA(x.name))
      : []),
    ...colophonIllustrators(r.file).map((x) => NA(x)),
  ]);
  const il = bwIl.length > 0 && !bwIl.every((x) => known.has(x));
  let se = false;
  if (p.series) {
    const ft = (r.file.opf_title || r.calibre.cal_title) as string;
    const name = p.series.replace(/^全d+冊中d+番目の本s+|^シリーズ:s*/u, '').trim();
    const vols = (r.bookwalker?.series_candidates || []).map((c) => nfkc(c[1]));
    const stem = titleStem(ft);
    const fromStem =
      name === stem && vols.filter((v) => v.startsWith(stem)).length * 2 >= vols.length;
    const rdbSe = rdbOk ? rb!.series?.title_orig || rb!.book!.series?.title_orig : null;
    const rdbAgrees = Boolean(rdbSe && N(seriesName(rdbSe, ft)) === N(seriesName(name, ft)));
    se = !fromStem && !rdbAgrees;
  }
  return { il, se };
}

/** Title key for identification: volume numbers written alike (II = 2 = Ⅱ, (中) = 中). */
function idKey(t: string | null | undefined): string | null {
  if (!t) return null;
  const ROM: Record<string, string> = {
    I: '1',
    II: '2',
    III: '3',
    IV: '4',
    V: '5',
    VI: '6',
    VII: '7',
    VIII: '8',
    IX: '9',
    X: '10',
    XI: '11',
    XII: '12',
  };
  let s = nfkc(t);
  s = s.replace(/[Ⅰ-Ⅻ]/gu, (c) => String(c.charCodeAt(0) - 0x215f));
  s = s.replace(
    /(^|[^A-Za-z])(XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)(?![A-Za-z])/g,
    (_m, a, r) => a + ROM[r],
  );
  s = s.replace(/[(（]s*(d+|[上中下])s*[)）]/gu, '$1').replace(/第s*(d+)s*巻?/gu, '$1');
  return N(s);
}

/** BookWalker identified the book: its title is the file's, and it names a file author. */
function bwIdentified(r: Rec): boolean {
  const d = r.bookwalker?.detail;
  if (!d?.title) return false;
  const kw = (d.keywords || '').split(',');
  const label = kw.length >= 5 ? kw[kw.length - 3] : '';
  const ft = (r.file.opf_title || r.calibre.cal_title) as string;
  const a = clean(ft, label ? [label] : [], [ft, d.title], [null]);
  const b = clean(d.title, label ? [label] : [], [ft, d.title], [null]);
  if (N(a) !== N(b) && !(WIDE && idKey(a) !== null && idKey(a) === idKey(b))) return false;
  const fa = fileAuthors(r);
  return fa.length === 0 || kw.some((x) => fa.some((y) => NA(x) === NA(y)));
}

const hasAsin = (r: Rec) => Boolean(r.file?.asin);
const WIDE = process.argv.includes('--wide');
type Choice = 'amazon' | 'bw' | 'none' | 'prod';
const POLICIES: Record<string, (r: Rec) => Choice> = {
  'all Amazon (today)': () => 'amazon',
  'BookWalker in place of Amazon, never Amazon': (r) => (bwAsAmazon(r) ? 'bw' : 'none'),
  'BookWalker when it identified the book, else Amazon': (r) => (bwIdentified(r) ? 'bw' : 'amazon'),
  'file ASIN: Amazon; else BookWalker when identified, else Amazon': (r) =>
    hasAsin(r) ? 'amazon' : bwIdentified(r) ? 'bw' : 'amazon',
  'BookWalker first; Amazon when any field stays unsettled': (r) =>
    bwSettles(r) ? 'bw' : 'amazon',
  'BookWalker first; Amazon when title, authors, series or format stay unsettled': (r) =>
    bwSettles(r, ['t', 'au', 'se', 'ix', 'fmt']) ? 'bw' : 'amazon',
  'STRICT: BookWalker first, illustrators and series only with agreement; else Amazon': (r) =>
    bwSettles(r, SCORED_FIELDS, true) ? 'bw' : 'amazon',
  'LIGHT NOVELS: BookWalker settles light novels with a series list or no volume number; else Amazon':
    (r) => (bwLightNovel(r) && bwSettles(r) ? 'bw' : 'amazon'),
  'PRODUCTION (src/cleanup/stage4/bw-standin.ts)': (r) => (prod.bwSettles(r) ? 'prod' : 'amazon'),
};

/** BookWalker files the book as a light novel, and its series is known or it has no number. */
function bwLightNovel(r: Rec): boolean {
  const kw = (r.bookwalker?.detail?.keywords || '').split(',');
  const cat = kw.length >= 3 ? kw[kw.length - 2] : '';
  if (cat !== 'ライトノベル' && cat !== '新文芸') return false;
  const vols = r.bookwalker?.series_candidates || [];
  const ft = (r.file.opf_title || r.calibre.cal_title) as string;
  return vols.length >= 2 || !/[0-9０-９Ⅰ-Ⅻ]|[上中下]$/u.test(nfkc(ft));
}

/** BookWalker identified the book and, standing in for Amazon, settles every given field. */
function bwSettles(
  r: Rec,
  fields: readonly ScoredField[] = SCORED_FIELDS,
  strict = false,
): boolean {
  if (!bwIdentified(r)) return false;
  if (strict) {
    const u = bwUnsettled(r);
    if (u.il || u.se) return false;
  }
  const x = structuredClone(r);
  x.amazon = bwAsAmazon(x) ?? {};
  const d = decideStage4(x as RefRecord);
  return fields.every((f) => d.auto[f]);
}

const today = run(POLICIES['all Amazon (today)']);
for (const [name, pick] of Object.entries(POLICIES)) {
  const res = name === 'all Amazon (today)' ? today : run(pick);
  console.log(
    `\n${name}: Amazon requests per book ${res.perBook.toFixed(2)}; BookWalker stood in for ${res.bw} books`,
  );
  for (const grp of ['ABC', 'D'] as const) {
    const s = res.groups[grp];
    const t = today.groups[grp];
    console.log(
      `  ${grp === 'ABC' ? 'the 600' : 'check D'}: ` +
        SCORED_FIELDS.map((f) => {
          const p = percent(s[f].right, s[f].auto);
          const a = percent(s[f].auto, s[f].scored);
          const pt = percent(t[f].right, t[f].auto);
          const at = percent(t[f].auto, t[f].scored);
          return `${f} ${p?.toFixed(1) ?? '-'}% right (${pt?.toFixed(1)}), ${a?.toFixed(0) ?? '-'}% filled (${at?.toFixed(0)})`;
        }).join(' | '),
    );
  }
}

function run(pick: (r: Rec) => Choice) {
  const groups = { ABC: emptyScores(), D: emptyScores() } as Record<
    string,
    ReturnType<typeof emptyScores>
  >;
  let requests = 0;
  let bw = 0;
  for (const [id, g] of Object.entries(gold)) {
    const r = structuredClone(records[id]);
    const c = pick(r);
    if (c === 'amazon') {
      requests += (hasAsin(r) ? 0 : 1) + ((r.amazon as { product?: unknown })?.product ? 1 : 0);
    } else if (c === 'prod') {
      r.amazon = prod.bwAsAmazon(r) ?? {};
      bw += 1;
    } else if (c === 'bw') {
      r.amazon = bwAsAmazon(r) ?? {};
      bw += 1;
    } else r.amazon = {};
    const d = decideStage4(r as RefRecord);
    addScore(
      groups[g.sample === 'D' ? 'D' : 'ABC'],
      id,
      d.values as unknown as Record<ScoredField, unknown>,
      d.auto,
      g,
    );
  }
  return { groups, perBook: requests / Object.keys(gold).length, bw };
}

// Diagnosis: series and number that today's rules get right but BookWalker's stand-in doesn't.
if (process.argv.includes('--series')) {
  for (const [id, g] of Object.entries(gold)) {
    const r = records[id];
    if (!bwIdentified(r)) continue;
    const t0 = decideStage4(structuredClone(r) as RefRecord);
    const rb = structuredClone(r);
    rb.amazon = bwAsAmazon(rb) ?? {};
    const t1 = decideStage4(rb as RefRecord);
    for (const f of ['se', 'ix'] as const) {
      const ok0 = t0.auto[f] && fieldRight(f, t0.values[f], g) === true;
      const bad1 = t1.auto[f] && fieldRight(f, t1.values[f], g) === false;
      const lost = ok0 && !t1.auto[f];
      if (bad1 || lost)
        console.log(
          `${bad1 ? 'WRONG' : 'LOST '} ${id} ${f}: gold ${JSON.stringify(f === 'se' ? g.se : g.ix)} | today ${JSON.stringify(t0.values[f])} | bw ${JSON.stringify(t1.values[f])} | bw series ${JSON.stringify((rb.amazon as { product?: { series?: string } }).product?.series)} | ${String(r.file.opf_title).slice(0, 40)}`,
        );
    }
  }
}

// Diagnosis: illustrator and series/number errors when BookWalker settles the book, and
// near-miss identifications.
if (process.argv.includes('--errors')) {
  for (const [id, g] of Object.entries(gold)) {
    const r = records[id];
    if (!bwSettles(r)) continue;
    const x = structuredClone(r);
    x.amazon = bwAsAmazon(x) ?? {};
    const d = decideStage4(x as RefRecord);
    const t = decideStage4(structuredClone(r) as RefRecord);
    for (const f of ['il', 'se', 'ix'] as const) {
      if (d.auto[f] && fieldRight(f, d.values[f], g) === false) {
        const kw = (r.bookwalker?.detail?.keywords || '').split(',');
        console.log(
          `${f} ${id} [${g.sample}]: gold ${JSON.stringify((g as unknown as Record<string, unknown>)[f])} | bw ${JSON.stringify(d.values[f])} | today ${JSON.stringify(t.values[f])}${t.auto[f] ? ' auto' : ''} ${fieldRight(f, t.values[f], g)} | people ${kw.slice(2, -3).join('/')} | cat ${kw[kw.length - 2]} | ${String(r.file.opf_title).slice(0, 30)}`,
        );
      }
    }
  }
}

// Diagnosis: labeled light novels that still go to Amazon, and why.
if (process.argv.includes('--ln')) {
  const why: Record<string, number> = {};
  const ex: Record<string, string[]> = {};
  for (const [id, g] of Object.entries(gold)) {
    if (g.fmt !== 'light novel') continue;
    const r = records[id];
    let k: string;
    const d = r.bookwalker?.detail;
    const kw = (d?.keywords || '').split(',');
    const cat = kw.length >= 3 ? kw[kw.length - 2] : '';
    if (!d?.title) k = 'no BookWalker page';
    else if (!bwIdentified(r)) k = 'BookWalker page not identified';
    else if (cat !== 'ライトノベル' && cat !== '新文芸') k = `category ${cat}`;
    else if (!bwLightNovel(r)) k = 'numbered, no series list';
    else if (!bwSettles(r)) {
      const x = structuredClone(r);
      x.amazon = bwAsAmazon(x) ?? {};
      const dd = decideStage4(x as RefRecord);
      k = 'unsettled: ' + SCORED_FIELDS.filter((f) => !dd.auto[f]).join(',');
    } else continue;
    why[k] = (why[k] ?? 0) + 1;
    if ((ex[k] ??= []).length < 4)
      ex[k].push(
        `${id} file "${String(r.file.opf_title).slice(0, 30)}" bw "${String(d?.title ?? '').slice(0, 30)}" asin ${r.file.asin ? 'yes' : 'no'}`,
      );
  }
  for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
    console.log(`${n} ${k}`);
    for (const e of ex[k]) console.log('    ' + e);
  }
}

// The refinements one at a time and together (bw-standin.ts standinOptions).
if (process.argv.includes('--tuning')) {
  const combos: [string, Partial<typeof prod.standinOptions>][] = [
    ['none', { prefixes: false, strictMajority: false, multiIllustrators: false }],
    ['prefixes', { prefixes: true, strictMajority: false, multiIllustrators: false }],
    ['strict majority', { prefixes: false, strictMajority: true, multiIllustrators: false }],
    ['several illustrators', { prefixes: false, strictMajority: false, multiIllustrators: true }],
    ['all three', { prefixes: true, strictMajority: true, multiIllustrators: true }],
  ];
  for (const [name, o] of combos) {
    Object.assign(prod.standinOptions, o);
    const res = run((r) => (prod.bwSettles(r) ? 'prod' : 'amazon'));
    console.log(
      `\nTUNING ${name}: Amazon requests per book ${res.perBook.toFixed(3)}; BookWalker stood in for ${res.bw}`,
    );
    for (const grp of ['ABC', 'D'] as const) {
      const s = res.groups[grp];
      const t = today.groups[grp];
      console.log(
        `  ${grp === 'ABC' ? 'the 600' : 'check D'}: ` +
          SCORED_FIELDS.map((f) => {
            const p = percent(s[f].right, s[f].auto);
            const a = percent(s[f].auto, s[f].scored);
            const pt = percent(t[f].right, t[f].auto);
            const at = percent(t[f].auto, t[f].scored);
            return `${f} ${p?.toFixed(1)} (${pt?.toFixed(1)}) / ${a?.toFixed(0)} (${at?.toFixed(0)}) [${s[f].auto - s[f].right} wrong vs ${t[f].auto - t[f].right}]`;
          }).join(' | '),
      );
    }
  }
}
