# CLAUDE.md

Self-hosted fork of ッツ (ttu) Ebook Reader with integrated whispersync, served from the user's Unraid NAS.
The app works today. Every change must be intentional and must not break reading.

## Design docs (read before starting any work)

- `docs/design/design-doc.md`: the agreed design (v1), organized by system. Section 13 maps it to current code; section 14 lists risks.
- `docs/design/dependency-map.md`: work packages (WP1-WP18), their prerequisites and the agreed phase order.
- `docs/design/decisions.md`: the log of individual decisions and verified facts about the code and the NAS.

If code and docs disagree, or a task needs a decision the docs don't cover, STOP and ask. Do not guess or silently extend the design.

## Current phase

**Phase 3** (Phases 0-2 are done and merged). The WP5 side-by-side week is running: do not touch the migration, the old-sync switch or the check page. WP7 and WP8 are split because they depend on each other (status chips; smart collections use the search parser). Agreed order:

1. **WP3b**: server character-count job; counts in the catalog API and the library list.
2. **WP8a**: book state. Status (Reading set on the first page turn), favorite, read-throughs and "Start over", manual completion, per-book blur value; sync kinds; minimal UI.
3. **WP7a**: Library browse and search. Search language, browse tabs, grouped cards and collages, grid/list, info line, status and built-in filter chips, cover blur with tag rules, bulk status/favorite/blur.
4. **WP8b**: collections. Manual, smart (WP7a's parser), built-ins, Collections page, "add to collection".
5. **WP7b**: Home rows, navigation, upload with duplicate check.

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

## Repo facts

- pnpm workspace. `apps/web` (SvelteKit 2, Svelte 4, Vite 5) and `apps/storage-server` (Express file server).
- Root scripts: `pnpm dev`, `pnpm build`, `pnpm check` (eslint), `pnpm lint`, `pnpm format`. In `apps/web`: `pnpm check` (svelte-check).
- Tests: Vitest in both apps (`pnpm test` in `apps/web`, `npm test` in `apps/storage-server`). `pnpm test:parity` in `apps/web` is opt-in and needs the NAS shares.
- The server counts characters with a bundle of the web app's EPUB import code (`apps/storage-server/vendor/epub-count.cjs`). After changing that code, run `pnpm build:server-counter` in `apps/web` (a test fails otherwise), and bump `EPUB_COUNT_VERSION` in `count-epub.ts` if counts can change.
