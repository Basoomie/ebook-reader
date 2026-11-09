# CLAUDE.md

Self-hosted fork of ッツ (ttu) Ebook Reader with integrated whispersync, served from the user's Unraid NAS.
The app works today. Every change must be intentional and must not break reading.

## Design docs (read before starting any work)

- `docs/design/design-doc.md`: the agreed design (v1), organized by system. Section 13 maps it to current code; section 14 lists risks.
- `docs/design/dependency-map.md`: work packages (WP1-WP18), their prerequisites and the agreed phase order.
- `docs/design/decisions.md`: the log of individual decisions and verified facts about the code and the NAS.

If code and docs disagree, or a task needs a decision the docs don't cover, STOP and ask. Do not guess or silently extend the design.

## Current phase

**Phase 0**:

1. **WP3a**: shared loader and character counter, plus a parity test against existing books.
2. **WP10 (hands-free tracker only)**: auto-start and idle-pause on by default, auto-resume after an automatic pause, one-tap toggle. All thresholds are per-device settings.

Stop condition: each work package is finished on its own branch, with a summary of what changed, how it was verified, and anything unexpected. Then stop for review. Do not start the next work package or phase without approval.

## Standing rules

- Never write into or near Calibre-managed ebook folders. Calibre libraries are read-only to this app.
- Preserve whispersync's match/re-match/reset semantics; do not "improve" them.
- Keep audio out of the replicator.
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
