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

## Sync notes (WP15c: the library server, not the old file sync)

- Audio is **linked**, never uploaded: the book's audiobook is chosen in the library's
  picker (book details), and whispersync plays it from a signed URL
  (`lib/linked-audio.ts`, implemented by `$lib/audio/whispersync-reader.ts`). Only
  single-file audiobooks play. A dropped or picked local file plays for this session only.
- A confirmed subtitle file is loaded through `updateSubtitles`, as if dropped, when
  nothing is saved or open yet.
- Position, saved subtitles and saved match sync through the library server
  (`$lib/audio/whispersync-sync.ts`). whispersync's own rows (`audioBook`, `subtitle`,
  `data`) and its match / re-match / reset steps are unchanged.

### What syncs and how

| Data | Written by | IDB store | On the server | Sync trigger |
|------|-----------|-----------|---------------|--------------|
| Playback position | `Player.svelte` | `audioBook` | record `audiobook-position` (`<bookId>`) `{position, modifiedAt}` | `ttu-action` `syncType:'audioBook'` → `onPositionSaved` |
| Subtitle data | `actions.ts` `persistSubtitles` | `subtitle` | attachment `whispersync-subtitles` + record `book-attachment` | `ttu-action` `syncType:'subtitle'` → `onSubtitlesSaved` |
| Matched book HTML | `Match.svelte` `onSaveMatch` | `data` | attachment `whispersync-match` + record `book-attachment` | `ttu-action` `type:'syncAndReload'` → `onMatchSaved` (waits at most the library request time) → reload |
| Audio file | the library's audiobooks folder | — | `audio_links` (picker) | streamed with Range from `/api/v1/audio/files/...` |

Attachments are files in `DATA_DIR/.uploads/attachments/<user>/<bookId>/`; the
`book-attachment` record (`<bookId>:<name>`, `{size, sha256, modifiedAt}`) tells the
other devices, which download it in the background.

### Newest wins

`modifiedAt` is whispersync's own save time (`lastAudioBookModified`,
`lastSubtitleDataModified`, `lastBookModified`), as with the old sync. A device never
uploads a copy older than the server's (the server also refuses it: 409 `stale`). When
a book opens, and whenever a sync brings a record of the open book, newer data from
another device is written into whispersync's rows exactly as its own save would (the
match with its `htmlBackup`). Reading never waits: a short notice offers "Reload" when
the open book's data changed.

**Match/re-match on device A:** `onSaveMatch` writes the matched HTML and `htmlBackup`,
dispatches `syncAndReload`; the match is uploaded, then the page reloads. Device B gets
it on its next open (or with the notice while open).

**Reset match applies on every device** (decided with the user, 2026-11-11):
`onResetBook` runs as before and then removes the shared match (a deletion marker).
Another device that finds that deletion newer than its own matched copy restores its
`htmlBackup`, the same step as `onResetBook`. **Reset all** also removes the saved
subtitles and the position on the server. On the device itself nothing else changes.

**Re-match conflict:** the later save wins (by `modifiedAt`); no merge.
