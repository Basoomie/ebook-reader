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
import { hasAiData, moveAiToShared } from './ai-move';

export const CLEANUP_DB_FILENAME = 'cleanup.db';

export function cleanupDbPath(dbDir: string): string {
  return path.join(dbDir, CLEANUP_DB_FILENAME);
}

/** Manga part B: the migration that gives every stage, pass and import run its library. */
export const LIBRARY_SCOPE_VERSION = 37;

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
  {
    version: 15,
    name: 'audiobook cleanup: the switch to the new library (WP21e-2)',
    // The switch (src/cleanup/audio/stage6-switch.ts): japanese -> japanese-old,
    // japanese-new -> japanese, the reader's links remapped; Undo; covers; deleting
    // japanese-old. One state row; the sidecar's operations and batches; every link the switch
    // changed (also what Undo restores); the PDFs and archives re-checked before the deletion.
    sql: `
      CREATE TABLE audio_switch (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        state         TEXT NOT NULL CHECK (state IN ('none', 'running', 'switched', 'deleted')),
        progress_json TEXT NOT NULL CHECK (json_valid(progress_json)),
        pause_reason  TEXT,
        pause_detail  TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO audio_switch (id, state, progress_json, updated_at) VALUES (1, 'none', '{}', 0);

      CREATE TABLE audio_switch_ops (
        id           INTEGER PRIMARY KEY,
        run_id       TEXT NOT NULL,
        phase        TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN
                       ('rename', 'from_library', 'folder', 'link', 'metadata', 'inventory', 'delete')),
        book_id      INTEGER,
        src_rel      TEXT,
        src_raw      TEXT,
        dst          TEXT NOT NULL,
        size         INTEGER,
        mtime_ms     INTEGER,
        dev          INTEGER,
        ino          INTEGER,
        sha256       TEXT,
        is_dir       INTEGER NOT NULL DEFAULT 0,
        state        TEXT NOT NULL DEFAULT 'planned'
                       CHECK (state IN ('planned', 'claimed', 'done', 'failed')),
        batch_id     INTEGER,
        result_json  TEXT,
        done_at      INTEGER
      );
      CREATE INDEX audio_switch_ops_next ON audio_switch_ops (run_id, phase, state, seq);
      CREATE INDEX audio_switch_ops_batch ON audio_switch_ops (batch_id);

      CREATE TABLE audio_switch_batches (
        id           INTEGER PRIMARY KEY,
        run_id       TEXT NOT NULL,
        state        TEXT NOT NULL CHECK (state IN ('claimed', 'reported', 'expired')),
        ops          INTEGER NOT NULL,
        claimed_at   INTEGER NOT NULL,
        lease_until  INTEGER NOT NULL,
        reported_at  INTEGER
      );
      CREATE INDEX audio_switch_batches_state ON audio_switch_batches (run_id, state, id);

      -- Every reader link the switch looked at (paths relative to the audiobooks root, as
      -- ttsu.db stores them): before, after, why; Undo writes the old values back.
      CREATE TABLE audio_switch_links (
        run_id         TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        book_id        TEXT NOT NULL,
        old_folder     TEXT,
        old_file       TEXT,
        new_folder     TEXT,
        new_file       TEXT,
        outcome        TEXT NOT NULL,
        detail         TEXT,
        changed        INTEGER NOT NULL,
        status_before  TEXT,
        playable_before INTEGER,
        status_after   TEXT,
        playable_after INTEGER,
        restored_at    INTEGER,
        PRIMARY KEY (run_id, user_id, book_id)
      );
      CREATE INDEX audio_switch_links_outcome ON audio_switch_links (run_id, outcome);

      -- Before deleting japanese-old: its PDFs and archives read again on both sides.
      CREATE TABLE audio_switch_files (
        run_id       TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('pdf', 'archive')),
        lib_rel      TEXT NOT NULL,
        lib_raw      TEXT,
        torrent_rel  TEXT,
        torrent_raw  TEXT,
        size         INTEGER NOT NULL,
        lib_sha      TEXT,
        torrent_sha  TEXT,
        state        TEXT NOT NULL DEFAULT 'planned'
                       CHECK (state IN ('planned', 'same', 'different', 'no_twin', 'unreadable')),
        PRIMARY KEY (run_id, lib_rel)
      );
      CREATE INDEX audio_switch_files_state ON audio_switch_files (run_id, state);

      -- Covers (stop 3): the books without embedded art, their Audiobookshelf item and the
      -- cover set through its API (stage5's store cover, else the old library's ABS cover).
      CREATE TABLE audio_covers_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        state         TEXT NOT NULL CHECK (state IN ('none', 'running', 'done')),
        progress_json TEXT NOT NULL CHECK (json_valid(progress_json)),
        pause_reason  TEXT,
        pause_detail  TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO audio_covers_state (id, state, progress_json, updated_at) VALUES (1, 'none', '{}', 0);
      CREATE TABLE audio_covers (
        run_id     TEXT NOT NULL,
        book_id    INTEGER NOT NULL,
        folder     TEXT NOT NULL,
        item_id    TEXT,
        source     TEXT NOT NULL CHECK (source IN ('url', 'file', 'none')),
        url        TEXT,
        file_rel   TEXT,
        state      TEXT NOT NULL CHECK (state IN
                     ('planned', 'set', 'failed', 'has_cover', 'no_item', 'no_source')),
        detail     TEXT,
        done_at    INTEGER,
        PRIMARY KEY (run_id, book_id)
      );
      CREATE INDEX audio_covers_state_idx ON audio_covers (run_id, state, book_id);
    `,
  },
  {
    version: 16,
    name: 'AI: indexes for the queries every step runs (the call pool)',
    // Timed on a copy at stop 2's end size (114,036 questions, 2.6 GB): the step's queries took
    // 475 ms of the server (the spending total scanned every row, the run's cost per model and
    // its items sorted, the "returned" questions scanned Haiku's 52,120 queued ones); with these
    // and the queued-rows query without a sort, 20 ms. The call pool steps several times a
    // second, so each step must stay this cheap.
    sql: `
      CREATE INDEX ai_requests_cost ON ai_requests (cost_usd) WHERE cost_usd IS NOT NULL;
      CREATE INDEX ai_requests_run_cost ON ai_requests (stage, run_id, model, item_key, cost_usd)
        WHERE cost_usd IS NOT NULL;
      CREATE INDEX ai_requests_run_items ON ai_requests (stage, run_id, item_key)
        WHERE cost_usd IS NOT NULL;
      CREATE INDEX ai_requests_returned ON ai_requests (run_id, stage, model, labeled)
        WHERE state = 'queued' AND mode = 'direct';
    `,
  },
  {
    version: 17,
    name: 'audiobook cleanup: stage 7, the daily new arrivals (WP21f-1)',
    // Stage 7 (src/cleanup/audio/stage7-arrivals.ts): once a day (or Run now) it runs stages 1-5
    // again and adds the recordings that are not in the library yet as new books in
    // media/audiobooks/japanese through the linking sidecar. The archives are unpacked into
    // torrents/audiobooks/japanese/_extracted/ first. ai_item_designs: the design (E/F/J) each
    // recording's values are decided with (the new arrivals: the setting, default J).
    sql: `
      INSERT INTO audio_stages (stage, updated_at) VALUES (7, 0);

      -- One row per run (daily or Run now): its phase, progress and report.
      CREATE TABLE audio_arrival_runs (
        id             INTEGER PRIMARY KEY,
        trigger        TEXT NOT NULL CHECK (trigger IN ('schedule', 'now')),
        mode           TEXT NOT NULL CHECK (mode IN ('analyse', 'on')),
        state          TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'stopped')),
        phase          TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        progress_json  TEXT NOT NULL CHECK (json_valid(progress_json)),
        report_json    TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
        error          TEXT
      );
      CREATE INDEX audio_arrival_runs_state ON audio_arrival_runs (state, id);

      -- What a run found for each recording that is not simply in the library already (those are
      -- only counted): new (planned or added), identical, duplicate, better copy, waiting, held,
      -- removed by hand.
      CREATE TABLE audio_arrivals (
        run_id       INTEGER NOT NULL REFERENCES audio_arrival_runs(id) ON DELETE CASCADE,
        unit_key     TEXT NOT NULL,
        name         TEXT NOT NULL,
        outcome      TEXT NOT NULL CHECK (outcome IN
                       ('new', 'identical', 'duplicate', 'better', 'waiting', 'held', 'removed')),
        reason       TEXT,
        folder       TEXT,
        design       TEXT,
        detail_json  TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
        PRIMARY KEY (run_id, unit_key)
      );
      CREATE INDEX audio_arrivals_outcome ON audio_arrivals (run_id, outcome, name);

      -- The books stage 7 plans (Preview) and builds (On); built rows are the manifest of what it
      -- added (with audio_arrival_ops). folder is relative to media/audiobooks.
      CREATE TABLE audio_arrival_books (
        id             INTEGER PRIMARY KEY,
        run_id         INTEGER NOT NULL,
        unit_key       TEXT NOT NULL,
        copy_key       TEXT NOT NULL,
        area           TEXT NOT NULL CHECK (area IN ('main', 'ai')),
        state          TEXT NOT NULL CHECK (state IN ('planned', 'built')),
        folder         TEXT NOT NULL,
        base_folder    TEXT NOT NULL,
        author         TEXT NOT NULL,
        series         TEXT,
        title          TEXT NOT NULL,
        notes_json     TEXT NOT NULL CHECK (json_valid(notes_json)),
        files          INTEGER NOT NULL,
        pdfs           INTEGER NOT NULL,
        metadata       BLOB NOT NULL,
        design         TEXT NOT NULL,
        abs_item_id    TEXT,
        abs_json       TEXT CHECK (abs_json IS NULL OR json_valid(abs_json)),
        built_at       INTEGER,
        UNIQUE (run_id, folder)
      );
      CREATE INDEX audio_arrival_books_state ON audio_arrival_books (state, run_id, id);
      CREATE INDEX audio_arrival_books_unit ON audio_arrival_books (unit_key);

      -- Every operation of a run's build (folder, link, pdf, metadata), as stage 6's.
      CREATE TABLE audio_arrival_ops (
        id           INTEGER PRIMARY KEY,
        run_id       INTEGER NOT NULL,
        book_id      INTEGER,
        kind         TEXT NOT NULL CHECK (kind IN ('folder', 'link', 'pdf', 'metadata')),
        dst          TEXT NOT NULL,
        book_folder  TEXT,
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
        result_json  TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        done_at      INTEGER
      );
      CREATE INDEX audio_arrival_ops_state ON audio_arrival_ops (run_id, state, id);
      CREATE INDEX audio_arrival_ops_batch ON audio_arrival_ops (batch_id);
      CREATE INDEX audio_arrival_ops_book ON audio_arrival_ops (book_id);
      CREATE INDEX audio_arrival_ops_done ON audio_arrival_ops (state, kind);

      -- Batches handed to the linking sidecar (ids from 2,000,000,000: never a build's or the
      -- switch's). kind archive: listing or unpacking archives.
      CREATE TABLE audio_arrival_batches (
        id           INTEGER PRIMARY KEY,
        run_id       INTEGER NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('build', 'list', 'extract')),
        state        TEXT NOT NULL CHECK (state IN ('claimed', 'reported', 'expired')),
        ops          INTEGER NOT NULL,
        claimed_at   INTEGER NOT NULL,
        lease_until  INTEGER NOT NULL,
        reported_at  INTEGER
      );
      INSERT INTO audio_arrival_batches (id, run_id, kind, state, ops, claimed_at, lease_until)
        VALUES (2000000000, 0, 'build', 'expired', 0, 0, 0);
      CREATE INDEX audio_arrival_batches_state ON audio_arrival_batches (state, id);

      -- The archives under the torrents (.zip/.rar/.7z) and what became of them. An archive is
      -- keyed by its path; a changed one (size, mtime or inode) is handled again.
      CREATE TABLE audio_archives (
        id            INTEGER PRIMARY KEY,
        rel           TEXT NOT NULL UNIQUE,
        raw           TEXT,
        size          INTEGER NOT NULL,
        mtime_ms      INTEGER NOT NULL,
        dev           INTEGER NOT NULL,
        ino           INTEGER NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('new', 'listed', 'extracted', 'failed',
                        'password', 'no_audio', 'not_archive', 'names')),
        detail        TEXT,
        encoding      TEXT,
        entries       INTEGER,
        audio_entries INTEGER,
        bytes         INTEGER,
        audio_bytes   INTEGER,
        listed_at     INTEGER,
        extracted_at  INTEGER,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX audio_archives_state ON audio_archives (state, id);

      -- An archive's entries (name: the path inside the archive as text, after the archive's
      -- name encoding; dst: relative to torrents/audiobooks/japanese, under _extracted/).
      CREATE TABLE audio_archive_entries (
        archive_id   INTEGER NOT NULL REFERENCES audio_archives(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('file', 'dir', 'link', 'other')),
        size         INTEGER NOT NULL,
        audio        INTEGER NOT NULL DEFAULT 0,
        skip         TEXT,
        dst          TEXT,
        state        TEXT NOT NULL DEFAULT 'planned'
                       CHECK (state IN ('planned', 'claimed', 'done', 'failed', 'skipped')),
        batch_id     INTEGER,
        result_json  TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        done_at      INTEGER,
        PRIMARY KEY (archive_id, seq)
      );
      CREATE INDEX audio_archive_entries_next ON audio_archive_entries (state, archive_id, seq);
      CREATE INDEX audio_archive_entries_batch ON audio_archive_entries (batch_id);

      -- Review items of stage 7 (better copies of books already in Audiobookshelf, archives
      -- that can't be unpacked, held arrivals, books Audiobookshelf doesn't show). review_key is
      -- stable across runs, so a choice survives; a choice is only recorded (WP21f-2 applies the
      -- better copies) except "Add anyway", which the next run applies.
      CREATE TABLE audio_arrival_reviews (
        id            INTEGER PRIMARY KEY,
        review_key    TEXT NOT NULL UNIQUE,
        kind          TEXT NOT NULL CHECK (kind IN ('better_copy', 'archive', 'held', 'abs_missing')),
        unit_key      TEXT,
        title         TEXT NOT NULL,
        detail_json   TEXT NOT NULL CHECK (json_valid(detail_json)),
        first_run_id  INTEGER NOT NULL,
        last_run_id   INTEGER NOT NULL,
        decision      TEXT,
        decided_at    INTEGER,
        resolved_at   INTEGER
      );
      CREATE INDEX audio_arrival_reviews_open ON audio_arrival_reviews (resolved_at, kind, id);
      CREATE INDEX audio_arrival_reviews_run ON audio_arrival_reviews (first_run_id);

      -- A run's walks of the torrents and the library before and after its build (gzip JSON of
      -- the entries: what its check compares), kept for the run's report.
      CREATE TABLE audio_arrival_walks (
        run_id   INTEGER NOT NULL,
        phase    TEXT NOT NULL CHECK (phase IN ('before', 'after')),
        root     TEXT NOT NULL CHECK (root IN ('torrents', 'library', 'generated')),
        entries  INTEGER NOT NULL,
        data     BLOB NOT NULL,
        PRIMARY KEY (run_id, phase, root)
      );

      -- The design (E, F or J) each item of a stage is decided with; none = E.
      CREATE TABLE ai_item_designs (
        stage     TEXT NOT NULL,
        item_key  TEXT NOT NULL,
        design    TEXT NOT NULL CHECK (design IN ('E', 'F', 'J')),
        set_at    INTEGER NOT NULL,
        PRIMARY KEY (stage, item_key)
      );
      CREATE INDEX ai_values_design ON ai_values (stage, design);
    `,
  },
  {
    version: 18,
    name: 'audiobook cleanup: stage 4, one store record per recording (WP21c follow-up (3))',
    // Two recordings that are not the same never both match one store record automatically.
    // Pairs stage 3 never compared are compared here with stage 3's windows (the fingerprints
    // themselves go into audio_fingerprints under stage 3's keys); keyed by the two openings'
    // contents, so nothing is read twice. A unit looked up again without a record keeps the
    // records it may not take in excluded_json (recomputed whenever stage 4 decides again).
    sql: `
      CREATE TABLE audio_online_pair_checks (
        pair_key     TEXT PRIMARY KEY,
        a_name       TEXT NOT NULL,
        b_name       TEXT NOT NULL,
        verdict      TEXT NOT NULL CHECK (verdict IN ('same', 'different', 'partly', 'unknown')),
        scores_json  TEXT NOT NULL CHECK (json_valid(scores_json)),
        made_at      INTEGER NOT NULL
      );
      ALTER TABLE audio_online_units ADD COLUMN excluded_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(excluded_json));
    `,
  },
  {
    version: 19,
    name: 'stage 5: the Google run workflow marks recorded before stage 5 removes them (WP20f)',
    // Stage 2 and stage 4 rules read the tag metadata-processed; stage 5 removes it from Calibre
    // (decided with the user 2026-11-21), so which books had each of the four Google-run marks
    // is recorded first and the rules read the record too. Filled once, never cleared.
    sql: `
      CREATE TABLE calibre_marks (
        library_id   TEXT NOT NULL,
        calibre_uuid TEXT NOT NULL,
        tag          TEXT NOT NULL,
        recorded_at  INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid, tag)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 20,
    name: 'audiobook cleanup: story order and changes to books in the library (WP21f-2)',
    // Which tags a health row holds (2: with track and disc); the files of multi-file books
    // checked before are checked again once, so their story order can use the track numbers.
    // The library ledger: one row per book now in media/audiobooks/japanese*, what was built
    // and last written there (folder, links, metadata.json); the changes stage 7 plans and
    // applies to them (field changes, a move, numbered link names), their sidecar operations
    // and batches (ids from 3,000,000,000), the reader links they remap, and the files the
    // reader wrote that get their original name under the torrents' AI/ or _merged/.
    sql: `
      ALTER TABLE audio_file_health ADD COLUMN tags_version INTEGER;

      CREATE TABLE audio_library_books (
        id           INTEGER PRIMARY KEY,
        folder       TEXT NOT NULL UNIQUE,
        base_folder  TEXT NOT NULL,
        area         TEXT NOT NULL CHECK (area IN ('main', 'ai')),
        origin_ref   TEXT NOT NULL UNIQUE,
        unit_key     TEXT,
        files_json   TEXT NOT NULL CHECK (json_valid(files_json)),
        metadata     BLOB NOT NULL,
        decided      BLOB NOT NULL,
        folder_ino   INTEGER,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE audio_library_changes (
        id                 INTEGER PRIMARY KEY,
        run_id             INTEGER NOT NULL,
        book_id            INTEGER NOT NULL REFERENCES audio_library_books(id),
        state              TEXT NOT NULL CHECK (state IN ('planned', 'applied', 'failed', 'skipped', 'review')),
        folder_from        TEXT NOT NULL,
        folder_to          TEXT,
        base_to            TEXT,
        fields_json        TEXT NOT NULL CHECK (json_valid(fields_json)),
        user_fields_json   TEXT NOT NULL CHECK (json_valid(user_fields_json)),
        conflicts_json     TEXT NOT NULL CHECK (json_valid(conflicts_json)),
        renames_json       TEXT NOT NULL CHECK (json_valid(renames_json)),
        renames_held       INTEGER NOT NULL DEFAULT 0,
        reviews_json       TEXT NOT NULL CHECK (json_valid(reviews_json)),
        skipped            TEXT,
        metadata_new       BLOB,
        decided_new        BLOB,
        metadata_sha_read  TEXT,
        abs_item_id        TEXT,
        abs_before_json    TEXT,
        abs_after_json     TEXT,
        created_at         INTEGER NOT NULL
      );
      CREATE INDEX audio_library_changes_run ON audio_library_changes (run_id, state);
      CREATE INDEX audio_library_changes_book ON audio_library_changes (book_id, run_id);

      CREATE TABLE audio_library_choices (
        book_id     INTEGER NOT NULL REFERENCES audio_library_books(id),
        field       TEXT NOT NULL,
        choice      TEXT NOT NULL,
        decided_at  INTEGER NOT NULL,
        PRIMARY KEY (book_id, field)
      );

      CREATE TABLE audio_library_ops (
        id           INTEGER PRIMARY KEY,
        run_id       INTEGER NOT NULL,
        change_id    INTEGER,
        seq          INTEGER NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('replace_metadata', 'move_book', 'rmdir', 'reader_link', 'rename_file')),
        book         TEXT,
        src_rel      TEXT,
        dst          TEXT NOT NULL,
        size         INTEGER,
        mtime_ms     INTEGER,
        dev          INTEGER,
        ino          INTEGER,
        bytes        BLOB,
        sha256       TEXT,
        state        TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'claimed', 'done', 'failed')),
        batch_id     INTEGER,
        preflight    TEXT,
        result_json  TEXT,
        done_at      INTEGER
      );
      CREATE INDEX audio_library_ops_run ON audio_library_ops (run_id, state, seq);
      CREATE INDEX audio_library_ops_batch ON audio_library_ops (batch_id);
      CREATE INDEX audio_library_ops_change ON audio_library_ops (change_id);

      CREATE TABLE audio_library_batches (
        id           INTEGER PRIMARY KEY,
        run_id       INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        state        TEXT NOT NULL,
        ops          INTEGER NOT NULL DEFAULT 0,
        claimed_at   INTEGER,
        lease_until  INTEGER
      );
      INSERT INTO audio_library_batches (id, run_id, kind, state) VALUES (3000000000, 0, 'seed', 'done');
      CREATE INDEX audio_library_batches_state ON audio_library_batches (state, lease_until);

      CREATE TABLE audio_library_links (
        id          INTEGER PRIMARY KEY,
        run_id      INTEGER NOT NULL,
        user_id     TEXT NOT NULL,
        book_id     TEXT NOT NULL,
        old_folder  TEXT NOT NULL,
        old_file    TEXT,
        new_folder  TEXT NOT NULL,
        new_file    TEXT,
        status      TEXT NOT NULL,
        playable_before INTEGER
      );
      CREATE INDEX audio_library_links_run ON audio_library_links (run_id);

      CREATE TABLE audio_library_reader_files (
        rel        TEXT PRIMARY KEY,
        size       INTEGER NOT NULL,
        mtime_ms   INTEGER NOT NULL,

        dev        INTEGER NOT NULL,
        ino        INTEGER NOT NULL,
        dst        TEXT NOT NULL,
        state      TEXT NOT NULL CHECK (state IN ('waiting', 'planned', 'linked', 'review')),
        note       TEXT,
        seen_at    INTEGER NOT NULL,
        linked_at  INTEGER
      );
      CREATE INDEX audio_library_reader_files_state ON audio_library_reader_files (state);
    `,
  },
  {
    version: 21,
    name: 'the shared AI layer: the keys, provider settings, model checks and batch tests moved to ttsu.db',
    // Book summaries session 1: what every AI feature shares is in ttsu.db (src/ai/). Runs only
    // after cleanup/ai-move.ts copied it there and checked it (AI_MOVE_VERSION below). The
    // questions, answers, batches and values stay here; the cleanup's own AI choices
    // (labeledOnly, arrivalsDesign, upgradeIncludeDecided) stay in its `ai` group. A batch's
    // provider data is deleted once collected (files_deleted_at).
    sql: `
      DELETE FROM secrets WHERE name IN ('anthropicApiKey', 'openaiApiKey');
      UPDATE settings SET value_json = json_remove(value_json, '$.spendLimitUsd', '$.modes',
        '$.batchStallMinutes', '$.connectAttemptMs', '$.batchTurnaroundMinutes', '$.directWorkers',
        '$.batchSize', '$.batchPollSeconds', '$.maxTokens', '$.requestTimeoutSeconds',
        '$.attempts', '$.batchPriceFactor', '$.prices', '$.structuredOutputs')
      WHERE key = 'ai';
      DROP TABLE ai_model_checks;
      DROP TABLE ai_batch_tests;
      ALTER TABLE ai_batches ADD COLUMN files_deleted_at INTEGER;
      CREATE INDEX ai_batches_files ON ai_batches (submitted_at)
        WHERE state <> 'submitted' AND files_deleted_at IS NULL;
    `,
  },
  {
    version: 22,
    name: 'audiobook library changes: what we wrote and when, what Audiobookshelf made of it, your fields',
    // Audiobook cleanup leftovers, item 6 (approved by the user 2026-11-21): a field whose
    // metadata.json value differs from what we wrote is yours only when no evidence says
    // Audiobookshelf changed it. Per ledger book: when we last wrote metadata.json (or changed
    // its folder or links) and in which run; the file just before that write; the file as
    // Audiobookshelf left it after its scan of that write (`seen`, proven by time: the file's
    // last change at the item's import or at a library scan we asked for). Fields once yours stay
    // yours (a later write never takes them back) until you choose the cleanup's value. A change
    // records the file it read, the fields where Audiobookshelf kept an older value (review) and
    // the fields to set through Audiobookshelf's edit call (your "Use the cleanup's" on those).
    sql: `
      ALTER TABLE audio_library_books ADD COLUMN written_at INTEGER;
      ALTER TABLE audio_library_books ADD COLUMN written_run INTEGER;
      ALTER TABLE audio_library_books ADD COLUMN before BLOB;
      ALTER TABLE audio_library_books ADD COLUMN seen BLOB;
      ALTER TABLE audio_library_books ADD COLUMN seen_at INTEGER;
      ALTER TABLE audio_library_books ADD COLUMN seen_state TEXT
        CHECK (seen_state IS NULL OR seen_state IN ('seen', 'unproven'));
      ALTER TABLE audio_library_books ADD COLUMN seen_detail TEXT;
      CREATE INDEX audio_library_books_seen ON audio_library_books (area, seen_state);

      CREATE TABLE audio_library_owners (
        book_id   INTEGER NOT NULL REFERENCES audio_library_books(id),
        field     TEXT NOT NULL,
        since     INTEGER NOT NULL,
        run_id    INTEGER,
        evidence  TEXT NOT NULL,
        PRIMARY KEY (book_id, field)
      );

      ALTER TABLE audio_library_changes ADD COLUMN metadata_read BLOB;
      ALTER TABLE audio_library_changes ADD COLUMN abs_kept_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(abs_kept_json));
      ALTER TABLE audio_library_changes ADD COLUMN abs_set_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(abs_set_json));
    `,
  },
  {
    version: 23,
    name: 'stage 4: the order of each series, and best guesses listed',
    // Series-order follow-up (plan approved 2026-11-22): the series step's choice per book of a
    // series (stage4/series-order.ts): its number, where the number came from, whether it is a
    // best guess and why, a title with its number, and a problem for review. Every book of a
    // series has a row (src 'calibre' for books stage 4 doesn't change), so the Best guesses
    // list shows each series whole, in order. The other fields' best guesses (the models' flagged
    // values) are listed through v13's ai_values_flagged.
    sql: `
      CREATE TABLE stage4_series_order (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        calibre_id    INTEGER NOT NULL,
        series        TEXT NOT NULL,
        series_key    TEXT NOT NULL,
        idx           REAL,
        src           TEXT NOT NULL,
        guess         INTEGER NOT NULL DEFAULT 0,
        reason        TEXT,
        title         TEXT,
        title_src     TEXT,
        review        TEXT,
        run_at        INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid)
      );
      CREATE INDEX stage4_series_order_series ON stage4_series_order (library_id, series_key, idx);
      CREATE INDEX stage4_series_order_flagged ON stage4_series_order (library_id, series_key)
        WHERE guess = 1 OR review IS NOT NULL;
    `,
  },
  {
    version: 24,
    name: 'the Calibre library new arrivals and the import from the torrents folders (WP20g)',
    // WP20g (plan approved 2026-11-22): books added by hand in Calibre and EPUBs imported from
    // source folders go through stages 1-5 with the cleanup's own rules (src/cleanup/arrivals/).
    //
    // calibre_arrivals_state  one row: the arrivals' mode (off / Preview / On), pause, schedule
    //                         and the baseline of books present before the first run.
    // calibre_arrival_pairs   a source folder -> library pair as first seen (a changed folder is
    //                         a new pair): its first run (every file checked, a Preview); runs
    //                         that start after it add when On (approved_at unused since v26).
    // calibre_arrival_runs    one row per run (schedule, Run now, books added by hand).
    // calibre_arrival_files   the catalog: one row per file version seen in a source folder (a
    //                         file whose size or mtime changes is a new row), each looked at once,
    //                         with its outcome and the book it was added as or duplicates.
    // calibre_arrival_archives / _entries  archives (and split sets) listed and unpacked under
    //                         <source folder>/_extracted/ by the linking sidecar.
    // calibre_known_books     every Calibre book the arrivals know (the baseline at the first
    //                         run, books added by the import, books added by hand, books Undo
    //                         brought back): a book not here is new.
    // calibre_arrival_books   the books of a run that go through stages 1-5 (the scope).
    // calibre_arrival_batches / _items  add batches for the apply sidecar (calibredb add) and
    //                         their Undo (export to the quarantine, then Calibre's trash).
    // calibre_arrival_reviews review items with a stable key (a better copy of a book with
    //                         reader data, an archive that can't be read, an add that failed).
    sql: `
      CREATE TABLE calibre_arrivals_state (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        mode                TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        pause_reason        TEXT,
        pause_detail        TEXT,
        paused_at           INTEGER,
        last_scheduled_day  TEXT,
        run_now             INTEGER NOT NULL DEFAULT 0,
        current_run         INTEGER,
        baseline_at         INTEGER,
        snapshot_seen       TEXT,
        hand_checked_at     INTEGER,
        updated_at          INTEGER NOT NULL
      );
      INSERT INTO calibre_arrivals_state (id, updated_at) VALUES (1, 0);

      CREATE TABLE calibre_arrival_pairs (
        pair_key      TEXT PRIMARY KEY,
        pair_id       TEXT NOT NULL,
        source        TEXT NOT NULL,
        library_id    TEXT NOT NULL,
        first_run_id  INTEGER,
        first_done_at INTEGER,
        approved_at   INTEGER,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE calibre_arrival_runs (
        id             INTEGER PRIMARY KEY,
        trigger        TEXT NOT NULL CHECK (trigger IN ('schedule', 'now', 'hand')),
        mode           TEXT NOT NULL CHECK (mode IN ('analyse', 'on')),
        state          TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'stopped')),
        phase          TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        progress_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        report_json    TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
        error          TEXT
      );
      CREATE INDEX calibre_arrival_runs_state ON calibre_arrival_runs (state, id);

      CREATE TABLE calibre_arrival_archives (
        id            INTEGER PRIMARY KEY,
        pair_key      TEXT NOT NULL,
        rel_path      TEXT NOT NULL,
        volumes_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(volumes_json)),
        size          INTEGER NOT NULL,
        mtime_ms      INTEGER NOT NULL,
        dev           INTEGER,
        ino           INTEGER,
        state         TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'waiting', 'listed',
                        'unpacked', 'no_books', 'password', 'not_archive', 'names', 'failed')),
        encoding      TEXT,
        detail        TEXT,
        books         INTEGER NOT NULL DEFAULT 0,
        listed_at     INTEGER,
        unpacked_at   INTEGER,
        updated_at    INTEGER NOT NULL,
        UNIQUE (pair_key, rel_path)
      );
      CREATE INDEX calibre_arrival_archives_state ON calibre_arrival_archives (state, id);

      CREATE TABLE calibre_arrival_archive_entries (
        archive_id  INTEGER NOT NULL REFERENCES calibre_arrival_archives(id),
        name        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        dst         TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('planned', 'done', 'skipped', 'failed')),
        detail      TEXT,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (archive_id, name)
      );
      CREATE INDEX calibre_arrival_archive_entries_state
        ON calibre_arrival_archive_entries (state, archive_id);

      CREATE TABLE calibre_arrival_files (
        id             INTEGER PRIMARY KEY,
        pair_key       TEXT NOT NULL,
        rel_path       TEXT NOT NULL,
        size           INTEGER NOT NULL,
        mtime_ms       INTEGER NOT NULL,
        dev            INTEGER,
        ino            INTEGER,
        first_seen_at  INTEGER NOT NULL,
        seen_at        INTEGER NOT NULL,
        gone_at        INTEGER,
        kind           TEXT NOT NULL CHECK (kind IN ('epub', 'book', 'archive', 'volume',
                         'partial', 'other')),
        format         TEXT,
        archive_id     INTEGER REFERENCES calibre_arrival_archives(id),
        sha256         TEXT,
        hashed_at      INTEGER,
        outcome        TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'waiting',
                         'downloading', 'new', 'added', 'identical', 'duplicate', 'better',
                         'better_review', 'not_imported', 'unreadable', 'too_long', 'skipped',
                         'removed_by_you', 'undone', 'failed')),
        detail         TEXT,
        calibre_id     INTEGER,
        calibre_uuid   TEXT,
        run_id         INTEGER,
        decided_at     INTEGER,
        facts_json     TEXT CHECK (facts_json IS NULL OR json_valid(facts_json)),
        UNIQUE (pair_key, rel_path, size, mtime_ms)
      );
      CREATE INDEX calibre_arrival_files_path ON calibre_arrival_files (pair_key, rel_path);
      CREATE INDEX calibre_arrival_files_outcome ON calibre_arrival_files (outcome, pair_key, id);
      CREATE INDEX calibre_arrival_files_sha ON calibre_arrival_files (sha256) WHERE sha256 IS NOT NULL;
      CREATE INDEX calibre_arrival_files_book ON calibre_arrival_files (calibre_uuid)
        WHERE calibre_uuid IS NOT NULL;
      CREATE INDEX calibre_arrival_files_run ON calibre_arrival_files (run_id, outcome);

      CREATE TABLE calibre_known_books (
        library_id   TEXT NOT NULL,
        calibre_id   INTEGER NOT NULL,
        calibre_uuid TEXT NOT NULL,
        origin       TEXT NOT NULL CHECK (origin IN ('baseline', 'import', 'hand', 'undo')),
        file_id      INTEGER,
        added_at     INTEGER NOT NULL,
        settled_at   INTEGER,
        run_id       INTEGER,
        gone_at      INTEGER,
        PRIMARY KEY (library_id, calibre_id)
      );
      CREATE INDEX calibre_known_books_uuid ON calibre_known_books (calibre_uuid);
      CREATE INDEX calibre_known_books_waiting ON calibre_known_books (library_id, origin, run_id);

      CREATE TABLE calibre_arrival_books (
        run_id        INTEGER NOT NULL REFERENCES calibre_arrival_runs(id),
        library_id    TEXT NOT NULL,
        calibre_id    INTEGER NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        origin        TEXT NOT NULL CHECK (origin IN ('import', 'hand')),
        file_id       INTEGER,
        state         TEXT NOT NULL DEFAULT 'open',
        detail        TEXT,
        PRIMARY KEY (run_id, calibre_id)
      );
      CREATE INDEX calibre_arrival_books_book ON calibre_arrival_books (library_id, calibre_uuid);

      CREATE TABLE calibre_arrival_batches (
        id                INTEGER PRIMARY KEY,
        run_id            INTEGER,
        library_id        TEXT NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('add', 'undo_add')),
        state             TEXT NOT NULL CHECK (state IN ('planned', 'claimed', 'done', 'failed',
                            'undone')),
        undo_of           INTEGER REFERENCES calibre_arrival_batches(id),
        item_count        INTEGER NOT NULL,
        lease_expires_at  INTEGER,
        attempts          INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        claimed_at        INTEGER,
        finished_at       INTEGER,
        error             TEXT,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX calibre_arrival_batches_state ON calibre_arrival_batches (state, id);

      CREATE TABLE calibre_arrival_batch_items (
        id              INTEGER PRIMARY KEY,
        batch_id        INTEGER NOT NULL REFERENCES calibre_arrival_batches(id),
        file_id         INTEGER NOT NULL REFERENCES calibre_arrival_files(id),
        position        INTEGER NOT NULL,
        state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'fetched',
                          'added', 'exported', 'removed', 'failed', 'skipped')),
        max_id_before   INTEGER,
        calibre_id      INTEGER,
        calibre_uuid    TEXT,
        quarantine_dir  TEXT,
        detail          TEXT,
        updated_at      INTEGER NOT NULL,
        UNIQUE (batch_id, file_id)
      );
      CREATE INDEX calibre_arrival_batch_items_file ON calibre_arrival_batch_items (file_id);

      CREATE TABLE calibre_arrival_reviews (
        id          INTEGER PRIMARY KEY,
        review_key  TEXT NOT NULL UNIQUE,
        kind        TEXT NOT NULL CHECK (kind IN ('better_copy', 'archive', 'add_failed',
                      'too_long')),
        file_id     INTEGER,
        calibre_id  INTEGER,
        calibre_uuid TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
        run_id      INTEGER,
        created_at  INTEGER NOT NULL,
        decision    TEXT,
        decided_at  INTEGER,
        applied_at  INTEGER
      );
      CREATE INDEX calibre_arrival_reviews_open ON calibre_arrival_reviews (decision, id);
    `,
  },
  {
    version: 25,
    name: "stage 4: author readings without NDL's notes",
    // The live Preview of 2026-11-22 found NDL's notes in written author_sort values ("アオキ,
    // クニコ, トウゲイカ", "ワタナベ, マサカズ, pub. 2013"). Stage 4 reads the stored answers again
    // (READINGS_VERSION) and keeps the reading as it was stored before in `noted`, so a value the
    // cleanup wrote with the notes is corrected at On.
    sql: `ALTER TABLE author_readings ADD COLUMN noted TEXT;`,
  },
  {
    version: 26,
    name: 'titles too long for a Calibre folder: fitted, and the list of shortened titles',
    // Decided with the user 2026-11-22: a title whose Calibre folder or file name would pass 255
    // bytes is cleaned, shortened or cut (title-fit.ts) instead of being held for review. Every
    // title change that was shortened or cut is listed (calibre_title_fits), filled from the
    // proposal's own evidence ($.fit) by triggers, so every stage's proposals land on the list;
    // a new arrival's add is listed by the run (arrival_file_id). Cleaned-only titles are not
    // listed. One-time: the holds that were automatic before are open again (stage 2's and 5's
    // proposals held for the name; the arrivals' files held as too long). Stage 4's held books
    // are decided again by stage 4's own one-time pass (TITLE_FIT_VERSION): its hold replaced
    // the class they had, so they are not simply made automatic here.
    sql: `
      CREATE TABLE calibre_title_fits (
        id              INTEGER PRIMARY KEY,
        change_id       INTEGER UNIQUE,
        arrival_file_id INTEGER UNIQUE,
        library_id      TEXT NOT NULL,
        calibre_id      INTEGER,
        calibre_uuid    TEXT,
        stage           INTEGER NOT NULL,
        original        TEXT NOT NULL,
        written         TEXT NOT NULL,
        step            TEXT NOT NULL CHECK (step IN ('shortened', 'cut')),
        rules_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rules_json)),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX calibre_title_fits_book ON calibre_title_fits (library_id, calibre_uuid);

      CREATE TRIGGER calibre_title_fits_insert AFTER INSERT ON proposed_changes
      WHEN NEW.field = 'title' AND json_extract(NEW.evidence_json, '$.fit.step') IN ('shortened', 'cut')
      BEGIN
        INSERT OR REPLACE INTO calibre_title_fits (change_id, library_id, calibre_id, calibre_uuid,
          stage, original, written, step, rules_json, created_at, updated_at)
        VALUES (NEW.id, NEW.library_id, NEW.calibre_id, NEW.calibre_uuid, NEW.stage,
          json_extract(NEW.evidence_json, '$.fit.from'), json_extract(NEW.new_json, '$'),
          json_extract(NEW.evidence_json, '$.fit.step'),
          COALESCE(json_extract(NEW.evidence_json, '$.fit.rules'), '[]'),
          NEW.created_at, NEW.updated_at);
      END;

      CREATE TRIGGER calibre_title_fits_update AFTER UPDATE OF new_json, evidence_json ON proposed_changes
      WHEN NEW.field = 'title'
      BEGIN
        DELETE FROM calibre_title_fits WHERE change_id = NEW.id
          AND COALESCE(json_extract(NEW.evidence_json, '$.fit.step'), '') NOT IN ('shortened', 'cut');
        INSERT OR REPLACE INTO calibre_title_fits (change_id, library_id, calibre_id, calibre_uuid,
          stage, original, written, step, rules_json, created_at, updated_at)
        SELECT NEW.id, NEW.library_id, NEW.calibre_id, NEW.calibre_uuid, NEW.stage,
          json_extract(NEW.evidence_json, '$.fit.from'), json_extract(NEW.new_json, '$'),
          json_extract(NEW.evidence_json, '$.fit.step'),
          COALESCE(json_extract(NEW.evidence_json, '$.fit.rules'), '[]'),
          NEW.created_at, NEW.updated_at
        WHERE json_extract(NEW.evidence_json, '$.fit.step') IN ('shortened', 'cut');
      END;

      CREATE TRIGGER calibre_title_fits_delete AFTER DELETE ON proposed_changes
      WHEN OLD.field = 'title'
      BEGIN
        DELETE FROM calibre_title_fits WHERE change_id = OLD.id;
      END;

      UPDATE proposed_changes SET class = 'auto', review_reason = NULL
      WHERE stage IN (2, 5) AND state = 'proposed' AND class = 'review' AND decided_by IS NULL
        AND review_reason LIKE 'Too long for a folder name%';

      UPDATE calibre_arrival_files SET outcome = 'pending', detail = NULL
      WHERE outcome = 'too_long' AND gone_at IS NULL;
      DELETE FROM calibre_arrival_reviews WHERE kind = 'too_long' AND decision IS NULL;
    `,
  },
  {
    version: 27,
    name: 'audiobooks stage 8: the second pass from the Calibre ebooks',
    // Stage 8 (src/cleanup/audio/stage8-ebooks.ts, WP21g): each audiobook recording (stage 5's
    // units; AI books, radio clips and drama CDs left out) paired with its exact Calibre volume by
    // cleaned title, author and printed volume. From the pair: genres and tags for ABS, a series
    // where the audiobook has none from a store, and (cleanup.db only) the ebook's author
    // readings, cover reference and description. Calibre is only read (the indexer's snapshot
    // copy); ABS is changed only through stage 7's library changes.
    sql: `
      INSERT INTO audio_stages (stage, updated_at) VALUES (8, 0);

      -- One row per recording (stage 5's unit key). class: auto (paired) | review | none
      -- (no Calibre book passes) | excluded (AI, radio, drama CD). calibre_id: the pair (auto),
      -- or the best candidate (review). audio_hash: the audiobook facts the pairing read (a change
      -- pairs it again); ebook_fp: the paired ebook's fingerprint when decided.
      CREATE TABLE audio_ebook_pairs (
        unit_key        TEXT PRIMARY KEY,
        library_id      TEXT,
        calibre_id      INTEGER,
        class           TEXT NOT NULL CHECK (class IN ('auto', 'review', 'none', 'excluded')),
        kind            TEXT NOT NULL,
        audio_title     TEXT NOT NULL,
        audio_authors   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(audio_authors)),
        reason          TEXT,
        checks_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checks_json)),
        candidates_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates_json)),
        audio_hash      TEXT NOT NULL,
        ebook_fp        TEXT,
        rules_version   INTEGER NOT NULL,
        first_review_run INTEGER,
        decided_at      INTEGER NOT NULL
      );
      CREATE INDEX audio_ebook_pairs_class ON audio_ebook_pairs (class, unit_key);
      CREATE INDEX audio_ebook_pairs_calibre ON audio_ebook_pairs (calibre_id);

      -- Your review choices, never overwritten by the stage. field 'pair': value = the Calibre
      -- id ("this ebook") or null ("no ebook"); a chosen ebook that is gone goes back to review.
      -- field 'series': value = "calibre" (use the ebook's series) or "none" (no series).
      CREATE TABLE audio_ebook_choices (
        unit_key    TEXT NOT NULL,
        field       TEXT NOT NULL CHECK (field IN ('pair', 'series')),
        value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
        chosen_at   INTEGER NOT NULL,
        PRIMARY KEY (unit_key, field)
      );

      -- The ebooks that are paired or a review candidate: what stage 8 read from Calibre. fp =
      -- sha1 of the fields used (a change is noticed even when last_modified is not updated).
      -- Readings, the description and the cover reference are kept here only (decided: ABS keeps
      -- the audiobook's own).
      CREATE TABLE audio_ebook_books (
        library_id      TEXT NOT NULL,
        calibre_id      INTEGER NOT NULL,
        uuid            TEXT,
        fp              TEXT NOT NULL,
        last_modified   TEXT,
        title           TEXT NOT NULL,
        authors_json    TEXT NOT NULL CHECK (json_valid(authors_json)),
        author_sort     TEXT,
        series          TEXT,
        series_index    REAL,
        terms_json      TEXT NOT NULL CHECK (json_valid(terms_json)),
        description     TEXT,
        cover_json      TEXT CHECK (cover_json IS NULL OR json_valid(cover_json)),
        read_at         INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_id)
      );

      -- The values a pair gives a recording (fields genres, tags, series), as the build and the
      -- library changes use them when stage 8 is On.
      CREATE TABLE audio_ebook_values (
        unit_key    TEXT NOT NULL,
        field       TEXT NOT NULL CHECK (field IN ('genres', 'tags', 'series')),
        value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
        calibre_id  INTEGER NOT NULL,
        decided_at  INTEGER NOT NULL,
        PRIMARY KEY (unit_key, field)
      );

      -- Every Calibre id seen with its last_modified (new and changed ebooks are found against
      -- it), and the snapshot it was read from.
      CREATE TABLE audio_ebook_known (
        library_id      TEXT NOT NULL,
        calibre_id      INTEGER NOT NULL,
        fp              TEXT NOT NULL,
        PRIMARY KEY (library_id, calibre_id)
      );

      -- The series stage 8 would give a recording, and why it doesn't (review: "series"; info:
      -- a store series that differs from Calibre's). kind: fill | review | disagree.
      CREATE TABLE audio_ebook_series (
        unit_key    TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('fill', 'review', 'disagree')),
        calibre_id  INTEGER NOT NULL,
        calibre_series TEXT NOT NULL,
        calibre_index  REAL,
        written_name   TEXT,
        reason      TEXT,
        current_json TEXT,
        decided_at  INTEGER NOT NULL
      );
      CREATE INDEX audio_ebook_series_kind ON audio_ebook_series (kind, unit_key);

      -- Stage 8's Preview: what the library changes would do with its values (books already in
      -- the library), from the last Preview run.
      CREATE TABLE audio_ebook_preview (
        book_id     INTEGER PRIMARY KEY,
        unit_key    TEXT,
        folder_from TEXT NOT NULL,
        folder_to   TEXT,
        fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
        reviews_json TEXT NOT NULL CHECK (json_valid(reviews_json)),
        run_id      INTEGER,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE audio_ebook_state (
        library_id      TEXT PRIMARY KEY,
        snapshot_mtime  REAL,
        snapshot_size   INTEGER,
        audio_key       TEXT,
        rules_version   INTEGER,
        updated_at      INTEGER NOT NULL
      );
    `,
  },
  {
    version: 28,
    name: 'new arrivals: a folder adds once its first run has finished (no "Add these")',
    // WP20g stop 2: the first look at books/japanese was marked done while every file still
    // waited to settle (an earlier build), and "Add these" is removed (user, 2026-11-23: On is
    // the go-ahead). A folder whose first run was marked done without an approval is not done:
    // its run marks it done when nothing in it waits, and runs that start after that add.
    sql: `UPDATE calibre_arrival_pairs SET first_done_at = NULL WHERE approved_at IS NULL;`,
  },
  {
    version: 29,
    name: 'the user’s edits from the reader: fields that are the user’s, changes seen in Calibre',
    // Calibre metadata editing (tier 3 item 2). Edits are field batches of their own stage (10)
    // in proposed_changes / batches / field_undo like the cleanup's. user_fields: every field
    // the user edited, confirmed, put back, or changed in Calibre's own program; no cleanup pass
    // changes it again. calibre_seen_changes: the history's "Changed in Calibre" entries (and
    // the books a case-only rename of a shared name changed with an edit). series_pair_decisions:
    // "Not the same series" (and merges) for the series editor's suggested pair.
    sql: `
      CREATE TABLE user_fields (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        field         TEXT NOT NULL,
        value_json    TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
        source        TEXT NOT NULL CHECK (source IN
                        ('edit', 'confirm', 'undo', 'calibre', 'carried', 'shared_rename')),
        since         INTEGER NOT NULL,
        change_id     INTEGER,
        PRIMARY KEY (library_id, calibre_uuid, field)
      ) WITHOUT ROWID;
      CREATE TABLE calibre_seen_changes (
        id              INTEGER PRIMARY KEY,
        library_id      TEXT NOT NULL,
        calibre_uuid    TEXT NOT NULL,
        calibre_id      INTEGER NOT NULL,
        field           TEXT NOT NULL,
        old_json        TEXT NOT NULL CHECK (json_valid(old_json)),
        new_json        TEXT NOT NULL CHECK (json_valid(new_json)),
        kind            TEXT NOT NULL CHECK (kind IN ('calibre', 'shared_rename', 'confirm')),
        cause_change_id INTEGER,
        cause_title     TEXT,
        seen_at         INTEGER NOT NULL
      );
      CREATE INDEX calibre_seen_changes_book ON calibre_seen_changes (library_id, calibre_uuid, field);
      CREATE TABLE series_pair_decisions (
        library_id  TEXT NOT NULL,
        name_a      TEXT NOT NULL,
        name_b      TEXT NOT NULL,
        decision    TEXT NOT NULL CHECK (decision IN ('different', 'merged')),
        decided_at  INTEGER NOT NULL,
        PRIMARY KEY (library_id, name_a, name_b)
      ) WITHOUT ROWID;
      CREATE INDEX undo_records_kept ON undo_records (library_id, kept_uuid);
      CREATE INDEX batches_open ON batches (state, stage, created_at);

      -- No cleanup pass proposes a field that is the user's: a proposal made for one is set
      -- aside at once (any stage, new arrivals included), and a field that becomes the user's
      -- sets aside the open proposals for it. A title write also writes the title sort and an
      -- author write the author sort, a series write its number: those count too. The batch
      -- planner and the sidecar's verify check again (stage2-batches.ts).
      CREATE TRIGGER proposed_changes_yours AFTER INSERT ON proposed_changes
      WHEN NEW.stage <> 10 AND NEW.state = 'proposed' AND EXISTS (
        SELECT 1 FROM user_fields u
        WHERE u.library_id = NEW.library_id AND u.calibre_uuid = NEW.calibre_uuid
          AND (u.field = NEW.field
            OR (NEW.field = 'title' AND u.field = 'sort')
            OR (NEW.field = 'authors' AND u.field = 'author_sort')
            OR (NEW.field = 'series' AND u.field = 'series_index')))
      BEGIN
        UPDATE proposed_changes SET state = 'skipped',
          review_reason = 'Yours: you edited or confirmed this field (the cleanup never changes it)'
        WHERE id = NEW.id;
      END;
      -- A field changed in Calibre's own program is set aside by the batch planner instead (it
      -- counts as "changed in Calibre since the analysis" there, so a mass change still pauses
      -- the stage: WP20 lessons 1).
      CREATE TRIGGER user_fields_yours AFTER INSERT ON user_fields
      WHEN NEW.source <> 'calibre'
      BEGIN
        UPDATE proposed_changes SET state = 'skipped',
          review_reason = 'Yours: you edited or confirmed this field (the cleanup never changes it)',
          updated_at = NEW.since
        WHERE library_id = NEW.library_id AND calibre_uuid = NEW.calibre_uuid
          AND stage <> 10 AND state = 'proposed'
          AND (field = NEW.field
            OR (field = 'title' AND NEW.field = 'sort')
            OR (field = 'authors' AND NEW.field = 'author_sort')
            OR (field = 'series' AND NEW.field = 'series_index'));
      END;
    `,
  },
  {
    version: 30,
    name: 'More Bookmeter coverage: the pass over the stored answers, its requests and spot check',
    // More Bookmeter coverage, step 2 (bookmeter-coverage.md; stage4/bookmeter-more.ts). One pass
    // with its own Off/Preview/On (the stages table holds stages 0-5 only). bookmeter_more_books:
    // the books without a match the chosen rules decided (matched: waits for its store list;
    // ready: can be proposed; near: waits for the AI check; second: waits for the second search).
    // bookmeter_more_waiters: the pass's own waiters on the fetch queue, made ready by the queue
    // like the audiobook cleanup's (stage 4's lookups take every ready row of fetch_waiters).
    // bookmeter_more_spot: the 50-book spot check before On and the user's verdicts.
    sql: `
      CREATE TABLE bookmeter_more_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        library_id    TEXT,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        paused_detail TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO bookmeter_more_state (id, updated_at) VALUES (1, 0);
      CREATE TABLE bookmeter_more_books (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        calibre_id    INTEGER NOT NULL,
        labeled       INTEGER NOT NULL DEFAULT 0,
        state         TEXT NOT NULL CHECK (state IN ('near', 'second', 'none', 'matched', 'ready')),
        source        TEXT CHECK (source IN ('rules', 'ai', 'second')),
        hit_json      TEXT CHECK (hit_json IS NULL OR json_valid(hit_json)),
        failed_check  TEXT,
        query_step    TEXT CHECK (query_step IN ('q1', 'q2', 'done')),
        stores_json   TEXT CHECK (stores_json IS NULL OR json_valid(stores_json)),
        stores_failed INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid)
      ) WITHOUT ROWID;
      CREATE INDEX bookmeter_more_books_state
        ON bookmeter_more_books (library_id, state, source, labeled);
      CREATE TABLE bookmeter_more_waiters (
        request_id    INTEGER NOT NULL,
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        step          TEXT NOT NULL CHECK (step IN ('q1', 'q2', 'stores')),
        ready         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (request_id, library_id, calibre_uuid, step)
      ) WITHOUT ROWID;
      CREATE INDEX bookmeter_more_waiters_ready ON bookmeter_more_waiters (ready, request_id) WHERE ready = 1;
      CREATE INDEX bookmeter_more_waiters_book ON bookmeter_more_waiters (library_id, calibre_uuid);
      CREATE INDEX bookmeter_more_waiters_step ON bookmeter_more_waiters (step, ready);
      CREATE TABLE bookmeter_more_spot (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        position      INTEGER NOT NULL,
        source        TEXT NOT NULL CHECK (source IN ('rules', 'ai', 'second')),
        verdict       TEXT CHECK (verdict IN ('right', 'wrong')),
        decided_at    INTEGER,
        PRIMARY KEY (library_id, calibre_uuid)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 31,
    name: 'series under a short and a full name: the pairs, their answers and who decided',
    // Tier 4, Part 3 (cleanup-finish.md; series-pairs/pass.ts). One pass with its own
    // Off/Preview/On. series_pairs: every pair of series names where one name's key starts the
    // other's, with its signals, the rules' answer and the books of both names (for the review
    // list). series_pair_decisions (v29, the series editor's) is the one record of a choice per
    // pair, shared with the editor: who decided it and why; "Forget my choice" deletes the row.
    sql: `
      CREATE TABLE series_pairs_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        library_id    TEXT,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO series_pairs_state (id, updated_at) VALUES (1, 0);
      CREATE TABLE series_pairs (
        id            INTEGER PRIMARY KEY,
        library_id    TEXT NOT NULL,
        run           INTEGER NOT NULL,
        short_name    TEXT NOT NULL,
        long_name     TEXT NOT NULL,
        grp           TEXT NOT NULL,
        added         TEXT NOT NULL,
        kept_name     TEXT NOT NULL,
        short_books   INTEGER NOT NULL,
        long_books    INTEGER NOT NULL,
        signals_json  TEXT CHECK (signals_json IS NULL OR json_valid(signals_json)),
        books_json    TEXT CHECK (books_json IS NULL OR json_valid(books_json)),
        answer        TEXT CHECK (answer IS NULL OR answer IN ('merge', 'separate', 'review')),
        rule          TEXT,
        held          TEXT,
        note          TEXT,
        updated_at    INTEGER NOT NULL,
        UNIQUE (library_id, short_name, long_name)
      );
      CREATE INDEX series_pairs_answer ON series_pairs (library_id, answer, id);
      -- The pass's own merge proposals (source 'series-pairs'): read per pair by the review list
      -- and per run by the card, never by scanning stage 4's rows.
      CREATE INDEX proposed_changes_series_pairs
        ON proposed_changes (library_id, analysis_id, state) WHERE source = 'series-pairs';
      ALTER TABLE series_pair_decisions ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'you';
      ALTER TABLE series_pair_decisions ADD COLUMN note TEXT;
    `,
  },
  {
    version: 32,
    name: 'new arrivals: the picture facts of each file, kept once read (the quality check)',
    // WP20g (2026-11-24): the measuring's quality check read every picture of a copy each time
    // the copy was in a pair (158,934 checks of 93,611 files left in the live run). One row per
    // file as read (path, size, mtime): the pictures, the cover's size and the writing
    // direction, never the parts that change without the file (your tags, the date added).
    // Read by primary key only (a rowid table: a book's row can be large).
    sql: `
      CREATE TABLE calibre_arrival_quality (
        file        TEXT PRIMARY KEY,
        size        INTEGER NOT NULL,
        mtime_ms    INTEGER NOT NULL,
        facts_json  TEXT NOT NULL CHECK (json_valid(facts_json)),
        made_at     INTEGER NOT NULL
      );
    `,
  },
  {
    version: 33,
    name: 'more direct links: the picks from the stored answers and their spot check',
    // More direct links (link-discovery.md; stage4/link-discovery.ts). One pass with its own
    // Off/Preview/On over stage 4's stored answers; it fetches nothing. link_discovery_picks:
    // one row per book and site the rules found an id for (how: the record stage 4 picked, or
    // a series neighbour's list), with the store's title as its evidence; state ok, or why it is
    // not proposed (clash: two books claim one id; differs: the two rules disagree; saved: the book
    // has saved_id and the series list names another, listed for the user and never changed).
    // link_discovery_spot: the links drawn for the spot check before On and the user's verdicts.
    sql: `
      CREATE TABLE link_discovery_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        library_id    TEXT,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        paused_detail TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO link_discovery_state (id, updated_at) VALUES (1, 0);
      CREATE TABLE link_discovery_picks (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        site          TEXT NOT NULL CHECK (site IN ('amazon', 'ranobedb', 'bookwalker')),
        calibre_id    INTEGER NOT NULL,
        labeled       INTEGER NOT NULL DEFAULT 0,
        store_id      TEXT NOT NULL,
        store_title   TEXT NOT NULL,
        how           TEXT NOT NULL CHECK (how IN ('record', 'series')),
        state         TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'clash', 'differs', 'saved')),
        saved_id      TEXT,
        proposed      INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid, site)
      ) WITHOUT ROWID;
      CREATE INDEX link_discovery_picks_counts
        ON link_discovery_picks (library_id, state, site, how, labeled);
      CREATE INDEX link_discovery_picks_id
        ON link_discovery_picks (library_id, site, store_id);
      CREATE TABLE link_discovery_spot (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        site          TEXT NOT NULL CHECK (site IN ('amazon', 'ranobedb', 'bookwalker')),
        position      INTEGER NOT NULL,
        how           TEXT NOT NULL CHECK (how IN ('record', 'series')),
        verdict       TEXT CHECK (verdict IN ('right', 'wrong')),
        decided_at    INTEGER,
        PRIMARY KEY (library_id, calibre_uuid, site)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 34,
    name: 'manga part A: moving books to another Calibre library (the move stage)',
    // manga-library.md, part A (2026-11-24). Every book tagged マンガ or 画像のみ moves from the
    // cleanup's library to manga-library: exported, added there with every field, checked, then
    // removed the usual way (quarantine plus Calibre's trash); the reader keeps the same book
    // (its Calibre source is re-bound to the new library). Batches are stage 11 (MOVE_STAGE);
    // a move batch also names its target library. calibre_moves maps every moved book's old
    // Calibre identity to its new one: the cleanup's own state follows the book through it, and
    // history keyed by the old identity is found through it. batch_items.move_json holds what the
    // sidecar checked when the copy arrived (its new id and UUID, the fields compared).
    sql: `
      ALTER TABLE batches ADD COLUMN target_library_id TEXT;
      ALTER TABLE batch_items ADD COLUMN move_json TEXT CHECK (move_json IS NULL OR json_valid(move_json));
      CREATE TABLE calibre_move_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        library_id    TEXT,
        target_id     TEXT,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        paused_detail TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO calibre_move_state (id, updated_at) VALUES (1, 0);
      CREATE TABLE calibre_moves (
        id               INTEGER PRIMARY KEY,
        change_id        INTEGER NOT NULL REFERENCES proposed_changes(id),
        batch_id         TEXT NOT NULL REFERENCES batches(id),
        from_library_id  TEXT NOT NULL,
        from_calibre_id  INTEGER NOT NULL,
        from_uuid        TEXT NOT NULL,
        to_library_id    TEXT NOT NULL,
        to_calibre_id    INTEGER NOT NULL,
        to_uuid          TEXT NOT NULL,
        source_row_id    TEXT,
        handoff_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(handoff_json)),
        rekey_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rekey_json)),
        fields_json      TEXT CHECK (fields_json IS NULL OR json_valid(fields_json)),
        state            TEXT NOT NULL CHECK (state IN ('moved', 'undone')),
        moved_at         INTEGER NOT NULL,
        undo_batch_id    TEXT,
        undone_at        INTEGER,
        back_calibre_id  INTEGER,
        back_uuid        TEXT,
        UNIQUE (batch_id, change_id)
      );
      CREATE INDEX calibre_moves_from ON calibre_moves (from_library_id, from_uuid);
      CREATE INDEX calibre_moves_to ON calibre_moves (to_library_id, to_uuid);
      CREATE INDEX calibre_moves_change ON calibre_moves (change_id);
      -- A book moved back by Undo is never moved again by itself (also when re-added: a new UUID).
      CREATE INDEX calibre_moves_back ON calibre_moves (from_library_id, back_uuid)
        WHERE back_uuid IS NOT NULL;
      -- The 30-book spot check before On (all marked, none wrong: the user, 2026-11-24).
      CREATE TABLE calibre_move_spot (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        change_id     INTEGER NOT NULL,
        position      INTEGER NOT NULL,
        tag           TEXT NOT NULL,
        verdict       TEXT CHECK (verdict IN ('right', 'wrong')),
        decided_at    INTEGER,
        PRIMARY KEY (library_id, calibre_uuid)
      ) WITHOUT ROWID;
      -- The move's own proposals (stage 11), read per run by the card and the planner.
      CREATE INDEX proposed_changes_move
        ON proposed_changes (library_id, analysis_id, state, class) WHERE stage = 11;
    `,
  },
  {
    version: 35,
    name: 'Bookmeter links: the saved ids checked against the listing readers log',
    // Bookmeter listings (bookmeter-listings.md; stage4/bookmeter-listing.ts, 2026-11-25). One
    // pass with its own Off/Preview/On over every saved bookmeter id: searched again with the
    // author field, the most registered listing that is the book picked. bookmeter_listing_books:
    // one row per book with a saved id (saved_id as Calibre held it when looked at), its state
    // (search: the new search is open; keep, change, adaptation, unseen, ai, nofacts, yours) and
    // the decision (both listings with their 登録 counts). bookmeter_listing_waiters: the pass's
    // own waiters on the fetch queue, made ready by the queue like More Bookmeter coverage's.
    // bookmeter_listing_spot: the 50 changes drawn for the spot check and the user's verdicts.
    sql: `
      CREATE TABLE bookmeter_listing_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        library_id    TEXT,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        paused_detail TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO bookmeter_listing_state (id, updated_at) VALUES (1, 0);
      CREATE TABLE bookmeter_listing_books (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        calibre_id    INTEGER NOT NULL,
        labeled       INTEGER NOT NULL DEFAULT 0,
        saved_id      TEXT NOT NULL,
        state         TEXT NOT NULL CHECK (state IN
                        ('search', 'keep', 'change', 'adaptation', 'unseen', 'ai', 'nofacts', 'yours')),
        decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
        proposed      INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid)
      ) WITHOUT ROWID;
      CREATE INDEX bookmeter_listing_books_state
        ON bookmeter_listing_books (library_id, state, calibre_uuid);
      CREATE TABLE bookmeter_listing_waiters (
        request_id    INTEGER NOT NULL,
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        ready         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (request_id, library_id, calibre_uuid)
      ) WITHOUT ROWID;
      CREATE INDEX bookmeter_listing_waiters_ready
        ON bookmeter_listing_waiters (ready, request_id) WHERE ready = 1;
      -- The open searches, counted for the card's bar every few seconds.
      CREATE INDEX bookmeter_listing_waiters_open
        ON bookmeter_listing_waiters (ready) WHERE ready = 0;
      CREATE INDEX bookmeter_listing_waiters_book
        ON bookmeter_listing_waiters (library_id, calibre_uuid);
      CREATE TABLE bookmeter_listing_spot (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        position      INTEGER NOT NULL,
        verdict       TEXT CHECK (verdict IN ('right', 'wrong')),
        decided_at    INTEGER,
        PRIMARY KEY (library_id, calibre_uuid)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 36,
    name: 'Bookmeter links: a book Bookmeter could not search is listed, never decided',
    // User, 2026-11-25: a refused search must never leave a book quietly with its wrong link.
    // Refused searches are asked again (the pass, BL_SEARCH_VERSION 2); a search Bookmeter
    // answers "not found" puts the book in the new state unsearched (listed on the card). SQLite
    // can't change a CHECK, so the table is made again with the same rows.
    sql: `
      CREATE TABLE bookmeter_listing_books_v36 (
        library_id    TEXT NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        calibre_id    INTEGER NOT NULL,
        labeled       INTEGER NOT NULL DEFAULT 0,
        saved_id      TEXT NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('search', 'keep', 'change', 'adaptation',
                        'unseen', 'unsearched', 'ai', 'nofacts', 'yours')),
        decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
        proposed      INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (library_id, calibre_uuid)
      ) WITHOUT ROWID;
      INSERT INTO bookmeter_listing_books_v36 SELECT library_id, calibre_uuid, calibre_id, labeled,
        saved_id, state, decision_json, proposed, updated_at FROM bookmeter_listing_books;
      DROP TABLE bookmeter_listing_books;
      ALTER TABLE bookmeter_listing_books_v36 RENAME TO bookmeter_listing_books;
      CREATE INDEX bookmeter_listing_books_state
        ON bookmeter_listing_books (library_id, state, calibre_uuid);
    `,
  },
  {
    version: LIBRARY_SCOPE_VERSION,
    name: 'Manga part B: every stage, pass and import run belongs to one Calibre library',
    // manga-library.md part B (approved 2026-11-25). The state that was one row per stage (or
    // id = 1) becomes one row per reader library; today's rows go to the primary library (the
    // cleanup's library until now), whose id the server puts in _cleanup_primary before this runs
    // (migrateCleanup). Without it (a tool, a test), the library of the newest stage 1-5 batch, the
    // move's source or any proposal's. A database with none of those has nothing to carry: its
    // rows are made per library when first needed.
    sql: `
      CREATE TEMP TABLE IF NOT EXISTS _cleanup_primary (library_id TEXT);
      CREATE TEMP TABLE _v37_primary AS SELECT COALESCE(
        (SELECT library_id FROM _cleanup_primary WHERE library_id IS NOT NULL LIMIT 1),
        (SELECT library_id FROM batches WHERE stage BETWEEN 1 AND 5
           ORDER BY created_at DESC LIMIT 1),
        (SELECT library_id FROM calibre_move_state WHERE id = 1),
        (SELECT library_id FROM proposed_changes WHERE stage BETWEEN 1 AND 5 LIMIT 1)
      ) AS id;

      CREATE TABLE stages_v37 (
        stage          INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 5),
        library_id     TEXT NOT NULL,
        mode           TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        state          TEXT NOT NULL DEFAULT 'idle',
        pause_reason   TEXT,
        pause_detail   TEXT,
        paused_at      INTEGER,
        progress_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        precision_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(precision_json)),
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (stage, library_id)
      );
      INSERT INTO stages_v37 (stage, library_id, mode, state, pause_reason, pause_detail,
          paused_at, progress_json, precision_json, updated_at)
        SELECT s.stage, p.id, s.mode, s.state, s.pause_reason, s.pause_detail, s.paused_at,
          s.progress_json, s.precision_json, s.updated_at
        FROM stages s, _v37_primary p WHERE p.id IS NOT NULL;
      DROP TABLE stages;
      ALTER TABLE stages_v37 RENAME TO stages;

      -- library_id '' = every library: a gate's pause (one gate per stage across the libraries).
      CREATE TABLE stage_field_pauses_v37 (
        stage      INTEGER NOT NULL,
        library_id TEXT NOT NULL,
        field      TEXT NOT NULL,
        reason     TEXT NOT NULL,
        detail     TEXT,
        paused_at  INTEGER NOT NULL,
        PRIMARY KEY (stage, library_id, field)
      );
      INSERT INTO stage_field_pauses_v37 (stage, library_id, field, reason, detail, paused_at)
        SELECT f.stage, CASE WHEN f.reason IN ('gate', 'no_labels') THEN '' ELSE p.id END,
          f.field, f.reason, f.detail, f.paused_at
        FROM stage_field_pauses f, _v37_primary p
        WHERE p.id IS NOT NULL OR f.reason IN ('gate', 'no_labels');
      DROP TABLE stage_field_pauses;
      ALTER TABLE stage_field_pauses_v37 RENAME TO stage_field_pauses;

      -- '' = a check about the content server, the sidecar or the settings (all libraries).
      CREATE TABLE preflight_v37 (
        name        TEXT NOT NULL,
        library_id  TEXT NOT NULL DEFAULT '',
        ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
        detail      TEXT,
        source      TEXT NOT NULL CHECK (source IN ('sidecar', 'server')),
        checked_at  INTEGER NOT NULL,
        PRIMARY KEY (name, library_id)
      );
      INSERT INTO preflight_v37 (name, library_id, ok, detail, source, checked_at)
        SELECT name, '', ok, detail, source, checked_at FROM preflight;
      DROP TABLE preflight;
      ALTER TABLE preflight_v37 RENAME TO preflight;

      CREATE TABLE bookmeter_more_state_v37 (
        library_id    TEXT PRIMARY KEY,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        paused_detail TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO bookmeter_more_state_v37
        SELECT COALESCE(s.library_id, p.id), s.mode, s.progress_json, s.paused_reason,
          s.paused_detail, s.updated_at
        FROM bookmeter_more_state s, _v37_primary p WHERE COALESCE(s.library_id, p.id) IS NOT NULL;
      DROP TABLE bookmeter_more_state;
      ALTER TABLE bookmeter_more_state_v37 RENAME TO bookmeter_more_state;

      CREATE TABLE series_pairs_state_v37 (
        library_id    TEXT PRIMARY KEY,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO series_pairs_state_v37
        SELECT COALESCE(s.library_id, p.id), s.mode, s.progress_json, s.paused_reason, s.updated_at
        FROM series_pairs_state s, _v37_primary p WHERE COALESCE(s.library_id, p.id) IS NOT NULL;
      DROP TABLE series_pairs_state;
      ALTER TABLE series_pairs_state_v37 RENAME TO series_pairs_state;

      CREATE TABLE link_discovery_state_v37 (
        library_id    TEXT PRIMARY KEY,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        paused_detail TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO link_discovery_state_v37
        SELECT COALESCE(s.library_id, p.id), s.mode, s.progress_json, s.paused_reason,
          s.paused_detail, s.updated_at
        FROM link_discovery_state s, _v37_primary p WHERE COALESCE(s.library_id, p.id) IS NOT NULL;
      DROP TABLE link_discovery_state;
      ALTER TABLE link_discovery_state_v37 RENAME TO link_discovery_state;

      CREATE TABLE bookmeter_listing_state_v37 (
        library_id    TEXT PRIMARY KEY,
        mode          TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
        paused_reason TEXT,
        paused_detail TEXT,
        updated_at    INTEGER NOT NULL
      );
      INSERT INTO bookmeter_listing_state_v37
        SELECT COALESCE(s.library_id, p.id), s.mode, s.progress_json, s.paused_reason,
          s.paused_detail, s.updated_at
        FROM bookmeter_listing_state s, _v37_primary p
        WHERE COALESCE(s.library_id, p.id) IS NOT NULL;
      DROP TABLE bookmeter_listing_state;
      ALTER TABLE bookmeter_listing_state_v37 RENAME TO bookmeter_listing_state;

      CREATE TABLE calibre_arrivals_state_v37 (
        library_id          TEXT PRIMARY KEY,
        mode                TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'analyse', 'on')),
        pause_reason        TEXT,
        pause_detail        TEXT,
        paused_at           INTEGER,
        last_scheduled_day  TEXT,
        run_now             INTEGER NOT NULL DEFAULT 0,
        current_run         INTEGER,
        baseline_at         INTEGER,
        snapshot_seen       TEXT,
        hand_checked_at     INTEGER,
        updated_at          INTEGER NOT NULL
      );
      INSERT INTO calibre_arrivals_state_v37
        SELECT p.id, s.mode, s.pause_reason, s.pause_detail, s.paused_at, s.last_scheduled_day,
          s.run_now, s.current_run, s.baseline_at, s.snapshot_seen, s.hand_checked_at, s.updated_at
        FROM calibre_arrivals_state s, _v37_primary p WHERE p.id IS NOT NULL;
      DROP TABLE calibre_arrivals_state;
      ALTER TABLE calibre_arrivals_state_v37 RENAME TO calibre_arrivals_state;

      ALTER TABLE calibre_arrival_runs ADD COLUMN library_id TEXT;
      UPDATE calibre_arrival_runs SET library_id = COALESCE(json_extract(progress_json, '$.libraryId'),
        (SELECT id FROM _v37_primary));
      CREATE INDEX calibre_arrival_runs_library ON calibre_arrival_runs (library_id, id);

      -- The library of the Calibre book a file names (added as, identical or duplicate of, better
      -- than). Until now always its pair's library.
      ALTER TABLE calibre_arrival_files ADD COLUMN calibre_library_id TEXT;
      UPDATE calibre_arrival_files SET calibre_library_id =
          (SELECT p.library_id FROM calibre_arrival_pairs p WHERE p.pair_key = calibre_arrival_files.pair_key)
        WHERE calibre_id IS NOT NULL;
      ALTER TABLE calibre_arrival_batch_items ADD COLUMN calibre_library_id TEXT;
      UPDATE calibre_arrival_batch_items SET calibre_library_id =
          (SELECT b.library_id FROM calibre_arrival_batches b WHERE b.id = calibre_arrival_batch_items.batch_id)
        WHERE calibre_id IS NOT NULL;
      ALTER TABLE calibre_arrival_reviews ADD COLUMN calibre_library_id TEXT;
      UPDATE calibre_arrival_reviews SET calibre_library_id = COALESCE(
          (SELECT f.calibre_library_id FROM calibre_arrival_files f WHERE f.id = calibre_arrival_reviews.file_id),
          (SELECT id FROM _v37_primary))
        WHERE calibre_id IS NOT NULL;

      CREATE TABLE calibre_arrival_books_v37 (
        run_id        INTEGER NOT NULL REFERENCES calibre_arrival_runs(id),
        library_id    TEXT NOT NULL,
        calibre_id    INTEGER NOT NULL,
        calibre_uuid  TEXT NOT NULL,
        origin        TEXT NOT NULL CHECK (origin IN ('import', 'hand')),
        file_id       INTEGER,
        state         TEXT NOT NULL DEFAULT 'open',
        detail        TEXT,
        PRIMARY KEY (run_id, library_id, calibre_id)
      );
      INSERT INTO calibre_arrival_books_v37 SELECT run_id, library_id, calibre_id, calibre_uuid,
        origin, file_id, state, detail FROM calibre_arrival_books;
      DROP TABLE calibre_arrival_books;
      ALTER TABLE calibre_arrival_books_v37 RENAME TO calibre_arrival_books;
      CREATE INDEX calibre_arrival_books_book ON calibre_arrival_books (library_id, calibre_uuid);

      -- origin 'move': a book a move brought into this library (never taken for one added by hand).
      CREATE TABLE calibre_known_books_v37 (
        library_id   TEXT NOT NULL,
        calibre_id   INTEGER NOT NULL,
        calibre_uuid TEXT NOT NULL,
        origin       TEXT NOT NULL CHECK (origin IN ('baseline', 'import', 'hand', 'undo', 'move')),
        file_id      INTEGER,
        added_at     INTEGER NOT NULL,
        settled_at   INTEGER,
        run_id       INTEGER,
        gone_at      INTEGER,
        PRIMARY KEY (library_id, calibre_id)
      );
      INSERT INTO calibre_known_books_v37 SELECT library_id, calibre_id, calibre_uuid, origin,
        file_id, added_at, settled_at, run_id, gone_at FROM calibre_known_books;
      DROP TABLE calibre_known_books;
      ALTER TABLE calibre_known_books_v37 RENAME TO calibre_known_books;
      CREATE INDEX calibre_known_books_uuid ON calibre_known_books (calibre_uuid);
      CREATE INDEX calibre_known_books_waiting ON calibre_known_books (library_id, origin, run_id);

      DROP TABLE _v37_primary;
    `,
  },
];

