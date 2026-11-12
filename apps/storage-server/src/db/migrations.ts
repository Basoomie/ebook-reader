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
