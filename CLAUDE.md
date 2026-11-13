# CLAUDE.md

Self-hosted fork of ッツ (ttu) Ebook Reader with integrated whispersync, served from the user's Unraid NAS.
The app works today. Every change must be intentional and must not break reading.

## Design docs (read before starting any work)

- `docs/design/design-doc.md`: the agreed design (v1), organized by system. Section 13 maps it to current code; section 14 lists risks.
- `docs/design/dependency-map.md`: work packages (WP1-WP19), their prerequisites and the agreed phase order.
- `docs/design/decisions.md`: the log of individual decisions and verified facts about the code and the NAS.

If code and docs disagree, or a task needs a decision the docs don't cover, STOP and ask. Do not guess or silently extend the design.

## Current phase

**Phase 6: the Calibre library cleanup** (approved by the user 2026-11-13; Phases 0-5 are done and deployed). Design: `docs/design/library-cleanup-plan.md` (the agreed plan), `library-cleanup.md` (findings), `reference-sample.md` (measurements), `file-inventory.md` (NAS paths and backups), `known-bugs.md`. Decisions: `docs/design/decisions.md`, "Phase 6 decisions". Work packages in plan order, one at a time (`dependency-map.md`): **WP20a** groundwork + stage 0 (safety) + stage 1 (identical files) → WP20b stage 2 → WP20c stage 3 → WP20d fetch container + stage 4 rules → WP20e AI setup → WP20f stage 5 → WP20g new arrivals.

**WP20a** (branch `wp20a-cleanup-foundation`): `apps/storage-server/src/cleanup/` (cleanup.db beside ttsu.db with its own migrations and nightly snapshot; settings and AES-256-GCM secrets, key in ttsu.db; stage-1 analysis; batches; the reader-side handoff, which swaps two Calibre sources' reader books instead of moving records; Undo), the apply sidecar `apps/cleanup-apply` (container `ttsu-cleanup-apply`, built FROM `lscr.io/linuxserver/calibre` at the calibre container's version; its own tokens `cli token cleanup` reach only `/api/v1/cleanup-apply/*`), and `/cleanup` in the web app (linked only from Settings > Data). Every stage is off by default; the real stage-1 run is switched on by the user from `/cleanup` after deploy. Calibre must be 9.18+ for Undo from Calibre's trash; `#illustrator` is added by the user in the Calibre GUI (calibredb can't create columns through the content server).

Phase 5 (done): WP15, WP15f, WP14, WP16 and WP17 are merged and deployed; the PC's TTS program is set up. Later fixes (search width folding, count/thumbnail file identity) took ttsu.db to schema v17. WP20a adds no ttsu.db migration (its data is in cleanup.db).

WP17 "Make an audiobook on the PC": the book's text comes from the reader's own import (`apps/web/src/lib/server/epub/book-script.ts` in the counter bundle; rebuild with `pnpm build:server-counter`), jobs share the WP16 queue (`apps/storage-server/src/audio/tts-jobs.ts`, `tts-routes.ts`, `tts-models.ts`, `src/voices/`), the PC runs the TTS program (`apps/gpu-worker/tts/`: Irodori-TTS in Docker, image `ttsu-irodori:<n>` built by `main.js build-tts`; models in the shared `C:\Data\LLM\Models\ttsu-reader-tts`). The model is chosen per book (list in Settings > Audiobooks), with a Preview. Results go through `audio-write.ts` into a new folder `japanese-generated/<Author>/<Title>[ (vN)]/` and are linked automatically.

WP16 "Make subtitles on the PC": the server's job queue (`apps/storage-server/src/audio/subtitle-jobs.ts`, `worker-routes.ts`; worker tokens `cli token worker` reach only `/api/v1/worker/*`), the PC worker `apps/gpu-worker` (Node, no dependencies; runs the pinned SubPlz image with Docker Desktop on the WSL 2 engine, cache folder mounted at `/config`; works in either of the user's two Windows accounts, one worker at a time), and the book page panel and Settings > Audiobooks section in the web app. Results go through `audio-write.ts` into `japanese-srt/_generated/` and are linked automatically.

