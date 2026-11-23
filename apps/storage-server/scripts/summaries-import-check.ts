/**
 * Book summaries session 3: after the import on a working copy, what the server does with it:
 * the stored summaries per book and the "book-summary" record each device gets (written by the
 * server's sweep). Only for copies: never point it at the live databases.
 *   npx ts-node --transpile-only scripts/summaries-import-check.ts <db dir of the copy>
 */
import path from 'path';
import { initDatabase } from '../src/db/database';
import { listUsers } from '../src/db/users';
import { SummaryService } from '../src/summaries/service';
import { openSummariesDb, summariesDbPath } from '../src/summaries/summaries-db';
import { SyncStore } from '../src/sync/store';

const dir = process.argv[2];
const state = initDatabase(dir, path.join(dir, '..', 'data'));
if (!state.ok) throw new Error(state.error);
const sdb = openSummariesDb(summariesDbPath(dir));
const svc = new SummaryService({
  db: sdb,
  main: state.db,
  core: { settings: () => ({ models: [] }) } as never,
  runner: {} as never,
  readScript: async () => {
    throw new Error('not here');
  },
});
const sync = new SyncStore(state.db);
svc.attachSync(sync);
const user = listUsers(state.db)[0];
for (const m of sdb.prepare(`SELECT * FROM summaries ORDER BY id`).all() as {
  id: number;
  book_id: string;
  origin: string;
  setup: string;
  background: number;
  made_at: number;
  note: string;
}[]) {
  const v = svc.store.view(m.id)!;
  const items = v.sections.reduce(
    (a, s) => a + s.groups.reduce((b, g) => b + g.items.length, 0),
    0,
  );
  const rec = sync.getRecord(user.id, 'book-summary', m.book_id);
  console.log(
    `${v.bookTitle} · ${m.origin}/${m.setup}${m.background ? ' bg' : ''} · made ${new Date(m.made_at).toISOString()} · ${items} items · ${m.note}\n   record: ${JSON.stringify(rec?.data)}`,
  );
}
