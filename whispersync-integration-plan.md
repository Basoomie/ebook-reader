# ttu-whispersync Native Integration — Build Plan for Claude Code

This document is the authoritative spec for integrating `ttu-whispersync` natively into the
`Basoomie/ebook-reader` fork (a fork of ttu's ebook reader) and its self-hosted storage server.

It is written to be executed by Claude Code in an IDE. Use it two ways:

1. Read **Section A (Context & Ground Truth)** once at the start of every session so you understand
   the architecture and the decisions already made. Do not re-litigate these decisions.
2. Execute **one phase at a time** from **Section B**. Each phase is a self-contained prompt with
   its own scope, files, acceptance criteria, and stop condition. Finish and verify a phase before
   starting the next.

> **Golden rule for the agent:** Prefer the smallest change that satisfies the phase. Do not
> "improve" working whispersync behavior (especially the match/re-match lifecycle). Preserve existing
> semantics; only change what a phase explicitly calls for. When something is ambiguous, stop and ask
> rather than guess.

---

## Section A — Context & Ground Truth

### A.1 What we are building

The user reads Japanese ebooks in a self-hosted ttu fork. Books, reading progress, statistics,
and (already, in the data model) audiobook position + subtitle data sync across devices (Windows PC,
Linux, Android phone, e-reader) via a self-hosted storage server. `ttu-whispersync` is currently an
external Violentmonkey userscript / Chrome extension that adds audiobook playback synced to the text
(follow-along line highlighting, transport controls, Anki card creation, etc.).

**Goal:** Bring whispersync *into* the reader as native code so that:

- There is **nothing to install per device** — loading the reader URL gives you whispersync.
- **Audio is added once** (dropped into the whispersync panel on one device), uploaded to the book's
  folder on the NAS, and **streamed by every other device** — no per-device file copying.
- **SRT + playback position + matched text** sync automatically through the existing replication
  pipeline (match once on one device, propagates everywhere).
- Whispersync **settings sync** too (they become reader settings).

### A.2 The two repos involved (both already cloned/owned by the user)

- **Reader fork** — `Basoomie/ebook-reader`. SvelteKit app under `apps/web/`. Self-hosted storage
  server under `apps/storage-server/` (Express + TypeScript). Deployed via Docker Compose: reader on
  `:3080`, storage server on `:3081` (internal `:3001`), data volume at `/data`.
- **whispersync** — `Renji-XD/ttu-whispersync`. Svelte + TypeScript. We vendor its `src/` into the
  reader fork and convert it from an injected userscript into native reader components.

> The agent should obtain whispersync's source by cloning `https://github.com/Renji-XD/ttu-whispersync`
> into a scratch location for reference, then copy/adapt files into the reader fork. Do **not** add it
> as a runtime dependency or git submodule unless the user asks; vendor the source.

### A.3 Architecture facts already verified (do not re-investigate; rely on these)

**Reader fork — storage & sync (verified):**
- Self-host client handler: `apps/web/src/lib/data/storage/handler/selfhost-handler.ts`, extends
  `ApiStorageHandler` (`api-handler.ts`) which extends `BaseStorageHandler` (`base-handler.ts`).
- The data model **already** defines audiobook & subtitle file types:
  `FilePrefix.AUDIO_BOOK = 'audioBook_'`, `FilePrefix.SUBTITLE = 'subtitles_'` in `base-handler.ts`.
  `ApiStorageHandler` already implements `saveAudioBook`, `saveSubtitleData`, `getAudioBook`,
  `getSubtitleData`, and the up-to-date checks.
- The replicator (`apps/web/src/lib/functions/replication/replicator.ts`) already moves
  `StorageDataType.AUDIOBOOK`, `StorageDataType.SUBTITLE`, and `StorageDataType.DATA` between source
  and target.
- Local IndexedDB schema **already** has `audioBook` and `subtitle` object stores
  (`apps/web/src/lib/data/database/books-db/versions/v6/books-db-v6.ts`). **No schema migration is
  required** to store audiobook position / subtitle data locally.
- Central store/db wiring is in `apps/web/src/lib/data/store.ts` via a `DatabaseService`
  (`database/books-db/database.service.ts`) and `createBooksDb` factory. Reader settings use
  `writable*LocalStorageSubject` stores defined in `store.ts`.
- Book content is stored in the `data` store as `BooksDBData` with `elementHtml` and optional
  `htmlBackup` fields (matches whispersync's expectations exactly).

**Reader fork — storage server (verified, `apps/storage-server/src/index.ts`):**
- Express app, raw body parser with **`limit: '200mb'`** (a hard blocker for large audio).
- `PUT /file?path=` writes via `fs.writeFile(absPath, body)` — **buffers whole file in memory, writes
  non-atomically** to the final path.
- `GET /file?path=` reads via `fs.readFile` (whole file in memory), sets `Last-Modified` and
  `Content-Length`. **No HTTP Range support** (needed for audio seeking).
- Has `progress_*.json` timestamp-reject (409) logic for last-write-wins. Other endpoints:
  `GET /list`, `DELETE /file`, `POST /mkdir`, `DELETE /rmdir`. Auth via `Bearer` header; `GET /file`
  also accepts `?token=` for `<img>` cover loading.
- Data layout: one folder per book title (sanitized), containing `bookdata_*`, `cover_*`,
  `progress_*`, etc.

**whispersync — key seams (verified):**
- Injection entrypoint `src/content/content.ts`: DOM-polls for `.book-content`, finds the footer by
  Tailwind-class selector, injects a container, mounts `AudioBookMenu.svelte`, injects a `<style>`,
  sets up a `chrome.runtime` sandbox iframe, parses book id from URL. **All of this is deleted when
  native.**
- Audio loading: `src/lib/files.ts` → `updateAudio()` does `audioSourceUrl = URL.createObjectURL(file)`
  from a local `File` (from dropzone or `getFileHandle`/`showOpenFilePicker`). **This is the seam to
  patch for audio-from-NAS.** Cover/chapters use a MediaInfo WASM path; card export uses an FFMPEG
  WASM path — both want file bytes (deferred to Phase 5).
- File UI: `src/components/Audiobook.svelte` supports drag/drop (`Dropzone.svelte`) and file picker.
  The audiobook menu appears **inside an opened book**, not on the homepage.
- Matching/highlight: `src/components/Match.svelte` parses `$bookData$.elementHtml`, wraps matched
  lines in `<span class="ttu-whispersync-line-highlight-<id>">`, tags the root with
  `data-ttuWhispersyncMatched*`. `onSaveMatch()` writes `{ ...bookData, htmlBackup: oldElementHtml,
  elementHtml: wrappedHtml, lastBookModified: Date.now() }` via `$booksDB$.put('data', …)` then
  `location.reload()`. Live highlight is CSS targeting those spans, driven by `activeSubtitle$`.
  Reset path in `Audiobook.svelte` restores `elementHtml` from `htmlBackup`.
- whispersync settings live in `localStorage` keys (`ttu-whispersync-*`) via its own writable stores
  in `src/lib/stores.ts`.
- whispersync local db (`src/lib/db.ts`) defines `data` / `audioBook` / `subtitle` / `handle` stores —
  to be **merged into / repointed at** the reader's existing db, not run as a second db.

### A.4 Decisions already made (do NOT revisit)

1. **Keep the panel-drop workflow.** Audio + SRT are dropped into the whispersync panel inside an
   opened book, on ONE device, ONCE per book. (Not on the homepage; not per device.)
2. **Audio reaches other devices by upload→fetch**, not by writing into Calibre folders. On drop, the
   audio uploads (streaming) into the book's existing reader-managed NAS folder (next to `bookdata_`,
   `cover_`). Other devices fetch it. **Never touch the user's Calibre-managed ebook folders.**
3. **SRT + playback position + matched text sync via the existing replicator.** No new sync mechanism.
4. **Audio blob is NOT synced through the replicator** (too large, by design). It is uploaded/fetched
   directly via the storage server `/file` endpoint. Audio is therefore **online-only** (reachable on
   LAN or via Tailscale; silent only with no connectivity at all). This is acceptable; offline audio
   ("Option 2") is explicitly out of scope for now.
5. **Addressing inherits the existing per-device config.** The reader already stores `serverUrl`
   (`clientId`) + token (`clientSecret`) per device; PC uses the LAN IP, phone/e-reader use the
   Tailscale IP. Audio fetch/upload uses this same configured `serverUrl`. **Nothing hardcoded.**
6. **All whispersync settings sync for now** (converted to reader stores); refine subset later if any
   prove device-specific.
7. **Anki/AnkiConnect: preserve whispersync's existing configuration and behavior verbatim.** (Deferred
   to Phase 5; not changed, only re-mounted.)
