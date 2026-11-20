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
  {
    version: 7,
    name: 'user seeds',
    // WP8b. Records the server writes once per user (the empty "Planned" collection).
    // A row means it was done; the record itself may since have been renamed or deleted
    // by the user, and is never written again.
    sql: `
      CREATE TABLE user_seeds (
        user_id    TEXT NOT NULL REFERENCES users(id),
        name       TEXT NOT NULL,
        device_id  TEXT REFERENCES devices(id),
        done_at    INTEGER NOT NULL,
        PRIMARY KEY (user_id, name)
      );
    `,
  },
  {
    version: 8,
    name: 'custom fonts',
    // WP13. One row per uploaded font file (DATA_DIR/.uploads/fonts/<file_path>). The
    // "font" sync record must match its row, so devices can delete or restore a font
    // but never invent one or change its file. Rows are never deleted: a deleted font's
    // file stays on the server and can be restored.
    sql: `
      CREATE TABLE fonts (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        name        TEXT NOT NULL,
        file_name   TEXT NOT NULL,
        format      TEXT NOT NULL CHECK (format IN ('woff2', 'woff', 'ttf', 'otf')),
        size        INTEGER NOT NULL CHECK (size > 0),
        sha256      TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX fonts_user ON fonts (user_id);
    `,
  },
  {
    version: 9,
    name: 'library sort indexes',
    // WP19a. One index per sort expression in catalog/sort.ts (they must match exactly).
    // Books without a value sort last in both directions, so author, length and
    // publication date have one expression (and index) per direction; title has no
    // NULLs and one index, walked backwards for Z→A. Date added uses books_added.
    sql: `
      CREATE INDEX books_sort_title ON books (COALESCE(title_sort, title), id);
      CREATE INDEX books_sort_author_asc ON books (IFNULL(author_sort, char(1114111)), id);
      CREATE INDEX books_sort_author_desc ON books (IFNULL(author_sort, ''), id);
      CREATE INDEX books_sort_chars_asc ON books (IFNULL(char_count, 9000000000000000), id);
      CREATE INDEX books_sort_chars_desc ON books (IFNULL(char_count, -1), id);
      CREATE INDEX books_sort_published_asc ON books (IFNULL(published_at, 9000000000000000), id);
      CREATE INDEX books_sort_published_desc ON books (IFNULL(published_at, -9000000000000000), id);
    `,
  },
  {
    version: 10,
    name: 'audiobook folder and subtitle index',
    // WP15a. The audiobooks root is mounted read-only; these tables only describe
    // what a scan found there. Paths are relative to that root, with forward
    // slashes, so a link survives a change of a library's audio folder setting.
    // A folder or file that disappears is marked missing, never deleted, so a
    // link to it can say so. libraries.srt_archive_path (v2) is the subtitle folder.
    sql: `
      ALTER TABLE libraries ADD COLUMN audio_dir TEXT;

      CREATE TABLE audio_folders (
        id                INTEGER PRIMARY KEY,
        library_id        TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        rel_path          TEXT NOT NULL,
        name              TEXT NOT NULL,
        parent_name       TEXT,
        title_key         TEXT NOT NULL,
        loose_key         TEXT NOT NULL,
        volume            REAL,
        meta_title        TEXT,
        meta_series       TEXT,
        meta_sequence     TEXT,
        asin              TEXT,
        files             TEXT NOT NULL,
        file_count        INTEGER NOT NULL CHECK (file_count >= 1),
        total_bytes       INTEGER NOT NULL,
        duration_seconds  REAL,
        seen_at           INTEGER NOT NULL,
        missing_at        INTEGER,
        UNIQUE (library_id, rel_path)
      );
      CREATE INDEX audio_folders_title ON audio_folders (library_id, title_key);

      CREATE TABLE subtitle_files (
        id          INTEGER PRIMARY KEY,
        library_id  TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        rel_path    TEXT NOT NULL,
        name        TEXT NOT NULL,
        parent_name TEXT,
        title_key   TEXT NOT NULL,
        loose_key   TEXT NOT NULL,
        volume      REAL,
        size        INTEGER NOT NULL,
        mtime_ms    INTEGER NOT NULL,
        seen_at     INTEGER NOT NULL,
        missing_at  INTEGER,
        UNIQUE (library_id, rel_path)
      );

      CREATE TABLE audio_scan_state (
        library_id         TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
        status             TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'scanning', 'error')),
        scanned_at         INTEGER,
        folders            INTEGER NOT NULL DEFAULT 0,
        subtitles          INTEGER NOT NULL DEFAULT 0,
        archives_skipped   INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        last_error_at      INTEGER,
        scan_requested_at  INTEGER
      );
    `,
  },
  {
    version: 11,
    name: 'audio links',
    // WP15b. The user's confirmed choice of audiobook (and subtitle file) for a book.
    // Stored by root-relative path, never by index row id, so a link survives rescans;
    // a folder that disappears shows as missing and is never relinked automatically.
    // state 'none' = "No audiobook" (stops suggestions). subtitle_state NULL = the
    // subtitle step hasn't been answered yet. book_id has no foreign key: a book that
    // leaves Calibre keeps its link, like its reading data.
    sql: `
      CREATE TABLE audio_links (
        user_id            TEXT NOT NULL REFERENCES users(id),
        book_id            TEXT NOT NULL,
        state              TEXT NOT NULL CHECK (state IN ('linked', 'none')),
        folder_rel_path    TEXT,
        file_name          TEXT,
        subtitle_rel_path  TEXT,
        subtitle_state     TEXT CHECK (subtitle_state IN ('linked', 'none')),
        source             TEXT NOT NULL DEFAULT 'library' CHECK (source IN ('library', 'migrated')),
        confirmed_at       INTEGER NOT NULL,
        PRIMARY KEY (user_id, book_id),
        CHECK ((state = 'linked') = (folder_rel_path IS NOT NULL)),
        CHECK ((subtitle_state = 'linked') = (subtitle_rel_path IS NOT NULL)),
        CHECK (state = 'linked' OR subtitle_state IS NULL)
      );
    `,
  },
  {
    version: 12,
    name: 'book attachments',
    // WP15c. Files of one book of one user that are too large for a sync record
    // (whispersync's saved subtitles and saved match), stored in
    // DATA_DIR/.uploads/attachments/<file_path>. The "book-attachment" sync record must
    // match its row, so a device can delete or restore it but never invent one.
    // modified_at is the device's own save time (newest wins).
    sql: `
      CREATE TABLE book_attachments (
        user_id      TEXT NOT NULL REFERENCES users(id),
        book_id      TEXT NOT NULL,
        name         TEXT NOT NULL CHECK (name IN ('whispersync-subtitles', 'whispersync-match')),
        size         INTEGER NOT NULL,
        sha256       TEXT NOT NULL,
        modified_at  INTEGER NOT NULL,
        file_path    TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (user_id, book_id, name)
      );
    `,
  },
  {
    version: 13,
    name: 'audio merges',
    // WP15f. audio_merge_jobs: the user's "Merge into one file" requests (one runs at a
    // time). file_names is the JSON list in the user's order. link_confirmed_at is the
    // book's link confirmed_at when the merge was asked for (NULL = no link): the merged
    // file is linked only if the link is unchanged by then.
    // audio_writes: every file src/audio/audio-write.ts creates in the audiobooks folder,
    // recorded before it is created, so an interrupted write can remove its own partial
    // file (and nothing else) at the next start. temp_rel_path is the file being written
    // (a hidden .ttsu-merge-<id>.partial, or the final name itself when hard links are
    // not available, direct = 1); final_rel_path is set once the file is published.
    sql: `
      CREATE TABLE audio_merge_jobs (
        id                 INTEGER PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users(id),
        book_id            TEXT NOT NULL,
        library_id         TEXT NOT NULL,
        folder_rel_path    TEXT NOT NULL,
        file_names         TEXT NOT NULL,
        state              TEXT NOT NULL CHECK (state IN ('queued', 'running', 'saving', 'done', 'failed', 'cancelled')),
        mode               TEXT CHECK (mode IN ('copy', 'reencode')),
        progress           REAL NOT NULL DEFAULT 0,
        output_name        TEXT,
        error              TEXT,
        linked             INTEGER NOT NULL DEFAULT 0,
        link_confirmed_at  INTEGER,
        created_at         INTEGER NOT NULL,
        started_at         INTEGER,
        finished_at        INTEGER,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX audio_merge_jobs_book ON audio_merge_jobs (user_id, book_id, id);

      CREATE TABLE audio_writes (
        id              INTEGER PRIMARY KEY,
        purpose         TEXT NOT NULL CHECK (purpose IN ('merge', 'generated')),
        temp_rel_path   TEXT NOT NULL,
        final_rel_path  TEXT,
        direct          INTEGER NOT NULL DEFAULT 0,
        state           TEXT NOT NULL CHECK (state IN ('reserving', 'writing', 'published', 'done', 'cleaned')),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
    `,
  },
  {
    version: 14,
    name: 'gpu worker jobs',
    // WP16. worker_jobs: jobs for the GPU worker on the user's PC (the design doc's Job
    // table; kind 'sync_subtitles' = SubPlz, WP17 adds 'generate_audiobook'). Queued only
    // by the user from a book's page; the worker claims one at a time and holds it with a
    // lease (lease_expires_at) that its progress reports extend; an expired lease puts the
    // job back in the queue (attempts + 1). audio_folder_rel_path/audio_file_name are the
    // book's linked file when the job was queued; link_confirmed_at is the link's
    // confirmed_at then (the result is linked only if the link is unchanged).
    // worker_status: one row (id 1): the pause switch and what the worker last reported.
    // api_tokens.scope: 'worker' tokens reach only /api/v1/worker/* (R7).
    sql: `
      CREATE TABLE worker_jobs (
        id                     INTEGER PRIMARY KEY,
        user_id                TEXT NOT NULL REFERENCES users(id),
        book_id                TEXT NOT NULL,
        kind                   TEXT NOT NULL CHECK (kind IN ('sync_subtitles')),
        library_id             TEXT NOT NULL,
        audio_folder_rel_path  TEXT NOT NULL,
        audio_file_name        TEXT NOT NULL,
        link_confirmed_at      INTEGER,
        state                  TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
        stage                  TEXT CHECK (stage IN ('downloading', 'syncing', 'uploading', 'saving')),
        progress               REAL,
        message                TEXT,
        cancel_requested       INTEGER NOT NULL DEFAULT 0,
        attempts               INTEGER NOT NULL DEFAULT 0,
        lease_expires_at       INTEGER,
        output_rel_path        TEXT,
        linked                 INTEGER NOT NULL DEFAULT 0,
        error                  TEXT,
        log_tail               TEXT,
        created_at             INTEGER NOT NULL,
        started_at             INTEGER,
        finished_at            INTEGER,
        updated_at             INTEGER NOT NULL
      );
      CREATE INDEX worker_jobs_book ON worker_jobs (user_id, book_id, id);
      CREATE INDEX worker_jobs_state ON worker_jobs (state, id);

      CREATE TABLE worker_status (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        paused          INTEGER NOT NULL DEFAULT 0,
        last_seen_at    INTEGER,
        worker_version  TEXT,
        image           TEXT,
        problem         TEXT,
        updated_at      INTEGER NOT NULL
      );

      ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'worker'));
    `,
  },
  {
    version: 15,
    name: 'generated audiobooks',
    // WP17. worker_jobs is rebuilt (SQLite can't change a CHECK) for three new kinds:
    // 'generate_audiobook' (a whole book, chapter by chapter, resumable), 'preview_audiobook'
    // (about a minute of one chapter) and 'voice_sample' (a described voice, no book). The
    // audio columns are only for 'sync_subtitles' now; library_id/book_id are NULL for a
    // voice sample. params = the job's settings as JSON (voice map v1: voice, model, seed,
    // pauses); version = the generated audiobook's version (folder <Title> / <Title> (vN));
    // chapters_total/chapters_done = progress; claim_chapters = chapters_done when the job was
    // last handed out (a lease that runs out after new chapters doesn't count as an attempt).
    // tts_job_chapters: a finished chapter of a running job (its audio part waits in
    // CACHE_DIR/tts-parts/<job>/ until the book is put together).
    // tts_models: the TTS models offered (Settings > Audiobooks), each pinned to the revision
    // recorded when it was added; removed_at hides it (the PC then deletes its files).
    // tts_voices: voice presets, their reference clip in DATA_DIR/.uploads/voices/<id>/.
    // generated: index rows found under <audio folder>-generated/.
    sql: `
      CREATE TABLE worker_jobs_v15 (
        id                     INTEGER PRIMARY KEY,
        user_id                TEXT NOT NULL REFERENCES users(id),
        book_id                TEXT,
        kind                   TEXT NOT NULL CHECK (kind IN ('sync_subtitles', 'generate_audiobook', 'preview_audiobook', 'voice_sample')),
        library_id             TEXT,
        audio_folder_rel_path  TEXT,
        audio_file_name        TEXT,
        link_confirmed_at      INTEGER,
        state                  TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
        stage                  TEXT CHECK (stage IN ('downloading', 'syncing', 'uploading', 'saving', 'preparing', 'generating', 'assembling')),
        progress               REAL,
        message                TEXT,
        cancel_requested       INTEGER NOT NULL DEFAULT 0,
        attempts               INTEGER NOT NULL DEFAULT 0,
        lease_expires_at       INTEGER,
        output_rel_path        TEXT,
        linked                 INTEGER NOT NULL DEFAULT 0,
        error                  TEXT,
        log_tail               TEXT,
        params                 TEXT,
        version                INTEGER,
        chapters_total         INTEGER,
        chapters_done          INTEGER NOT NULL DEFAULT 0,
        claim_chapters         INTEGER,
        created_at             INTEGER NOT NULL,
        started_at             INTEGER,
        finished_at            INTEGER,
        updated_at             INTEGER NOT NULL,
        CHECK (kind <> 'sync_subtitles' OR (book_id IS NOT NULL AND library_id IS NOT NULL
          AND audio_folder_rel_path IS NOT NULL AND audio_file_name IS NOT NULL)),
        CHECK (kind = 'voice_sample' OR book_id IS NOT NULL)
      );
      INSERT INTO worker_jobs_v15 (id, user_id, book_id, kind, library_id, audio_folder_rel_path,
        audio_file_name, link_confirmed_at, state, stage, progress, message, cancel_requested,
        attempts, lease_expires_at, output_rel_path, linked, error, log_tail, created_at,
        started_at, finished_at, updated_at)
      SELECT id, user_id, book_id, kind, library_id, audio_folder_rel_path, audio_file_name,
        link_confirmed_at, state, stage, progress, message, cancel_requested, attempts,
        lease_expires_at, output_rel_path, linked, error, log_tail, created_at, started_at,
        finished_at, updated_at
      FROM worker_jobs;
      DROP TABLE worker_jobs;
      ALTER TABLE worker_jobs_v15 RENAME TO worker_jobs;
      CREATE INDEX worker_jobs_book ON worker_jobs (user_id, book_id, id);
      CREATE INDEX worker_jobs_state ON worker_jobs (state, id);

      CREATE TABLE tts_job_chapters (
        job_id       INTEGER NOT NULL REFERENCES worker_jobs(id) ON DELETE CASCADE,
        idx          INTEGER NOT NULL,
        title        TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        cues         TEXT NOT NULL,
        part_file    TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        done_at      INTEGER NOT NULL,
        PRIMARY KEY (job_id, idx)
      );

      CREATE TABLE tts_models (
        id                    INTEGER PRIMARY KEY,
        source                TEXT NOT NULL,
        revision              TEXT NOT NULL,
        label                 TEXT NOT NULL,
        note                  TEXT,
        supports_description  INTEGER,
        supports_clip         INTEGER,
        is_default            INTEGER NOT NULL DEFAULT 0,
        added_at              INTEGER NOT NULL,
        removed_at            INTEGER
      );
      CREATE UNIQUE INDEX tts_models_present ON tts_models (source) WHERE removed_at IS NULL;
      INSERT INTO tts_models (source, revision, label, note, supports_description, supports_clip, is_default, added_at) VALUES
        ('Aratako/Irodori-TTS-v4.1-Small', '2b28324dc263ed5e6638b3cf3dd94c82ead07b4b', 'Irodori v4.1 Small', 'Recommended. About 7 times faster than real time on the RTX 4070.', 1, 1, 1, 0),
        ('Aratako/Irodori-TTS-v4.1-Small-MF', 'ccc78f5d480b6e51b69b2d5042a14c4da04fea6e', 'Irodori v4.1 Small MF', 'Fastest (about 14 times real time); a shortcut version of Small.', 1, 1, 0, 0),
        ('Aratako/Irodori-TTS-500M-v3', '236c1e56591279fc24e3c1bf6609fc06e48dde28', 'Irodori 500M v3', 'Older model. Copies a voice clip only (no described voices).', 0, 1, 0, 0),
        ('Aratako/Irodori-TTS-v4-Large-Quantized/float8-weight-only', 'bdef9592db4426bd1c99ccdf0cfc3a213223fb61', 'Irodori v4 Large (fp8)', 'Very slow: slower than real time, about 14 hours for a long novel. Gemma Terms of Use.', 1, 1, 0, 0);

      CREATE TABLE tts_voices (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('clip', 'design')),
        description   TEXT,
        model_source  TEXT,
        seed          INTEGER,
        clip_seconds  REAL NOT NULL,
        size          INTEGER NOT NULL,
        sha256        TEXT NOT NULL,
        consent_at    INTEGER,
        created_at    INTEGER NOT NULL,
        CHECK (kind = 'design' OR consent_at IS NOT NULL)
      );

      ALTER TABLE audio_folders ADD COLUMN generated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE subtitle_files ADD COLUMN generated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE worker_status ADD COLUMN tts_image TEXT;
    `,
  },
  {
    version: 16,
    name: 'search folding',
    // fix-search-width-folding: folded copies (NFKC + lower case, catalog/fold.ts) of the
    // searchable names, so library search matches full-width and half-width alike without
    // folding every row per query. Search only; displayed text keeps the original columns.
    // NULL = not folded yet: openDatabase() fills them (fillSearchFolds) right after
    // migrating, and the catalog writers set them from then on.
    sql: `
      ALTER TABLE books ADD COLUMN title_fold TEXT;
      ALTER TABLE authors ADD COLUMN name_fold TEXT;
      ALTER TABLE series ADD COLUMN name_fold TEXT;
      ALTER TABLE tags ADD COLUMN name_fold TEXT;
    `,
  },
  {
    version: 17,
    name: 'count and cover file identity',
    // fix-count-file-identity: the size and modified time (nanoseconds, as text) of the file
    // a count or thumbnail was made from. Calibre bumps last_modified for any metadata edit;
    // when only that (or the book folder) changed and the file is the same, the count or
    // thumbnail is kept instead of made again. NULL = made before this migration (then the
    // file must be older than counted_at / generated_at to count as unchanged).
    sql: `
      ALTER TABLE char_counts ADD COLUMN file_bytes INTEGER;
      ALTER TABLE char_counts ADD COLUMN file_mtime_ns TEXT;
      ALTER TABLE thumbnails ADD COLUMN cover_bytes INTEGER;
      ALTER TABLE thumbnails ADD COLUMN cover_mtime_ns TEXT;
    `,
  },
  {
    version: 18,
    name: 'book file hashes',
    // Season 2 "Cached book whose Calibre file changed": the SHA-256 of a book's EPUB with
    // the size and modified time (nanoseconds, as text) of the file it was made from, so a
    // device can tell a changed file from a metadata edit. Made when a device asks
    // (catalog/file-hashes.ts); hashed again only when the file's size or modified time
    // changed. No book_id foreign key: a row is only a cache and is replaced, never read
    // for a book the catalog no longer has.
    sql: `
      CREATE TABLE file_hashes (
        book_id    TEXT PRIMARY KEY,
        bytes      INTEGER NOT NULL,
        mtime_ns   TEXT NOT NULL,
        sha256     TEXT NOT NULL,
        hashed_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 19,
    name: 'google fonts',
    // Season 2 Phase 10: fonts added from Google Fonts. A Google font's `fonts` row is its
    // regular file (so the WP13 record fields and file route stay as they are); its other
    // weights (bold) are in font_faces. source is 'upload' for every font before this.
    // copyright and license_url come from the font file's own name table.
    sql: `
      ALTER TABLE fonts ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'
        CHECK (source IN ('upload', 'google'));
      ALTER TABLE fonts ADD COLUMN copyright TEXT;
      ALTER TABLE fonts ADD COLUMN license_url TEXT;
      CREATE TABLE font_faces (
        font_id    TEXT NOT NULL REFERENCES fonts(id),
        weight     INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 1000),
        format     TEXT NOT NULL CHECK (format IN ('woff2', 'woff', 'ttf', 'otf')),
        size       INTEGER NOT NULL CHECK (size > 0),
        sha256     TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        PRIMARY KEY (font_id, weight)
      );
    `,
  },
  {
    version: 20,
    name: 'pronunciation fixes',
    // Season 2 Phase 12: the per-book (book_id) and global (book_id NULL) pronunciation
    // fixes the PC voices use: a plain word or a JavaScript regex pattern, and the reading
    // to say instead (src/pronunciation/). No book_id foreign key, like audio_links: a fix
    // stays when the catalog forgets a book. Order within a list: created_at, then id.
    sql: `
      CREATE TABLE pronunciation_fixes (
        id          INTEGER PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        book_id     TEXT,
        kind        TEXT NOT NULL CHECK (kind IN ('word', 'pattern')),
        match       TEXT NOT NULL,
        reading     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX pronunciation_fixes_book
        ON pronunciation_fixes (user_id, book_id, kind, match) WHERE book_id IS NOT NULL;
      CREATE UNIQUE INDEX pronunciation_fixes_global
        ON pronunciation_fixes (user_id, kind, match) WHERE book_id IS NULL;
    `,
  },
  {
    version: 21,
    name: 'sentence audio from the PC',
    // Season 2 Phase 12: Enrich's sentence audio read by the PC for a book without an
    // audiobook (audio/sentence-audio.ts).
    // worker_jobs: rebuilt for the new kind 'sentence_audio' (its rows kept as they are).
    //   tts_job_chapters references it, so it is set aside and put back around the rebuild
    //   (a DROP TABLE with foreign keys on would delete its rows).
    // tts_sentence_clips: one clip a device asked for; it is one chapter (idx) of a
    //   'sentence_audio' job; its MP3 waits in CACHE_DIR/tts/<job>/ until the device has it.
    // tts_voice_choices: the voice and model the PC reads with, per book (book_id) or for
    //   every book (book_id NULL). No book foreign key, like audio_links.
    // worker_status.kinds: the job kinds the PC asked for in its last claim (JSON), so a
    //   long audiobook only makes way for sentence audio when the PC can read it.
    sql: `
      CREATE TABLE tts_job_chapters_keep AS SELECT * FROM tts_job_chapters;
      DROP TABLE tts_job_chapters;

      CREATE TABLE worker_jobs_v21 (
        id                     INTEGER PRIMARY KEY,
        user_id                TEXT NOT NULL REFERENCES users(id),
        book_id                TEXT,
        kind                   TEXT NOT NULL CHECK (kind IN ('sync_subtitles', 'generate_audiobook', 'preview_audiobook', 'voice_sample', 'sentence_audio')),
        library_id             TEXT,
        audio_folder_rel_path  TEXT,
        audio_file_name        TEXT,
        link_confirmed_at      INTEGER,
        state                  TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
        stage                  TEXT CHECK (stage IN ('downloading', 'syncing', 'uploading', 'saving', 'preparing', 'generating', 'assembling')),
        progress               REAL,
        message                TEXT,
        cancel_requested       INTEGER NOT NULL DEFAULT 0,
        attempts               INTEGER NOT NULL DEFAULT 0,
        lease_expires_at       INTEGER,
        output_rel_path        TEXT,
        linked                 INTEGER NOT NULL DEFAULT 0,
        error                  TEXT,
        log_tail               TEXT,
        params                 TEXT,
        version                INTEGER,
        chapters_total         INTEGER,
        chapters_done          INTEGER NOT NULL DEFAULT 0,
        claim_chapters         INTEGER,
        created_at             INTEGER NOT NULL,
        started_at             INTEGER,
        finished_at            INTEGER,
        updated_at             INTEGER NOT NULL,
        CHECK (kind <> 'sync_subtitles' OR (book_id IS NOT NULL AND library_id IS NOT NULL
          AND audio_folder_rel_path IS NOT NULL AND audio_file_name IS NOT NULL)),
        CHECK (kind = 'voice_sample' OR book_id IS NOT NULL)
      );
      INSERT INTO worker_jobs_v21 SELECT * FROM worker_jobs;
      DROP TABLE worker_jobs;
      ALTER TABLE worker_jobs_v21 RENAME TO worker_jobs;
      CREATE INDEX worker_jobs_book ON worker_jobs (user_id, book_id, id);
      CREATE INDEX worker_jobs_state ON worker_jobs (state, id);

      CREATE TABLE tts_job_chapters (
        job_id       INTEGER NOT NULL REFERENCES worker_jobs(id) ON DELETE CASCADE,
        idx          INTEGER NOT NULL,
        title        TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        cues         TEXT NOT NULL,
        part_file    TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        done_at      INTEGER NOT NULL,
        PRIMARY KEY (job_id, idx)
      );
      INSERT INTO tts_job_chapters (job_id, idx, title, duration_ms, cues, part_file, bytes, done_at)
        SELECT job_id, idx, title, duration_ms, cues, part_file, bytes, done_at FROM tts_job_chapters_keep;
      DROP TABLE tts_job_chapters_keep;

      CREATE TABLE tts_sentence_clips (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        book_id       TEXT NOT NULL,
        job_id        INTEGER,
        idx           INTEGER,
        text          TEXT NOT NULL,
        sentences     TEXT NOT NULL CHECK (json_valid(sentences)),
        found         INTEGER NOT NULL DEFAULT 1,
        fixes         TEXT,
        state         TEXT NOT NULL CHECK (state IN ('waiting', 'done', 'failed', 'cancelled')),
        duration_ms   INTEGER,
        bytes         INTEGER,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        done_at       INTEGER,
        picked_up_at  INTEGER
      );
      CREATE INDEX tts_sentence_clips_job ON tts_sentence_clips (job_id, idx);

      CREATE TABLE tts_voice_choices (
        user_id     TEXT NOT NULL REFERENCES users(id),
        book_id     TEXT,
        voice_id    TEXT NOT NULL,
        model_id    INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX tts_voice_choices_book
        ON tts_voice_choices (user_id, book_id) WHERE book_id IS NOT NULL;
      CREATE UNIQUE INDEX tts_voice_choices_global
        ON tts_voice_choices (user_id) WHERE book_id IS NULL;

      ALTER TABLE worker_status ADD COLUMN kinds TEXT;
    `,
  },
  {
    version: 22,
    name: 'live read-aloud with the PC voice',
    // Season 2 Phase 12 session 3 (audio/read-aloud.ts): the PC keeps one voice process
    // loaded for read-aloud and Enrich clips.
    // keep_loaded_minutes: how long it stays loaded after read-aloud's last activity (a user
    //   setting, Settings > Audiobooks, stored here like the pause switch).
    // engine: what the PC last reported about that process (JSON: model, state, since), or NULL.
    // voice_used_at: the last time the loaded voice was used (read-aloud or a clip); the
    //   keep time counts from it, also across a server restart.
    sql: `
      ALTER TABLE worker_status ADD COLUMN keep_loaded_minutes INTEGER NOT NULL DEFAULT 10;
      ALTER TABLE worker_status ADD COLUMN engine TEXT;
      ALTER TABLE worker_status ADD COLUMN voice_used_at INTEGER;
    `,
  },
  {
    version: 23,
    name: 'narration and dialogue voices',
    // Season 2 Phase 12 session 4 (audio/voice-map.ts): the PC voice choice (every book, or
    // one book) can name a second voice for dialogue. NULL: one voice reads everything.
    sql: `
      ALTER TABLE tts_voice_choices ADD COLUMN dialogue_voice_id TEXT;
    `,
  },
  {
    version: 24,
    name: 'per-character voices',
    // Season 2 Phase 12 session 5 (audio/speakers/): a model on the PC works out who speaks
    // each quote of a book; each character can have a voice.
    // worker_jobs: rebuilt for the new kind 'attribute_speakers' (rows kept as they are;
    //   tts_job_chapters set aside and put back, as in migration 21).
    // speaker_models: the speaker models offered (Settings > Audiobooks), one GGUF file of a
    //   Hugging Face repo each, pinned to a revision, with the file's size and sha256 (the PC
    //   checks its download). Seeded with the model picked in step A (2026-11-17).
    // speaker_books: per book, the last finished run, what it read (script version, dialogue
    //   rule, the EPUB's size|mtime) and who reads the narration (the narration voice, or the
    //   narrator character's voice: a per-book setting, user 2026-11-16).
    // speaker_characters: the book's characters; `no` is their number in the book (C<no> in
    //   the model's prompts); `edited`: the user renamed it (a run never renames it again);
    //   `hidden`: "not a character" (never offered as a speaker).
    // speaker_quotes: one row per quote, keyed by its text (quote_key: occurrence + the first
    //   40 characters), so a renumbered book finds them again. The model's answer and the
    //   user's correction are kept apart: a run writes only the model columns.
    // speaker_steps: the answers of a running job (what lets it continue after a pause);
    //   removed when the job ends.
    sql: `
      CREATE TABLE tts_job_chapters_keep AS SELECT * FROM tts_job_chapters;
      DROP TABLE tts_job_chapters;

      CREATE TABLE worker_jobs_v24 (
        id                     INTEGER PRIMARY KEY,
        user_id                TEXT NOT NULL REFERENCES users(id),
        book_id                TEXT,
        kind                   TEXT NOT NULL CHECK (kind IN ('sync_subtitles', 'generate_audiobook', 'preview_audiobook', 'voice_sample', 'sentence_audio', 'attribute_speakers')),
        library_id             TEXT,
        audio_folder_rel_path  TEXT,
        audio_file_name        TEXT,
        link_confirmed_at      INTEGER,
        state                  TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
        stage                  TEXT CHECK (stage IN ('downloading', 'syncing', 'uploading', 'saving', 'preparing', 'generating', 'assembling')),
        progress               REAL,
        message                TEXT,
        cancel_requested       INTEGER NOT NULL DEFAULT 0,
        attempts               INTEGER NOT NULL DEFAULT 0,
        lease_expires_at       INTEGER,
        output_rel_path        TEXT,
        linked                 INTEGER NOT NULL DEFAULT 0,
        error                  TEXT,
        log_tail               TEXT,
        params                 TEXT,
        version                INTEGER,
        chapters_total         INTEGER,
        chapters_done          INTEGER NOT NULL DEFAULT 0,
        claim_chapters         INTEGER,
        created_at             INTEGER NOT NULL,
        started_at             INTEGER,
        finished_at            INTEGER,
        updated_at             INTEGER NOT NULL,
        CHECK (kind <> 'sync_subtitles' OR (book_id IS NOT NULL AND library_id IS NOT NULL
          AND audio_folder_rel_path IS NOT NULL AND audio_file_name IS NOT NULL)),
        CHECK (kind = 'voice_sample' OR book_id IS NOT NULL)
      );
      INSERT INTO worker_jobs_v24 SELECT * FROM worker_jobs;
      DROP TABLE worker_jobs;
      ALTER TABLE worker_jobs_v24 RENAME TO worker_jobs;
      CREATE INDEX worker_jobs_book ON worker_jobs (user_id, book_id, id);
      CREATE INDEX worker_jobs_state ON worker_jobs (state, id);

      CREATE TABLE tts_job_chapters (
        job_id       INTEGER NOT NULL REFERENCES worker_jobs(id) ON DELETE CASCADE,
        idx          INTEGER NOT NULL,
        title        TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        cues         TEXT NOT NULL,
        part_file    TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        done_at      INTEGER NOT NULL,
        PRIMARY KEY (job_id, idx)
      );
      INSERT INTO tts_job_chapters (job_id, idx, title, duration_ms, cues, part_file, bytes, done_at)
        SELECT job_id, idx, title, duration_ms, cues, part_file, bytes, done_at FROM tts_job_chapters_keep;
      DROP TABLE tts_job_chapters_keep;

      CREATE TABLE speaker_models (
        id          INTEGER PRIMARY KEY,
        repo        TEXT NOT NULL,
        file        TEXT NOT NULL,
        revision    TEXT NOT NULL,
        size        INTEGER,
        sha256      TEXT,
        label       TEXT NOT NULL,
        is_default  INTEGER NOT NULL DEFAULT 0,
        added_at    INTEGER NOT NULL,
        removed_at  INTEGER
      );
      INSERT INTO speaker_models (repo, file, revision, size, sha256, label, is_default, added_at)
        VALUES ('unsloth/gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-UD-IQ4_XS.gguf',
          'c099eb48e663fd284577b04978a94ffccb261841', 13597177568,
          'babd1e389d386352f71600765d37390f7dc993fbfad6725caccf996ffe34aecf',
          'Gemma 4 26B A4B', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

      CREATE TABLE speaker_books (
        user_id         TEXT NOT NULL REFERENCES users(id),
        book_id         TEXT NOT NULL,
        job_id          INTEGER,
        model_id        INTEGER,
        prompt_version  INTEGER,
        script_version  INTEGER,
        dialogue_rule   INTEGER,
        file_key        TEXT,
        quotes          INTEGER,
        finished_at     INTEGER,
        narration_by    TEXT NOT NULL DEFAULT 'narration' CHECK (narration_by IN ('narration', 'narrator')),
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (user_id, book_id)
      );

      CREATE TABLE speaker_characters (
        id            INTEGER PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        book_id       TEXT NOT NULL,
        no            INTEGER NOT NULL,
        name          TEXT NOT NULL,
        aliases       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases)),
        first_person  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(first_person)),
        gender        TEXT NOT NULL DEFAULT '不明',
        narrator      INTEGER NOT NULL DEFAULT 0,
        voice_id      TEXT,
        origin        TEXT NOT NULL CHECK (origin IN ('model', 'user')),
        edited        INTEGER NOT NULL DEFAULT 0,
        hidden        INTEGER NOT NULL DEFAULT 0,
        windows       INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE (user_id, book_id, no)
      );

      CREATE TABLE speaker_quotes (
        user_id          TEXT NOT NULL REFERENCES users(id),
        book_id          TEXT NOT NULL,
        quote_key        TEXT NOT NULL,
        quote            INTEGER NOT NULL,
        text             TEXT NOT NULL,
        paragraph        INTEGER,
        position         INTEGER,
        model_character  INTEGER,
        model_p          REAL,
        model_unknown    INTEGER NOT NULL DEFAULT 0,
        user_set         INTEGER NOT NULL DEFAULT 0,
        user_character   INTEGER,
        user_at          INTEGER,
        lost             INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, book_id, quote_key)
      );
      CREATE INDEX speaker_quotes_quote ON speaker_quotes (user_id, book_id, quote);

      CREATE TABLE speaker_steps (
        job_id      INTEGER NOT NULL,
        seq         INTEGER NOT NULL,
        stage       TEXT NOT NULL,
        answer      TEXT NOT NULL,
        ms          INTEGER,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (job_id, seq)
      );
    `,
  },
  {
    version: 25,
    name: 'notifications',
    // Notifications N1 (src/notifications/): the server tells the user about problems through
    // Discord and Gmail.
    // notification_settings: one JSON value per key ('settings'), like cleanup.db's settings.
    // notification_secrets: the webhook URL and the Gmail app password, AES-256-GCM; the key
    //   is NOT in this database but in its own file beside it (DB_DIR/notification-secrets.key,
    //   decided with the user 2026-11-18), so copies of ttsu.db reveal nothing.
    // notification_problems: one row per problem the watcher has seen (waiting for its wait
    //   time, open, or resolved and waiting for the digest's "resolved" line).
    // notification_log: every message, also the outbox (pending → sent / failed after retries).
    // notification_digest_lines: lines waiting for the next daily digest.
    // notification_state: watermarks and the last digest day.
    sql: `
      CREATE TABLE notification_settings (
        key         TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE notification_secrets (
        name        TEXT PRIMARY KEY,
        ciphertext  BLOB NOT NULL,
        nonce       BLOB NOT NULL,
        tag         BLOB NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE notification_problems (
        key             TEXT PRIMARY KEY,
        event           TEXT NOT NULL,
        first_seen_at   INTEGER NOT NULL,
        last_active_at  INTEGER NOT NULL,
        noticed_at      INTEGER,
        resolved_at     INTEGER,
        summary         TEXT,
        detail          TEXT
      );

      CREATE TABLE notification_log (
        id          INTEGER PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        event       TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('now', 'digest', 'test')),
        channel     TEXT NOT NULL CHECK (channel IN ('discord', 'email')),
        text        TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
        attempts    INTEGER NOT NULL DEFAULT 0,
        next_at     INTEGER,
        error       TEXT,
        sent_at     INTEGER
      );
      CREATE INDEX notification_log_pending ON notification_log (status, next_at);

      CREATE TABLE notification_digest_lines (
        id          INTEGER PRIMARY KEY,
        event       TEXT NOT NULL,
        text        TEXT NOT NULL,
        link        TEXT,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE notification_state (
        name        TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL CHECK (json_valid(value_json))
      );
    `,
  },
  {
    version: 26,
    name: 'notification-stats-reports',
    // Notifications N2: the daily, weekly and monthly stats messages are logged (and sent
    // from the outbox) with kind 'report'. SQLite can't change a CHECK, so the log table is
    // rebuilt with the same columns and rows (at most NOTIFY_LOG_KEEP, 500) and its index.
    sql: `
      CREATE TABLE notification_log_new (
        id          INTEGER PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        event       TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('now', 'digest', 'test', 'report')),
        channel     TEXT NOT NULL CHECK (channel IN ('discord', 'email')),
        text        TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
        attempts    INTEGER NOT NULL DEFAULT 0,
        next_at     INTEGER,
        error       TEXT,
        sent_at     INTEGER
      );
      INSERT INTO notification_log_new
        (id, created_at, event, kind, channel, text, status, attempts, next_at, error, sent_at)
        SELECT id, created_at, event, kind, channel, text, status, attempts, next_at, error, sent_at
        FROM notification_log;
      DROP TABLE notification_log;
      ALTER TABLE notification_log_new RENAME TO notification_log;
      CREATE INDEX notification_log_pending ON notification_log (status, next_at);
    `,
  },
  {
    version: 27,
    name: 'audio-hold',
    // WP21e-2: the reader's audiobook hold (src/audio/audio-hold.ts). 'switch' while the
    // audiobook cleanup renames the library's audio folder and remaps the links (scans,
    // merges, PC jobs, link edits and writes wait); 'merge_wait' refuses merges until the
    // switch is done. Kept here so a restart in the middle keeps it.
    sql: `
      CREATE TABLE audio_hold (
        kind    TEXT PRIMARY KEY CHECK (kind IN ('switch', 'merge_wait')),
        reason  TEXT NOT NULL,
        since   INTEGER NOT NULL
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
