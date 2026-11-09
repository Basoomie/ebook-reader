/**
 * Checks the hand-written fixture schema against a metadata.db made by real
 * Calibre (tests/fixtures/calibre-7.1, built by scripts/make-calibre-fixture.ts),
 * so the synthetic tests can't drift from what Calibre actually writes.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { CALIBRE_FIXTURE_DIR, FIXTURE_DDL } from './helpers/calibre-fixture';

const REAL_DB = path.join(CALIBRE_FIXTURE_DIR, 'japanese-test', 'metadata.db');

function columns(db: Database.Database, table: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
  }[]) {
    out[c.name] = c.type;
  }
  return out;
}

describe('Calibre schema', () => {
  it('has every table and column the fixture (and the indexer) uses, with the same types', () => {
    const real = new Database(REAL_DB, { readonly: true, fileMustExist: true });
    const fixture = new Database(':memory:');
    fixture.exec(FIXTURE_DDL);
    try {
      const tables = (
        fixture.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      )
        .map((t) => t.name)
        .filter((n) => !n.startsWith('sqlite_'));
      expect(tables.length).toBeGreaterThan(10);
      for (const table of tables) {
        const realCols = columns(real, table);
        for (const [name, type] of Object.entries(columns(fixture, table))) {
          expect(realCols[name], `${table}.${name}`).toBe(type);
        }
      }
    } finally {
      real.close();
      fixture.close();
    }
  });

  it('uses a rollback journal, not WAL (header bytes 18/19 = 1)', () => {
    const header = fs.readFileSync(REAL_DB).subarray(0, 20);
    expect(header[18]).toBe(1);
    expect(header[19]).toBe(1);
  });
});
