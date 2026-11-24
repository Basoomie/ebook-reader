/**
 * The Natively level (2026-11-24): one real read through NativelyLevels (the server's own request,
 * pace and parser) on a throwaway database. Asks Natively once per id given.
 *   npx ts-node -T scripts/natively-level-real.ts a7af2a17be [more ids…]
 */
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrations';
import { NativelyLevels } from '../src/natively/levels';

async function main() {
  const db = new Database(':memory:');
  const log = console.log;
  console.log = () => {};
  migrate(db);
  console.log = log;
  const levels = new NativelyLevels({ db, log: (l) => console.log(l) });
  levels.start();
  for (const id of process.argv.slice(2)) {
    const t = Date.now();
    const row = await levels.refresh(id, 60_000);
    console.log(id, JSON.stringify(row), `${Date.now() - t} ms`);
  }
  await levels.stop();
}

void main();
