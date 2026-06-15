This repo is mid-integration. Standing rules:
- Never write into or near Calibre-managed ebook folders.
- Preserve whispersync's match/re-match/reset semantics; do not "improve" them.
- Keep audio out of the replicator.
- If a component secretly depended on the removed sandbox/chrome.runtime, STOP and report.
- Execute one phase at a time; honor each phase's stop condition.