# Library cleanup: apply sidecar (WP20a)

The only program that writes to Calibre. It runs as its own container (`ttsu-cleanup-apply`)
next to `ttsu-storage`, and:

- writes **only through the running Calibre content server**, with `calibredb --with-library
http://host:port/#<library id>` (calibredb refuses to open the library folder while the
  Calibre GUI runs, and the sidecar doesn't mount it);
- writes **only for batches the reader's server hands out** (`/cleanup`), one step at a time,
  each reported and acknowledged before the next;
- removes books to **Calibre's trash** (never `--permanent`), after exporting each one to the
  quarantine folder; Undo brings them back from Calibre's trash (calibre 9.18 or newer, same
  id and UUID) or re-adds the quarantined copy;
- **never deletes anything in the quarantine folder**; you empty it when you choose.

It never writes `cleanup.db` (only `ttsu-storage` does). All its state is on the server, so
it continues after a restart, and it waits while `ttsu-storage` is stopped for the nightly
backup.

## Settings

The Calibre address, library id, user and password are entered on the reader's `/cleanup`
page and fetched from the server. The container only needs:

| Variable                     | Meaning                                                                          | Default                    |
| ---------------------------- | -------------------------------------------------------------------------------- | -------------------------- |
| `CLEANUP_TOKEN`              | From `docker exec ttsu-storage node dist/cli.js token cleanup "cleanup sidecar"` | (required)                 |
| `TTSU_URL`                   | The storage server on the compose network                                        | `http://ttsu-storage:3001` |
| `QUARANTINE_DIR`             | Where `/mnt/user/data/backups/calibre-quarantine` is mounted                     | `/quarantine`              |
| `QUARANTINE_MIN_FREE_MB`     | Free space the safety check asks for                                             | `2048`                     |
| `CALIBREDB_TIMEOUT_SECONDS`  | One calibredb call is stopped after this long                                    | `600`                      |
| `CHECK_SECONDS`              | How often the safety checks run                                                  | `120`                      |
| `TRASH_RESTORE_WAIT_SECONDS` | Undo: how long to wait for Calibre to bring books back from its trash            | `3600`                     |
| `REMOVE_WAIT_SECONDS`        | How long to wait for Calibre to remove a copy after the remove request failed    | `600`                      |
| `WAIT_POLL_SECONDS`          | While waiting for Calibre (Undo, a timed-out remove): how often to look          | `15`                       |

**Undo and a big trash:** Calibre reads its whole trash before every `trash restore`, which
takes minutes with thousands of entries, and its content server answers HTTP 408 after its
own time limit (120 s) while it keeps restoring. So Undo asks once for all of a batch's books
and then waits for them to reappear. It never re-adds a book it asked the trash for (no
double copies); only a book Calibre says isn't in its trash is re-added from the quarantine.
Each request is noted in the batch's quarantine folder (`trash-restore-*.json`), so after a
restart the sidecar waits for it instead of asking again.

**A remove that times out:** the request can time out while Calibre still removes the book
(seen on the NAS). The sidecar then looks for up to `REMOVE_WAIT_SECONDS` whether the copy
goes; if it does, it is recorded as removed (with its Undo record and the reading-data
handoff), otherwise the copy is marked failed.

The image must be built with the **same calibre version** as the content server
(`CALIBRE_TAG` build argument = the `calibre` container's tag, e.g. `9.18.0`); the safety
checks show "versions match" on `/cleanup`.

## Quarantine layout

```
calibre-quarantine/<batch id>/
  batch.json           what the batch was
  metadata.db          Calibre's metadata.db as it was before the batch
  <calibre id>/        the removed copy: book.epub (+ other formats), book.opf, book.jpg
  <calibre id>.json    what it was a duplicate of, and the EPUB's SHA-256
```

## Development

`npm run build` compiles to `dist/`. The tests run with the storage server's tests:
`npx vitest run tests/wp20a-sidecar` in `apps/storage-server` (a stand-in calibredb changes a
test library the way the content server would).
