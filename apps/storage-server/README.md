# ttsu Storage Server

Self-hosted REST storage backend for [ttsu Ebook Reader](https://github.com/ttu-ttu/ebook-reader).

Its API (`/api/v1/...`, design doc section 4.4) is backed by a SQLite database: health, per-user tokens and `/me` (WP1), the Calibre catalog with cover thumbnails (WP2), record sync (WP4) and the later work packages below.

The old sync's file endpoints (`/list`, `/file`, `/audio-file`, `/mkdir`, `/rmdir`) were removed in WP15e; those addresses now answer 404. The old sync's files in `DATA_DIR` are left as they are (the migration still reads them, read-only).

## API v1

| Method | Path                                                                          | Auth           | Description                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/v1/health`                                                              | none           | `{ ok, version, schemaVersion }`; 503 when the database is unavailable. Used by the Docker healthcheck.                                                                     |
| `GET`  | `/api/v1/me`                                                                  | per-user token | `{ user: {id, name}, token: {id, label, deviceId} }`                                                                                                                        |
| `GET`  | `/api/v1/libraries`                                                           | per-user token | `{ indexer: {enabled, error}, libraries: [...] }`: every discovered library with its settings and index state.                                                              |
| `GET`  | `/api/v1/books?q=&library=&by=&group=&none=1&limit=&cursor=&includeMissing=1` | per-user token | `{ books, nextCursor }`: books of enabled libraries, newest added first. `q`: the library search (below). `by=series                                                        | author         | tag&group=<name>`lists one group (a series in series order;`by=series&none=1`= "No series").`limit`1-200 (default 50). Missing books only with`includeMissing=1`. 400 `invalid_query`(with`start`/`end`of the problem), 422`regex_timeout`.                                                                  |
| `GET`  | `/api/v1/groups?by=series                                                     | author         | tag&q=&library=&limit=&cursor=`                                                                                                                                             | per-user token | `{ groups, nextCursor }`: one card per series, author or tag with a book matching `q`, newest book first, "No series" (`name: null`) last. Each has `bookCount` and `chars {total, counted, pending, failed}` for the whole group; series have `cover` and `bookIds`, the others up to four collage `tiles`. |
| `GET`  | `/api/v1/books/:id`                                                           | per-user token | One book with `description` (Calibre's comments, raw HTML: sanitize before display) and `sources`.                                                                          |
| `GET`  | `/api/v1/books/:id/thumbnail`                                                 | per-user token | Cover thumbnail (WebP). Use the `thumbnail` URL from the book list: its `?v=` makes it cacheable forever. 404 `no_cover` / `cover_unreadable`; 503 when the indexer is off. |

- Record sync (`/api/v1/devices/*`, `/api/v1/sync`): see [Record sync](#record-sync).
- Auth: `Authorization: Bearer ttsu_...` (a per-user token, see below). The old sync's `AUTH_TOKEN` is never accepted.
- Errors: `{ "error": { "code": "...", "message": "..." } }`.
- Library search (WP7a): plain text matches the title, an author or the series; `author:` `series:` `tag:` (substring; `=` exact; `,` = any of), `chars:<N` / `>=N` / `N-M` (books without a count never match), `status:unread,reading,completed,dropped`, `favorite:yes|no` (the caller's own book state), `on:device` (the books stored on the device whose token asks, from its `device-books` record; WP15e), `/regex/` and `/regex/i` (JavaScript, Unicode), `-` to leave a term out. The parser is the web app's (`vendor/library-query.cjs`, rebuilt with `pnpm build:server-query` in apps/web). Searches with a pattern run in a worker thread that is stopped after `SEARCH_REGEX_TIMEOUT_SECONDS`.
- Uploads (WP7b): `POST /api/v1/uploads?library=<id>&name=<file>` with the EPUB as the body stages it and answers `{ uploadId, title, authors, series, duplicates: [{ match: same-file|fingerprint|title-author, book }] }`; `POST /api/v1/uploads/<uploadId>/add` adds it as its own book (`source: "upload"` in book lists), `DELETE /api/v1/uploads/<uploadId>` discards it. Nothing is merged automatically. Files live in `DATA_DIR/.uploads/` (created by the first upload; `books/<bookId>/book.epub`, `staging/`), never near the Calibre libraries. Uploads are on when the Calibre indexer is; `GET /api/v1/libraries` reports `uploads: { enabled, maxBytes }`. `cli uploads list` lists them.
- If the database can't be opened, the server still starts and every `/api/v1` route answers 503.

### Per-user tokens

Tokens are created with the CLI inside the container. A token is shown once; only its SHA-256 hash is stored. One token per device makes it easy to revoke one.

```sh
docker exec ttsu-storage node dist/cli.js token create "Phone"
docker exec ttsu-storage node dist/cli.js token list
docker exec ttsu-storage node dist/cli.js token revoke <token-id>
```

The database starts with a single user, `owner`.

## Database

- File: `$DB_DIR/ttsu.db` (SQLite, WAL mode). Schema version is `PRAGMA user_version`; migrations run at startup.
- `DB_DIR` must exist and must not be inside `DATA_DIR`. The server refuses to use it otherwise.
- **Nightly snapshot**: at `SNAPSHOT_TIME` (container local time, set `TZ`), a consistent copy is written to `$DB_DIR/snapshots/ttsu-YYYYMMDD-HHMMSSZ.db` (timestamp in UTC) using SQLite's online backup API and checked with `quick_check`. The newest `SNAPSHOT_KEEP` are kept; other files in that folder are never touched. If the newest snapshot is older than 24 hours at startup (the container was down), one is taken right away.
- **Restore**: stop the container, copy a snapshot over `ttsu.db` (delete `ttsu.db-wal` and `ttsu.db-shm` if present), start the container, then run `docker exec ttsu-storage node dist/cli.js sync new-epoch`. The new epoch makes every device re-send the records it has, so changes made after the snapshot come back from the devices.
- **Rolling back the server** to a build older than the database schema: the older server refuses the newer database, so restore a snapshot taken before the upgrade (schema 4 is WP4).

## Record sync

User data (WP4 onwards) syncs per record, not per file. Every record has a `kind`, an `id`, the device that last wrote it, `updatedAt`, `deletedAt` (deletion marker) and a server-assigned `rev`. The server decides which version wins:

| Policy   | Rule                                                                        | Kinds (WP4)                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lww`    | Higher `(updatedAt, deviceId)` wins. A newer edit revives a deleted record. | `device` (name), `setting` `global:<key>`                                                                                                                                                                                                      |
| `owner`  | Only the device named in the id may write it; no conflicts possible.        | `position` `<bookId>:<deviceId>`, `setting` `device:<id>:<key>`, `stat-session` `<bookId>:<deviceId>:<uuid>` (sealed once `closed`), `device-books` `<deviceId>` (`{ bookIds }`: the books stored on that device, for "On this device"; WP15e) |
| `append` | Written once; later writes to the id change nothing.                        | (none)                                                                                                                                                                                                                                         |

`updatedAt` more than `SYNC_MAX_CLOCK_SKEW_SECONDS` ahead of the server clock is set to the server time.

Kinds listed in `SYNC_FROZEN_KINDS` (default `stat-day`, WP12) are refused when a device pushes them (`<kind>_frozen`); the server's own writes, such as the WP5 migration import, are not affected. `SYNC_FROZEN_KINDS=none` lifts it.

| Method | Path                          | Description                                                                                                                                                                           |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/devices/register`    | `{ deviceId? }` binds the calling token to a device (the id is kept across re-pairing). 409 `token_bound_to_other_device` if the token has another.                                   |
| `GET`  | `/api/v1/devices`             | `{ devices: [{id, name, createdAt, lastSeenAt, current}] }`                                                                                                                           |
| `POST` | `/api/v1/sync`                | `{ changes: [{kind, id, updatedAt, deletedAt?, data}] }` (at most 500) → one result per change: `applied`, `duplicate`, `stale` (with the server copy), `rejected` (with the reason). |
| `GET`  | `/api/v1/sync?cursor=&limit=` | `{ records, cursor, more, serverTime }`: everything changed after the cursor, deletion markers included. 409 `cursor_reset` after a restore.                                          |

`/sync` needs a registered device (409 `device_not_registered`).

```sh
docker exec ttsu-storage node dist/cli.js sync status                 # counts per kind, devices, last seen
docker exec ttsu-storage node dist/cli.js sync dump --kind position --book <id>
docker exec ttsu-storage node dist/cli.js sync new-epoch              # after restoring a snapshot
```

## Calibre indexer

The server indexes the Calibre libraries into its own database (design doc 4.1). Calibre is **read-only** to this server:

- The libraries root is mounted read-only (`CALIBRE_DIR`, compose: `read_only: true`). The indexer refuses to run if the mount is writable.
- The live `metadata.db` is only ever read as the source of a snapshot copy (SQLite online backup API) into `$CACHE_DIR/calibre/`. Everything is read from the copy.
- Metadata (titles, authors, series, tags, ...) comes only from `metadata.db`, never from file or folder names. Only books with an EPUB are indexed.
- Books removed from Calibre are flagged missing, never deleted (user data stays attached). They come back if Calibre gets them back with the same UUID.

**Libraries.** Every folder directly under `CALIBRE_DIR` that holds a `metadata.db` (or `CALIBRE_DIR` itself) is a library. Nothing deeper is scanned. A new library is **off until you set its language**; the language is never guessed:

```sh
docker exec ttsu-storage node dist/cli.js library list
docker exec ttsu-storage node dist/cli.js library set <id> --language ja --name "Japanese" --enable
docker exec ttsu-storage node dist/cli.js index status
```

A library is identified by Calibre's library UUID, so renaming its folder keeps its books and IDs: enable the renamed folder once and the old record moves over. Two folders holding the same Calibre library (for example a copy) are refused.

**Change detection.** Every `CALIBRE_POLL_SECONDS`, the server `stat`s each enabled library's `metadata.db`. When it changed, has not changed for `CALIBRE_SETTLE_SECONDS` and Calibre has no journal file next to it, the server snapshots and re-indexes it (unchanged books are skipped). A copy is thrown away and retried on the next poll if `metadata.db` changed while it was copied.

**Thumbnails.** Made from each book's `cover.jpg`: fit inside 320x480, WebP quality 75 (about 15 KB each), stored in `$CACHE_DIR/thumbs/`. A background pass makes them newest first, one at a time and at most `THUMB_PER_SECOND`; a thumbnail requested before the pass reaches it is made on the spot. They are remade when Calibre changes the cover.

**Character counts.** A background pass counts each EPUB's characters with the reader's own import and counting code, so library counts match in-book progress (design R1). The code is a bundle of the web app's loader, `vendor/epub-count.cjs`, generated by `pnpm build:server-counter` in `apps/web`. A web test fails when the committed bundle is out of date.

- Newest books first, one at a time by default, in a separate counter process at lower priority (`COUNT_NICE`). A crash or a stuck book never affects the server; the process is replaced and the book is recorded as failed.
- Counted with the reader's default import settings (`COUNT_IMPORT_FIX_MODE` Off, `COUNT_RESTRICT_FIX_TO_ANCHOR` true). Devices that import with other settings can show a different in-book total. The library count is for browsing only; the reader always uses its own count.
- A book is counted again when Calibre replaces its EPUB (Calibre bumps `last_modified` and the stored size; verified with Calibre 7.1), when the counting rules change (`epub-count-version` in the bundle header) or when the import settings change.
- A book that fails (`bad_epub`, `file_missing`, `read_error`, `timeout`, `crashed`) is tried again only when its EPUB changes or on `counts retry`. If `COUNT_MAX_CONSECUTIVE_FAILURES` books in a row time out or crash, or the counter can't start, the pass pauses until the next poll and the server logs why once.
- The API returns `charCount` and `charCountStatus` (`counted`, `pending`, `error`) per book and `counts` per library. While a changed EPUB waits for its new count, the old count stays with status `pending`.

**HDD load.** Discovery and polling are a few `stat`s. A changed `metadata.db` is read once, sequentially. The first thumbnail pass reads every cover once (about 55 GB for 60k books); after that only changed covers are read. The first count pass reads each EPUB's ZIP directory and text entries, never its images (a few percent of a typical illustrated EPUB); after that only replaced EPUBs are read. No EPUB is hashed or walked.

**CLI** (writes only to the database; the server acts on its next poll):

| Command                                                                    | Description                                                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `library list`                                                             | Discovered libraries with id, folder, name, language, enabled, available                                                            |
| `library set <id> [--name <n>] [--language <tag>] [--enable \| --disable]` | Language is a BCP 47 tag (`ja`, `en`, `en-GB`); `--enable` needs one                                                                |
| `index status`                                                             | State, counts and the last error or warning per library                                                                             |
| `index run [<id>] [--allow-mass-missing]`                                  | Re-snapshot and re-index now. `--allow-mass-missing` lets one run flag more than `CALIBRE_MAX_MISSING_PERCENT` of a library missing |
| `thumbs rebuild (--book <id> \| --library <id> \| --all)`                  | Make thumbnails again in the background                                                                                             |
| `counts status`                                                            | Character counts per library (counted, pending, failed), the spec and counter build, and the latest failures                        |
| `counts rebuild (--book <id> \| --library <id> \| --all)`                  | Count again in the background (old counts are shown until then)                                                                     |
| `counts retry`                                                             | Count the books that failed again                                                                                                   |

**Cache.** Everything in `CACHE_DIR` can be rebuilt (delete it with the container stopped; the next start re-snapshots and remakes the thumbnails), so it can be left out of backups.

## Audiobooks (WP15)

Audiobooks are **linked and streamed, never copied**. Existing files in the audiobooks folder are never changed:

- The audiobooks root is `AUDIOBOOKS_DIR`. The scanner refuses to run if it overlaps `DATA_DIR`, `DB_DIR`, `CACHE_DIR` or `CALIBRE_DIR`. `src/audio/audio-fs.ts` reads it.
- Since WP15f the mount may be writable, for **new files only**, and only through `src/audio/audio-write.ts` (a test fails if any other audio module writes). It never overwrites, renames or deletes a file it did not create, and writes only: a merged `.m4b` directly inside an indexed audiobook folder, and (for later work packages) files under `<subtitle folder>/_generated/` and `<audio folder>-generated/` (e.g. `japanese-srt/_generated/`, `japanese-generated/`). A file is written under a hidden `.ttsu-write-*.partial` name, recorded in the database first, and gets its final name with a hard link only when complete; an interrupted write is removed at the next start. New files get `AUDIOBOOKS_FILE_UID`/`GID`/`MODE`. A read-only mount still links and streams; only merging is off.
- Each library gets an audiobook folder and a subtitle folder inside that root with the CLI (unset = none):

```sh
docker exec ttsu-storage node dist/cli.js library set <id> --audio-dir japanese --subtitle-dir japanese-srt
docker exec ttsu-storage node dist/cli.js audio status
```

**Index.** At start, every `AUDIO_SCAN_HOURS` and on request, the server walks each library's audiobook folder and records every folder that directly holds `.m4b`, `.m4a` or `.mp3` files: that folder is what a book links to (series are folders of volume folders). `_Archives` and dot folders are skipped; Audiobookshelf's `metadata.json` (series and number) is read when present. The subtitle folder is walked for `.srt`, `.vtt` and `.ass` files; archives are only counted. Durations come from the file headers (a few KB per file). A folder that disappears is marked missing, never deleted; a scan that suddenly finds nothing (an unmounted share) is an error and marks nothing.

**One file, or a merge (WP15f).** A book links to a folder that holds one audio file, or to one file chosen in a folder of several (`PUT /books/:id/audio-link` with `audio.fileName`); only a link to one file plays. `GET /audio/folders/:id` says `looksLikeCopies` when the files are long and almost the same length (duplicate copies rather than parts; `AUDIO_COPY_HINT_*`). "Merge into one file" (`POST /books/:id/audio-merge {folderId, files}`, files in the user's order; `GET` the book's latest merge; `POST /audio/merges/:id/cancel`) runs one merge at a time: ffprobe reads each file; ffmpeg joins them by stream copy when every file is AAC of the same layout, otherwise (or when the copy fails) re-encodes to AAC (`AUDIO_MERGE_BITRATE`); one chapter per original file, tags and cover from the first, moov first (`+faststart`). ffmpeg writes only into `CACHE_DIR/audio-merge/<job>/`; the checked result (length, one chapter per file) is then saved next to the originals as `<folder name>.m4b` (or `<folder name> (merged).m4b`, `(merged 2)`, …). The folder is re-indexed and the book linked to the merged file if its link did not change meanwhile; the subtitle step asks again. A failure, cancel, stall (`AUDIO_MERGE_STALL_MINUTES`), lack of space (`AUDIO_MERGE_MIN_FREE_MB`) or restart leaves nothing in the audiobooks folder. `/audio/status` says whether merging is available and why not.

**Sentence audio for Anki (WP14).** `GET /books/:id/audio-clip?start=<s>&end=<s>` answers the MP3 of that time range of the book's linked audio file, for "Enrich last Anki card" (the device works out the range from the subtitle lines). Only a link that plays is used (one file, still there): no link 409 `no_audiobook`, a folder of several files 409 `not_one_file`, gone 409 `missing`/`changed`. ffmpeg reads the file and writes the clip to its output; nothing is written anywhere. At most `AUDIO_CLIP_MAX_SECONDS` long (400 `too_long`), `AUDIO_CLIP_CONCURRENCY` cuts at once (429 `busy`), stopped after `AUDIO_CLIP_TIMEOUT_SECONDS` (504 `timeout`).

**Suggestions.** `GET /api/v1/books/:id/audio/candidates` ranks folders and subtitle files by title (normalized: full/half width, brackets, `_ (出版社)`, `[N巻]`, `Vol N - `, ASINs) and series number. It never links anything: the user picks in the confirmation picker. `GET /api/v1/audio/search?q=` searches the whole index.

**Streaming.** `GET /api/v1/audio/files/:folder/:index` serves one file with byte ranges (206), from a signed URL (an `<audio>` element can't send the token) or with the token. A URL stops working when the file changes (409).

| Command                               | Description                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `audio status`                        | Folders, single-file folders, subtitle files and the last error per library |
| `audio scan [<library-id>]`           | Scan again (the server runs it on its next poll)                            |
| `audio match <book-id> [--limit <n>]` | The suggestions the picker would show for a book                            |

## Environment variables

| Variable                           | Default    | Description                                                                                                                          |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_TOKEN`                       | _(unused)_ | The old sync's token. Unused since WP15e: when set, a startup warning says so (it is still removed from logged lines).               |
| `DATA_DIR`                         | `/data`    | The app's data folder (uploads, fonts, attachments; the old sync's files, read by the migration). Server exits if missing.           |
| `DB_DIR`                           | `/db`      | Folder for the SQLite database and snapshots.                                                                                        |
| `PORT`                             | `3001`     | Listening port.                                                                                                                      |
| `CORS_ORIGIN`                      | `*`        | Comma-separated list of allowed origins (e.g. `http://tower:3080,http://100.64.0.1:3080`). `*` allows any origin and logs a warning. |
| `TZ`                               | _(UTC)_    | Time zone for the snapshot schedule.                                                                                                 |
| `SNAPSHOT_TIME`                    | `03:00`    | Daily snapshot time, `HH:MM`.                                                                                                        |
| `SNAPSHOT_KEEP`                    | `7`        | Number of snapshots to keep.                                                                                                         |
| `CALIBRE_DIR`                      | _(unset)_  | Calibre libraries root, mounted read-only. Unset: the indexer is off.                                                                |
| `CACHE_DIR`                        | `/cache`   | Snapshots of `metadata.db` and thumbnails. Must exist; must not overlap `CALIBRE_DIR`, `DB_DIR` or `DATA_DIR`.                       |
| `CALIBRE_POLL_SECONDS`             | `60`       | How often `metadata.db` is checked for changes (5 or more).                                                                          |
| `CALIBRE_SETTLE_SECONDS`           | `30`       | `metadata.db` must be unchanged this long before it is copied.                                                                       |
| `CALIBRE_SNAPSHOT_TIMEOUT_SECONDS` | `600`      | A snapshot copy that takes longer is abandoned and retried on a later poll.                                                          |
| `CALIBRE_MAX_MISSING_PERCENT`      | `20`       | If one index would flag more than this share of a library missing, nothing is flagged and a warning is recorded.                     |
| `CALIBRE_REQUIRE_READONLY`         | `true`     | Refuse to index a writable Calibre mount. Set `false` only for local development.                                                    |
| `THUMB_CONCURRENCY`                | `1`        | Covers the background pass works on at the same time (1-8).                                                                          |
| `THUMB_PER_SECOND`                 | `8`        | Background pass rate limit; `0` = no limit. On-request thumbnails are not limited.                                                   |
| `THUMB_BACKGROUND`                 | `true`     | `false` = thumbnails are only made when requested.                                                                                   |
| `COUNT_BACKGROUND`                 | `true`     | `false` = no character counting (counts stay pending).                                                                               |
| `COUNT_CONCURRENCY`                | `1`        | Books counted at the same time, one counter process each (1-4).                                                                      |
| `COUNT_PER_MINUTE`                 | `0`        | Rate limit of the count pass in books per minute; `0` = no limit (the low process priority already yields to other work).            |
| `COUNT_TIMEOUT_SECONDS`            | `120`      | A book that takes longer is recorded as `timeout` and its counter process is replaced.                                               |
| `COUNT_START_TIMEOUT_SECONDS`      | `60`       | A counter process that is not ready after this long pauses the pass until the next poll.                                             |
| `COUNT_MAX_MEMORY_MB`              | `768`      | Heap limit of each counter process.                                                                                                  |
| `COUNT_BOOKS_PER_PROCESS`          | `500`      | A counter process is replaced after this many books (bounds memory growth).                                                          |
| `COUNT_NICE`                       | `10`       | Scheduling priority of the counter processes (0-19; higher = lower priority).                                                        |
| `COUNT_MAX_CONSECUTIVE_FAILURES`   | `5`        | The pass pauses after this many timeouts or crashes in a row.                                                                        |
| `COUNT_IMPORT_FIX_MODE`            | `Off`      | Reader import setting the counts use: `Off`, `Standard` or `Extended`. A change recounts every book.                                 |
| `COUNT_RESTRICT_FIX_TO_ANCHOR`     | `true`     | Reader import setting the counts use (import fix only on anchors). A change recounts every book.                                     |
| `SYNC_MAX_CLOCK_SKEW_SECONDS`      | `300`      | A synced change stamped further ahead of the server clock gets the server time instead.                                              |
| `SYNC_FROZEN_KINDS`                | `stat-day` | Record kinds devices may no longer change (comma-separated; `none` = no kind). Statistics days are frozen since WP12's sessions.     |
| `SEARCH_REGEX_TIMEOUT_SECONDS`     | `5`        | A library search with a `/pattern/` that runs longer is stopped (its worker thread is replaced) and answered with `regex_timeout`.   |
| `UPLOAD_MAX_MB`                    | `200`      | Largest EPUB the Library's Upload accepts (`413 too_large` above it).                                                                |
| `UPLOAD_STAGED_HOURS`              | `24`       | An uploaded file waiting for "Use the library copy / Add as a separate book" is deleted after this long.                             |
| `AUDIOBOOKS_DIR`                   | _(unset)_  | Audiobooks root (WP15). Unset: audio linking is off. Writable only for merging (WP15f): new files only, see above.                   |
| `AUDIOBOOKS_FILE_UID`, `_GID`      | _(unset)_  | Owner and group given to new files in the audiobooks folder (Unraid: `99`, `100`). Unset: left as created.                           |
| `AUDIOBOOKS_FILE_MODE`             | _(unset)_  | Mode given to new files there, octal (Unraid: `0666`). Unset: left as created.                                                       |
| `AUDIO_COPY_HINT_MIN_MINUTES`      | `60`       | The picker's "look like copies" hint: only files at least this long…                                                                 |
| `AUDIO_COPY_HINT_PERCENT`          | `3`        | …whose lengths differ by at most this percent.                                                                                       |
| `AUDIO_MERGE_BITRATE`              | `128k`     | AAC bitrate when a merge has to re-encode.                                                                                           |
| `AUDIO_MERGE_MIN_FREE_MB`          | `2048`     | Free space a merge leaves in the cache folder and the audiobooks folder; it refuses to start or save otherwise.                      |
| `AUDIO_MERGE_STALL_MINUTES`        | `10`       | A merge whose ffmpeg reports nothing this long is stopped.                                                                           |
| `FFMPEG_PATH`, `FFPROBE_PATH`      | `ffmpeg`…  | The programs used to merge and to cut sentence audio (in the Docker image).                                                          |
| `AUDIO_CLIP_MAX_SECONDS`           | `60`       | Longest sentence audio the server cuts (WP14).                                                                                       |
| `AUDIO_CLIP_BITRATE`               | `128k`     | MP3 bitrate of sentence audio.                                                                                                       |
| `AUDIO_CLIP_TIMEOUT_SECONDS`       | `30`       | A cut that takes longer is stopped.                                                                                                  |
| `AUDIO_CLIP_CONCURRENCY`           | `2`        | Cuts at the same time; more are answered "busy".                                                                                     |
| `AUDIO_SCAN_HOURS`                 | `24`       | Full rescan interval of the audiobook and subtitle folders; `0` = only at start and on request.                                      |
| `AUDIO_POLL_SECONDS`               | `60`       | How often the server checks for a scan requested with the CLI.                                                                       |

Invalid values for the WP1, WP2, WP6, WP4, WP3b, WP7a, WP7b and WP15 settings are reported at startup and fall back to the default; they never stop the legacy endpoints.

## Running with Docker

```sh
docker build -t ttsu-storage .
docker run -d \
  -p 3001:3001 \
  -v /your/nas/data:/data \
  -v /your/nas/db:/db \
  -v /your/nas/cache:/cache \
  -v /your/nas/books:/calibre:ro \
  -e CORS_ORIGIN=http://your-host:3080 \
  -e CALIBRE_DIR=/calibre \
  -e TZ=Europe/Berlin \
  ttsu-storage
```

## Development

```sh
npm install
npm test          # vitest: legacy characterization suite + API, DB, CORS, snapshot, CLI, Calibre, thumbnail and count tests
npm run build

# Benchmark a first index of a large synthetic library (not part of npm test)
node -r ts-node/register/transpile-only scripts/bench-index.ts --books 60000 --covers 500

# Benchmark library search and browse (synthetic 65k books, or a COPY of a real ttsu.db, opened read-only)
node -r ts-node/register/transpile-only scripts/bench-search.ts [--books 65000 | --db <copy of ttsu.db>]
```

The Calibre tests use throwaway libraries in temp folders. `tests/fixtures/calibre-7.1/` is a tiny library made by real Calibre with `scripts/make-calibre-fixture.ts`, which only ever runs `calibredb` against a new, empty folder. The tests check the hand-built fixture schema against it.

## Quick smoke-test with curl

```sh
TOKEN=changeme
BASE=http://localhost:3001

# List root
curl -H "Authorization: Bearer $TOKEN" "$BASE/list?path="

# Upload a file
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  --data-binary @somefile.txt \
  "$BASE/file?path=test%2Fsomefile.txt"

# Download it back
curl -H "Authorization: Bearer $TOKEN" "$BASE/file?path=test%2Fsomefile.txt"

# Delete it
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/file?path=test%2Fsomefile.txt"

# API v1
curl "$BASE/api/v1/health"
curl -H "Authorization: Bearer ttsu_..." "$BASE/api/v1/me"
```

## Progress file conflict resolution

Progress filenames encode a timestamp: `progress_<book_id>_<chapter_idx>_<timestamp>_<ratio>.json`.

When a `PUT /file` targets a `progress_*.json`, the server scans the directory for any existing progress file with a **newer** timestamp. If one is found, the upload is refused with **409 Conflict**. The client (ttsu handler) treats 409 as a no-op — the other device wrote more recent data, so nothing needs to happen.
