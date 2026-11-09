import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface User {
  id: string;
  name: string;
  createdAt: number;
}

/** Name of the user created on first start. The app is single-user for now. */
export const OWNER_NAME = 'owner';

interface UserRow {
  id: string;
  name: string;
  created_at: number;
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export function listUsers(db: Database.Database): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUser);
}

export function getUserByName(db: Database.Database, name: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/** Creates the owner user if the database has no users yet. */
export function ensureOwner(db: Database.Database, now = Date.now()): void {
  db.transaction(() => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (n > 0) return;
    db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').run(
      randomUUID(),
      OWNER_NAME,
      now,
    );
    console.log(`Database: created user "${OWNER_NAME}"`);
  })();
}
