/**
 * WP20g stop 1: stage 2 for the scoped proof's books (wp20g-scoped.ts's working copy, after its
 * run): the run's stage-2 proposals vs stage 2's own analysis code for the same books
 * (`proposalsFor` with the library's spellings, as its whole-library propose step calls it for
 * each book; the never-again rules as there). Reads only the working copy.
 *
 *   npx ts-node --transpile-only scripts/wp20g-stage2-check.ts --work <dir> --calibre <dir>
 */
import Database from 'better-sqlite3';
import path from 'path';
import { getSettings } from '../src/cleanup/settings';
import { loadEvidence, Stage2Analysis } from '../src/cleanup/stage2';
import { spellingLookup } from '../src/cleanup/stage2-snapshot';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const work = arg('work')!;
const cleanup = new Database(path.join(work, 'cleanup.db'), { readonly: true });
const main = new Database(path.join(work, 'ttsu.db'), { readonly: true });
const a2 = new Stage2Analysis({
  cleanup,
  main,
  calibreDir: arg('calibre')!,
  cacheDir: path.join(work, 'cache'),
});
const runId = (
  cleanup.prepare('SELECT MAX(id) AS id FROM calibre_arrival_runs').get() as { id: number }
).id;
const aid = `arrivals:${runId}`;
const libraryId = (
  cleanup
    .prepare(`SELECT library_id FROM calibre_known_books WHERE origin = 'hand' LIMIT 1`)
    .get() as {
    library_id: string;
  }
).library_id;
const snap = a2.currentSnapshot(libraryId);
const spelling = spellingLookup(snap.names);
const settings = getSettings(cleanup);
const done = new Set(
  (
    cleanup
      .prepare(
        `SELECT calibre_uuid || '|' || field AS k FROM proposed_changes WHERE stage = 2 AND library_id = ?
         AND (state IN ('queued', 'applied', 'undone', 'kept') OR (state = 'proposed' AND decided_by IS NOT NULL))`,
      )
      .all(libraryId) as { k: string }[]
  ).map((r) => r.k),
);
const byUuid = new Map([...snap.books.values()].map((b) => [b.uuid, b]));
const hand = (
  cleanup.prepare(`SELECT calibre_uuid FROM calibre_known_books WHERE origin = 'hand'`).all() as {
    calibre_uuid: string;
  }[]
).map((r) => r.calibre_uuid);
const whole: string[] = [];
let read = 0;
for (const uuid of hand) {
  const book = byUuid.get(uuid);
  const ev = book ? loadEvidence(cleanup, libraryId, uuid) : null;
  if (!book || !ev?.file) continue;
  read++;
  for (const p of a2.proposalsFor(book, ev, settings, spelling))
    if (!done.has(`${uuid}|${p.field}`))
      whole.push(`${book.calibreId}|${p.field}|${JSON.stringify(p.new ?? null)}|${p.class}`);
}
const scoped = (
  cleanup
    .prepare(
      `SELECT calibre_id, field, new_json, class FROM proposed_changes WHERE stage = 2 AND analysis_id = ?`,
    )
    .all(aid) as { calibre_id: number; field: string; new_json: string; class: string }[]
).map((r) => `${r.calibre_id}|${r.field}|${r.new_json}|${r.class}`);
const ws = new Set(whole);
const ss = new Set(scoped);
console.log(
  JSON.stringify(
    {
      books: hand.length,
      withEvidence: read,
      whole: whole.length,
      scoped: scoped.length,
      onlyScoped: scoped.filter((x) => !ws.has(x)),
      onlyWhole: whole.filter((x) => !ss.has(x)),
    },
    null,
    1,
  ),
);
