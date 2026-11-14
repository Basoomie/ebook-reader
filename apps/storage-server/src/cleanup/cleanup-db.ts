/**
 * cleanup.db (Phase 6, WP20a): the Calibre library cleanup's own database, beside ttsu.db
 * in DB_DIR. Only this server writes it (the apply sidecar talks to the server's API).
 *
 * It holds the proposed changes (one row per book and field), batches and the undo record
 * of every applied batch, the cleanup's settings and encrypted secrets, the sidecar's
 * tokens, and room for the later stages (evidence records, the source of every applied
 * value). The reader never depends on it: if it can't be opened, only /api/v1/cleanup*
 * answers 503.
 *
 * Migrations work like ttsu.db's (src/db/migrations.ts): applied in order, tracked with
 * PRAGMA user_version, never edited once shipped; a newer file is refused.
 */
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import path from 'path';

export const CLEANUP_DB_FILENAME = 'cleanup.db';

export function cleanupDbPath(dbDir: string): string {
  return path.join(dbDir, CLEANUP_DB_FILENAME);
}

export const CLEANUP_MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'cleanup foundation (WP20a)',
    sql: `
      -- Settings edited on /cleanup (JSON values; defaults live in code).
      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at  INTEGER NOT NULL
      );

      -- AI keys and the Calibre password: AES-256-GCM, the key is in ttsu.db
      -- (server_secrets 'cleanup_secrets'), so this file alone reveals nothing.
      CREATE TABLE secrets (
        name        TEXT PRIMARY KEY,
        ciphertext  BLOB NOT NULL,
        nonce       BLOB NOT NULL,
        tag         BLOB NOT NULL,
        hint        TEXT,
        updated_at  INTEGER NOT NULL
      );

      -- The apply sidecar's tokens (cli token cleanup). Only a SHA-256 hash is stored.
      CREATE TABLE apply_tokens (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        revoked_at    INTEGER
      );

      -- One row per stage (0 = safety checks, 1-5 = the plan's stages). mode: off (default),
      -- analyse (analysis only, nothing applied) or on (analysis and unattended apply).
      CREATE TABLE stages (
        stage          INTEGER PRIMARY KEY CHECK (stage BETWEEN 0 AND 5),
        mode           TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        state          TEXT NOT NULL DEFAULT 'idle',
        pause_reason   TEXT,
        pause_detail   TEXT,
        paused_at      INTEGER,
        progress_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        precision_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(precision_json)),
        updated_at     INTEGER NOT NULL
      );
      INSERT INTO stages (stage, updated_at) VALUES (0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (5, 0);

      -- Results of the safety checks (stage 0), from the sidecar and the server.
      CREATE TABLE preflight (
        name        TEXT PRIMARY KEY,
        ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
        detail      TEXT,
        source      TEXT NOT NULL CHECK (source IN ('sidecar', 'server')),
        checked_at  INTEGER NOT NULL
      );

      CREATE TABLE sidecar_status (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        last_seen_at     INTEGER,
        version          TEXT,
        calibredb        TEXT,
        server_version   TEXT,
        trash_restore    INTEGER,
        problem          TEXT,
        updated_at       INTEGER NOT NULL
      );
      INSERT INTO sidecar_status (id, updated_at) VALUES (1, 0);

      -- What the server knows about each EPUB file (stage 1): stat and, for files that
      -- share a size with another, the SHA-256. A file is hashed again only when its
      -- path, size or mtime changed.
      CREATE TABLE file_facts (
        library_id             TEXT NOT NULL,
        calibre_id             INTEGER NOT NULL,
        calibre_uuid           TEXT NOT NULL,
        file_path              TEXT NOT NULL,
        size                   INTEGER,
        mtime_ms               INTEGER,
        calibre_last_modified  TEXT,
        sha256                 TEXT,
        stat_at                INTEGER,
        hashed_at              INTEGER,
        error                  TEXT,
        PRIMARY KEY (library_id, calibre_id)
      );
      CREATE INDEX file_facts_size ON file_facts (library_id, size);

      -- Proposed changes: one row per book and field. Stage 1 rows have field 'book',
      -- old 'present', new 'removed'.
      CREATE TABLE proposed_changes (
        id             INTEGER PRIMARY KEY,
        stage          INTEGER NOT NULL,
        library_id     TEXT NOT NULL,
        calibre_id     INTEGER NOT NULL,
        calibre_uuid   TEXT NOT NULL,
        field          TEXT NOT NULL,
        old_json       TEXT CHECK (old_json IS NULL OR json_valid(old_json)),
        new_json       TEXT CHECK (new_json IS NULL OR json_valid(new_json)),
        source         TEXT NOT NULL,
        evidence_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
        class          TEXT NOT NULL CHECK (class IN ('auto', 'review')),
        review_reason  TEXT,
        state          TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (state IN ('proposed', 'queued', 'applied', 'kept', 'skipped', 'undone')),
        decided_by     TEXT,
        decided_at     INTEGER,
        batch_id       TEXT,
        analysis_id    TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX proposed_changes_stage ON proposed_changes (stage, state, class, id);
      CREATE INDEX proposed_changes_book ON proposed_changes (library_id, calibre_uuid);

      -- Batches handed to the sidecar. kind: apply, or undo of an applied batch.
      CREATE TABLE batches (
        id                TEXT PRIMARY KEY,
        stage             INTEGER NOT NULL,
        library_id        TEXT NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('apply', 'undo')),
        undo_of           TEXT REFERENCES batches(id),
        state             TEXT NOT NULL
                          CHECK (state IN ('planned', 'claimed', 'applied', 'partial', 'failed', 'undone')),
        item_count        INTEGER NOT NULL,
        snapshot_sha256   TEXT,
        snapshot_saved    INTEGER NOT NULL DEFAULT 0,
        lease_expires_at  INTEGER,
        attempts          INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        claimed_at        INTEGER,
        finished_at       INTEGER,
        ingested_at       INTEGER,
        error             TEXT,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX batches_state ON batches (state, created_at);

      CREATE TABLE batch_items (
        id              INTEGER PRIMARY KEY,
        batch_id        TEXT NOT NULL REFERENCES batches(id),
        change_id       INTEGER NOT NULL REFERENCES proposed_changes(id),
        position        INTEGER NOT NULL,
        state           TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'verified', 'exported', 'tagged', 'removed', 'restored', 'failed', 'skipped')),
        quarantine_dir  TEXT,
        export_sha256   TEXT,
        method          TEXT,
        detail          TEXT,
        updated_at      INTEGER NOT NULL,
        UNIQUE (batch_id, change_id)
      );
      CREATE INDEX batch_items_batch ON batch_items (batch_id, position);

      -- The undo record of every applied removal: what was removed, what it was a duplicate
      -- of (this also maps a removed reference-sample book to its kept copy), its tags, the
      -- user's own tags that were added to the kept copy (decided with the user 2026-11-13:
      -- they are copied, not lost; Undo takes them off again), the quarantine folder and the
      -- reader-side handoff.
      CREATE TABLE undo_records (
        batch_id           TEXT NOT NULL REFERENCES batches(id),
        change_id          INTEGER NOT NULL REFERENCES proposed_changes(id),
        library_id         TEXT NOT NULL,
        removed_calibre_id INTEGER NOT NULL,
        removed_uuid       TEXT NOT NULL,
        kept_calibre_id    INTEGER NOT NULL,
        kept_uuid          TEXT NOT NULL,
        tags_json          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
        added_tags_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(added_tags_json)),
        quarantine_dir     TEXT,
        handoff_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(handoff_json)),
        restored_at        INTEGER,
        restore_method     TEXT,
        restored_calibre_id INTEGER,
        restored_uuid      TEXT,
        created_at         INTEGER NOT NULL,
        PRIMARY KEY (batch_id, change_id)
      );
      CREATE INDEX undo_records_removed ON undo_records (library_id, removed_uuid);

      -- Room for the later stages (WP20b+), unused in WP20a:
      -- each book's extracted evidence (file metadata, fetched pages, model answers) ...
      CREATE TABLE evidence_records (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        kind          TEXT NOT NULL,
        version       INTEGER NOT NULL,
        data          BLOB NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid, kind)
      );
      -- ... and the source of every value a later stage applies (rules, haiku+luna, luna,
      -- user), so an upgrade re-checks only what the models decided and never overwrites
      -- a value the user edited since.
      CREATE TABLE applied_values (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        field         TEXT NOT NULL,
        value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
        source        TEXT NOT NULL,
        batch_id      TEXT,
        applied_at    INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid, field)
      );
    `,
  },
  {
    version: 2,
    name: "the content server's library list",
    // The library ids the sidecar found on the content server, so the page needs no
    // "Calibre library id" field: the id is found from the reader library's folder.
    sql: `ALTER TABLE sidecar_status ADD COLUMN calibre_libraries TEXT;`,
  },
  {
    version: 3,
    name: 'stage 2: metadata and covers from the files (WP20b)',
    sql: `
      -- Stage 2 items end as 'written' (a book's fields were set in Calibre). CHECK lists
      -- can't be altered, so batch_items is rebuilt; nothing references it.
      CREATE TABLE batch_items_v3 (
        id              INTEGER PRIMARY KEY,
        batch_id        TEXT NOT NULL REFERENCES batches(id),
        change_id       INTEGER NOT NULL REFERENCES proposed_changes(id),
        position        INTEGER NOT NULL,
        state           TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending', 'verified', 'exported', 'tagged', 'removed',
                                         'written', 'restored', 'failed', 'skipped')),
        quarantine_dir  TEXT,
        export_sha256   TEXT,
        method          TEXT,
        detail          TEXT,
        -- stage 2: what the sidecar saw when it verified the book (last_modified before the write)
        stage2_json     TEXT CHECK (stage2_json IS NULL OR json_valid(stage2_json)),
        updated_at      INTEGER NOT NULL,
        UNIQUE (batch_id, change_id)
      );
      INSERT INTO batch_items_v3 (id, batch_id, change_id, position, state, quarantine_dir,
        export_sha256, method, detail, updated_at)
        SELECT id, batch_id, change_id, position, state, quarantine_dir, export_sha256, method,
          detail, updated_at FROM batch_items;
      DROP TABLE batch_items;
      ALTER TABLE batch_items_v3 RENAME TO batch_items;
      CREATE INDEX batch_items_batch ON batch_items (batch_id, position);

      -- The undo record of every field stage 2 wrote: the old value (with the sort written
      -- alongside a title or author change), the value written, Calibre's last_modified right
      -- after the write, and Calibre's old cover saved in the quarantine before it was replaced.
      CREATE TABLE field_undo (
        batch_id            TEXT NOT NULL REFERENCES batches(id),
        change_id           INTEGER NOT NULL REFERENCES proposed_changes(id),
        library_id          TEXT NOT NULL,
        calibre_id          INTEGER NOT NULL,
        calibre_uuid        TEXT NOT NULL,
        field               TEXT NOT NULL,
        old_json            TEXT NOT NULL CHECK (json_valid(old_json)),
        new_json            TEXT NOT NULL CHECK (json_valid(new_json)),
        extra_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
        last_modified_after TEXT,
        old_cover_path      TEXT,
        restored_at         INTEGER,
        restored_last_modified TEXT,
        restore_detail      TEXT,
        created_at          INTEGER NOT NULL,
        PRIMARY KEY (batch_id, change_id)
      );
      CREATE INDEX field_undo_book ON field_undo (library_id, calibre_uuid, field);

      -- A stage can stop applying one field (e.g. titles below their bar) and go on with the
      -- others. reason: gate, review_alarm, failures.
      CREATE TABLE stage_field_pauses (
        stage      INTEGER NOT NULL,
        field      TEXT NOT NULL,
        reason     TEXT NOT NULL,
        detail     TEXT,
        paused_at  INTEGER NOT NULL,
        PRIMARY KEY (stage, field)
      );

      ALTER TABLE applied_values ADD COLUMN change_id INTEGER;
      ALTER TABLE applied_values ADD COLUMN last_modified_after TEXT;
      CREATE INDEX applied_values_source ON applied_values (library_id, source);
    `,
  },
];

