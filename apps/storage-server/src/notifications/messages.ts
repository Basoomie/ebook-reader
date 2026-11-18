/**
 * The words of the messages (anti-fatigue rules, user 2026-11-17): at most 3 lines: what
 * happened, which item, and a link to the page where it's fixed. Plain words, no design-doc
 * names.
 */

export interface Message {
  event: string;
  /** What happened, then (optional) which item. */
  lines: string[];
  /** A path in the web app (joined to the link address), or null. */
  link: string | null;
}

export const LINKS = {
  book: (id: string) => `/library/book?id=${encodeURIComponent(id)}`,
  pc: '/settings?tab=audiobooks',
  cleanup: '/cleanup',
  audioCleanup: '/cleanup?tab=audiobooks',
  data: '/settings?tab=data',
  diagnostics: '/settings?tab=diagnostics',
  notifications: '/settings?tab=notifications',
};

export const JOB_KIND_LABEL: Record<string, string> = {
  sync_subtitles: 'Subtitles',
  generate_audiobook: 'Audiobook',
  preview_audiobook: 'Audiobook preview',
  voice_sample: 'Voice sample',
  sentence_audio: 'Sentence audio',
  attribute_speakers: 'Speaker detection',
};

/** "A", "A and B", "A, B and 3 more". */
export function listItems(items: string[], max = 2): string {
  const unique = [...new Set(items.filter((s) => s))];
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0];
  if (unique.length <= max) return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
  return `${unique.slice(0, max).join(', ')} and ${unique.length - max} more`;
}

export function clip(text: string, max = 200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function render(m: Message, linkBase: string): string {
  const lines = m.lines.filter((l) => l).slice(0, m.link ? 2 : 3);
  if (m.link) lines.push(`${linkBase}${m.link}`);
  return lines.join('\n');
}

/** Why a Calibre cleanup stage paused, in plain words. */
export const STAGE_PAUSE_TEXT: Record<string, string> = {
  library_changed: 'books changed in Calibre since the analysis',
  ingest_mismatch: "the reader's library index doesn't show the last batch",
  not_identical: 'copies are no longer identical',
  batch_failed: 'a batch failed',
  mass_missing: 'the reader reports many books gone from Calibre',
};

export function stagePauseText(reason: string): string {
  return STAGE_PAUSE_TEXT[reason] ?? reason.replace(/_/g, ' ');
}

export function hoursText(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 1) return `${Math.round(h)} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}