8. **Book↔audio association is by sanitized title** (matches existing folder keying). Acceptable now;
   contained change later if needed.
9. **No storage-source-lookup patch.** The reader already downloads book content into the local db on
   open, so whispersync's "book must be in local db" requirement is already satisfied by normal use.
   Only revisit if a real `required data for id x not found` occurs in practice.
10. **VBR MP3 caveat:** whispersync requires constant-bitrate MP3 (VBR drifts out of sync). M4B is
    fine. This is a user library-prep task, not a code task.

### A.5 Tech/style constraints

- SvelteKit + TypeScript + Vite throughout. Match the reader fork's existing code style, lint config
  (eslint/prettier present), and store conventions. Run the repo's existing lint/format/build scripts
  before declaring a phase done.
- Do not introduce new heavy dependencies in early phases. FFMPEG/MediaInfo WASM assets are Phase 5
  only.
- Keep commits small and per-phase. Use clear commit messages. Do not force-push or rewrite history.
- The reader is BSD-3-Clause; whispersync is MIT. Both permissive and compatible. Preserve license
  headers on vendored files and note the vendored origin.

---

## Section B — Phased Build (execute one at a time)

Each phase below is written as a prompt you can paste to Claude Code on its own. Phases are ordered so
that the **spine works before optional features are added**. Do not skip ahead; later phases assume
earlier ones are merged and verified.

