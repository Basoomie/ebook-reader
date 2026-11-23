/**
 * WP21g stop 1: the gate on the labeled recordings (ebook-pairs.json), on copies of the live
 * databases: every recording paired as the stage pairs it, the labels found through the stage's
 * own unit finder, scored with its own gate. Prints found / right per kind and every miss.
 *
 *   npx vite-node scripts/wp21g-gate.ts -- --cleanup <cleanup.db copy> --calibre <snapshot copy>
 *     --labels <ebook-pairs.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { DiskLock } from '../src/cleanup/disk-lock';
import { readEbookSnapshot } from '../src/cleanup/audio/ebook-snapshot';
import {
  AudioStage8,
  audioFactsAll,
  scoreEbookGate,
  type EbookLabel,
} from '../src/cleanup/audio/stage8-ebooks';
import { buildIndex, candidatesOf, pairRecording } from '../src/cleanup/audio/ebook-pair';
import { DEFAULT_SETTINGS } from '../src/cleanup/settings';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}
const db = new Database(arg('cleanup'), { readonly: true, fileMustExist: true });
const snap = readEbookSnapshot(arg('calibre'));
const labels = (
  JSON.parse(fs.readFileSync(arg('labels'), 'utf8')) as {
    books: (EbookLabel & { note?: string })[];
  }
).books;
const idx = buildIndex(snap.books.values());
const a = DEFAULT_SETTINGS.audiobooks;
const s = {
  titleScore: a.ebookTitleScore,
  titleMinChars: a.ebookTitleMinChars,
  titleMinShare: a.ebookTitleMinShare,
};
const facts = audioFactsAll(db);
const results = new Map(
  facts.map((f) => [f.unitKey, { f, r: pairRecording(f, candidatesOf(f, idx), s) }]),
);
const s8 = new AudioStage8({ db, lock: new DiskLock(), calibre: () => null });
const finder = s8.unitFinder();
const g = scoreEbookGate(labels, finder, (u) => {
  const x = results.get(u);
  return x ? { cls: x.r.class, id: x.r.calibreId, title: x.f.title } : null;
});
console.log(
  `gate ${g.passed ? 'PASSED' : 'FAILED'}: ${g.labels} labels, ${g.wrong.length} wrong, ${g.notFound.length} not found`,
);
console.log('kind               with  found right wrong | none noneRight | review');
for (const [k, v] of Object.entries(g.kinds))
  console.log(
    `${k.padEnd(18)} ${String(v.withEbook).padStart(4)} ${String(v.found).padStart(6)} ${String(v.right).padStart(5)} ${String(v.wrong).padStart(5)} | ${String(v.none).padStart(4)} ${String(v.noneRight).padStart(9)} | ${String(v.review).padStart(6)}`,
  );
const tot = Object.values(g.kinds).reduce(
  (t, v) => ({
    withEbook: t.withEbook + v.withEbook,
    found: t.found + v.found,
    right: t.right + v.right,
    wrong: t.wrong + v.wrong,
    none: t.none + v.none,
    noneRight: t.noneRight + v.noneRight,
    review: t.review + v.review,
  }),
  { withEbook: 0, found: 0, right: 0, wrong: 0, none: 0, noneRight: 0, review: 0 },
);
console.log(
  `all: ${tot.found} of ${tot.withEbook} found (${((100 * tot.found) / Math.max(1, tot.withEbook)).toFixed(1)} %), ${tot.right} right of ${tot.found + (tot.wrong - (tot.found - tot.right))} automatic; ${tot.noneRight} of ${tot.none} without an ebook left unpaired; ${tot.review} to review`,
);
for (const w of g.wrong) console.log('WRONG', w);
for (const n of g.notFound) console.log('NOT FOUND', n);
// Labeled with an ebook but not paired automatically: why.
for (const l of labels) {
  const u = finder(l.torrent);
  const x = u ? results.get(u) : null;
  if (!x || !l.calibre?.length || x.r.class === 'auto') continue;
  console.log(
    `missed ${l.id} [${l.kind}] ${x.f.title} → want ${l.calibre.join('/')}: ${x.r.class} · ${x.r.reason}`,
  );
}
