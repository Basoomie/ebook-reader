# ttsu Storage Server

Self-hosted REST storage backend for [ttsu Ebook Reader](https://github.com/ttu-ttu/ebook-reader).

Exposes a simple file API over HTTP so multiple devices can share one canonical reading-data directory without any external sync software.

## API

All endpoints require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/list?path=<dir>` | List entries in `<dir>`. Returns `[]` if directory does not exist. |
| `GET` | `/file?path=<file>` | Download file bytes. Returns `Last-Modified` header. |
| `PUT` | `/file?path=<file>` | Upload file (raw bytes). Creates parent dirs. Returns `{lastModified}`. For `progress_*.json` files, rejects with **409** if an existing progress file in the same directory has a newer timestamp. |
| `DELETE` | `/file?path=<file>` | Delete a file. Returns 200 or 404. |
| `POST` | `/mkdir?path=<dir>` | Create directory (idempotent). |
| `DELETE` | `/rmdir?path=<dir>` | Delete directory recursively. Returns 200 or 404. |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | *(required)* | Bearer token for all requests. Server exits if unset. |
| `DATA_DIR` | `/data` | Root directory for stored files. |
| `PORT` | `3001` | Listening port. |
| `CORS_ORIGIN` | `*` | Value for `Access-Control-Allow-Origin`. |

## Running with Docker

```sh
docker build -t ttsu-storage .
docker run -d \
  -p 3001:3001 \
  -v /your/nas/path:/data \
  -e AUTH_TOKEN=changeme \
  ttsu-storage
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
```

## Progress file conflict resolution

Progress filenames encode a timestamp: `progress_<book_id>_<chapter_idx>_<timestamp>_<ratio>.json`.

When a `PUT /file` targets a `progress_*.json`, the server scans the directory for any existing progress file with a **newer** timestamp. If one is found, the upload is refused with **409 Conflict**. The client (ttsu handler) treats 409 as a no-op — the other device wrote more recent data, so nothing needs to happen.