export const CLEANUP_SCHEMA_VERSION = CLEANUP_MIGRATIONS[CLEANUP_MIGRATIONS.length - 1].version;

export function cleanupSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function migrateCleanup(db: Database.Database): number {
  const current = cleanupSchemaVersion(db);
  if (current > CLEANUP_SCHEMA_VERSION) {
    throw new Error(
      `cleanup.db schema version ${current} is newer than this server supports (${CLEANUP_SCHEMA_VERSION}). ` +
        'Refusing to run an older server against a newer cleanup database.',
    );
  }
  for (const migration of CLEANUP_MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
    console.log(`cleanup.db: applied migration ${migration.version} (${migration.name})`);
  }
  return cleanupSchemaVersion(db);
}

export function openCleanupDatabase(file: string): Database.Database {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    migrateCleanup(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export type CleanupDbState =
  | { ok: true; db: Database.Database; file: string; schemaVersion: number }
  | { ok: false; error: string };

/** Never throws: without cleanup.db only the cleanup routes are off. */
export function initCleanupDatabase(dbDir: string): CleanupDbState {
  try {
    if (!existsSync(dbDir) || !statSync(dbDir).isDirectory()) {
      return { ok: false, error: `DB_DIR does not exist: ${dbDir}` };
    }
    const file = cleanupDbPath(dbDir);
    const db = openCleanupDatabase(file);
    return { ok: true, db, file, schemaVersion: cleanupSchemaVersion(db) };
  } catch (err) {
    return { ok: false, error: `could not open cleanup.db: ${(err as Error).message}` };
  }
}
