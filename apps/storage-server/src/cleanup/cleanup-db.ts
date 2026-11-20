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
  {
    version: 4,
    name: 'stage 3: content duplicates (WP20c)',
    sql: `
      -- What stage 3 read from each EPUB: its text as the reader counts it (length, the
      -- reader's own count for the same file, chapters), its edition kind, and for books in
      -- a duplicate pair the facts that pick the better copy. The sketch itself lives in the
      -- regenerable cache (cache/cleanup/stage3.db). A file is read again only when its size
      -- or mtime changed, or the counter bundle did.
      CREATE TABLE text_facts (
        library_id             TEXT NOT NULL,
        calibre_id             INTEGER NOT NULL,
        calibre_uuid           TEXT NOT NULL,
        file_path              TEXT NOT NULL,
        size                   INTEGER,
        mtime_ms               INTEGER,
        calibre_last_modified  TEXT,
        counter_build          TEXT,
        chars                  INTEGER,
        import_chars           INTEGER,
        reader_chars           INTEGER,
        samples                INTEGER,
        chapters_json          TEXT CHECK (chapters_json IS NULL OR json_valid(chapters_json)),
        ruby                   INTEGER,
        toc_entries            INTEGER,
        file_title             TEXT,
        kind                   TEXT,
        kind_marker            TEXT,
        kind_by                TEXT,
        image_entries          INTEGER,
        image_only             INTEGER NOT NULL DEFAULT 0,
        read_ms                INTEGER,
        read_at                INTEGER,
        error                  TEXT,
        -- Best-copy facts (only books in a duplicate pair): the EPUB's SHA-256 (the export
        -- check), writing direction, cover side and every picture's pHash/side/quantization.
        quality_size           INTEGER,
        quality_mtime_ms       INTEGER,
        sha256                 TEXT,
        vertical               INTEGER,
        cover_side             INTEGER,
        images_json            TEXT CHECK (images_json IS NULL OR json_valid(images_json)),
        quality_ms             INTEGER,
        quality_at             INTEGER,
        quality_error          TEXT,
        PRIMARY KEY (library_id, calibre_id)
      );
      CREATE INDEX text_facts_uuid ON text_facts (library_id, calibre_uuid);

      -- Pairs of one analysis: how they were found (index, gate, image_only), the estimate,
      -- the exact containment both ways, the class and its rule, the extra-text measure,
      -- the best-copy comparison, and the copy each pair keeps (null = trade-off).
      CREATE TABLE content_pairs (
        id             INTEGER PRIMARY KEY,
        analysis_id    TEXT NOT NULL,
        library_id     TEXT NOT NULL,
        a_id           INTEGER NOT NULL,
        a_uuid         TEXT NOT NULL,
        b_id           INTEGER NOT NULL,
        b_uuid         TEXT NOT NULL,
        source         TEXT NOT NULL,
        shared         INTEGER,
        est_a_in_b     REAL,
        est_b_in_a     REAL,
        a_in_b         REAL,
        b_in_a         REAL,
        class          TEXT,
        rule           TEXT,
        reason         TEXT,
        container      TEXT,
        spread_json    TEXT CHECK (spread_json IS NULL OR json_valid(spread_json)),
        best_json      TEXT CHECK (best_json IS NULL OR json_valid(best_json)),
        keep_id        INTEGER,
        measured_at    INTEGER,
        error          TEXT,
        UNIQUE (analysis_id, a_id, b_id)
      );
      CREATE INDEX content_pairs_class ON content_pairs (analysis_id, class);
      CREATE INDEX content_pairs_books ON content_pairs (analysis_id, a_id, b_id);

      -- Your decisions on review pairs (keep both / remove one copy), by UUID so they
      -- survive a new analysis.
      CREATE TABLE pair_decisions (
        library_id   TEXT NOT NULL,
        a_uuid       TEXT NOT NULL,
        b_uuid       TEXT NOT NULL,
        decision     TEXT NOT NULL CHECK (decision IN ('keep_both', 'remove_a', 'remove_b')),
        decided_at   INTEGER NOT NULL,
        PRIMARY KEY (library_id, a_uuid, b_uuid)
      );
    `,
  },
  {
    version: 5,
    name: 'stage 3: who decided a pair (you on the page, or Claude in the review) and why',
    sql: `
      ALTER TABLE pair_decisions ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'you';
      ALTER TABLE pair_decisions ADD COLUMN note TEXT;
    `,
  },
  {
    version: 6,
    name: 'indexes on the tables that point at proposed changes (a delete checked them row by row)',
    // Found live 2026-11-17: stage 3 replacing 8,664 proposals scanned batch_items (204,000 rows),
    // field_undo and undo_records once per deleted row for the foreign keys; the server answered
    // nothing for over an hour. With these indexes the same delete takes half a second.
    sql: `
      CREATE INDEX IF NOT EXISTS batch_items_change ON batch_items (change_id);
      CREATE INDEX IF NOT EXISTS undo_records_change ON undo_records (change_id);
      CREATE INDEX IF NOT EXISTS field_undo_change ON field_undo (change_id);
    `,
  },
  {
    version: 7,
    name: 'covering indexes for the page status (counts, pace, batch counts)',
    // Found live 2026-11-17: while /cleanup was open, its status poll read every row of
    // proposed_changes (224,000 wide rows, stage 2's counts) and batch_items (204,000, the pace
    // and the counts of 100 batches) every 5 s, blocking the server ~3 s of every 8 on the NAS;
    // the sidecar's reports waited behind it (a third of stage 3's removal time). Same results,
    // read from the indexes: 2 s -> 0.1 s on the PC.
    sql: `
      CREATE INDEX IF NOT EXISTS proposed_changes_counts
        ON proposed_changes (stage, library_id, state, field, class, analysis_id, decided_by);
      CREATE INDEX IF NOT EXISTS batch_items_batch_state ON batch_items (batch_id, state);
      CREATE INDEX IF NOT EXISTS batch_items_done ON batch_items (state, updated_at);
    `,
  },
  {
    version: 8,
    name: 'audiobook cleanup: stages 0-2 (WP21a)',
    sql: `
      -- The audiobook cleanup's own stages (Calibre's stages table means Calibre's stages).
      -- 0 = the ABS snapshot, 1 = identity, 2 = books and file health; later WPs add rows.
      CREATE TABLE audio_stages (
        stage          INTEGER PRIMARY KEY CHECK (stage BETWEEN 0 AND 9),
        mode           TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        state          TEXT NOT NULL DEFAULT 'idle',
        pause_reason   TEXT,
        pause_detail   TEXT,
        paused_at      INTEGER,
        progress_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        updated_at     INTEGER NOT NULL
      );
      INSERT INTO audio_stages (stage, updated_at) VALUES (0, 0), (1, 0), (2, 0);

      -- Every file under the two audiobook roots (read-only): torrents/audiobooks/japanese and
      -- media/audiobooks/japanese. rel_path is the name as text; rel_path_raw (hex) only when the
      -- bytes on disk are not valid UTF-8. A hash is kept only while path, size, mtime and inode
      -- are unchanged.
      CREATE TABLE audio_files (
        id             INTEGER PRIMARY KEY,
        root           TEXT NOT NULL CHECK (root IN ('torrents', 'library')),
        rel_path       TEXT NOT NULL,
        rel_path_raw   TEXT,
        decoded_path   TEXT,
        ext            TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('audio', 'archive', 'other', 'link')),
        size           INTEGER NOT NULL,
        mtime_ms       INTEGER NOT NULL,
        dev            INTEGER NOT NULL,
        ino            INTEGER NOT NULL,
        nlink          INTEGER NOT NULL,
        sha256         TEXT,
        hashed_at      INTEGER,
        hash_error     TEXT,
        hash_source    TEXT,
        first_seen_at  INTEGER NOT NULL,
        seen_at        INTEGER NOT NULL,
        gone_at        INTEGER,
        UNIQUE (root, rel_path)
      );
      CREATE INDEX audio_files_size ON audio_files (size, root);
      CREATE INDEX audio_files_sha ON audio_files (sha256);
      CREATE INDEX audio_files_inode ON audio_files (dev, ino);

      -- Stage 1's result per file of the current analysis.
      CREATE TABLE audio_identity (
        analysis_id        TEXT NOT NULL,
        file_id            INTEGER NOT NULL REFERENCES audio_files(id),
        class              TEXT NOT NULL,
        ai_original        INTEGER NOT NULL DEFAULT 0,
        group_sha256       TEXT,
        original_file_ids  TEXT CHECK (original_file_ids IS NULL OR json_valid(original_file_ids)),
        detail             TEXT,
        PRIMARY KEY (analysis_id, file_id)
      );
      CREATE INDEX audio_identity_class ON audio_identity (analysis_id, class);

      -- Stage 2: book units of the current analysis (a folder that holds audio, or one file in
      -- the TMW torrents), keyed by book_key = root + ':' + unit path (stable across analyses).
      CREATE TABLE audio_books (
        id             INTEGER PRIMARY KEY,
        analysis_id    TEXT NOT NULL,
        book_key       TEXT NOT NULL,
        root           TEXT NOT NULL,
        unit_rel_path  TEXT NOT NULL,
        unit_kind      TEXT NOT NULL CHECK (unit_kind IN ('folder', 'file')),
        source         TEXT NOT NULL,
        name_raw       TEXT NOT NULL,
        name_decoded   TEXT,
        file_count     INTEGER NOT NULL,
        total_seconds  REAL,
        multi_class    TEXT,
        class_reason   TEXT,
        UNIQUE (analysis_id, book_key)
      );
      CREATE INDEX audio_books_class ON audio_books (analysis_id, multi_class);

      CREATE TABLE audio_book_files (
        book_id   INTEGER NOT NULL REFERENCES audio_books(id) ON DELETE CASCADE,
        file_id   INTEGER NOT NULL REFERENCES audio_files(id),
        position  INTEGER NOT NULL,
        disc      TEXT,
        PRIMARY KEY (book_id, file_id)
      );
      CREATE INDEX audio_book_files_file ON audio_book_files (file_id);

      -- Stage 2: what ffprobe and two short decodes found in each audio file (format from the
      -- content, not the name). Kept until the file's size or mtime changes.
      CREATE TABLE audio_file_health (
        file_id          INTEGER PRIMARY KEY REFERENCES audio_files(id),
        size             INTEGER NOT NULL,
        mtime_ms         INTEGER NOT NULL,
        format           TEXT,
        format_long      TEXT,
        codec            TEXT,
        profile          TEXT,
        bitrate          INTEGER,
        sample_rate      INTEGER,
        channels         INTEGER,
        duration         REAL,
        chapter_count    INTEGER,
        chapters_json    TEXT CHECK (chapters_json IS NULL OR json_valid(chapters_json)),
        has_cover        INTEGER,
        tags_json        TEXT CHECK (tags_json IS NULL OR json_valid(tags_json)),
        header_ok        INTEGER NOT NULL DEFAULT 0,
        start_decode_ok  INTEGER,
        end_decode_ok    INTEGER,
        decode_error     TEXT,
        error            TEXT,
        tool_version     TEXT,
        checked_ms       INTEGER,
        checked_at       INTEGER NOT NULL
      );

      -- Each book's evidence (names raw and decoded, ids in the names, the first file's tags,
      -- ABS's metadata.json), kept for the later AI upgrade path.
      CREATE TABLE audio_evidence (
        book_key    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        version     INTEGER NOT NULL,
        data        TEXT NOT NULL CHECK (json_valid(data)),
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (book_key, kind)
      );

      -- Stage 0: read-only snapshots of Audiobookshelf (libraries, counts, every user's progress).
      CREATE TABLE abs_snapshots (
        id            INTEGER PRIMARY KEY,
        taken_at      INTEGER NOT NULL,
        abs_version   TEXT,
        data_json     TEXT NOT NULL CHECK (json_valid(data_json)),
        summary_json  TEXT NOT NULL CHECK (json_valid(summary_json))
      );
    `,
  },
  {
    version: 9,
    name: 'stage 4: the fetch queue, lookups, Natively index and author readings (WP20d)',
    sql: `
      -- The fetch container's tokens reach only /api/v1/cleanup-fetch/*; the apply sidecar's
      -- only /api/v1/cleanup-apply/*.
      ALTER TABLE apply_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'apply'
        CHECK (scope IN ('apply', 'fetch'));

      -- Pace and backoff state per site (and per shared key: 'amazon' paces product pages and
      -- searches together when they share a slot, and backs off every Amazon queue at once).
      -- Survives restarts, so neither side can burst after one.
      CREATE TABLE fetch_sites (
        site               TEXT PRIMARY KEY,
        last_claim_at      INTEGER,
        backoff_until      INTEGER,
        backoff_reason     TEXT,
        backoff_seconds    INTEGER NOT NULL DEFAULT 0,
        failures_in_row    INTEGER NOT NULL DEFAULT 0,
        challenges_in_row  INTEGER NOT NULL DEFAULT 0,
        paused_reason      TEXT,
        paused_at          INTEGER,
        slow_factor        REAL NOT NULL DEFAULT 1,
        mode               TEXT,
        -- Totals per site for the page (counted as answers arrive; reading fetch_attempts
        -- for them took 0.4 s on the PC at the library's size).
        attempts           INTEGER NOT NULL DEFAULT 0,
        challenges         INTEGER NOT NULL DEFAULT 0,
        errors             INTEGER NOT NULL DEFAULT 0,
        busy               INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL
      );

      -- One row per distinct request (a series page shared by many volumes is asked once).
      -- The answer itself is in the fetch cache (cache/cleanup/fetch/<site>/..., regenerable).
      CREATE TABLE fetch_requests (
        id           INTEGER PRIMARY KEY,
        site         TEXT NOT NULL,
        key          TEXT NOT NULL,
        method       TEXT NOT NULL DEFAULT 'GET',
        url          TEXT NOT NULL,
        body         TEXT,
        accept       TEXT,
        priority     INTEGER NOT NULL DEFAULT 0,
        state        TEXT NOT NULL DEFAULT 'queued'
                     CHECK (state IN ('queued', 'leased', 'done', 'gone', 'failed')),
        attempts     INTEGER NOT NULL DEFAULT 0,
        next_at      INTEGER NOT NULL DEFAULT 0,
        lease_token  TEXT,
        lease_until  INTEGER,
        status       INTEGER,
        bytes        INTEGER,
        outcome      TEXT,
        error        TEXT,
        ms           INTEGER,
        cache_file   TEXT,
        created_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        updated_at   INTEGER NOT NULL,
        UNIQUE (site, key)
      );
      -- The claim takes a site's next request straight off this index (priority first).
      CREATE INDEX fetch_requests_due ON fetch_requests (site, state, priority DESC, next_at);
      CREATE INDEX fetch_requests_lease ON fetch_requests (state, lease_until);

      -- Every attempt (pace, challenge rate, seconds per request), with the Amazon pace in use.
      CREATE TABLE fetch_attempts (
        id          INTEGER PRIMARY KEY,
        request_id  INTEGER NOT NULL,
        site        TEXT NOT NULL,
        at          INTEGER NOT NULL,
        ms          INTEGER,
        status      INTEGER,
        bytes       INTEGER,
        outcome     TEXT NOT NULL,
        pace        TEXT,
        labeled     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX fetch_attempts_site ON fetch_attempts (site, at);

      -- Which book waits on which request, and at which lookup step. ready = the request has
      -- its answer (or was given up); the analysis takes ready rows and deletes them once the
      -- book's next step is saved, so an answer survives any restart.
      CREATE TABLE fetch_waiters (
        request_id    INTEGER NOT NULL REFERENCES fetch_requests(id),
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        step          TEXT NOT NULL,
        ready         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (request_id, library_id, calibre_uuid, step)
      );
      CREATE INDEX fetch_waiters_book ON fetch_waiters (library_id, calibre_uuid);
      CREATE INDEX fetch_waiters_ready ON fetch_waiters (ready, request_id) WHERE ready = 1;

      -- Stage 4's state per book: read (file evidence taken), waiting (lookups open), ready
      -- (all answered), proposed (rules run), error. lookup_json holds each source's step.
      CREATE TABLE stage4_books (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        calibre_id    INTEGER NOT NULL,
        analysis_id   TEXT NOT NULL,
        labeled       INTEGER NOT NULL DEFAULT 0,
        state         TEXT NOT NULL
                      CHECK (state IN ('read', 'waiting', 'ready', 'proposed', 'error')),
        pending       INTEGER NOT NULL DEFAULT 0,
        lookup_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(lookup_json)),
        error         TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid)
      );
      CREATE INDEX stage4_books_state ON stage4_books (analysis_id, state, labeled);

      -- Natively's book pages (from its sitemap), read once each: their ISBNs and Kindle ASINs.
      CREATE TABLE natively_books (
        natively_id  TEXT PRIMARY KEY,
        url          TEXT NOT NULL,
        title        TEXT,
        isbn10       TEXT,
        isbn13       TEXT,
        listed_at    INTEGER NOT NULL,
        queued_at    INTEGER,
        read_at      INTEGER
      );
      CREATE INDEX natively_books_isbn13 ON natively_books (isbn13);
      CREATE INDEX natively_books_unqueued ON natively_books (natively_id) WHERE queued_at IS NULL;
      CREATE TABLE natively_asins (
        asin         TEXT NOT NULL,
        natively_id  TEXT NOT NULL,
        PRIMARY KEY (asin, natively_id)
      );

      -- Author readings: Web NDL Authorities first; a generated reading (Sudachi) is marked.
      -- queued -> asked (NDL) -> found | not_found -> generating (Sudachi) -> generated | none.
      CREATE TABLE author_readings (
        name        TEXT PRIMARY KEY,
        state       TEXT NOT NULL
                    CHECK (state IN ('queued', 'asked', 'found', 'not_found', 'generating', 'generated', 'none')),
        reading     TEXT,
        source      TEXT,
        authority   TEXT,
        ambiguous   INTEGER NOT NULL DEFAULT 0,
        generated   TEXT,
        request_id  INTEGER,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX author_readings_state ON author_readings (state);

      CREATE TABLE fetcher_status (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        fetcher_id    TEXT,
        last_seen_at  INTEGER,
        version       TEXT,
        problem       TEXT,
        sudachi       TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO fetcher_status (id, updated_at) VALUES (1, 0);
    `,
  },
  {
    version: 10,
    name: 'audiobook cleanup: stage 3, duplicates (WP21b)',
    sql: `
      INSERT INTO audio_stages (stage, updated_at) VALUES (3, 0);

      -- A Chromaprint fingerprint of one stretch of a copy. win_key names the stretch as the
      -- files and seconds read ([[file_id, start_ms, length_ms], ...]); files_sig holds each
      -- file's size and mtime when it was read, so a changed file is read again. Kept across
      -- analyses (taken over, never repeated).
      CREATE TABLE audio_fingerprints (
        win_key       TEXT PRIMARY KEY,
        files_sig     TEXT NOT NULL,
        fp            BLOB,
        items         INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        tool_version  TEXT,
        took_ms       INTEGER,
        made_at       INTEGER NOT NULL
      );

      -- Full decodes (rule 0): ffmpeg's error count, and faad2's decoded length (it stops
      -- silently at damage). Kept until the file's size or mtime changes.
      CREATE TABLE audio_full_decodes (
        file_id           INTEGER NOT NULL REFERENCES audio_files(id),
        decoder           TEXT NOT NULL CHECK (decoder IN ('ffmpeg', 'faad')),
        size              INTEGER NOT NULL,
        mtime_ms          INTEGER NOT NULL,
        ok                INTEGER,
        error_count       INTEGER,
        decoded_seconds   REAL,
        expected_seconds  REAL,
        detail            TEXT,
        tool_version      TEXT,
        took_ms           INTEGER,
        checked_at        INTEGER NOT NULL,
        PRIMARY KEY (file_id, decoder)
      );

      -- Stage 3's copies: one complete recording each (a file, the parts of a folder, or a
      -- library-only file), keyed by copy_key (stable across analyses).
      CREATE TABLE audio_dup_copies (
        id           INTEGER PRIMARY KEY,
        analysis_id  TEXT NOT NULL,
        copy_key     TEXT NOT NULL,
        book_key     TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('file', 'parts', 'library_only')),
        file_ids     TEXT NOT NULL CHECK (json_valid(file_ids)),
        name         TEXT NOT NULL,
        seconds      REAL,
        ai           INTEGER NOT NULL DEFAULT 0,
        title_key    TEXT,
        volume       TEXT,
        asins        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(asins)),
        abs_asins    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(abs_asins)),
        excluded     TEXT,
        UNIQUE (analysis_id, copy_key)
      );
      CREATE INDEX audio_dup_copies_title ON audio_dup_copies (analysis_id, title_key);

      -- Candidate pairs and what measured them (the cheapest test that proposed the pair).
      CREATE TABLE audio_dup_pairs (
        id            INTEGER PRIMARY KEY,
        analysis_id   TEXT NOT NULL,
        a_id          INTEGER NOT NULL,
        b_id          INTEGER NOT NULL,
        test          TEXT NOT NULL CHECK (test IN ('identical', 'asin', 'abs_asin', 'title', 'in_folder')),
        verdict       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (verdict IN ('pending', 'same', 'different', 'unsure')),
        fp_verdict    TEXT,
        scores_json   TEXT CHECK (scores_json IS NULL OR json_valid(scores_json)),
        length_diff   REAL,
        detail        TEXT,
        rules_key     TEXT,
        UNIQUE (analysis_id, a_id, b_id)
      );
      CREATE INDEX audio_dup_pairs_verdict ON audio_dup_pairs (analysis_id, verdict, test);
      CREATE INDEX audio_dup_pairs_b ON audio_dup_pairs (analysis_id, b_id);

      -- Groups of copies of one recording (kind 'group') and unsure pairs (kind 'unsure': both
      -- stay, review). best_copy_id is the best copy or the best guess.
      CREATE TABLE audio_dup_groups (
        id             INTEGER PRIMARY KEY,
        analysis_id    TEXT NOT NULL,
        group_key      TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('group', 'unsure')),
        first_test     TEXT NOT NULL,
        tests_json     TEXT NOT NULL CHECK (json_valid(tests_json)),
        members        INTEGER NOT NULL,
        best_copy_id   INTEGER,
        rule           TEXT,
        outcome        TEXT NOT NULL CHECK (outcome IN ('auto', 'review')),
        review_reason  TEXT,
        conflicts_json TEXT CHECK (conflicts_json IS NULL OR json_valid(conflicts_json)),
        damaged        INTEGER NOT NULL DEFAULT 0,
        rules_key      TEXT,
        UNIQUE (analysis_id, group_key)
      );
      CREATE INDEX audio_dup_groups_outcome ON audio_dup_groups (analysis_id, outcome, kind);
      CREATE INDEX audio_dup_groups_test ON audio_dup_groups (analysis_id, first_test);

      CREATE TABLE audio_dup_members (
        group_id      INTEGER NOT NULL REFERENCES audio_dup_groups(id) ON DELETE CASCADE,
        copy_id       INTEGER NOT NULL,
        rank          INTEGER NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('keep', 'drop', 'review')),
        against_json  TEXT CHECK (against_json IS NULL OR json_valid(against_json)),
        PRIMARY KEY (group_id, copy_id)
      );
      CREATE INDEX audio_dup_members_copy ON audio_dup_members (copy_id);

      -- The user's choices on the review page (recorded only; WP21e applies them). Keyed by
      -- the group's copies, so a choice survives a new analysis of the same copies.
      CREATE TABLE audio_dup_decisions (
        group_key    TEXT PRIMARY KEY,
        member_keys  TEXT NOT NULL CHECK (json_valid(member_keys)),
        decision     TEXT NOT NULL,
        decided_by   TEXT NOT NULL DEFAULT 'you',
        note         TEXT,
        decided_at   INTEGER NOT NULL
      );
    `,
  },
  {
    version: 11,
    name: 'audiobook cleanup: stage 3 proves copies frame by frame (WP21b follow-up)',
    sql: `
      -- The frame-by-frame comparison of two copies (the longer one first): whether the shorter
      -- is inside the longer and what is extra. Keyed by the copies' contents (SHA-256, or the
      -- file as it was when not hashed), so it is never repeated while the files are the same.
      CREATE TABLE audio_frame_checks (
        pair_key      TEXT PRIMARY KEY,
        result_json   TEXT NOT NULL CHECK (json_valid(result_json)),
        tool_version  TEXT,
        took_ms       INTEGER,
        checked_at    INTEGER NOT NULL
      );
    `,
  },
  {
    version: 12,
    name: 'audiobook cleanup: stage 4, online sources (WP21c)',
    sql: `
      INSERT INTO audio_stages (stage, updated_at) VALUES (4, 0);

      -- Which lookup unit waits on which request of the shared fetch queue, and at which step.
      -- Separate from Calibre's fetch_waiters (its stage 4 takes every ready row there and
      -- empties the table when it starts over). ready = answered or given up.
      CREATE TABLE audio_fetch_waiters (
        request_id  INTEGER NOT NULL REFERENCES fetch_requests(id),
        unit_key    TEXT NOT NULL,
        step        TEXT NOT NULL,
        ready       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (request_id, unit_key, step)
      );
      CREATE INDEX audio_fetch_waiters_ready ON audio_fetch_waiters (ready, request_id) WHERE ready = 1;
      CREATE INDEX audio_fetch_waiters_unit ON audio_fetch_waiters (unit_key);

      -- One recording looked up once: the stage-3 copies proven the same recording, or one copy.
      -- kind none_expected: AI books and the radio clips (no store record by nature).
      -- state: planned -> waiting (requests open) -> ready (one answered) -> ... -> decided;
      -- audio = needs the recording's opening or a store sample fingerprinted (the disk part).
      -- class: auto | review | unknown | none_expected once decided.
      CREATE TABLE audio_online_units (
        id             INTEGER PRIMARY KEY,
        analysis_id    TEXT NOT NULL,
        unit_key       TEXT NOT NULL,
        copy_keys      TEXT NOT NULL CHECK (json_valid(copy_keys)),
        book_keys      TEXT NOT NULL CHECK (json_valid(book_keys)),
        name           TEXT NOT NULL,
        seconds        REAL,
        labeled        INTEGER NOT NULL DEFAULT 0,
        kind           TEXT NOT NULL CHECK (kind IN ('lookup', 'none_expected')),
        state          TEXT NOT NULL
                       CHECK (state IN ('planned', 'waiting', 'ready', 'audio', 'decided', 'error')),
        pending        INTEGER NOT NULL DEFAULT 0,
        inputs_json    TEXT NOT NULL CHECK (json_valid(inputs_json)),
        steps_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(steps_json)),
        class          TEXT,
        source         TEXT,
        store_id       TEXT,
        review_reason  TEXT,
        detail         TEXT,
        rules_key      TEXT,
        error          TEXT,
        updated_at     INTEGER NOT NULL,
        UNIQUE (analysis_id, unit_key)
      );
      CREATE INDEX audio_online_units_state ON audio_online_units (analysis_id, state, labeled);
      CREATE INDEX audio_online_units_class ON audio_online_units (analysis_id, class, source);
      CREATE INDEX audio_online_units_reason ON audio_online_units (analysis_id, review_reason);

      -- Every store record a unit's lookups found, with each check's result on both sides.
      CREATE TABLE audio_online_candidates (
        id           INTEGER PRIMARY KEY,
        unit_id      INTEGER NOT NULL REFERENCES audio_online_units(id) ON DELETE CASCADE,
        source       TEXT NOT NULL,
        store_id     TEXT NOT NULL,
        via          TEXT NOT NULL,
        checks_json  TEXT NOT NULL CHECK (json_valid(checks_json)),
        verdict      TEXT NOT NULL,
        sample_score REAL,
        UNIQUE (unit_id, source, store_id)
      );

      -- Each store record once, with every field its answer had (what WP21d reads; nothing is
      -- fetched again), and the request it came from (its page stays in the fetch cache).
      CREATE TABLE audio_online_records (
        source      TEXT NOT NULL,
        store_id    TEXT NOT NULL,
        request_id  INTEGER,
        record      BLOB NOT NULL,
        fetched_at  INTEGER NOT NULL,
        PRIMARY KEY (source, store_id)
      );
    `,
  },
  {
    version: 13,
    name: 'the shared AI framework and audiobook stage 5, metadata (WP21d)',
    sql: `
      -- The AI framework (src/cleanup/ai/, shared by every stage that asks the models; stage =
      -- "audio5" here, "calibre4" for WP20e). Each item's evidence record, kept so an upgrade
      -- (setups F/J) asks other models without fetching or reading anything again.
      CREATE TABLE ai_items (
        stage             TEXT NOT NULL,
        item_key          TEXT NOT NULL,
        evidence          BLOB NOT NULL,
        evidence_version  INTEGER NOT NULL,
        evidence_hash     TEXT NOT NULL,
        labeled           INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL,
        PRIMARY KEY (stage, item_key)
      );

      -- Every question to a model and its answer. One per item, model, prompt version and
      -- evidence: a restart, a rules change or a new analysis with the same evidence never asks
      -- again. state: queued -> sent -> answered | blocked (a content block: final, never asked
      -- again) | invalid (no usable JSON) | failed (errors after every try).
      CREATE TABLE ai_requests (
        id                 INTEGER PRIMARY KEY,
        stage              TEXT NOT NULL,
        item_key           TEXT NOT NULL,
        role               TEXT NOT NULL,
        provider           TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
        model              TEXT NOT NULL,
        prompt_version     TEXT NOT NULL,
        evidence_hash      TEXT NOT NULL,
        state              TEXT NOT NULL
                           CHECK (state IN ('queued', 'sent', 'answered', 'blocked', 'invalid', 'failed')),
        mode               TEXT CHECK (mode IS NULL OR mode IN ('direct', 'batch')),
        batch_id           TEXT,
        attempts           INTEGER NOT NULL DEFAULT 0,
        answer_json        TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
        raw_text           TEXT,
        input_tokens       INTEGER,
        output_tokens      INTEGER,
        cache_read_tokens  INTEGER,
        cost_usd           REAL,
        error              TEXT,
        run_id             TEXT,
        labeled            INTEGER NOT NULL DEFAULT 0,
        created_at         INTEGER NOT NULL,
        sent_at            INTEGER,
        answered_at        INTEGER,
        UNIQUE (stage, item_key, model, prompt_version, evidence_hash)
      );
      CREATE INDEX ai_requests_state ON ai_requests (stage, state, model, labeled);
      CREATE INDEX ai_requests_batch ON ai_requests (batch_id) WHERE batch_id IS NOT NULL;
      CREATE INDEX ai_requests_run ON ai_requests (run_id, stage, state, model, labeled);
      CREATE INDEX ai_requests_model ON ai_requests (model, state);
      CREATE INDEX ai_requests_item ON ai_requests (stage, item_key);

      -- A batch at a provider (its id is the provider's). estimate_usd is held against the
      -- spending limit until its answers are in.
      CREATE TABLE ai_batches (
        id               TEXT PRIMARY KEY,
        provider         TEXT NOT NULL,
        model            TEXT NOT NULL,
        stage            TEXT NOT NULL,
        state            TEXT NOT NULL CHECK (state IN ('submitted', 'collected', 'failed')),
        requests         INTEGER NOT NULL,
        estimate_usd     REAL NOT NULL,
        cost_usd         REAL,
        provider_status  TEXT,
        input_file_id    TEXT,
        error            TEXT,
        submitted_at     INTEGER NOT NULL,
        checked_at       INTEGER,
        ended_at         INTEGER
      );
      CREATE INDEX ai_batches_state ON ai_batches (state, provider);

      -- Settings > AI "Test batch": one tiny question sent to a model as a batch, to see whether
      -- and how fast its provider runs batches for it (OpenAI ran none for gpt-6-luna on
      -- 2026-11-19). state: open -> answered | nothing (cancelled after the stall time) | failed.
      CREATE TABLE ai_batch_tests (
        id            INTEGER PRIMARY KEY,
        provider      TEXT NOT NULL,
        model         TEXT NOT NULL,
        batch_id      TEXT,
        state         TEXT NOT NULL CHECK (state IN ('open', 'answered', 'nothing', 'failed')),
        submitted_at  INTEGER NOT NULL,
        checked_at    INTEGER,
        ended_at      INTEGER,
        cost_usd      REAL,
        detail        TEXT
      );
      CREATE INDEX ai_batch_tests_model ON ai_batch_tests (model, id);
      CREATE INDEX ai_batch_tests_open ON ai_batch_tests (state) WHERE state = 'open';

      -- The model ids each provider offered when last checked (Settings: Check models).
      CREATE TABLE ai_model_checks (
        provider    TEXT PRIMARY KEY,
        checked_at  INTEGER NOT NULL,
        models_json TEXT CHECK (models_json IS NULL OR json_valid(models_json)),
        error       TEXT
      );

      -- The value of every field and where it came from: rules | both_models (both agreed) |
      -- secondary_guess (flagged: the second model's answer) | rules_guess (flagged: the rules')
      -- | unknown (flagged, nobody knows) | user | upgrade_models (setups F/J). An upgrade
      -- re-checks only both_models, secondary_guess and rules_guess; nothing replaces user.
      CREATE TABLE ai_values (
        stage           TEXT NOT NULL,
        item_key        TEXT NOT NULL,
        field           TEXT NOT NULL,
        value_json      TEXT NOT NULL CHECK (json_valid(value_json)),
        source          TEXT NOT NULL CHECK (source IN ('rules', 'both_models', 'secondary_guess',
                          'rules_guess', 'unknown', 'user', 'upgrade_models')),
        flagged         INTEGER NOT NULL DEFAULT 0,
        reason          TEXT,
        rules_json      TEXT CHECK (rules_json IS NULL OR json_valid(rules_json)),
        rules_auto      INTEGER,
        primary_json    TEXT CHECK (primary_json IS NULL OR json_valid(primary_json)),
        secondary_json  TEXT CHECK (secondary_json IS NULL OR json_valid(secondary_json)),
        design          TEXT NOT NULL DEFAULT 'E',
        evidence_hash   TEXT,
        decided_at      INTEGER NOT NULL,
        user_at         INTEGER,
        PRIMARY KEY (stage, item_key, field)
      );
      CREATE INDEX ai_values_field ON ai_values (stage, field, source, flagged);
      CREATE INDEX ai_values_flagged ON ai_values (stage, flagged, item_key);

      -- Audiobook stage 5: one row per recording (stage 4's units), its values in ai_values.
      -- kind: record (a store record chosen or to judge) | no_record | ai | radio.
      -- state: evidence (built) -> asking (models asked) -> decided | error.
      INSERT INTO audio_stages (stage, updated_at) VALUES (5, 0);
      CREATE TABLE audio_meta_units (
        analysis_id   TEXT NOT NULL,
        unit_key      TEXT NOT NULL,
        name          TEXT NOT NULL,
        labeled       INTEGER NOT NULL DEFAULT 0,
        kind          TEXT NOT NULL CHECK (kind IN ('record', 'no_record', 'ai', 'radio')),
        stage4_class  TEXT,
        record        TEXT,
        state         TEXT NOT NULL CHECK (state IN ('evidence', 'asking', 'decided', 'error')),
        flagged       INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (analysis_id, unit_key)
      );
      CREATE INDEX audio_meta_units_state ON audio_meta_units (analysis_id, state, labeled);
      CREATE INDEX audio_meta_units_flagged ON audio_meta_units (analysis_id, flagged, unit_key);
      CREATE INDEX audio_meta_units_kind ON audio_meta_units (analysis_id, kind, unit_key);
      CREATE INDEX audio_meta_units_labeled ON audio_meta_units (analysis_id, labeled, unit_key);
    `,
  },
  {
    version: 14,
    name: 'audiobook cleanup: stage 6 builds japanese-new with hard links (WP21e-1)',
    sql: `
      -- Tokens get the scope 'link' (the linking sidecar, cli token link): the table is rebuilt
      -- because SQLite can't change a CHECK.
      CREATE TABLE apply_tokens_v14 (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        revoked_at    INTEGER,
        scope         TEXT NOT NULL DEFAULT 'apply' CHECK (scope IN ('apply', 'fetch', 'link'))
      );
      INSERT INTO apply_tokens_v14 (id, label, token_hash, created_at, last_used_at, revoked_at, scope)
        SELECT id, label, token_hash, created_at, last_used_at, revoked_at, scope FROM apply_tokens;
      DROP TABLE apply_tokens;
      ALTER TABLE apply_tokens_v14 RENAME TO apply_tokens;

      -- The linking sidecar's last heartbeat (one row).
      CREATE TABLE link_sidecar_status (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        sidecar_id    TEXT,
        run_id        TEXT,
        version       TEXT,
        last_seen_at  INTEGER,
        problem       TEXT,
        info_json     TEXT CHECK (info_json IS NULL OR json_valid(info_json))
      );

      -- Stage 6: one row per book folder the build makes (or will make at the switch: the
      -- library-only files, state pending). folder is relative to media/audiobooks.
      INSERT INTO audio_stages (stage, updated_at) VALUES (6, 0);
      CREATE TABLE audio_build_books (
        id             INTEGER PRIMARY KEY,
        analysis_id    TEXT NOT NULL,
        unit_key       TEXT NOT NULL,
        copy_key       TEXT NOT NULL,
        area           TEXT NOT NULL CHECK (area IN ('main', 'ai')),
        state          TEXT NOT NULL CHECK (state IN ('build', 'pending')),
        folder         TEXT NOT NULL,
        base_folder    TEXT NOT NULL,
        author         TEXT NOT NULL,
        series         TEXT,
        title          TEXT NOT NULL,
        notes_json     TEXT NOT NULL CHECK (json_valid(notes_json)),
        files          INTEGER NOT NULL,
        pdfs           INTEGER NOT NULL,
        cover          INTEGER NOT NULL,
        metadata       BLOB NOT NULL,
        sample         INTEGER NOT NULL DEFAULT 0,
        UNIQUE (analysis_id, folder)
      );
      CREATE INDEX audio_build_books_unit ON audio_build_books (analysis_id, unit_key);
      CREATE INDEX audio_build_books_sample ON audio_build_books (analysis_id, sample, id);
      CREATE INDEX audio_build_books_state ON audio_build_books (analysis_id, state, id);

      -- Every operation of the build, in order (id): folder, link (audio), pdf (link), metadata.
      -- dst is relative to media/audiobooks; src relative to torrents/audiobooks/japanese (src_raw:
      -- the exact bytes as hex when the name is not UTF-8). state: planned -> claimed -> done |
      -- failed. A claimed batch whose lease ran out goes back to planned (the sidecar's operations
      -- are safe to repeat).
      CREATE TABLE audio_build_ops (
        id           INTEGER PRIMARY KEY,
        analysis_id  TEXT NOT NULL,
        book_id      INTEGER,
        kind         TEXT NOT NULL CHECK (kind IN ('folder', 'link', 'pdf', 'metadata')),
        dst          TEXT NOT NULL,
        src_file_id  INTEGER,
        src_rel      TEXT,
        src_raw      TEXT,
        size         INTEGER,
        mtime_ms     INTEGER,
        dev          INTEGER,
        ino          INTEGER,
        state        TEXT NOT NULL DEFAULT 'planned'
                       CHECK (state IN ('planned', 'claimed', 'done', 'failed')),
        batch_id     INTEGER,
        preflight    TEXT,
        result_json  TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        done_at      INTEGER
      );
      CREATE INDEX audio_build_ops_state ON audio_build_ops (analysis_id, state, id);
      CREATE INDEX audio_build_ops_batch ON audio_build_ops (batch_id);
      CREATE INDEX audio_build_ops_book ON audio_build_ops (book_id);
      CREATE INDEX audio_build_ops_src ON audio_build_ops (analysis_id, src_file_id);
      CREATE INDEX audio_build_ops_preflight ON audio_build_ops (analysis_id, preflight, id);

      -- A batch handed to the sidecar (kind preflight: read-only checks of the sources).
      CREATE TABLE audio_build_batches (
        id           INTEGER PRIMARY KEY,
        analysis_id  TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('preflight', 'build')),
        state        TEXT NOT NULL CHECK (state IN ('claimed', 'reported', 'expired')),
        ops          INTEGER NOT NULL,
        claimed_at   INTEGER NOT NULL,
        lease_until  INTEGER NOT NULL,
        reported_at  INTEGER
      );
      CREATE INDEX audio_build_batches_state ON audio_build_batches (analysis_id, state, id);

      -- The move list (WP21e-2's input for the reader's links): every audio file of the live
      -- library (paths relative to media/audiobooks) and what became of it.
      CREATE TABLE audio_build_moves (
        analysis_id  TEXT NOT NULL,
        file_id      INTEGER NOT NULL,
        old_path     TEXT NOT NULL,
        outcome      TEXT NOT NULL CHECK (outcome IN
                       ('moved', 'ai', 'dropped', 'library_only_pending', 'reader_written', 'unaccounted')),
        new_path     TEXT,
        kept_path    TEXT,
        detail       TEXT,
        PRIMARY KEY (analysis_id, file_id)
      );
      CREATE INDEX audio_build_moves_outcome ON audio_build_moves (analysis_id, outcome, file_id);

      -- The walks before and after the build (torrents and library): what the check compares.
      CREATE TABLE audio_build_manifest (
        analysis_id  TEXT NOT NULL,
        phase        TEXT NOT NULL CHECK (phase IN ('before', 'after')),
        root         TEXT NOT NULL CHECK (root IN ('torrents', 'library')),
        rel          TEXT NOT NULL,
        raw          TEXT,
        is_dir       INTEGER NOT NULL,
        size         INTEGER NOT NULL,
        mtime_ms     INTEGER NOT NULL,
        dev          INTEGER NOT NULL,
        ino          INTEGER NOT NULL,
        nlink        INTEGER NOT NULL,
        PRIMARY KEY (analysis_id, phase, root, rel)
      );
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
