/**
 * Titles too long for a Calibre folder, stop B (read-only): candidate shortening rules on every
 * title still too long after cleaning, each measured alone, with its impact:
 *   (a) the same store record: stage 4's own pickByVolume on the stored search results and
 *       recordFit on the chosen records, with the shortened title in place of the full one;
 *   (b) the same volume number: the series order's printedNumber with the book's series name
 *       (or, without one, the numbers of the title's main part).
 * The rules here are a prototype for the user to choose from; nothing is written anywhere.
 *
 *   npx ts-node --transpile-only scripts/title-length-shorten.ts --long <long.json>
 *     --titles <titles.json> --cleanup <cleanup.db copy> --out <shorten.json>
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { calibreNameBytes, NAME_MAX_BYTES } from '../src/cleanup/stage2-rules';
import { nfkc } from '../src/cleanup/title-rules';
import { pickByVolume, queryTitle } from '../src/cleanup/stage4/pick';
import { amazonFacts, bwFacts, recordFit } from '../src/cleanup/stage4/record-judge';
import { printedNumber } from '../src/cleanup/stage4/series-order';
import { removeRepeat } from './title-length-shorten-rules';

const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const LIB = '6efee4ba-c851-4f7b-9804-998f52a5d024';
const long = JSON.parse(readFileSync(arg('--long'), 'utf8')) as any[];
const titles = JSON.parse(readFileSync(arg('--titles'), 'utf8'));
const byId = new Map<number, any>(titles.books.map((b: any) => [b.id, b]));
const db = new Database(arg('--cleanup'), { readonly: true, fileMustExist: true });
const evStmt = db.prepare(
  `SELECT kind, data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind IN ('online', 'file')`,
);
const blob = (b: Buffer) => JSON.parse(gunzipSync(b).toString('utf8'));

// ---- candidate rules (prototype) -------------------------------------------------------------
const VOL = String.raw`(?:\d{1,3}|[０-９]{1,3}|[IVXⅠ-Ⅻ]{1,4}|[上中下]|[一二三四五六七八九十]{1,3})(?:巻)?`;
const LABEL =
  /文庫|ノベルス|ノベルズ|ノベル$|ブックス|BOOKS|Books|新文芸|フォレスト|叢書|選書|新書|シリーズ|出版|書房|電子書籍|Kindle|kindle|NOVELS|COMICS|レーベル/u;
const BONUS = /特典|限定|特別版|SS|ＳＳ|書き下ろし|書下ろし|付き|付】|おまけ|寄付版|無料|お試し/u;
const KEEP_BRACKET = /合本|総集編|新装版|完全版|改訂|上下|前編|後編|^\s*\d+\s*$|^[上中下]$/u;

type Rule = { id: string; text: string; apply: (t: string) => string };
const tidy = (s: string) =>
  s
    .replace(/\s{2,}/gu, ' ')
    .replace(/^[\s:：]+|[\s:：、,]+$/gu, '')
    .trim();
const RULES: Rule[] = [
  {
    id: 'repeat',
    text: 'cleaning: a title that says itself twice keeps one part',
    apply: removeRepeat,
  },
  {
    id: 'bonus-note',
    text: 'drop a bracketed bonus or edition note (【電子特別版】, 〈電子特別版〉, （初回限定）); 合本/総集編/新装版/完全版 stay',
    apply: (t) =>
      tidy(
        t.replace(/[【〈《［[（(]([^】〉》］\]）)]{1,30})[】〉》］\]）)]/gu, (m, inner: string) =>
          BONUS.test(inner) && !KEEP_BRACKET.test(inner) ? ' ' : m,
        ),
      ),
  },
  {
    id: 'label',
    text: 'drop a bracketed imprint, label or series note anywhere ((サーガフォレスト), (電撃の新文芸), (歴史世界叢書))',
    apply: (t) =>
      tidy(
        t.replace(/\s*[（(]([^（()）]{2,40})[）)]/gu, (m, inner: string) =>
          LABEL.test(inner) && !KEEP_BRACKET.test(inner) ? ' ' : m,
        ),
      ),
  },
  {
    id: 'promo-head',
    text: 'drop bracketed notes before the title (【GPT-4対応】【入門書】, 【寄付版】, 【初心者に分かりやすい】)',
    apply: (t) => {
      const m = /^((?:\s*【[^】]{1,30}】)+)\s*/u.exec(t);
      if (!m) return t;
      const kept = [...m[1].matchAll(/【([^】]*)】/gu)].filter((x) => KEEP_BRACKET.test(x[1]));
      return tidy(kept.map((x) => x[0]).join('') + t.slice(m[0].length));
    },
  },
  {
    id: 'wave-subtitle',
    text: 'drop a subtitle between ～…～ / ―…― / -…- (keeps what is before and after it, so a number after it stays)',
    apply: (t) =>
      tidy(
        t.replace(
          /(.{4,}?)\s*([～~〜―─－-]{1,3})[^～~〜―─－-]{4,}\2/u,
          (_m, head: string) => `${head} `,
        ),
      ),
  },
  {
    id: 'colon-subtitle',
    text: 'drop a subtitle after ": " (KDP style) unless it is only the volume number; a number right before the colon stays',
    apply: (t) => {
      const m = /^(.{4,}?)\s*[:：]\s*(.+)$/u.exec(t);
      if (!m) return t;
      if (
        new RegExp(`^${VOL}\\s*$`, 'u').test(
          nfkc(m[2])
            .replace(/【.*?】/gu, '')
            .trim(),
        )
      )
        return t;
      return tidy(m[1]);
    },
  },
  {
    id: 'after-number',
    text: 'drop what follows the volume number after a space (「…生活１\u3000生真面目次期公爵から…」 → 「…生活１」)',
    apply: (t) => {
      const m = new RegExp(`^(.{4,}?${VOL})[\\s\u3000]+(?![\\d０-９])(.{6,})$`, 'u').exec(t);
      return m ? tidy(m[1]) : t;
    },
  },
];

