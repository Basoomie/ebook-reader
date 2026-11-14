/**
 * Reproduces the stage-2 measurement of 2026-11-14 (measure_stage2.py) with the server's own
 * TypeScript rules, and scores what stage 2 will actually apply.
 *
 *   node -r ts-node/register/transpile-only scripts/measure-stage2.ts <cleanup-reference dir>
 *
 * The reference folder (git-ignored, docs/design/cleanup-reference or the NAS copy) holds
 * gold800.json and records/<id>.json. Reads only.
 */
import fs from 'fs';
import path from 'path';
import { cleanTitleV3, N, NA } from '../src/cleanup/title-rules';
import {
  type CalibreFacts,
  type FileFacts,
  asinFromIdentifiers,
  proposeStage2,
} from '../src/cleanup/stage2-rules';
import {
  type GoldLabel,
  type ScoredBook,
  type Stage2Score,
  pct,
  scoreStage2,
  titleRight,
} from '../src/cleanup/stage2-score';

interface ReferenceRecord {
  calibre: {
    cal_title: string;
    cal_authors: string | null;
    cal_tags: string | null;
    has_cover: number;
  };
  file: {
    opf_title?: string | null;
    creators?: { name: string; role: string | null }[] | null;
    publisher?: string[] | null;
    identifiers?: string[] | null;
    language?: string[] | null;
    asin?: string | null;
    cover_px?: [number, number] | null;
  };
}

export function recordToFacts(r: ReferenceRecord): {
  cal: CalibreFacts;
  file: FileFacts;
  recordAsin: string | null;
} {
  const c = r.calibre;
  const f = r.file;
  const cal: CalibreFacts = {
    title: c.cal_title,
    titleSort: null,
    authors: (c.cal_authors ?? '')
      .split('&')
      .map((a) => a.trim())
      .filter((a) => a !== ''),
    authorSort: null,
    tags: (c.cal_tags ?? '').split('|').filter((t) => t !== ''),
    hasCover: c.has_cover === 1,
    cover: null,
    identifiers: {},
    publisher: null,
    languages: [],
    illustrators: [],
  };
  const file: FileFacts = {
    title: f.opf_title ?? null,
    creators: (f.creators ?? []).map((x) => ({ name: x.name, role: x.role })),
    publishers: f.publisher ?? [],
    languages: f.language ?? [],
    identifiers: f.identifiers ?? [],
    asin: asinFromIdentifiers(f.identifiers ?? []),
    cover: f.cover_px
      ? {
          entry: '',
          mediaType: 'image/jpeg',
          bytes: 0,
          sha256: '',
          width: f.cover_px[0],
          height: f.cover_px[1],
          dhash: null,
        }
      : null,
  };
  return { cal, file, recordAsin: f.asin ?? null };
}

export interface Reproduction {
  /** measure_stage2.py's table, computed the same way (rules_v3 clean, raw first author). */
  python: Record<
    string,
    { n: number; tn: number; t: number; ct: number; an: number; aa: number; a1: number }
  >;
  /** What stage 2 applies (production cleaning, name form, classes). */
  stage2: Stage2Score;
  asinMismatches: { id: string; record: string | null; ours: string | null }[];
}

export function reproduce(dir: string): Reproduction {
  const gold = JSON.parse(fs.readFileSync(path.join(dir, 'gold800.json'), 'utf8')) as Record<
    string,
    GoldLabel
  >;
  const python: Reproduction['python'] = {};
  const books: ScoredBook[] = [];
  const asinMismatches: Reproduction['asinMismatches'] = [];
  const S = (l: unknown[]) => new Set(l.map((x) => NA(String(x))));
  const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  const L = (x: unknown): unknown[] => (Array.isArray(x) ? x : x ? [x] : []);
  for (const [id, g] of Object.entries(gold)) {
    const r = JSON.parse(
      fs.readFileSync(path.join(dir, 'records', `${id}.json`), 'utf8'),
    ) as ReferenceRecord;
    const { cal, file, recordAsin } = recordToFacts(r);
    if ((recordAsin ?? null) !== file.asin)
      asinMismatches.push({ id, record: recordAsin, ours: file.asin });
    // measure_stage2.py, line by line.
    const v = cleanTitleV3(r.file.opf_title ?? '');
    const calt = cleanTitleV3(r.calibre.cal_title);
    const unk = ['', 'Unknown'].includes(r.calibre.cal_authors ?? '');
    const proc = (r.calibre.cal_tags ?? '').includes('metadata-processed');
    const k = unk ? 'unknown' : proc ? 'processed' : N(v) === N(calt) ? 'agree' : 'conflict';
    const c = (python[k] ??= { n: 0, tn: 0, t: 0, ct: 0, an: 0, aa: 0, a1: 0 });
    c.n += 1;
    if (g.t !== '?') {
      c.tn += 1;
      if (titleRight(v, g)) c.t += 1;
      if (titleRight(calt, g)) c.ct += 1;
    }
    const fa = (r.file.creators ?? [])
      .filter((x) => x.role === 'aut' || x.role === null)
      .map((x) => x.name);
    if (Array.isArray(g.au)) {
      c.an += 1;
      const golds = [g.au, ...L(g.alt_au)].filter((a): a is unknown[] => Array.isArray(a));
      if (golds.some((a) => eq(S(fa), S(a)))) c.aa += 1;
      if (golds.some((a) => eq(S(fa.slice(0, 1)), S(a)))) c.a1 += 1;
    }
    books.push({ id, gold: g, cal, file, proposals: proposeStage2(cal, file) });
  }
  return { python, stage2: scoreStage2(books), asinMismatches };
}

const f1 = (x: number | null) => (x === null ? '  -  ' : `${x.toFixed(1).padStart(5)}%`);

export function formatReproduction(r: Reproduction): string {
  const lines: string[] = ['measure_stage2.py, reproduced:'];
  for (const k of ['unknown', 'processed', 'agree', 'conflict']) {
    const c = r.python[k];
    if (!c) continue;
    lines.push(
      `${k.padEnd(10)} n=${String(c.n).padStart(4)} title file ${f1(pct(c.t, c.tn))} calibre ${f1(pct(c.ct, c.tn))} | ` +
        `authors all ${f1(pct(c.aa, c.an))} first ${f1(pct(c.a1, c.an))}`,
    );
  }
  lines.push(
    '',
    'Stage 2 as built (value after the auto changes; review = file value held for review):',
  );
  for (const field of ['title', 'authors'] as const) {
    for (const k of ['unknown', 'processed', 'agree', 'conflict'] as const) {
      const g = r.stage2[field][k];
      if (!g.n) continue;
      lines.push(
        `${field.padEnd(8)} ${k.padEnd(10)} n=${String(g.n).padStart(4)} applied ${f1(pct(g.applied, g.n))} ` +
          `calibre ${f1(pct(g.calibre, g.n))} file ${f1(pct(g.file, g.n))} review ${g.review}`,
      );
    }
  }
  const il = r.stage2.illustrator;
  lines.push(`illustrators from role ill: ${il.applied}/${il.n}`);
  lines.push(`ASIN read differently from the record: ${r.asinMismatches.length}`);
  return lines.join('\n');
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: measure-stage2.ts <cleanup-reference dir>');
    process.exit(2);
  }
  const r = reproduce(dir);
  console.log(formatReproduction(r));
  if (process.argv.includes('--misses')) {
    for (const m of r.stage2.misses) console.log(JSON.stringify(m));
    for (const m of r.asinMismatches) console.log('asin', JSON.stringify(m));
  }
}
