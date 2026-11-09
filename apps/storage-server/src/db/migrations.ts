import type Database from 'better-sqlite3';

/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Never edit a migration that has shipped; add a new one instead.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'users and api tokens',
    sql: `
      CREATE TABLE users (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE api_tokens (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        label         TEXT NOT NULL,
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        revoked_at    INTEGER
      );

      CREATE INDEX api_tokens_user ON api_tokens(user_id);
    `,
  },
  {
    version: 2,
    name: 'calibre catalog: libraries, books, sources, thumbnails',
    // Catalog data is shared by all users (no user_id); per-user library
    // visibility comes with multi-user support (decisions.md, WP2).
    sql: `
      CREATE TABLE libraries (
        id                    TEXT PRIMARY KEY,
        folder                TEXT NOT NULL UNIQUE,
        calibre_library_uuid  TEXT UNIQUE,
        name                  TEXT NOT NULL,
        language              TEXT,
        enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        available             INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
        srt_archive_path      TEXT,
        discovered_at         INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        CHECK (enabled = 0 OR language IS NOT NULL)
      );

      CREATE TABLE library_index_state (
        library_id            TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
        status                TEXT NOT NULL DEFAULT 'idle'
                              CHECK (status IN ('idle', 'settling', 'snapshotting', 'ingesting', 'error')),
        source_mtime_ms       INTEGER,
        source_size           INTEGER,
        snapshot_at           INTEGER,
        indexed_at            INTEGER,
        last_error            TEXT,
        last_error_at         INTEGER,
        last_warning          TEXT,
        last_warning_at       INTEGER,
        books_indexed         INTEGER NOT NULL DEFAULT 0,
        books_missing         INTEGER NOT NULL DEFAULT 0,
        books_skipped         INTEGER NOT NULL DEFAULT 0,
        reindex_requested_at  INTEGER,
        allow_mass_missing    INTEGER NOT NULL DEFAULT 0 CHECK (allow_mass_missing IN (0, 1))
      );

      CREATE TABLE authors (
        id    INTEGER PRIMARY KEY,
        name  TEXT NOT NULL UNIQUE,
        sort  TEXT
      );

      CREATE TABLE series (
        id    INTEGER PRIMARY KEY,
        name  TEXT NOT NULL UNIQUE,
        sort  TEXT
      );

      CREATE TABLE tags (
        id    INTEGER PRIMARY KEY,
        name  TEXT NOT NULL UNIQUE
      );

      CREATE TABLE books (
        id            TEXT PRIMARY KEY,
        library_id    TEXT NOT NULL REFERENCES libraries(id),
        title         TEXT NOT NULL,
        title_sort    TEXT,
        author_sort   TEXT,
        series_id     INTEGER REFERENCES series(id),
        series_index  REAL,
        description   TEXT,
        publisher     TEXT,
        published_at  INTEGER,
        added_at      INTEGER NOT NULL,
        char_count    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX books_added ON books(added_at DESC, id DESC);
      CREATE INDEX books_library_added ON books(library_id, added_at DESC, id DESC);
      CREATE INDEX books_series ON books(series_id, series_index);

      CREATE TABLE book_authors (
        book_id    TEXT NOT NULL REFERENCES books(id),
        author_id  INTEGER NOT NULL REFERENCES authors(id),
        position   INTEGER NOT NULL,
        PRIMARY KEY (book_id, position)
      );

      CREATE INDEX book_authors_author ON book_authors(author_id);

      CREATE TABLE book_tags (
        book_id  TEXT NOT NULL REFERENCES books(id),
        tag_id   INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY (book_id, tag_id)
      );

      CREATE INDEX book_tags_tag ON book_tags(tag_id);

      CREATE TABLE book_sources (
        id                     TEXT PRIMARY KEY,
        book_id                TEXT NOT NULL REFERENCES books(id),
        kind                   TEXT NOT NULL CHECK (kind IN ('calibre', 'upload')),
        library_id             TEXT NOT NULL REFERENCES libraries(id),
        calibre_uuid           TEXT,
        calibre_id             INTEGER,
        calibre_path           TEXT,
        file_path              TEXT,
        file_size              INTEGER,
        has_cover              INTEGER NOT NULL DEFAULT 0 CHECK (has_cover IN (0, 1)),
        calibre_last_modified  INTEGER,
        meta_hash              TEXT,
        content_hash           TEXT,
        missing_at             INTEGER,
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL,
        CHECK (kind <> 'calibre' OR calibre_uuid IS NOT NULL)
      );

      CREATE UNIQUE INDEX book_sources_calibre ON book_sources(library_id, calibre_uuid)
        WHERE kind = 'calibre';
      CREATE INDEX book_sources_book ON book_sources(book_id);

      CREATE TABLE thumbnails (
        book_id       TEXT PRIMARY KEY REFERENCES books(id),
        status        TEXT NOT NULL CHECK (status IN ('ok', 'none', 'error')),
        source_key    TEXT NOT NULL,
        spec          INTEGER NOT NULL,
        width         INTEGER,
        height        INTEGER,
        bytes         INTEGER,
        attempts      INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        generated_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'device pairing codes and server secrets',
    sql: `
      -- One-time codes a device trades for its own API token (WP6).
      -- Only a hash of the code is stored.
      CREATE TABLE pairing_codes (
        code_hash   TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        label       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER,
        token_id    TEXT REFERENCES api_tokens(id)
      );

      -- Server-side keys, e.g. the HMAC key that signs thumbnail URLs.
      CREATE TABLE server_secrets (
        name        TEXT PRIMARY KEY,
        value       BLOB NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'sync engine: devices and user-data records',
    // WP4. One generic store for every user-data kind: the sync columns are
    // real columns, the payload is JSON validated per kind in src/sync/kinds.ts.
    sql: `
      -- A device keeps its id across re-pairing; each token is bound to one device.
      CREATE TABLE devices (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER
      );

      CREATE INDEX devices_user ON devices(user_id);

      ALTER TABLE api_tokens ADD COLUMN device_id TEXT REFERENCES devices(id);

      -- Per-user change counter. The epoch changes after a database restore so
      -- devices notice that their cursor no longer means anything.
      CREATE TABLE sync_state (
        user_id   TEXT PRIMARY KEY REFERENCES users(id),
        epoch     TEXT NOT NULL,
        last_rev  INTEGER NOT NULL
      );

      CREATE TABLE sync_records (
        user_id      TEXT NOT NULL REFERENCES users(id),
        kind         TEXT NOT NULL,
        id           TEXT NOT NULL,
        book_id      TEXT,
        device_id    TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        deleted_at   INTEGER,
        rev          INTEGER NOT NULL,
        data         TEXT NOT NULL CHECK (json_valid(data)),
        received_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, kind, id)
      );

      CREATE UNIQUE INDEX sync_records_rev ON sync_records(user_id, rev);
      CREATE INDEX sync_records_book ON sync_records(user_id, book_id, kind)
        WHERE book_id IS NOT NULL;
    `,
  },
  {
    version: 5,
    name: 'migration off the old file sync',
    // WP5. Server-only bookkeeping of the one-time migration; the results that
    // devices need (links, positions, stats) are ordinary sync records.
    sql: `
      -- One row per book folder of the old sync (DATA_DIR/<folder>).
      CREATE TABLE legacy_books (
        user_id      TEXT NOT NULL REFERENCES users(id),
        folder       TEXT NOT NULL,
        title        TEXT NOT NULL,
        state        TEXT NOT NULL CHECK (state IN ('linked', 'needs_user', 'deferred')),
        reason       TEXT,
        method       TEXT CHECK (method IN ('calibre-link', 'fingerprint', 'user')),
        book_id      TEXT REFERENCES books(id),
        candidates   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates)),
        details      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
        scanned_at   INTEGER NOT NULL,
        decided_at   INTEGER,
        imported_at  INTEGER,
        PRIMARY KEY (user_id, folder),
        CHECK (state <> 'linked' OR (book_id IS NOT NULL AND method IS NOT NULL))
      );

      -- What each device holds locally (its Calibre links and titles with reading data).
      CREATE TABLE legacy_device_reports (
        user_id      TEXT NOT NULL REFERENCES users(id),
        device_id    TEXT NOT NULL REFERENCES devices(id),
        reported_at  INTEGER NOT NULL,
        data         TEXT NOT NULL CHECK (json_valid(data)),
        PRIMARY KEY (user_id, device_id)
      );

      CREATE TABLE migration_state (
        user_id           TEXT PRIMARY KEY REFERENCES users(id),
        import_device_id  TEXT REFERENCES devices(id),
        last_scan_at      INTEGER,
        last_import_at    INTEGER,
        last_snapshot     TEXT
      );
    `,
  },
  {
    version: 6,
    name: 'character counts',
    // WP3b. Per-book state of the background character count (like thumbnails).
    // The count itself is served from books.char_count, written in the same
    // transaction: the count when status = 'ok', NULL when status = 'error'.
    sql: `
      CREATE TABLE char_counts (
        book_id      TEXT PRIMARY KEY REFERENCES books(id),
        status       TEXT NOT NULL CHECK (status IN ('ok', 'error')),
        -- Calibre last_modified | EPUB path | EPUB size when counted.
        source_key   TEXT NOT NULL,
        -- Counting rules and import settings, e.g. 'v1|Off|anchor'.
        spec         TEXT NOT NULL,
        characters   INTEGER CHECK (characters IS NULL OR characters >= 0),
        -- Counter bundle build (for diagnostics only).
        build        TEXT,
        attempts     INTEGER NOT NULL DEFAULT 0,
        error_code   TEXT,
        error        TEXT,
        duration_ms  INTEGER,
        bytes_read   INTEGER,
        counted_at   INTEGER NOT NULL,
        CHECK ((status = 'ok') = (characters IS NOT NULL))
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies pending migrations, each in its own transaction. Returns the resulting version. */
export function migrate(db: Database.Database): number {
  const current = getSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this server supports (${LATEST_SCHEMA_VERSION}). ` +
        'Refusing to run an older server against a newer database.',
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
    console.log(`Database: applied migration ${migration.version} (${migration.name})`);
  }
  return getSchemaVersion(db);
}
