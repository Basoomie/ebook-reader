/**
 * Titles too long for a Calibre folder, stop B (read-only): candidate cleaning rules (branding,
 * author and format text, repeats), each counted on Calibre's titles, the files' titles and the
 * new arrivals, and checked on the labeled books (a change that moves a labeled title away from
 * its label is a loss). A prototype for the user to choose from; nothing is written.
 *
 *   npx ts-node --transpile-only scripts/title-length-clean.ts <titles.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'fs';
import { cleanTitle, N, NA, nfkc } from '../src/cleanup/title-rules';
import { removeRepeat } from './title-length-shorten-rules';

const [file, out] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf8'));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

type Rule = {
  id: string;
  kind: string;
  text: string;
  apply: (t: string, authors: string[]) => string;
};
const RULES: Rule[] = [
  {
    id: 'annas-archive',
    kind: 'branding',
    text: "Anna's Archive file names: 「title -- author -- … -- <md5> -- Anna’s Archive」 → the title",
    apply: (t) => (/\s--\s.*Anna[’']s Archive\s*$/iu.test(t) ? t.split(/\s--\s/u)[0].trim() : t),
  },
  {
    id: 'z-library',
    kind: 'branding',
    text: 'a trailing list of library sites: 「(z-library.sk, 1lib.sk, z-lib.sk)」',
    apply: (t) =>
      t
        .replace(/\s*[（(][^（()）]*(?:z-?lib|1lib|libgen|annas-archive)[^（()）]*[）)]\s*$/iu, '')
        .trim(),
  },
  {
    id: 'mokuro',
    kind: 'branding',
    text: 'mokuro (manga OCR) names: 「_14 - よつばと!(14) (368 MiB) | mokuro」 → 「よつばと!(14)」, 「… (with mokuro)」',
    apply: (t) =>
      t
        .replace(/\s*\|\s*mokuro\s*$/iu, '')
        .replace(/\s*\(with mokuro\)\s*$/iu, '')
        .replace(/\s*\(\d+(?:\.\d+)?\s*[KMG]iB\)\s*$/u, '')
        .replace(/^_\d+\s+-\s+/u, '')
        .trim(),
  },
  {
    id: 'raw-tag',
    kind: 'branding',
    text: 'scanner tags: 「[Raw-JP]」, 「[RAW]」, 「(一般小説)」 at the start',
    apply: (t) =>
      t
        .replace(/\s*\[raw(?:-jp)?\]\s*/giu, ' ')
        .replace(/^\s*[（(](?:一般小説|一般書籍|成年コミック|一般コミック)[）)]\s*/u, '')
        .trim(),
  },
  {
    id: 'file-name',
    kind: 'format',
    text: 'a file name as the title: a trailing .epub/.pdf/.azw3/.mobi/.txt; a Kindle file id 「CR!3V9N….azw」 means no title',
    apply: (t) =>
      /^CR![0-9A-Z]{20,}\.azw3?$/iu.test(t.trim())
        ? ''
        : t.replace(/\.(epub|pdf|azw3?|mobi|txt)\s*$/iu, '').trim(),
  },
  {
    id: 'store-bonus-head',
    kind: 'format',
    text: 'a store-bonus word before the title: 「電子書籍特典\u3000３分聖女の…」, 「…\u3000電子書籍特典付き」',
    apply: (t) =>
      t
        .replace(/^\s*電子書籍特典[\s\u3000]+/u, '')
        .replace(/[\s\u3000]+電子書籍特典付き\s*$/u, '')
        .trim(),
  },
  {
    id: 'author-tail',
    kind: 'author',
    text: 'the book\'s own author after " -- " at the end (today only " - author"): 「ウザク式麻雀学習 はじめの書 -- G・ウザク」',
    apply: (t, authors) => {
      const m = /^(.+?)\s+--\s+([^-]+)$/u.exec(t);
      if (!m) return t;
      const names = m[2].split(/[,、&＆]/u).map((x) => NA(x));
      return names.some((n) => n && authors.some((a) => NA(a) === n)) ? m[1].trim() : t;
    },
  },
  {
    id: 'author-bracket',
    kind: 'author',
    text: "the book's own author in [ ] anywhere (today only at the start): 「(一般小説) [橋本紡] 半分の月がのぼる空」",
    apply: (t, authors) =>
      t
        .replace(/\s*[[［]([^\]］]{1,30})[\]］]\s*/gu, (m, inner: string) =>
          authors.some((a) => NA(a) === NA(inner)) ? ' ' : m,
        )
        .trim(),
  },
  {
    id: 'repeat',
    kind: 'repeat',
    text: 'a title that says itself twice keeps one part (stage 2 sends these to review today)',
    apply: (t) => removeRepeat(t),
  },
];

const rows: any[] = [];
const sum: Record<string, any> = {};
for (const r of RULES)
  sum[r.id] = {
    kind: r.kind,
    text: r.text,
    cal: 0,
    file: 0,
    arr: 0,
    labeled: 0,
    closer: 0,
    farther: 0,
    same: 0,
    examples: [],
  };
const look = (s: string, id: any, raw: string | null, authors: string[], label: any) => {
  if (!raw) return;
  for (const rule of RULES) {
    // Applied the way the build would: on the title as stage 2 cleans it today.
    const before = cleanTitle(raw, authors);
    const after =
      rule.id === 'repeat'
        ? rule.apply(before, authors)
        : cleanTitle(rule.apply(raw, authors), authors);
    if (after === before) continue;
    const e = sum[rule.id];
    e[s]++;
    if (e.examples.length < 8 || (label && e.examples.filter((x: any) => x.label).length < 4))
      e.examples.push({ s, id, before, after, label: label?.t ?? null });
    if (label) {
      e.labeled++;
      const ok = (x: string) =>
        [label.t, ...(label.alt_t ?? [])].some((g: string) => N(g) === N(x));
      if (ok(after) && !ok(before)) e.closer++;
      else if (ok(before) && !ok(after)) e.farther++;
      else e.same++;
    }
    rows.push({ rule: rule.id, s, id, before, after, label: label?.t ?? null });
  }
};
for (const b of d.books) {
  look('cal', b.id, b.title, b.authors, null);
  look('file', b.id, b.fileTitle, [...(b.fileAuthors ?? []), ...b.authors], b.label);
}
for (const f of d.arrivals) look('arr', `f${f.id}`, f.facts.title, f.facts.authors ?? [], null);
writeFileSync(out, JSON.stringify({ rules: sum, rows }, null, 1));
for (const [id, e] of Object.entries(sum)) {
  console.log(
    `\n## ${id} (${e.kind}): Calibre ${e.cal}, files ${e.file}, arrivals ${e.arr}; labeled ${e.labeled} (closer ${e.closer}, farther ${e.farther}, same ${e.same})`,
  );
  for (const x of e.examples.slice(0, 6))
    console.log(
      `  ${x.s} ${x.id}: ${x.before}\n    → ${x.after}${x.label ? `\n    label: ${x.label}` : ''}`,
    );
}
void nfkc;
void esc;
