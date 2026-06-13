# whispersync — Vendored Source

Vendored from [ttu-whispersync](https://github.com/Renji-XD/ttu-whispersync) (MIT License).

**Upstream commit:** `dfc05f814e2c6edb30f07040418fd1d78bbf5b4d`

## What is here

- `components/` — all Svelte UI components
- `lib/` — all TypeScript library modules
- `styles.css` — whispersync styles

## What was excluded (userscript/extension layer)

- `src/content/` — userscript injection entry point (replaced by native reader mount in Phase 1)
- `src/sandbox/` — Chrome extension sandbox iframe (removed in Phase 1)
- `src/manifest.config.ts` and extension/userscript Vite configs

## Phase 0 stubs (TODO markers)

The following references are isolated behind TODO comments so the project compiles clean:

- `// TODO(phase1)` — sandbox element, chrome.runtime references (removed in Phase 1 native mount)
- `// TODO(phase5)` — FFMPEG/MediaInfo/recorder heavy deps (re-enabled in Phase 5 for Anki/cover features)

## Sync notes

- SRT + playback position + matched book HTML sync via the reader's existing replication pipeline
- Audio blob is NOT synced via replicator; it uploads/streams via the storage server `/file` endpoint
- Last-write-wins semantics for re-match/reset are preserved verbatim (see `onSaveMatch` in Match.svelte)
