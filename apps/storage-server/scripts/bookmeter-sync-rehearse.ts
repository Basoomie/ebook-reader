/**
 * Bookmeter sync, the rehearsal (docs/design/bookmeter-sync.md): the real server code on a copy
 * of the reader's ttsu.db, with the user's list pages saved on this PC in place of the internet.
 * Migrates the copy, adds the account, answers the fetch queue from the saved pages (a full
 * check), then runs the devices' planner (web lib/bookmeter/plan.ts) on the records it wrote.
 * Prints the counts, every planned change, what the reader keeps, and every entry nothing
 * matched (read ones with their date). Writes only the copy (refused on a live path) and a
 * temporary fetch queue.
 *
 *   npx vite-node scripts/bookmeter-sync-rehearse.ts -- --ttsu <ttsu.db copy>
 *     --html <folder with profile.html, read-N.html, reading-N.html, stacked-N.html, wish-N.html>
 *     --user <bookmeter user id> --out <report.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brotliCompressSync } from 'zlib';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { migrate } from '../src/db/migrations';
import { SyncStore } from '../src/sync/store';
import { BookmeterSync, BOOKMETER_ENTRY_KIND } from '../src/bookmeter/service';
import {
  entryFrom,
  planChanges,
  type BookmeterEntry,
  type StatusInfo,
} from '../../web/src/lib/bookmeter/plan';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ttsu = arg('ttsu');
const html = arg('html');
const user = arg('user');
const out = arg('out');
if (!ttsu || !html || !user || !out) throw new Error('--ttsu, --html, --user and --out are needed');
if (/^[a-z]:\\ttsu|^\\\\|^y:/i.test(path.resolve(ttsu))) throw new Error('refusing a live path');

async function main() {
  const db = new Database(ttsu!);
  db.pragma('journal_mode = WAL');
  console.log(`schema ${db.pragma('user_version', { simple: true })} → ${migrate(db)}`);

  const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-rehearse-'));
  const cdb = openCleanupDatabase(path.join(qdir, 'cleanup.db'));
  const fsSet = getSettings(cdb).fetch;
  updateSettings(cdb, {
    fetch: {
      ...fsSet,
      sites: Object.fromEntries(
        Object.keys(fsSet.sites).map((k) => [k, { ...fsSet.sites[k], intervalSeconds: 0.25 }]),
      ),
    },
  });
  const q = new FetchQueue(cdb, path.join(qdir, 'cache'), () => getSettings(cdb).fetch);
  const told: string[] = [];
  const s = new BookmeterSync({
    db,
    queue: () => q,
    notifications: { notify: (m) => told.push(m.lines[0]), addDigestLine: () => {} },
    log: (l) => console.log(l),
    tickMs: 3_600_000,
  });
  s.attachSync(new SyncStore(db));

  const pageFor = (url: string): string | null => {
    const u = new URL(url);
    const m = /^\/users\/\d+(?:\/books\/(read|reading|stacked|wish))?$/.exec(u.pathname);
    if (!m) return null;
    const file = m[1] ? `${m[1]}-${u.searchParams.get('page') ?? '1'}.html` : 'profile.html';
    const p = path.join(html!, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };

  const started = Date.now();
  const account = s.addAccount({ userId: user! });
  for (let i = 0; i < 400; i++) {
    await s.tick();
    const { requests } = q.claim();
    for (const r of requests) {
      const body = pageFor(r.url);
      q.report(r.id, r.leaseToken, {
        status: body === null ? 404 : 200,
        ms: 1,
        error: null,
        body: brotliCompressSync(Buffer.from(body ?? '')),
        encoding: 'br',
      });
    }
    await s.tick();
    const st = s.status().accounts[0];
    if (!st.checking) break;
    if (requests.length === 0) await new Promise((r) => setTimeout(r, 260));
  }
  const status = s.status().accounts[0];
  console.log(`check done in ${Date.now() - started} ms; error: ${status.error ?? 'none'}`);

  // The devices' side: the records the server wrote, through the web planner.
  const userId = (
    db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as { id: string }
  ).id;
  const records = db
    .prepare('SELECT * FROM sync_records WHERE user_id = ? AND kind = ? AND deleted_at IS NULL')
    .all(userId, BOOKMETER_ENTRY_KIND) as { id: string; data: string; updated_at: number }[];
  const entries = records
    .map((r) =>
      entryFrom({
        kind: BOOKMETER_ENTRY_KIND,
        id: r.id,
        bookId: null,
        deviceId: 'server',
        updatedAt: r.updated_at,
        deletedAt: null,
        rev: 1,
        data: JSON.parse(r.data),
      }),
    )
    .filter((e): e is BookmeterEntry => e !== null);
  type St =
    Parameters<typeof planChanges>[0]['states'] extends ReadonlyMap<string, infer S> ? S : never;
  const states = new Map<string, St>();
  const info = new Map<string, StatusInfo>();
  for (const r of db
    .prepare(
      "SELECT kind, id, book_id, data, updated_at FROM sync_records WHERE user_id = ? AND deleted_at IS NULL AND kind IN ('book-status', 'read-through')",
    )
    .all(userId) as {
    kind: string;
    id: string;
    book_id: string;
    data: string;
    updated_at: number;
  }[]) {
    const d = JSON.parse(r.data);
    const bookId = r.kind === 'book-status' ? r.id : r.id.split(':')[0];
    const st =
      states.get(bookId) ??
      ({
        bookId,
        status: 'unread',
        statusAuto: false,
        favorite: false,
        blur: 'inherit',
        readThroughs: [],
      } as unknown as St);
    if (r.kind === 'book-status') {
      (st as { status: string }).status = d.status;
      info.set(bookId, { updatedAt: r.updated_at, auto: d.auto === true });
    } else (st as { readThroughs: unknown[] }).readThroughs.push(d);
    states.set(bookId, st);
  }
  const dayOf = (ms: number) => new Date(ms - 7 * 3_600_000).toISOString().slice(0, 10);
  const changes = planChanges({ entries, states, statusInfo: info, applied: new Map(), dayOf });

  const title = (id: string) =>
    (db.prepare('SELECT title FROM books WHERE id = ?').get(id) as { title: string } | undefined)
      ?.title;
  const kept = [...states.values()].map((st) => {
    const e = entries.filter((x) => x.target === (st as { bookId: string }).bookId);
    const c = changes.find((x) => x.bookId === (st as { bookId: string }).bookId);
    return {
      title: title((st as { bookId: string }).bookId),
      reader: (st as { status: string }).status,
      auto: info.get((st as { bookId: string }).bookId)?.auto ?? null,
      setOn: info.has((st as { bookId: string }).bookId)
        ? dayOf(info.get((st as { bookId: string }).bookId)!.updatedAt!)
        : null,
      bookmeter: e.map((x) => `${x.list}${x.date ? ` ${x.date}` : ''}`),
      change: c ? `${c.kind}${c.date ? ` ${c.date}` : ''}` : null,
    };
  });
  const um = s.unmatched(account.id);
  const report = {
    status,
    changes: {
      complete: changes.filter((c) => c.kind === 'complete').length,
      reading: changes.filter((c) => c.kind === 'reading').length,
      list: changes.map((c) => ({
        title: title(c.bookId),
        kind: c.kind,
        date: c.date,
        from: c.from,
      })),
    },
    readerBooks: kept,
    unmatched: um.unmatched.map((e) => ({
      list: e.list,
      date: e.date,
      title: e.title,
      authors: e.authors,
      url: e.url,
      near: e.near.map((n) => n.title),
    })),
    told,
  };
  fs.writeFileSync(out!, JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify(
      {
        entries: status.entries,
        matched: status.matched,
        unmatched: status.unmatched,
        ...report.changes,
        list: undefined,
      },
      null,
      1,
    ),
  );
  s.stop();
  db.close();
  cdb.close();
  fs.rmSync(qdir, { recursive: true, force: true });
}

void main();