> Suggested workflow per phase: create a branch, implement, run lint+build, manually verify the
> acceptance criteria, commit, then return here for the next phase.

---

### PHASE 0 — Repo prep & vendoring (make it compile, change no behavior)

**Goal:** Get whispersync's source into the reader fork and the combined project building cleanly,
**before changing any behavior.** This is the "carry the tools into the house and check the lights
still work" phase.

**Do:**
1. Clone `https://github.com/Renji-XD/ttu-whispersync` into a scratch dir for reference (not inside the
   reader's build).
2. Create a vendored location in the reader app, e.g.
   `apps/web/src/lib/whispersync/` and copy whispersync's `src/components`, `src/lib`, `src/styles.css`,
   and needed assets there. **Do not** copy `src/content/`, `src/sandbox/`, `src/manifest.config.ts`,
   or the extension/userscript vite configs — those are the userscript packaging layer we're removing.
3. Preserve MIT license headers; add a short `README` note in the vendored dir recording the upstream
   commit hash it was copied from.
4. Reconcile TypeScript/path-alias/Svelte config so the vendored files typecheck within the reader
   app. Resolve import paths. Stub or comment out (clearly marked `// TODO(phase1)` /
   `// TODO(phase5)`) any references to `chrome.runtime`, the sandbox iframe, FFMPEG, or MediaInfo so
   the project compiles. **Do not delete logic yet — just isolate it behind TODOs so it builds.**
5. Ensure `pnpm install`, lint, and `pnpm build` (or the repo's equivalent) all succeed.

**Do NOT:** wire anything into the reader UI yet; change runtime behavior; remove FFMPEG/MediaInfo
logic (just isolate it).

**Acceptance criteria:**
- The reader app builds and lints clean with whispersync's source vendored in.
- No whispersync component is mounted anywhere yet (the running app is unchanged for the user).
- Every isolated/cut reference is marked with a `TODO(phaseN)` so later phases can find them.

**Stop** and report what was isolated behind TODOs before starting Phase 1.

---

### PHASE 1 — Native mount (replace injection; use local-file audio for now)

**Goal:** Make whispersync run as part of the reader — its panel/footer button, player, subtitle list,
match UI, dialogs — using the reader's own db and routing, with the **old local-file audio path still
in place** (audio-from-NAS comes in Phase 2). At the end you can drop a local audio + SRT, match, and
get follow-along highlighting, entirely inside the served reader, with no userscript installed.

**Do:**
1. Delete the injection model: remove reliance on `content.ts`, the Tailwind-class footer selector,
   the manual container insertion, the injected `<style>`, and the `chrome.runtime` sandbox. Replace
   the sandbox-dependent MediaInfo calls with the direct (non-sandbox) code path that already exists in
   `files.ts` (the `getAudioMetadata(file, enableCover)` branch). FFMPEG/MediaInfo stay behind
   `TODO(phase5)` if not trivially compiled — playback + matching must not depend on them.
2. Mount `AudioBookMenu.svelte` (and its children: `Player`, `Subtitles`, `Match`, `ReaderMenu`,
   dialogs) as **native components** in the reader's book-reader footer, as a sibling to existing
   footer controls. Source the current book id from the reader's own routing/stores, not from parsing
   `window.location`.
3. Repoint whispersync's `$booksDB$` / `$bookData$` to the reader's `DatabaseService` instance and its
   book-data store (from `store.ts`). Remove whispersync's separate db bootstrap; it must read/write
   the **same** `data` / `audioBook` / `subtitle` IndexedDB stores the reader already defines (v6).
4. Wire the highlight CSS into the reader's style layer so `span.ttu-whispersync-line-highlight-<id>`
   is styled in the rendered book, driven by `activeSubtitle$`. Honor whispersync's highlight color
   settings (read them wherever they currently live for now; Phase 4 moves them into reader stores).
5. Preserve the match/re-match lifecycle **exactly**: match parses `elementHtml`; `onSaveMatch` writes
   `htmlBackup` + wrapped `elementHtml` + `lastBookModified` and reloads; the reset path restores from
   `htmlBackup`. Do not change this logic.

**Do NOT:** change how audio bytes are sourced yet (still local `File`); touch the storage server;
implement settings sync; enable FFMPEG/MediaInfo features.

**Acceptance criteria (manual, on PC, no userscript installed):**
- Open a book in the served reader → whispersync footer button is present and opens the panel.
- Drop a **local** audio file + SRT into the panel; Match tab matches; "Save & reload" works.
- After reload, playing audio highlights the current line and autoscrolls; transport controls
  (play/pause, rewind, skip, rate) work.
- Reset restores the unmatched book.
- No console errors referencing `chrome.runtime`, sandbox, or a second IndexedDB.

**Stop** and confirm the spine works before Phase 2.

---

### PHASE 2 — Audio from the NAS (storage server + client fetch/upload)

**Goal:** Replace the local-file audio source with **upload-on-drop → fetch-on-play** against the
self-hosted storage server, engineered for large files. After this phase, dropping audio on one device
makes it stream on all devices.

**Part 2a — Storage server (`apps/storage-server/src/index.ts`):**
1. Add a **streaming upload path for audio** (e.g. a dedicated route or a branch of `PUT /file` keyed
   on an `audio_`-prefixed filename / a query flag): pipe `req` directly to
   `fs.createWriteStream(tmpPath)` instead of going through the `express.raw` 200 MB buffer, then
   `fs.rename(tmpPath, finalPath)` on completion (atomic on same FS). On error/abort, unlink the temp
   file. The 200 MB raw limit must **not** apply to this route.
2. Add **HTTP Range support** to `GET /file` (at least for audio): honor the `Range` request header,
   respond `206 Partial Content` with `Content-Range`/`Accept-Ranges`, and stream via
   `fs.createReadStream(absPath, { start, end })` rather than `fs.readFile`. Keep existing behavior for
   non-range requests/back-compat (covers, small JSON).
3. Keep the existing `Bearer` auth and `?token=` fallback. Keep `progress_` 409 logic untouched.
4. Verify path-safety (`resolveSafe`) still applies to the new route.

**Part 2b — Client (`apps/web/src/lib/whispersync/lib/files.ts` + the audiobook menu):**
5. Define a **stable audio filename** in the book's folder, e.g. `audio_<exporterVersion>_<dbVersion>_…`
   with the original extension preserved, mirroring how `cover_`/`bookdata_` are named in
   `base-handler.ts`. Add a presence check ("does an `audio_`-prefixed file exist in this title folder")
   so audio is uploaded once and never redundantly re-PUT.
6. On audio **drop** (panel): stream-upload the dropped `File` to the book's folder via the storage
   handler, using the configured `serverUrl`/token (reuse the handler's upload primitive; pass the
   `File`/`Blob` as a streaming body — do **not** read it into an ArrayBuffer first). Show progress.
7. Change `updateAudio()` so the audio source is the storage server URL
   (`${serverUrl}/file?path=<titleFolder>/<audioFilename>&token=<token>` or via authed fetch as
   appropriate) instead of `URL.createObjectURL(localFile)`. The `<audio>` element streams it with
   Range requests. Keep the local-file path available as a fallback if no NAS audio is present.
8. Confirm seeking/scrubbing works (depends on 2a Range support) and that this works against both the
   LAN `serverUrl` (PC) and the Tailscale `serverUrl` (phone) with no code change — it's just the
   configured value.

**Do NOT:** sync the audio blob through the replicator; alter the SRT/position/matched-text sync (that
already works via the replicator from Phase 1's native db wiring).

**Acceptance criteria:**
- On PC: drop audio in the panel → it uploads to the book's NAS folder (verify the `audio_*` file
  appears under `/data/<title>/`, not in any Calibre folder). Playback streams from the server;
  seeking works.
- Upload a >200 MB file successfully (proves the streaming path bypasses the old limit and doesn't
  exhaust memory). Interrupt an upload → only a temp file remains, no corrupt `audio_*` file; `/list`
  doesn't report a partial as present.
- On a second device (phone via Tailscale): open the same book → matched text + SRT + position arrived
  via sync; audio streams from the NAS with no per-device drop. Off-network → audio silent, text + SRT
  still work.

**Stop** and confirm cross-device audio before Phase 3.

---

### PHASE 3 — Sync wiring verification & polish (mostly confirmation)

**Goal:** Confirm SRT, playback position, and matched book HTML reliably propagate, and tidy any seams.
This phase is light because the replicator already supports these types — it is mostly verification plus
ensuring whispersync writes through the reader's save paths (not its own).

**Do:**
1. Verify whispersync writes playback position and subtitle data through the reader's
   `saveAudioBook` / `saveSubtitleData` (or the equivalent db writes that the replicator picks up), so
   the existing Auto Replication (`Upload` / `All`) carries them. Fix any spot still writing only to a
   whispersync-private location.
2. Verify the matched `elementHtml` (with highlight spans) syncs as `StorageDataType.DATA` and that a
   second device, on open, renders highlights without re-matching.
3. Confirm last-write-wins semantics behave sanely for a re-match/reset performed on one device
   (propagates via `lastBookModified`). Document the expected behavior in the vendored README.
4. Add minimal user-facing feedback where useful (e.g. "audio uploaded", "subtitles synced") consistent
   with the reader's existing toaster/notification patterns.

**Acceptance criteria:**
- Match on device A → device B shows highlights on open, no manual step.
- Adjust playback position on A → B reflects it after sync.
- Reset on A → B shows the unmatched book after sync.

**Stop** and confirm before Phase 4.

---

### PHASE 4 — Settings sync (convert whispersync settings to reader stores)

**Goal:** Move whispersync's `localStorage`-backed settings (`ttu-whispersync-*`) into the reader's
store pattern so they ride the existing sync pipeline. (Decision A.4.6: all-synced for now.)

**Do:**
1. Identify whispersync's settings stores in its vendored `lib/stores.ts`.
2. Recreate them using the reader's `writable*LocalStorageSubject` (or whichever store helper the
   reader uses for synced settings) in/alongside `store.ts`, preserving keys/defaults/behavior.
3. Repoint all references from the whispersync stores to the reader-backed ones, including the
   highlight-color settings used in Phase 1.
4. Ensure these settings are included wherever the reader serializes/replicates settings (match how
   existing reader settings sync; if reader settings are device-local rather than replicated, follow
   the same convention and note it — "all-synced" means "treated like the reader's other settings").

**Acceptance criteria:**
- Changing a whispersync setting persists across reloads and is consistent with how reader settings
  behave across devices.
- No remaining reads/writes to raw `ttu-whispersync-*` localStorage keys (except a one-time migration
  shim if you choose to preserve existing local values).

**Stop** and confirm before Phase 5.

---

### PHASE 5 — Heavy/optional features (cover, chapters, Anki) — only when wanted

**Goal:** Re-enable the deferred features behind the `TODO(phase5)` markers. These add bulk
(FFMPEG WASM, MediaInfo WASM) and the most wiring. Implement in sub-steps; each is independently
shippable. **Do only the sub-steps the user asks for.**

**5a — Cover art (easiest):** Re-enable the MediaInfo path to extract embedded cover art from the
audio and display it in the player. Bundle the MediaInfo WASM into the reader build. No sandbox/iframe;
call MediaInfo directly.

**5b — Chapter markers:** Re-enable chapter extraction via MediaInfo. Note chapters only appear if the
audio file embeds them.

**5c — Anki integration (most wiring):** Re-enable AnkiConnect card creation/update and the FFMPEG
WASM audio-clip extraction. **Preserve whispersync's existing Anki configuration and behavior verbatim**
(decision A.4.7) — re-mount it, do not redesign. Confirm the existing CORS allowlist and
AnkiConnect/AnkiconnectAndroid setup still apply; the only change is that whispersync is now served from
the reader origin (ensure that origin is in the AnkiConnect `webCorsOriginList`).

**Acceptance criteria (per sub-step):**
- 5a: opening a book with audio shows its embedded cover.
- 5b: chapters appear for files that contain chapter metadata.
- 5c: card create/update works from desktop (and from Android with AnkiconnectAndroid), audio clips
  extracted correctly; existing keybinds/behavior unchanged.

---

## Section C — Cross-cutting checklist (apply every phase)

- [ ] Never write into or near the user's Calibre-managed ebook folders. Audio lives only in the
      reader-managed per-title folder under `/data`.
- [ ] Nothing hardcoded for addressing; always use the configured `serverUrl`/token.
- [ ] Preserve whispersync's match/re-match/reset semantics; do not "improve" them.
- [ ] Keep audio out of the replicator; it moves only via direct `/file` upload/fetch.
- [ ] Run lint + format + build; fix warnings you introduced. Keep commits per-phase with clear
      messages.
- [ ] If you discover a component that secretly depended on the removed sandbox/`chrome.runtime`
      (possible residual risk from files only grepped, not fully read), stop and surface it rather than
      hacking around it.
- [ ] Don't add FFMPEG/MediaInfo to the bundle before Phase 5.

## Section D — Known residual risks (flag, don't silently work around)

1. **Un-read whispersync components.** Only the integration-critical files were fully audited. A helper
   may assume the sandbox/extension context. Expected to surface in Phase 1; isolate and report.
2. **VBR MP3 files** in the user's library will drift out of sync. This is a user library-prep task
   (re-encode to CBR); not a code fix. M4B unaffected.
3. **Android performance** is rougher than desktop (upstream-known). Treat desktop as primary.
4. **Large-file upload UX** on Android: even with streaming, a multi-hundred-MB upload over the panel is
   slow; ensure progress + cancel exist and a failed upload is recoverable (temp-file cleanup from 2a).
