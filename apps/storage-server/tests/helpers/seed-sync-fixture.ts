/**
 * Prepares a database for the web app's two-device sync test
 * (apps/web/tests/sync-two-devices.test.ts), which runs the real server as a
 * separate process:
 *
 *   node -r ts-node/register/transpile-only tests/helpers/seed-sync-fixture.ts <dbDir> <tokens>
 *
 * Creates (and migrates) the database, adds one catalog book and <tokens>
 * device tokens, and prints "SEED " + { bookId, tokens } as JSON on its own line.
 */
import { randomUUID } from 'crypto';
import path from 'path';
import { openDatabase } from '../../src/db/database';
import { createToken } from '../../src/db/tokens';
import { listUsers } from '../../src/db/users';

const [dbDir, countRaw] = process.argv.slice(2);
const count = Number(countRaw ?? '2');
if (!dbDir || !Number.isInteger(count) || count < 1) {
  console.error('usage: seed-sync-fixture.ts <dbDir> <tokens>');
  process.exit(1);
}

const db = openDatabase(path.join(dbDir, 'ttsu.db'));
try {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO libraries (id, folder, name, discovered_at, updated_at)
     VALUES ('lib1', 'lib', 'Lib', ?, ?)`,
  ).run(now, now);
  const bookId = randomUUID();
  db.prepare(
    `INSERT INTO books (id, library_id, title, added_at, created_at, updated_at)
     VALUES (?, 'lib1', 'Book', ?, ?, ?)`,
  ).run(bookId, now, now, now);
  const [owner] = listUsers(db);
  const tokens = Array.from(
    { length: count },
    (_, i) => createToken(db, owner.id, `Device ${i + 1}`).token,
  );
  // Migrations log to stdout too; the result is the line after the marker.
  console.log(`SEED ${JSON.stringify({ bookId, tokens })}`);
} finally {
  db.close();
}