WP14 "Enrich last Anki card" lives in `apps/web/src/lib/anki/` (its own AnkiConnect client; whispersync's `anki.ts` and its Ctrl+E / Alt+E are unchanged), `routes/open` (card links `/open?book=<library id>&pos=<char>`) and the server's read-only `src/audio/clip-service.ts` (sentence audio, ffmpeg to stdout).

1. **WP15a** `wp15a-audio-index`: server only. Read-only audiobooks mount, folder and subtitle index, matcher, search, streaming.
2. **WP15b** `wp15b-audio-picker`: audio links, the confirmation picker on book details (never auto-link; separate subtitle step; "No audiobook"), Settings > Audiobooks (`/audiobooks` forwards there).
3. **WP15c** `wp15c-whispersync-links`: whispersync plays linked audio (single-file audiobooks only); its position, saved subtitles and saved match move off the old sync. Reset match applies on every device (decided with the user); otherwise match, re-match and reset are unchanged.
4. **WP15d dropped** (decided with the user 2026-11-11): the 3 old-sync books are finished, so their whispersync data is not moved and they are not linked. Their 3 `audio_*` copies (~1.3 GB) stay in the old-sync folder for the later cleanup with the rest of it.
5. **WP15e** `wp15e-remove-old-sync`: remove the old sync code and `/manage` (`/manage` redirects to `/library`); "Remove from this device" and a built-in "On this device" collection replace the Manager. The old sync's files on the NAS stay for a later cleanup. Also remove the empty "From the old sync" section of Settings > Audiobooks.
6. **WP15f** `wp15f-multi-file-audio`: links to one file of a folder, the per-file picker with a copies hint, "Merge into one file" (server ffmpeg job, one chapter per file, saved next to the originals, auto-linked; the subtitle step still asks), guarded write access.

Since WP15f the audiobooks mount is writable with guardrails (see "Multi-file audiobooks: WP15f decisions" and its implementation section): every write goes through `apps/storage-server/src/audio/audio-write.ts` (a test enforces this), create-new-files only, never overwrite/rename/delete existing files, limited to merged files in a book's folder, `japanese-srt/_generated/` and `japanese-generated/`. New destructive actions use `confirmDestructive` / `inline-confirm.svelte` with their text in `lib/confirm/confirm-copy.ts`.

The old sync is off. Still don't change the migration pages or the old-sync switch. Existing `stat-day` rows stay frozen as "before device tracking": never delete or rewrite them. Don't rewrite existing position records.

Stop condition: each work package is finished on its own branch, with a summary of what changed, how it was verified, and anything unexpected. Then stop for review. Do not start the next work package or phase without approval.

## Standing rules

- Never write into or near Calibre-managed ebook folders. Calibre libraries are read-only to this app: the storage server and the web app never write to them. The only writer is the cleanup apply sidecar (`ttsu-cleanup-apply`), only through the running Calibre content server via `calibredb --with-library http://…`, and only for applied cleanup batches (decided by the user for the Phase 6 cleanup, 2026-11-13).
- Preserve whispersync's match/re-match/reset semantics; do not "improve" them.
- Keep audio out of the replicator.
- The app is served over plain http (HTTPS deferred). Feature-detect every secure-context API (service worker, `navigator.storage` persist/estimate, Web Locks, `crypto.randomUUID`, Clipboard API) and degrade gracefully; it must switch on automatically when `isSecureContext` is true.
- If a component secretly depended on the removed sandbox/chrome.runtime, STOP and report.
- Execute one phase (and one work package) at a time; honor each stop condition.
- Keep the browser tab title format `<book title> | ッツ Ebook Reader` (`lib/functions/format-page-title.ts`). Yomitan copies it into the user's Anki Comment field.
- Stats and tracking code must never block or break reading: isolate it and catch its errors.
- Behavior thresholds (timeouts, counts) are user settings, not hardcoded values.
- Work on a branch per work package; never commit directly to the main branch. Commits follow Conventional Commits (commitlint is configured).
- Before merging anything to `main`, run the full builds, not only the tests: `pnpm build` for the web app and `npm run build` (tsc, as used by the Docker image) for the storage server. Tests run transpile-only and miss type errors (this broke the Docker build once, fixed in `96a16b2`).

## Repo facts

- pnpm workspace. `apps/web` (SvelteKit 2, Svelte 4, Vite 5) and `apps/storage-server` (Express file server), plus two Node programs without dependencies whose tests run in the storage server's suite: `apps/gpu-worker` (the PC) and `apps/cleanup-apply` (the cleanup's apply sidecar; `tests/wp20a-sidecar.test.ts` with a stand-in calibredb).
- Root scripts: `pnpm dev`, `pnpm build`, `pnpm check` (eslint), `pnpm lint`, `pnpm format`. In `apps/web`: `pnpm check` (svelte-check).
- Tests: Vitest in both apps (`pnpm test` in `apps/web`, `npm test` in `apps/storage-server`). `pnpm test:parity` in `apps/web` is opt-in and needs the NAS shares.
- The server counts characters with a bundle of the web app's EPUB import code (`apps/storage-server/vendor/epub-count.cjs`). After changing that code, run `pnpm build:server-counter` in `apps/web` (a test fails otherwise), and bump `EPUB_COUNT_VERSION` in `count-epub.ts` if counts can change.
- The server parses library searches with a bundle of the web app's parser (`apps/storage-server/vendor/library-query.cjs`, from `apps/web/src/lib/library/query/`). After changing it, run `pnpm build:server-query` in `apps/web` (a test fails otherwise).
