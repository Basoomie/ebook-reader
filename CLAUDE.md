# CLAUDE.md

Self-hosted fork of ッツ (ttu) Ebook Reader with integrated whispersync, served from the user's Unraid NAS.
The app works today. Every change must be intentional and must not break reading.

## Design docs (read before starting any work)

- `docs/design/design-doc.md`: the agreed design (v1), organized by system. Section 13 maps it to current code; section 14 lists risks.
- `docs/design/dependency-map.md`: work packages (WP1-WP18), their prerequisites and the agreed phase order.
- `docs/design/decisions.md`: the log of individual decisions and verified facts about the code and the NAS.

If code and docs disagree, or a task needs a decision the docs don't cover, STOP and ask. Do not guess or silently extend the design.

## Current phase

**Phase 2** (Phase 0 and Phase 1, WP1, WP2, WP6 interim option and the minimal library list, are done and merged):

1. **WP4**: sync engine. Device records, local outbox, pull/push, local mirrors, global vs per-device settings. The legacy file sync stays the source of truth for reading data until WP5.
2. **WP5**: migration of current books, position, bookmark, stats, goals and settings; retire the old file sync only after it is verified.
3. **WP9**: "Continue from...?" position prompt.

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
- No test framework is installed yet. WP3a needs one; propose the choice (e.g. Vitest) before adding it.
