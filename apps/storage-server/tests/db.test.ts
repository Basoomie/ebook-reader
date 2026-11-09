import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { dbFilePath, initDatabase, openDatabase } from '../src/db/database';
import { getSchemaVersion, LATEST_SCHEMA_VERSION, migrate } from '../src/db/migrations';
import {
  authenticateToken,
  createToken,
  hashToken,
  listTokens,
  revokeToken,
  TOKEN_PREFIX,
} from '../src/db/tokens';
import { ensureOwner, listUsers, OWNER_NAME } from '../src/db/users';
import { makeTempDir } from './helpers/spawn-server';

function freshDb() {
  return openDatabase(path.join(makeTempDir('db'), 'ttsu.db'));
}

describe('migrations', () => {
  it('migrates an empty database to the latest version', () => {
    const db = new Database(':memory:');
    expect(getSchemaVersion(db)).toBe(0);
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'api_tokens',
      'authors',
      'book_authors',
      'book_sources',
      'book_tags',
      'books',
      'devices',
      'legacy_books',
      'legacy_device_reports',
      'libraries',
      'library_index_state',
      'migration_state',
      'pairing_codes',
      'series',
      'server_secrets',
      'sync_records',
      'sync_state',
      'tags',
      'thumbnails',
      'users',
    ]);
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('refuses a database from a newer server', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this server supports/);
  });

  it('enables WAL and foreign keys', () => {
    const db = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const owner = listUsers(db)[0];
    expect(() =>
      db
        .prepare(
          'INSERT INTO api_tokens (id, user_id, label, token_hash, created_at) VALUES (?,?,?,?,?)',
        )
        .run('x', 'no-such-user', 'l', 'h', 1),
    ).toThrow(/FOREIGN KEY/);
    expect(owner).toBeTruthy();
  });
});

describe('owner bootstrap', () => {
  it('creates exactly one owner, once', () => {
    const dir = makeTempDir('db');
    const file = path.join(dir, 'ttsu.db');
    openDatabase(file).close();
    const db = openDatabase(file);
    ensureOwner(db);
    const users = listUsers(db);
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe(OWNER_NAME);
    expect(users[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('initDatabase', () => {
  it('reports a missing DB_DIR instead of creating it', () => {
    const dir = path.join(makeTempDir('db'), 'missing');
    const state = initDatabase(dir, makeTempDir('data'));
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error).toContain('DB_DIR does not exist');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses a DB_DIR inside DATA_DIR and writes nothing there', () => {
    const data = makeTempDir('data');
    for (const dbDir of [data, path.join(data, 'db')]) {
      fs.mkdirSync(dbDir, { recursive: true });
      const state = initDatabase(dbDir, data);
      expect(state.ok).toBe(false);
      if (!state.ok) expect(state.error).toContain('inside DATA_DIR');
      expect(fs.existsSync(dbFilePath(dbDir))).toBe(false);
    }
  });

  it('allows a sibling folder whose name starts like DATA_DIR', () => {
    const parent = makeTempDir('parent');
    const data = path.join(parent, 'data');
    const dbDir = path.join(parent, 'data-db');
    fs.mkdirSync(data);
    fs.mkdirSync(dbDir);
    const state = initDatabase(dbDir, data);
    expect(state.ok).toBe(true);
    if (state.ok) state.db.close();
  });

  it('reports a corrupt database file', () => {
    const dir = makeTempDir('db');
    fs.writeFileSync(dbFilePath(dir), 'this is not a sqlite database, just some text '.repeat(50));
    const state = initDatabase(dir, makeTempDir('data'));
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error).toContain('could not open the database');
  });
});

describe('tokens', () => {
  it('creates a prefixed 256-bit token and stores only its hash', () => {
    const db = freshDb();
    const owner = listUsers(db)[0];
    const { token, record } = createToken(db, owner.id, '  Phone  ');
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBe(TOKEN_PREFIX.length + 43);
    expect(record.label).toBe('Phone');

    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(record.id) as any;
    expect(row.token_hash).toBe(hashToken(token));
    const everything = JSON.stringify(db.prepare('SELECT * FROM api_tokens').all());
    expect(everything).not.toContain(token);
  });

  it('requires a label', () => {
    const db = freshDb();
    expect(() => createToken(db, listUsers(db)[0].id, '   ')).toThrow(/label/);
  });

  it('authenticates active tokens and records last use', () => {
    const db = freshDb();
    const owner = listUsers(db)[0];
    const { token, record } = createToken(db, owner.id, 'Boox', 1000);
    expect(record.lastUsedAt).toBeNull();

    const auth = authenticateToken(db, token, 5000);
    expect(auth).toEqual({
      user: { id: owner.id, name: OWNER_NAME },
      token: { id: record.id, label: 'Boox', deviceId: null },
    });
    expect(listTokens(db)[0].lastUsedAt).toBe(5000);
  });

  it('rejects unknown, malformed and revoked tokens', () => {
    const db = freshDb();
    const owner = listUsers(db)[0];
    const { token, record } = createToken(db, owner.id, 'Phone');
    expect(authenticateToken(db, `${token}x`)).toBeNull();
    expect(authenticateToken(db, 'not-a-ttsu-token')).toBeNull();
    expect(authenticateToken(db, '')).toBeNull();

    expect(revokeToken(db, record.id, 42)).toBe(true);
    expect(authenticateToken(db, token)).toBeNull();
    expect(revokeToken(db, record.id)).toBe(false);
    expect(revokeToken(db, 'no-such-id')).toBe(false);
    expect(listTokens(db)[0].revokedAt).toBe(42);
  });

  it('lists tokens with their user', () => {
    const db = freshDb();
    const owner = listUsers(db)[0];
    createToken(db, owner.id, 'A', 1);
    createToken(db, owner.id, 'B', 2);
    expect(listTokens(db).map((t) => [t.label, t.userName])).toEqual([
      ['A', OWNER_NAME],
      ['B', OWNER_NAME],
    ]);
  });
});
