# Character-count parity (WP3a)

Checks that the Node build of the EPUB loader and character counter gives the same
results as the browser did for books already imported into the reader. Opt-in, because
it needs the NAS shares. Nothing here writes to the stored books or to Calibre.

## 1. Build the manifest (once, or after importing more books)

Run from `apps/web`:

```bash
pnpm parity:manifest --stored <storage-server-data-dir> --library <calibre-library-dir> [--library <another-calibre-library-dir>]
```

- `--stored`: the storage server's data folder, which holds one folder per book.
- `--library`: a Calibre library folder (the one containing `metadata.db`). Repeat it for each library.

- Each `metadata.db` is copied to a temp folder, and only the copy is opened.
- Every stored book (`<data>/<title>/bookdata_*.zip`) is paired with a Calibre EPUB by title.
- A pairing counts only if its fingerprint matches. The fingerprint is the EPUB `dc:title`, the image CRC32s and the spine ids. It involves no character counting.
- Output: `tests/parity/manifest.local.json` (gitignored). Check any entry that isn't `verified`.

## 2. Run the parity test

```bash
pnpm test:parity
```

| Check | Kind | What must hold                                                                                                                                |
| ----- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | hard | The Node reader count over the stored `elementHtml` equals the stored `characters`.                                                           |
| B     | hard | Node import of the paired EPUB equals the stored `characters` and section structure. Label differences are reported but don't fail the check. |
| C     | info | If B fails with fix mode Off, which other fix mode matches.                                                                                   |

The report is written to `tests/parity/.out/parity-report.{md,json}` (gitignored).
