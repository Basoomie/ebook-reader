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
  {
    version: 2,
    name: "the accuracy test: a mark on one setup's version of a claim",
    sql: `
      -- Overrides the group's mark for this one version (null: the group's mark counts).
      ALTER TABLE test_claims ADD COLUMN mark TEXT CHECK (mark IS NULL OR mark IN ('right', 'wrong', 'unsure'));
    `,
  },
  {
    version: 3,
    name: 'the accuracy test: marks on whole summary items',
    sql: `
      -- The user judges each setup's summary item by item (decided 2026-11-22: split-up claims
      -- lost their context and were too many). not_needed = vague, filler or unimportant.
      CREATE TABLE test_item_marks (
        run_id     TEXT NOT NULL REFERENCES test_runs(id),
        ref        TEXT NOT NULL,
        mark       TEXT NOT NULL CHECK (mark IN ('right', 'mistake', 'not_needed', 'unsure')),
        marked_at  INTEGER NOT NULL,
        PRIMARY KEY (run_id, ref)
      );
    `,
  },
  {
    version: 4,
    name: 'the accuracy test: notes on one summary, editable',
    sql: `
      -- The user's notes are feedback on one setup's summary (mistakes, what it misses, what
      -- should go); null = on the book.
      ALTER TABLE test_missing ADD COLUMN run_id TEXT REFERENCES test_runs(id);
      ALTER TABLE test_missing ADD COLUMN edited_at INTEGER;
    `,
  },
  {
    version: 5,
    name: 'the accuracy test: notes on one tab of a summary',
    sql: `
      -- The summary's tab the note was written under (overview, chapters, characters, ...).
      ALTER TABLE test_missing ADD COLUMN section TEXT;
    `,
  },
  {
    version: 6,
    name: 'the accuracy test: marks copied from the same item in another summary',
    sql: `
      -- An item that says the same as one the user already judged in another summary of the
      -- book takes that mark (matched by hand, 2026-11-22). The row goes when the user marks the
      -- item themself, so a copied mark is always told apart from the user's own.
      CREATE TABLE test_item_copies (
        run_id     TEXT NOT NULL REFERENCES test_runs(id),
        ref        TEXT NOT NULL,
        from_run   TEXT NOT NULL REFERENCES test_runs(id),
        from_ref   TEXT NOT NULL,
        copied_at  INTEGER NOT NULL,
        PRIMARY KEY (run_id, ref)
      );
    `,
  },
  {
    version: 7,
    name: "the accuracy test: Claude's check of each item against the book, and tab grades",
    sql: `
      -- Decided with the user 2026-11-22: Claude checks every item's facts against the book;
      -- the user reads only what Claude flags, plus spot checks of what Claude found right
      -- (spot = 1), and grades each tab of each summary against the others.
      CREATE TABLE test_item_checks (
        run_id      TEXT NOT NULL REFERENCES test_runs(id),
        ref         TEXT NOT NULL,
        verdict     TEXT NOT NULL CHECK (verdict IN ('right', 'mistake', 'not_needed', 'unsure')),
        reason      TEXT,
        spot        INTEGER NOT NULL DEFAULT 0,
        checked_at  INTEGER NOT NULL,
        PRIMARY KEY (run_id, ref)
      );
      CREATE TABLE test_tab_grades (
        run_id     TEXT NOT NULL REFERENCES test_runs(id),
        section    TEXT NOT NULL,
        grade      TEXT NOT NULL CHECK (grade IN ('best', 'good', 'weak')),
        graded_at  INTEGER NOT NULL,
        PRIMARY KEY (run_id, section)
      );
    `,
  },
  {
    version: 8,
    name: 'summaries on the server (session 3): versions, items, translations, jobs, books, settings',
    sql: `
      -- One row per version of a book's summary; one current per book (book-summaries.md
      -- "Add, replace, edit, versions"). Earlier versions stay on the server only.
      CREATE TABLE summaries (
        id                   INTEGER PRIMARY KEY,
        book_id              TEXT NOT NULL,
        state                TEXT NOT NULL CHECK (state IN ('current', 'earlier')),
        origin               TEXT NOT NULL CHECK (origin IN ('ai', 'user', 'import')),
        -- The setup that made it ("mixed", "two", "opus", or the models' own label); null when
        -- written by the user.
        setup                TEXT,
        models_json          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(models_json)),
        background           INTEGER NOT NULL DEFAULT 0,
        lang                 TEXT NOT NULL,
        book_title           TEXT NOT NULL,
        also_mentioned_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(also_mentioned_json)),
        made_at              INTEGER NOT NULL,
        created_at           INTEGER NOT NULL,
        replaced_at          INTEGER,
        edited_at            INTEGER,
        job_id               INTEGER,
        report_json          TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
        note                 TEXT
      );
      CREATE UNIQUE INDEX summaries_current ON summaries (book_id) WHERE state = 'current';
      CREATE INDEX summaries_book ON summaries (book_id, created_at);

      -- A summary's items (book-summaries.md "Summaries on the server"): the overview is one item.
      CREATE TABLE summary_items (
        id                 INTEGER PRIMARY KEY,
        summary_id         INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        section            TEXT NOT NULL CHECK (section IN
                             ('overview', 'chapters', 'characters', 'relationships', 'terms', 'threads')),
        ord                REAL NOT NULL,
        chapter            INTEGER,
        chapter_title      TEXT,
        ref                TEXT NOT NULL,
        heading            TEXT,
        between_json       TEXT CHECK (between_json IS NULL OR json_valid(between_json)),
        ruby_json          TEXT CHECK (ruby_json IS NULL OR json_valid(ruby_json)),
        between_ruby_json  TEXT CHECK (between_ruby_json IS NULL OR json_valid(between_ruby_json)),
        text               TEXT NOT NULL,
        cites_json         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cites_json)),
        quote              TEXT,
        position           INTEGER,
        show_quote         INTEGER NOT NULL DEFAULT 0,
        -- Changed or added by the user: never overwritten by an automatic run.
        edited_by_user     INTEGER NOT NULL DEFAULT 0,
        added_by_user      INTEGER NOT NULL DEFAULT 0,
        edited_at          INTEGER,
        UNIQUE (summary_id, ref)
      );
      CREATE INDEX summary_items_order ON summary_items (summary_id, section, ord);

      -- Translations item by item (quotes stay in the book's language). source_digest: the
      -- original item it was made from, so after an edit only changed items are translated again.
      CREATE TABLE summary_translations (
        summary_id     INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        lang           TEXT NOT NULL,
        ref            TEXT NOT NULL,
        heading        TEXT,
        between_json   TEXT CHECK (between_json IS NULL OR json_valid(between_json)),
        text           TEXT NOT NULL,
        source_digest  TEXT NOT NULL,
        model          TEXT,
        made_at        INTEGER NOT NULL,
        PRIMARY KEY (summary_id, lang, ref)
      );

      -- The languages a book's summary was asked for (made again for a new version).
      CREATE TABLE summary_book_languages (
        book_id   TEXT NOT NULL,
        lang      TEXT NOT NULL,
        added_at  INTEGER NOT NULL,
        PRIMARY KEY (book_id, lang)
      );

      -- Jobs: making a summary (automatic on a first completion, or Regenerate) along the route
      -- of setups, or translating one. step = the route's setup being tried.
      CREATE TABLE summary_jobs (
        id             INTEGER PRIMARY KEY,
        book_id        TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK (kind IN ('auto', 'regenerate', 'translate')),
        lang           TEXT,
        summary_id     INTEGER,
        state          TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'no_text', 'cancelled')),
        route_json     TEXT CHECK (route_json IS NULL OR json_valid(route_json)),
        step           INTEGER NOT NULL DEFAULT 0,
        attempts_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attempts_json)),
        generation     INTEGER NOT NULL DEFAULT 0,
        wait_text      TEXT,
        error          TEXT,
        cost_usd       REAL,
        created_at     INTEGER NOT NULL,
        started_at     INTEGER,
        ended_at       INTEGER
      );
      CREATE INDEX summary_jobs_open ON summary_jobs (state, id) WHERE state IN ('queued', 'running');
      CREATE INDEX summary_jobs_book ON summary_jobs (book_id, id);

      -- Per book: the first completion as the summaries saw it (an automatic summary is made
      -- only once, on the first: book-summaries.md "When a summary is made"), the regenerate
      -- generation, and the note shown when every setup failed or the book has no text.
      CREATE TABLE summary_books (
        book_id           TEXT PRIMARY KEY,
        first_completion  TEXT CHECK (first_completion IS NULL OR first_completion IN
                            ('baseline', 'auto', 'skipped', 'had_summary', 'no_text')),
        completed_at      INTEGER,
        generation        INTEGER NOT NULL DEFAULT 0,
        outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('made', 'failed', 'no_text')),
        note              TEXT,
        note_at           INTEGER
      );

      CREATE TABLE summary_settings (
        key         TEXT PRIMARY KEY,
        value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE summary_state (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
    `,
  },
  {
    version: 9,
    name: 'book summaries session 4: a short label per relationship (for the diagram lines)',
    sql: `
      -- One or two words naming a relationship (師弟, 敵対), shown on the diagram's lines; null
      -- for summaries written before it (labelled once by \`cli summaries label\`) and for
      -- relationships the user adds without one (the diagram shows a number).
      ALTER TABLE summary_items ADD COLUMN label TEXT;
      ALTER TABLE summary_translations ADD COLUMN label TEXT;
    `,
  },
  {
    version: 10,
    name: 'book summaries session 4b: book descriptions translated like summaries',
    sql: `
      -- One translation per book and language, of the description as it was (source_digest:
      -- sha1 of books.description then). A description that changed is translated again the
      -- next time that language is chosen; the old translation is never shown for new text.
      CREATE TABLE description_translations (
        book_id          TEXT NOT NULL,
        lang             TEXT NOT NULL,
        source_digest    TEXT NOT NULL,
        paragraphs_json  TEXT CHECK (paragraphs_json IS NULL OR json_valid(paragraphs_json)),
        state            TEXT NOT NULL CHECK (state IN ('queued', 'done', 'failed')),
        model            TEXT,
        error            TEXT,
        cost_usd         REAL,
        requested_at     INTEGER NOT NULL,
        made_at          INTEGER,
        PRIMARY KEY (book_id, lang)
      );
      CREATE INDEX description_translations_queued ON description_translations (state)
        WHERE state = 'queued';
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
