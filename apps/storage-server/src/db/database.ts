import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { getSchemaVersion, migrate } from './migrations';
import { ensureOwner } from './users';

export const DB_FILENAME = 'ttsu.db';

export function dbFilePath(dbDir: string): string {
  return path.join(dbDir, DB_FILENAME);
}

/** Opens (creating if needed) the database file, migrates it and ensures the owner user. */
export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    // Lets the CLI and the server use the file at the same time.
    db.pragma('busy_timeout = 5000');
    migrate(db);
    ensureOwner(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export type DatabaseState =
  | { ok: true; db: Database.Database; file: string; schemaVersion: number }
  | { ok: false; error: string };

/**
 * Opens the database for the server or the CLI. Never throws: on any problem
 * the server still starts and /api/v1 reports the reason.
 */
export function initDatabase(dbDir: string, dataRoot: string): DatabaseState {
  try {
    if (isInside(dataRoot, dbDir)) {
      return {
        ok: false,
        error:
          `DB_DIR (${dbDir}) is inside DATA_DIR (${dataRoot}); it must not share the data folder. ` +
          'Mount the database folder separately.',
      };
    }
    if (!existsSync(dbDir) || !statSync(dbDir).isDirectory()) {
      return { ok: false, error: `DB_DIR does not exist: ${dbDir}` };
    }
    const file = dbFilePath(dbDir);
    const db = openDatabase(file);
    return { ok: true, db, file, schemaVersion: getSchemaVersion(db) };
  } catch (err) {
    return { ok: false, error: `could not open the database: ${(err as Error).message}` };
  }
}
