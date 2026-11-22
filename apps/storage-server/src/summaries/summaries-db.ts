/**
 * summaries.db (book summaries, session 2): the summaries feature's own database, beside
 * ttsu.db in DB_DIR, as the shared AI layer asks of every feature (its questions and answers in
 * its own database; the keys, provider settings and spending in ttsu.db). Created only when the
 * feature is used.
 *
 * Session 2 (the accuracy test) adds the test's tables (`test_*`): its books, runs, finished
 * summaries, the claims judged on the judging page and the user's marks. Session 3 adds the
 * real storage beside them.
 *
 * Migrations work like ttsu.db's: applied in order, tracked with PRAGMA user_version, never
 * edited once shipped; a newer file is refused.
 */
import Database from 'better-sqlite3';
import path from 'path';

export const SUMMARIES_DB_FILENAME = 'summaries.db';

export function summariesDbPath(dbDir: string): string {
  return path.join(dbDir, SUMMARIES_DB_FILENAME);
}

export const SUMMARIES_MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'the AI queue (the shared layer runner) and the accuracy test (session 2)',
    sql: `
      -- The shared AI layer's queue (src/ai/runner.ts), the same shape as cleanup.db's.
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
      CREATE INDEX ai_requests_cost ON ai_requests (cost_usd) WHERE cost_usd IS NOT NULL;
      CREATE INDEX ai_requests_run_cost ON ai_requests (stage, run_id, model, item_key, cost_usd)
        WHERE cost_usd IS NOT NULL;
      CREATE INDEX ai_requests_run_items ON ai_requests (stage, run_id, item_key)
        WHERE cost_usd IS NOT NULL;
      CREATE INDEX ai_requests_returned ON ai_requests (run_id, stage, model, labeled)
        WHERE state = 'queued' AND mode = 'direct';
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
        ended_at         INTEGER,
        files_deleted_at INTEGER
      );
      CREATE INDEX ai_batches_state ON ai_batches (state, provider);
      CREATE INDEX ai_batches_files ON ai_batches (submitted_at)
        WHERE state <> 'submitted' AND files_deleted_at IS NULL;

      -- The local model's answers (llama-server on the PC): the same rule as ai_requests, one
      -- answer per item, model, prompt version and evidence, never asked again.
      CREATE TABLE local_answers (
        stage            TEXT NOT NULL,
        item_key         TEXT NOT NULL,
        model            TEXT NOT NULL,
        prompt_version   TEXT NOT NULL,
        evidence_hash    TEXT NOT NULL,
        state            TEXT NOT NULL CHECK (state IN ('answered', 'invalid')),
        answer_json      TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
        raw_text         TEXT,
        prompt_tokens    INTEGER,
        output_tokens    INTEGER,
        ms               INTEGER NOT NULL,
        answered_at      INTEGER NOT NULL,
        PRIMARY KEY (stage, item_key, model, prompt_version, evidence_hash)
      );

      -- The accuracy test: its books (copies, read-only), one row per test book.
      CREATE TABLE test_books (
        key          TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        file         TEXT NOT NULL,
        series       TEXT,
        volume       REAL,
        characters   INTEGER NOT NULL,
        reader_id    TEXT,
        added_at     INTEGER NOT NULL
      );

      -- One summary run: a book with a setup, with or without earlier volumes as background.
      -- metrics_json: cost, times, quotes dropped, items cross-checked, refusals.
      CREATE TABLE test_runs (
        id            TEXT PRIMARY KEY,
        book_key      TEXT NOT NULL REFERENCES test_books(key),
        setup         TEXT NOT NULL,
        background    INTEGER NOT NULL DEFAULT 0,
        round         TEXT NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('running', 'done', 'refused', 'failed')),
        phase         TEXT,
        error         TEXT,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER,
        metrics_json  TEXT CHECK (metrics_json IS NULL OR json_valid(metrics_json))
      );
      CREATE INDEX test_runs_book ON test_runs (book_key);

      -- A finished summary (and its translations), as the app would show it.
      CREATE TABLE test_summaries (
        run_id        TEXT NOT NULL REFERENCES test_runs(id),
        lang          TEXT NOT NULL,
        summary_json  TEXT NOT NULL CHECK (json_valid(summary_json)),
        made_at       INTEGER NOT NULL,
        PRIMARY KEY (run_id, lang)
      );

      -- The judging page: each run's single claims, grouped across runs of a book (the same
      -- claim written differently is one group; the model groups, the user corrects).
      CREATE TABLE test_groups (
        id         INTEGER PRIMARY KEY,
        book_key   TEXT NOT NULL REFERENCES test_books(key),
        scope      TEXT NOT NULL,
        text       TEXT NOT NULL,
        made_by    TEXT NOT NULL CHECK (made_by IN ('model', 'user'))
      );
      CREATE INDEX test_groups_book ON test_groups (book_key, scope);
      CREATE TABLE test_claims (
        id          INTEGER PRIMARY KEY,
        run_id      TEXT NOT NULL REFERENCES test_runs(id),
        ref         TEXT NOT NULL,
        text        TEXT NOT NULL,
        section     TEXT NOT NULL,
        quote       TEXT,
        position    INTEGER,
        group_id    INTEGER REFERENCES test_groups(id),
        UNIQUE (run_id, ref)
      );
      CREATE INDEX test_claims_group ON test_claims (group_id);
      CREATE TABLE test_marks (
        group_id   INTEGER PRIMARY KEY REFERENCES test_groups(id),
        mark       TEXT NOT NULL CHECK (mark IN ('right', 'wrong', 'unsure')),
        note       TEXT,
        marked_at  INTEGER NOT NULL
      );
      -- Small test settings (e.g. which setup's summaries are the earlier volumes' background).
      CREATE TABLE test_state (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
      CREATE TABLE test_missing (
        id        INTEGER PRIMARY KEY,
        book_key  TEXT NOT NULL REFERENCES test_books(key),
        scope     TEXT NOT NULL,
        text      TEXT NOT NULL,
        added_at  INTEGER NOT NULL
      );
    `,
  },
];

export const SUMMARIES_SCHEMA_VERSION =
  SUMMARIES_MIGRATIONS[SUMMARIES_MIGRATIONS.length - 1].version;

export function migrateSummaries(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > SUMMARIES_SCHEMA_VERSION)
    throw new Error(
      `summaries.db is schema ${current}, newer than this server (${SUMMARIES_SCHEMA_VERSION})`,
    );
  for (const m of SUMMARIES_MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

export function openSummariesDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrateSummaries(db);
  return db;
}
