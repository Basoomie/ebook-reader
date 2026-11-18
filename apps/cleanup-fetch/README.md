# ttsu-cleanup-fetch

The library cleanup's fetch container (WP20d, stage 4: online sources). It runs inside gluetun's
network, so Amazon, BOOK☆WALKER, RanobeDB, Bookmeter, Natively and Web NDL Authorities see the
VPN's address, never the home one.

- **Stateless.** The reader's storage server owns the queue (cleanup.db) and every site's pace:
  the fetcher claims at most one due request per site, fetches it, compresses the answer
  (brotli) and posts it back with its lease token. While the server is away (the nightly backup
  stop) the answer is kept and posted again. Restarts lose nothing.
- **Only allowlisted https hosts** (`src/hosts.ts`), redirects only within them, the reference
  run's browser headers. Challenge pages are never answered: the server backs the site off.
- **One fetcher at a time.** Its id is `FETCHER_ID` (kept across restarts); a second fetcher stays
  idle while the first one's heartbeat is fresh, and the server gives one request per site at a
  time at the site's pace whoever asks.
- **Generated author readings** for names Web NDL Authorities doesn't know: SudachiPy 0.6.10 with
  sudachidict-core 20260428 (the PC TTS's pins), `sudachi/readings.py`, only for names written in
  kana and kanji; always marked for spot checks.
- No volumes, read-only root, user 99:100, `/tmp` in memory.

Environment: `TTSU_URL` (the storage server as reached from inside gluetun, e.g.
`http://192.168.1.5:3081`), `FETCH_TOKEN` (`cli token fetch "<label>"`).

Tests run in the storage server's suite (`tests/wp20d-stage4.test.ts` drives this code against a
stand-in internet).
