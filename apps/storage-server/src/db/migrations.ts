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
