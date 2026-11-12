# CLAUDE.md

Self-hosted fork of ッツ (ttu) Ebook Reader with integrated whispersync, served from the user's Unraid NAS.
The app works today. Every change must be intentional and must not break reading.

## Design docs (read before starting any work)

- `docs/design/design-doc.md`: the agreed design (v1), organized by system. Section 13 maps it to current code; section 14 lists risks.
- `docs/design/dependency-map.md`: work packages (WP1-WP19), their prerequisites and the agreed phase order.
- `docs/design/decisions.md`: the log of individual decisions and verified facts about the code and the NAS.

If code and docs disagree, or a task needs a decision the docs don't cover, STOP and ask. Do not guess or silently extend the design.

## Current phase

**Phase 5** (Phases 0-4 and WP19 are done and merged). Decisions: `docs/design/decisions.md`, "Phase 5 decisions". Agreed order, one work package at a time: **WP15** audio linking → **WP15f** multi-file audiobooks (merge button, per-file picker; added 2026-11-12) → **WP14** "Enrich last card" → **WP16** GPU worker and job queue → **WP17** generated audiobooks.

WP15 and WP15f are done, merged and pushed (WP15f merged at e2868c9 on 2026-11-12; schema v13). Next: **WP14**, only after the user approves starting it.

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

- Never write into or near Calibre-managed ebook folders. Calibre libraries are read-only to this app.
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

- pnpm workspace. `apps/web` (SvelteKit 2, Svelte 4, Vite 5) and `apps/storage-server` (Express file server).
- Root scripts: `pnpm dev`, `pnpm build`, `pnpm check` (eslint), `pnpm lint`, `pnpm format`. In `apps/web`: `pnpm check` (svelte-check).
- Tests: Vitest in both apps (`pnpm test` in `apps/web`, `npm test` in `apps/storage-server`). `pnpm test:parity` in `apps/web` is opt-in and needs the NAS shares.
- The server counts characters with a bundle of the web app's EPUB import code (`apps/storage-server/vendor/epub-count.cjs`). After changing that code, run `pnpm build:server-counter` in `apps/web` (a test fails otherwise), and bump `EPUB_COUNT_VERSION` in `count-epub.ts` if counts can change.
- The server parses library searches with a bundle of the web app's parser (`apps/storage-server/vendor/library-query.cjs`, from `apps/web/src/lib/library/query/`). After changing it, run `pnpm build:server-query` in `apps/web` (a test fails otherwise).
