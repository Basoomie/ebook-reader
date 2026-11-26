/**
 * The series-arrival alert's words (docs/design/series-arrivals.md 3.3): one message for every
 * book a round told, at most 3 lines, and one digest line per series.
 */
import { LINKS, listItems } from '../notifications/messages';

export interface ToldBook {
  id: string;
  title: string;
  libraryId: string;
  seriesName: string;
  seriesIndex: number | null;
}

/** "16", "6.5". */
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/** "1-3, 5, 6.5": whole numbers in a row as a range, in order. */
export function formatNumbers(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    if (Number.isInteger(sorted[i])) {
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    }
    // Three or more in a row make a range; two stay "1, 2".
    parts.push(
      j >= i + 2
        ? `${formatNumber(sorted[i])}-${formatNumber(sorted[j])}`
        : sorted
            .slice(i, j + 1)
            .map(formatNumber)
            .join(', '),
    );
    i = j + 1;
  }
  return parts.join(', ');
}

export function seriesLink(name: string): string {
  return `/library?${new URLSearchParams({ tab: 'series', group: name }).toString()}`;
}

/** The newest-added Library (several series). */
export const ADDED_LINK = '/library?sort=added-desc';

interface Group {
  name: string;
  books: ToldBook[];
}

function groups(books: ToldBook[]): Group[] {
  const by = new Map<string, Group>();
  for (const b of books) {
    const key = `${b.libraryId}\u0000${b.seriesName}`;
    const g = by.get(key) ?? { name: b.seriesName, books: [] };
    g.books.push(b);
    by.set(key, g);
  }
  // In a steady order: series by name, books by number (books without one last).
  const order = (x: ToldBook) => x.seriesIndex ?? Infinity;
  for (const g of by.values()) g.books.sort((x, y) => order(x) - order(y) || 0);
  return [...by.values()].sort((x, y) => x.name.localeCompare(y.name, 'ja'));
}

/** "薬屋のひとりごと 16", "転生した大聖女… 1-3, 2 without a number": a series and its books. */
function groupText(g: Group): string {
  const numbers = g.books.filter((b) => b.seriesIndex !== null).map((b) => b.seriesIndex!);
  const loose = g.books.length - numbers.length;
  const parts = [numbers.length ? formatNumbers(numbers) : ''];
  if (loose) parts.push(numbers.length ? `and ${loose} more` : `${loose} new`);
  return `${g.name} ${parts.filter(Boolean).join(' ')}`.trim();
}

export interface SeriesArrivalMessage {
  lines: string[];
  link: string;
  digest: { text: string; link: string }[];
}

export function buildMessage(books: ToldBook[]): SeriesArrivalMessage | null {
  if (!books.length) return null;
  const gs = groups(books);
  const digest = gs.map((g) => ({
    text: `New in ${g.name}: ${groupText(g).slice(g.name.length).trim()}`,
    link: g.books.length === 1 ? LINKS.book(g.books[0].id) : seriesLink(g.name),
  }));
  if (books.length === 1) {
    const b = books[0];
    return {
      lines: [`New in a series you’re reading: ${groupText(gs[0])}`, b.title],
      link: LINKS.book(b.id),
      digest,
    };
  }
  const head = `${books.length} new volumes in series you’re reading`;
  const list =
    gs.length <= 2
      ? gs.map(groupText).join(' · ')
      : `${listItems(gs.map(groupText), 2).replace(/ and (\d+) more$/, ' and $1 more series')}`;
  return {
    lines: [head, list],
    link: gs.length === 1 ? seriesLink(gs[0].name) : ADDED_LINK,
    digest,
  };
}