export const CLEANUP_SCHEMA_VERSION = CLEANUP_MIGRATIONS[CLEANUP_MIGRATIONS.length - 1].version;

/** The migration that removes what the one-time AI move carried to ttsu.db. */
export const AI_MOVE_VERSION = 21;

/**
 * The primary library before migration LIBRARY_SCOPE_VERSION: the reader library the cleanup's
 * settings chose (targetLibraryId), else the one in the folder japanese-library, as
 * CleanupService.targetLibrary() found it. Null when ttsu.db has neither.
 */
export function primaryLibraryOf(
  cleanup: Database.Database,
  main: Database.Database,
): string | null {
  try {
    const row = cleanup
      .prepare("SELECT value_json FROM settings WHERE key = 'targetLibraryId'")
      .get() as { value_json: string } | undefined;
    const chosen = row ? (JSON.parse(row.value_json) as unknown) : null;
    if (typeof chosen === 'string' && chosen) {
      const ok = main.prepare('SELECT id FROM libraries WHERE id = ?').get(chosen);
      if (ok) return chosen;
    }
    const lib = main.prepare("SELECT id FROM libraries WHERE folder = 'japanese-library'").get() as
      | { id: string }
      | undefined;
    return lib?.id ?? null;
  } catch {
    return null;
  }
}

