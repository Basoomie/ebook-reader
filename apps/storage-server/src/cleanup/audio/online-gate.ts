/**
 * Stage 4's gate (WP21c): the lookups scored against the labeled books of the reference sample
 * (`labels.json` "books", labels final 2026-11-18). Each book's `src` is the store record it is
 * (audible:ASIN, audiobook.jp:id, kikubon:id) or null for none; kind "ai" and the radio bonus
 * clips expect no lookup at all.
 *
 * Decided with the user (2026-11-19): the gate passes only when no automatic match differs from
 * its label (another record, or a record where the label has none). A wrong match is worse than
 * a review item, so review and unknown are never misses. Pure: the caller follows each label's
 * torrent path to its lookup unit.
 */

export interface LabeledBook {
  id: string;
  kind: string;
  src: string | null;
  title?: string;
  /** The book's torrent file or folder (relative to the torrents root). */
  torrent: string;
}

export interface UnitOutcome {
  unitKey: string;
  kind: 'lookup' | 'none_expected';
  class: 'auto' | 'review' | 'unknown' | 'none_expected' | null;
  /** The store record found (the best candidate for review): "audible:B0…", … */
  record: string | null;
  reason: string | null;
}

export interface OnlineGateBook {
  id: string;
  title: string | null;
  expected: string;
  got: string;
  /** Which source the label names (audible, audiobook.jp, kikubon, none). */
  source: string;
  outcome: 'auto_agrees' | 'review' | 'unknown' | 'none_expected' | 'not_found' | 'miss';
  ok: boolean;
  note?: string;
}

export interface OnlineGateResult {
  passed: boolean;
  checked: number;
  misses: OnlineGateBook[];
  /** Per label source: auto matches agreeing, review, unknown (and the rest). */
  bySource: Record<string, Record<string, number>>;
  results: OnlineGateBook[];
  error: string | null;
}

/** "audible:B0…" from a label, normalised the way records are named here. */
export function labelRecord(src: string | null): string | null {
  if (!src) return null;
  const m = /^(audible|audiobook\.jp|audiobookjp|kikubon):\s*(.+)$/i.exec(src.trim());
  if (!m) return src.trim();
  const source = m[1].toLowerCase().replace('audiobook.jp', 'audiobookjp');
  return `${source}:${m[2].trim()}`;
}

export function noLookupExpected(b: LabeledBook): boolean {
  return b.kind === 'ai' || /radio/i.test(b.kind);
}

export function scoreOnlineGate(
  books: LabeledBook[],
  unitOf: (torrent: string) => UnitOutcome | null,
): OnlineGateResult {
  const results: OnlineGateBook[] = [];
  const bySource: Record<string, Record<string, number>> = {};
  for (const b of books) {
    const expected = labelRecord(b.src);
    const source = noLookupExpected(b)
      ? 'no lookup'
      : expected
        ? expected.split(':')[0].replace('audiobookjp', 'audiobook.jp')
        : 'none';
    const u = unitOf(b.torrent);
    let outcome: OnlineGateBook['outcome'];
    let ok = true;
    let got = '';
    let note: string | undefined;
    if (!u) {
      outcome = 'not_found';
      got = 'not found in stages 2-3';
      ok = false;
      note = 'the labeled book could not be followed to a recording';
    } else if (u.kind === 'none_expected' || u.class === 'none_expected') {
      got = 'no lookup';
      outcome = 'none_expected';
      ok = noLookupExpected(b);
      if (!ok) note = 'looked up nowhere, but the label is an ordinary book';
    } else if (u.class === 'auto') {
      got = u.record ?? '?';
      if (noLookupExpected(b)) {
        ok = false;
        note = 'an automatic match for a book that has no store record by nature';
      } else ok = got === expected;
      outcome = ok ? 'auto_agrees' : 'miss';
      if (!ok && !note) note = expected ? `labeled ${expected}` : 'labeled: no store record';
    } else if (u.class === 'review') {
      got = `review (${u.reason ?? '?'})${u.record ? `: ${u.record}` : ''}`;
      outcome = 'review';
    } else if (u.class === 'unknown') {
      got = `unknown${u.reason ? ` (${u.reason})` : ''}`;
      outcome = 'unknown';
    } else {
      got = 'not decided yet';
      outcome = 'unknown';
      ok = false;
      note = 'the lookup has not finished';
    }
    const r: OnlineGateBook = {
      id: b.id,
      title: b.title ?? null,
      expected: noLookupExpected(b) ? 'no lookup' : (expected ?? 'no store record'),
      got,
      source,
      outcome,
      ok,
      ...(note ? { note } : {}),
    };
    results.push(r);
    const row = (bySource[source] ??= {});
    row[outcome] = (row[outcome] ?? 0) + 1;
  }
  const misses = results.filter((r) => !r.ok);
  return {
    passed: misses.length === 0 && results.length > 0,
    checked: results.length,
    misses,
    bySource,
    results,
    error: null,
  };
}