// ---- impact ------------------------------------------------------------------------------------
function volumeOf(t: string, series: string | null): string {
  // The series order's own reading: the number printed after the series name. Without a series
  // name, the title's main part (before its first subtitle mark or bracket) stands in for it.
  const name =
    series ??
    nfkc(t)
      .replace(/^[【[].*?[】\]]\s*/u, '')
      .split(/[～~〜―─:：（(【\s]|\d/u)[0];
  if (!name) return '-';
  const n = printedNumber(t, name);
  return n === null ? '-' : `#${n}`;
}

function storeChecks(b: any, full: string, short: string): { pick: string[]; fit: string[] } {
  const out = { pick: [] as string[], fit: [] as string[] };
  if (!b?.uuid) return out;
  let ev: any = null;
  let file: any = null;
  for (const r of evStmt.all(LIB, b.uuid) as { kind: string; data: Buffer }[]) {
    if (r.kind === 'online') ev = blob(r.data);
    else file = blob(r.data);
  }
  if (!ev) return out;
  const tb = ev.query?.text_book !== false;
  const isBw = (c: [string, string]) => c[0].includes('/de');
  const lists: [string, any[] | undefined, any][] = [
    ['amazon', ev.amazon?.search_candidates?.slice(0, 6), true],
    ['ranobedb', ev.ranobedb?.search_candidates, true],
    ['bookwalker', ev.bookwalker?.search_candidates?.slice(0, 8), isBw],
    ['bookwalker-series', ev.bookwalker?.series_candidates, true],
  ];
  for (const [store, list, vol] of lists) {
    if (!list?.length) continue;
    const a = pickByVolume(queryTitle(full), list as [string, string][], tb, vol);
    const s = pickByVolume(queryTitle(short), list as [string, string][], tb, vol);
    if ((a?.[0] ?? null) === (s?.[0] ?? null) || !a) continue;
    // Harm only when the full title's pick was the book (a list of other books is no loss).
    const was = recordFit(
      { title: full, text: '', textBook: tb },
      { title: a[1] as string, words: '' },
    );
    if (was === null) continue;
    const now = s
      ? recordFit({ title: full, text: '', textBook: tb }, { title: s[1] as string, words: '' })
      : null;
    out.pick.push(
      `${store}: ${a[0]} ${a[1]} → ${s?.[0] ?? '-'} ${s?.[1] ?? '-'}${now !== null ? ' (also the book)' : ''}`,
    );
  }
  const text = `${file?.file?.front_text ?? ''}\n${file?.file?.colophon_text ?? ''}`;
  const recs: [string, any][] = [
    ['amazon', ev.amazon?.product ? amazonFacts(ev.amazon.product) : null],
    ['bookwalker', ev.bookwalker?.detail ? bwFacts(ev.bookwalker.detail) : null],
    ['ranobedb', ev.ranobedb?.book ? { title: ev.ranobedb.book.title_orig, words: '' } : null],
  ];
  for (const [store, rec] of recs) {
    if (!rec?.title) continue;
    const f1 = recordFit({ title: full, text, textBook: tb }, rec);
    const f2 = recordFit({ title: short, text, textBook: tb }, rec);
    if (f1 !== null && f2 === null) out.fit.push(`${store}: ${rec.title} no longer fits`);
  }
  return out;
}

// ---- run ---------------------------------------------------------------------------------------
const rows: any[] = [];
const seen = new Set<string>();
for (const r of long) {
  if (r.bytes <= NAME_MAX_BYTES || seen.has(`${r.id}:${r.clean}`)) continue;
  seen.add(`${r.id}:${r.clean}`);
  const cid = typeof r.id === 'number' ? r.id : 9_999_999;
  const b = typeof r.id === 'number' ? byId.get(r.id) : null;
  const series = b?.series ?? b?.label?.se ?? null;
  const v0 = volumeOf(r.clean, series);
  const each = RULES.map((rule) => {
    const s = rule.apply(r.clean);
    if (s === r.clean) return { rule: rule.id, changed: false };
    const v1 = volumeOf(s, series);
    const st = storeChecks(b, r.clean, s);
    return {
      rule: rule.id,
      changed: true,
      title: s,
      bytes: calibreNameBytes(cid, s, r.first),
      removed: [...r.clean].length - [...s].length,
      numberOk: v0 === v1,
      number: `${v0} → ${v1}`,
      pick: st.pick,
      fit: st.fit,
    };
  });
  rows.push({
    id: r.id,
    src: r.src,
    first: r.first,
    series,
    title: r.clean,
    bytes: r.bytes,
    volume: v0,
    each,
  });
}
// Per rule: books it changes, how many it brings under the limit, impact failures.
const sum: Record<string, any> = {};
for (const rule of RULES) {
  const e = rows.map((x) => x.each.find((y: any) => y.rule === rule.id)).filter((y) => y.changed);
  sum[rule.id] = {
    text: rule.text,
    changes: e.length,
    fitsAlone: e.filter((y) => y.bytes <= NAME_MAX_BYTES).length,
    numberChanged: e.filter((y) => !y.numberOk).length,
    pickChanged: e.filter((y) => y.pick.length).length,
    fitLost: e.filter((y) => y.fit.length).length,
    medianRemoved: e.map((y) => y.removed).sort((a, b) => a - b)[Math.floor(e.length / 2)] ?? 0,
  };
}
writeFileSync(arg('--out'), JSON.stringify({ rules: sum, rows }, null, 1));
console.log(`${rows.length} titles still too long after cleaning`);
console.table(
  Object.fromEntries(Object.entries(sum).map(([k, v]: any) => [k, { ...v, text: undefined }])),
);

// ---- the proposed chain: rules in order until the name fits, then the cut ----------------------
const VOLMARK = /その\s*\d+|第\s*\d+\s*[巻部]|\d+\s*巻|vol\.?\s*\d+/giu;
const ORDER = ['repeat', 'bonus-note', 'label', 'colon-subtitle', 'wave-subtitle'];
const PUNCT = /[、。，,・！!？?―～~〜：:\s」』）)】〉》]/u;
function cutTitle(t: string, cid: number, first: string): string {
  const m = new RegExp(
    `^(.*?)[\\s\u3000]*((?:その|第)?${VOL})\\s*(?:[（(][^（()）]*[）)])?\\s*$`,
    'u',
  ).exec(t);
  const head = m && m[1].length >= 4 ? m[1] : t;
  const tail = m && m[1].length >= 4 ? ` ${m[2]}` : '';
  const chars = [...head];
  let n = chars.length;
  while (
    n > 0 &&
    calibreNameBytes(cid, chars.slice(0, n).join('') + '…' + tail, first) > NAME_MAX_BYTES
  )
    n--;
  let k = n;
  while (k > 0 && !PUNCT.test(chars[k - 1])) k--;
  const cutAt = k >= Math.floor(n / 2) ? k : n; // a mark too far back: cut at the limit
  return (
    chars
      .slice(0, cutAt)
      .join('')
      .replace(/[\s、。，,・：:―～~〜]+$/u, '') +
    '…' +
    tail
  );
}
const chain: any[] = [];
for (const r of rows) {
  const cid = typeof r.id === 'number' ? r.id : 9_999_999;
  let t = r.title;
  const used: string[] = [];
  for (const id of ORDER) {
    if (calibreNameBytes(cid, t, r.first) <= NAME_MAX_BYTES) break;
    const s = RULES.find((x) => x.id === id)!.apply(t);
    // A step never drops a volume mark the rest of the title lacks (「…ティップス集その8」).
    const marks = (x: string) =>
      new Set([...nfkc(x).matchAll(VOLMARK)].map((m) => m[0].replace(/\s/gu, '')));
    const lost = [...marks(t)].some((m) => !marks(s).has(m));
    if (s !== t && !lost) {
      t = s;
      used.push(id);
    }
  }
  if (calibreNameBytes(cid, '', r.first) > NAME_MAX_BYTES) {
    chain.push({
      id: r.id,
      src: r.src,
      step: 'review: first author too long',
      rules: [],
      before: r.title,
      after: r.title,
      bytes: 0,
      number: '',
      numberOk: true,
      pick: [],
      fit: [],
    });
    continue;
  }
  let step = used.filter((x) => x !== 'repeat').length
    ? 'shortened'
    : used.length
      ? 'cleaned'
      : 'none';
  if (calibreNameBytes(cid, t, r.first) > NAME_MAX_BYTES) {
    t = cutTitle(t, cid, r.first);
    step = 'cut';
  }
  const b = typeof r.id === 'number' ? byId.get(r.id) : null;
  const v1 = volumeOf(t, r.series);
  const st = storeChecks(b, r.title, t);
  chain.push({
    id: r.id,
    src: r.src,
    step,
    rules: used,
    before: r.title,
    after: t,
    bytes: calibreNameBytes(cid, t, r.first),
    number: `${r.volume} → ${v1}`,
    numberOk: r.volume === v1,
    pick: st.pick,
    fit: st.fit,
  });
}
writeFileSync(arg('--out').replace(/\.json$/, '-chain.json'), JSON.stringify(chain, null, 1));
const cnt: Record<string, number> = {};
for (const c of chain) cnt[c.step] = (cnt[c.step] ?? 0) + 1;
console.log(
  'chain',
  cnt,
  'number changed',
  chain.filter((c) => !c.numberOk).length,
  'pick changed',
  chain.filter((c) => c.pick.length).length,
  'fit lost',
  chain.filter((c) => c.fit.length).length,
  'over 255',
  chain.filter((c) => c.bytes > NAME_MAX_BYTES).length,
);
