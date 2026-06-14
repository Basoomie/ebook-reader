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

### What syncs and how

| Data | Written by | IDB store | NAS file prefix | Sync trigger |
|------|-----------|-----------|-----------------|--------------|
| Playback position | `Player.svelte` | `audioBook` | `audioBook_` | `ttu-action` `syncType:'audioBook'` → `scheduleReplication` |
| Subtitle data | `actions.ts` `persistSubtitles` | `subtitle` | `subtitles_` | `ttu-action` `syncType:'subtitle'` → `scheduleReplication` |
| Matched book HTML | `Match.svelte` `onSaveMatch` | `data` | `bookdata_` | `ttu-action` `type:'syncAndReload'` → `executeReplication(DATA)` → reload |
| Audio file | `Audiobook.svelte` | (NAS only) | `audio_` | Streaming PUT via XHR; never through replicator |

### Last-write-wins semantics

All data types use a `lastXxxModified` timestamp embedded in the NAS filename. The replicator compares source vs target filename; if they differ, the source wins (i.e., the device that most recently wrote that type wins).

**Match/re-match on device A:**
1. `onSaveMatch` writes `{ htmlBackup: oldElementHtml, elementHtml: wrappedHtml, lastBookModified: now }` to local IDB.
2. A `syncAndReload` event triggers `executeReplication(DATA)` — the local bookdata (newer `lastBookModified`) is uploaded to the NAS.
3. Page reloads. Device B, on next open, runs `syncDownData` which downloads the newer bookdata and renders highlights.

**Reset on device A:**
1. `onResetBook` / `onResetAll` writes `{ elementHtml: htmlBackup, lastBookModified: now }` (removes `htmlBackup`).
2. The reset does `location.reload()` — no explicit sync dispatch (reset is local and immediate). The next auto-replication cycle or manual sync will upload the reset state.
3. Device B downloads the reset state on its next open.

**Re-match conflict (both devices match the same book independently):**
- Whichever device syncs to the NAS last wins. The other device will download the winning state on next open. No merge; last-write-wins.
