/**
 * WP21f-2 stop B2: store records chosen by the user for a recording stage 4 can't match by
 * itself, keyed by a torrent file of the recording (like `library-keep.ts`). Stage 4 reads the
 * record and takes it as decided (`via: 'correction'`), whatever its checks say; the record's
 * checks are still shown. Every entry is researched and approved by the user before it is added;
 * the evidence is in `decisions.md`, "WP21f-2", "Stop B2".
 */
import type { StoreSource } from './online-pages';

export interface RecordCorrection {
  /** A torrent file of the recording, relative to the torrents root. */
  torrent: string;
  source: StoreSource;
  id: string;
  /** Why (shown with the unit's detail). */
  reason: string;
  decided: string;
}

export const RECORD_CORRECTIONS: readonly RecordCorrection[] = [
  {
    // Built as 城谷歩's 実説 城谷怪談「影踏みチイちゃん」 (Audible B07DRN7MB7, a 26-minute ghost
    // story) from the old Audiobookshelf ASIN. It is 横山秀夫's 影踏み: the same 19-person cast
    // as audiobook.jp 235405 (池田秀一, 関智一, …), and stage 3's fingerprints find it the same
    // recording as `[横山 秀夫] 影踏み [audiobook.jp 235139].m4b`, which matches 235405 (start
    // 1.00, end 0.992 shifted 333 s, middle 0.93). It is 5.6 min shorter (8:43:00 against
    // 8:48:37), past the 5-minute length check, so the search never read the record.
    torrent:
      'TMW Japanese Audiobooks Collection (Part 12) - General Fiction (audiobook.jp)/影踏み/影踏み.m4b',
    source: 'audiobookjp',
    id: '235405',
    reason: 'Your choice (2026-11-21): audiobook.jp 235405, 横山秀夫',
    decided: '2026-11-21',
  },
];

/** The record chosen for a recording whose torrent files are `rels`, else null. */
export function recordCorrectionFor(rels: string[]): RecordCorrection | null {
  for (const c of RECORD_CORRECTIONS) if (rels.includes(c.torrent)) return c;
  return null;
}
