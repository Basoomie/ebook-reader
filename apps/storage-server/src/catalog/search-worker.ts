/**
 * The search worker thread (WP7a): runs the catalog queries that contain a /regex/ on
 * its own read-only connection, so a pattern that never finishes can be stopped by
 * terminating the thread (search-runner.ts) while the server keeps answering. The
 * database is in WAL mode, so this reader sees every committed write.
 */
import Database from 'better-sqlite3';
import { parentPort, workerData } from 'worker_threads';
import { registerRegexp } from './regexp';

interface Job {
  id: number;
  sql: string;
  params: unknown[];
}

const db = new Database((workerData as { file: string }).file, {
  readonly: true,
  fileMustExist: true,
});
db.pragma('busy_timeout = 5000');
registerRegexp(db);

const statements = new Map<string, Database.Statement>();

function statement(sql: string): Database.Statement {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    if (statements.size >= 64) statements.delete(statements.keys().next().value as string);
    statements.set(sql, stmt);
  }
  return stmt;
}

parentPort!.on('message', (job: Job) => {
  try {
    parentPort!.postMessage({ id: job.id, rows: statement(job.sql).all(...job.params) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error).message });
  }
});

parentPort!.postMessage({ ready: true });
