# ttsu Storage Server

Self-hosted REST storage backend for [ttsu Ebook Reader](https://github.com/ttu-ttu/ebook-reader).

It has two parts:

- **Legacy file API** (`/list`, `/file`, `/audio-file`, `/mkdir`, `/rmdir`): the file store that today's sync (the `selfhost` storage handler) and whispersync use. Its behavior is frozen and pinned by `tests/legacy-endpoints.test.ts`.
- **API v1** (`/api/v1/...`): the new API (design doc section 4.4), backed by a SQLite database. WP1 adds only the foundation: health, per-user tokens and `/me`.

## Legacy file API

All endpoints require `Authorization: Bearer <AUTH_TOKEN>`. `GET /file` also accepts `?token=<AUTH_TOKEN>` (for `<img src>`).

| Method   | Path                      | Description                                                                                                                                                                                         |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/list?path=<dir>`        | List entries in `<dir>`. Returns `[]` if directory does not exist.                                                                                                                                  |
| `GET`    | `/file?path=<file>`       | Download file bytes. Returns `Last-Modified` header. Supports Range requests.                                                                                                                       |
| `PUT`    | `/file?path=<file>`       | Upload file (raw bytes). Creates parent dirs. Returns `{lastModified}`. For `progress_*.json` files, rejects with **409** if an existing progress file in the same directory has a newer timestamp. |
| `PUT`    | `/audio-file?path=<file>` | Streamed upload for `audio_*` files (no 200 MB buffer).                                                                                                                                             |
| `DELETE` | `/file?path=<file>`       | Delete a file. Returns 200 or 404.                                                                                                                                                                  |
| `POST`   | `/mkdir?path=<dir>`       | Create directory (idempotent).                                                                                                                                                                      |
| `DELETE` | `/rmdir?path=<dir>`       | Delete directory recursively. Returns 200 or 404.                                                                                                                                                   |

The legacy endpoints accept only `AUTH_TOKEN`, not the per-user tokens.

## API v1

| Method | Path             | Auth           | Description                                                                                             |
| ------ | ---------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/health` | none           | `{ ok, version, schemaVersion }`; 503 when the database is unavailable. Used by the Docker healthcheck. |
| `GET`  | `/api/v1/me`     | per-user token | `{ user: {id, name}, token: {id, label} }`                                                              |

- Auth: `Authorization: Bearer ttsu_...` (a per-user token, see below). The legacy `AUTH_TOKEN` is not accepted here.
- Errors: `{ "error": { "code": "...", "message": "..." } }`.
- If the database can't be opened, the legacy endpoints keep working and every `/api/v1` route answers 503.

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
- `DB_DIR` must exist and must not be inside `DATA_DIR` (the file API would expose it). The server refuses to use it otherwise.
- **Nightly snapshot**: at `SNAPSHOT_TIME` (container local time, set `TZ`), a consistent copy is written to `$DB_DIR/snapshots/ttsu-YYYYMMDD-HHMMSSZ.db` (timestamp in UTC) using SQLite's online backup API and checked with `quick_check`. The newest `SNAPSHOT_KEEP` are kept; other files in that folder are never touched. If the newest snapshot is older than 24 hours at startup (the container was down), one is taken right away.
- **Restore**: stop the container, copy a snapshot over `ttsu.db` (delete `ttsu.db-wal` and `ttsu.db-shm` if present), start the container.

## Environment variables

| Variable        | Default      | Description                                                                                                                          |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_TOKEN`    | _(required)_ | Bearer token for the legacy endpoints. Server exits if unset.                                                                        |
| `DATA_DIR`      | `/data`      | Root directory for the legacy file API. Server exits if missing.                                                                     |
| `DB_DIR`        | `/db`        | Folder for the SQLite database and snapshots.                                                                                        |
| `PORT`          | `3001`       | Listening port.                                                                                                                      |
| `CORS_ORIGIN`   | `*`          | Comma-separated list of allowed origins (e.g. `http://tower:3080,http://100.64.0.1:3080`). `*` allows any origin and logs a warning. |
| `TZ`            | _(UTC)_      | Time zone for the snapshot schedule.                                                                                                 |
| `SNAPSHOT_TIME` | `03:00`      | Daily snapshot time, `HH:MM`.                                                                                                        |
| `SNAPSHOT_KEEP` | `7`          | Number of snapshots to keep.                                                                                                         |

Invalid values for the WP1 settings are reported at startup and fall back to the default; they never stop the legacy endpoints.

## Running with Docker

```sh
docker build -t ttsu-storage .
docker run -d \
  -p 3001:3001 \
  -v /your/nas/data:/data \
  -v /your/nas/db:/db \
  -e AUTH_TOKEN=changeme \
  -e CORS_ORIGIN=http://your-host:3080 \
  -e TZ=Europe/Berlin \
  ttsu-storage
```

## Development

```sh
npm install
npm test          # vitest: legacy characterization suite + API, DB, CORS, snapshot, CLI tests
npm run build
```

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
