# CLAUDE.md

Self-hosted fork of ッツ (ttu) Ebook Reader with integrated whispersync, served from the user's Unraid NAS.
The app works today. Every change must be intentional and must not break reading.

## Design docs (read before starting any work)

- `docs/design/design-doc.md`: the agreed design (v1), organized by system. Section 13 maps it to current code; section 14 lists risks.
- `docs/design/dependency-map.md`: work packages (WP1-WP18), their prerequisites and the agreed phase order.
- `docs/design/decisions.md`: the log of individual decisions and verified facts about the code and the NAS.

If code and docs disagree, or a task needs a decision the docs don't cover, STOP and ask. Do not guess or silently extend the design.

## Current phase

**WP19: catalogue refresh**, before Phase 5 (Phases 0-4 are done and merged). Decisions: `docs/design/decisions.md`, "WP19: plan". Only the catalogue pages (Home, Library, Collections, Notes, Stats, book details); never the reader. Agreed order, one branch each:

1. **WP19a**: Library behaviour: sorts, result counts, loading on scroll, cover size, author links, Connection and Migration moved to Settings.
2. **WP19b**: the new look (draft A "蔵書 Archive", navy and cream; light, dark and E-ink), hover states, card ⋮ menu.
3. **WP19c**: book details page.
4. **WP19d**: highlights and notes refresh (decisions: "WP19d: highlights and notes refresh, plan"), three branches: `wp19d-notes-page` (Notes page redesign, CSV export), `wp19d-quote-image` (quote images), `wp19d-reader-bar` (the reader's highlight bar). The reader bar branch is the one approved exception to "never the reader": restyle and a Quote image button only; the bar stays docked and its behaviour is unchanged.

Confirmations before destructive actions (`wp19-confirm-destructive`; decisions: "WP19: confirmations before destructive actions") are a second approved exception: a confirm step (or Undo) in front of existing actions, also in the reader, whispersync and the Book Manager; never the migration pages. New destructive actions use `confirmDestructive` / `inline-confirm.svelte` with their text in `lib/confirm/confirm-copy.ts`.

Phase 5 (WP14-WP17) comes after WP19. The old sync is off (whispersync still uses it for matches until WP15). Still don't change the migration pages or the old-sync switch. Existing `stat-day` rows stay frozen as "before device tracking": never delete or rewrite them. Don't rewrite existing position records.

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