export function cleanupSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export interface CleanupMigrateOptions {
  /**
   * Runs just before migration AI_MOVE_VERSION: the one-time move of the shared AI data to
   * ttsu.db (cleanup/ai-move.ts). Throwing stops the migration (cleanup.db stays as it was).
   * Without it, a cleanup.db that still has AI data is refused (nothing may be dropped unmoved).
   */
  beforeAiMove?: (db: Database.Database) => void;
  /**
   * The primary library's reader id (the cleanup's one library before manga part B), asked just
   * before migration LIBRARY_SCOPE_VERSION, which gives it today's stage and pass rows. Null or
   * absent: the migration finds it from the database itself (the newest stage 1-5 batch).
   */
  primaryLibrary?: (db: Database.Database) => string | null;
}

export function migrateCleanup(db: Database.Database, opts: CleanupMigrateOptions = {}): number {
  const current = cleanupSchemaVersion(db);
  if (current > CLEANUP_SCHEMA_VERSION) {
    throw new Error(
      `cleanup.db schema version ${current} is newer than this server supports (${CLEANUP_SCHEMA_VERSION}). ` +
        'Refusing to run an older server against a newer cleanup database.',
    );
  }
  for (const migration of CLEANUP_MIGRATIONS) {
    if (migration.version <= current) continue;
    if (migration.version === AI_MOVE_VERSION) {
      if (opts.beforeAiMove) opts.beforeAiMove(db);
      else if (hasAiData(db))
        throw new Error(
          'cleanup.db still holds the AI keys and spending: the server must move them to ttsu.db first',
        );
    }
    db.transaction(() => {
      if (migration.version === LIBRARY_SCOPE_VERSION) {
        db.exec('CREATE TEMP TABLE IF NOT EXISTS _cleanup_primary (library_id TEXT)');
        db.exec('DELETE FROM _cleanup_primary');
        const primary = opts.primaryLibrary?.(db) ?? null;
        if (primary) db.prepare('INSERT INTO _cleanup_primary VALUES (?)').run(primary);
      }
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
    console.log(`cleanup.db: applied migration ${migration.version} (${migration.name})`);
  }
  return cleanupSchemaVersion(db);
}

export function openCleanupDatabase(
  file: string,
  opts: CleanupMigrateOptions = {},
): Database.Database {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    migrateCleanup(db, opts);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export type CleanupDbState =
  | { ok: true; db: Database.Database; file: string; schemaVersion: number }
  | { ok: false; error: string };

/**
 * Never throws: without cleanup.db only the cleanup routes are off. `mainDb` (ttsu.db): the
 * one-time move of the shared AI data runs before cleanup.db's v21 (cleanup/ai-move.ts); if it
 * fails, cleanup.db stays at v20 and the cleanup is off until the next start.
 */
export function initCleanupDatabase(
  dbDir: string,
  opts: { mainDb?: Database.Database; log?: (m: string) => void } = {},
): CleanupDbState {
  try {
    if (!existsSync(dbDir) || !statSync(dbDir).isDirectory()) {
      return { ok: false, error: `DB_DIR does not exist: ${dbDir}` };
    }
    const file = cleanupDbPath(dbDir);
    const mainDb = opts.mainDb;
    const db = openCleanupDatabase(
      file,
      mainDb
        ? {
            beforeAiMove: (c) => void moveAiToShared(c, mainDb, dbDir, { log: opts.log }),
            primaryLibrary: (c) => primaryLibraryOf(c, mainDb),
          }
        : {},
    );
    return { ok: true, db, file, schemaVersion: cleanupSchemaVersion(db) };
  } catch (err) {
    return { ok: false, error: `could not open cleanup.db: ${(err as Error).message}` };
  }
}
