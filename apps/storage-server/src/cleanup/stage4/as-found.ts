/**
 * Calibre's title and authors as stage 4 found them (series-order follow-up, found at stop 2).
 *
 * Stage 4's records read Calibre's title and authors from the reader's snapshot of metadata.db.
 * After stage 4 On wrote them, a record built again (the rules version bump, the repick) read
 * stage 4's own values as Calibre's: 11,991 books' AI evidence changed with nothing new in it,
 * and the AI step asked both models about them again. Where stage 4 wrote a field and Calibre
 * still holds exactly what it wrote, the value before the write is Calibre's own; a value the
 * user changed since (or an undone write) is Calibre's as it is now.
 */

export interface Stage4Write {
  field: string;
  old_json: string;
  new_json: string;
}

export interface CalibreAsFound {
  title: string;
  authors: string[];
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

const asAuthors = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

/**
 * `writes`: stage 4's writes of the book's title and authors that were not undone, oldest first.
 * The value before the first one stands for Calibre's when Calibre holds the last one's value.
 */
export function calibreAsFound(current: CalibreAsFound, writes: Stage4Write[]): CalibreAsFound {
  const out = { title: current.title, authors: current.authors };
  const title = writes.filter((w) => w.field === 'title');
  if (title.length) {
    const before = parse(title[0].old_json);
    const written = parse(title[title.length - 1].new_json);
    if (typeof before === 'string' && written === current.title) out.title = before;
  }
  const authors = writes.filter((w) => w.field === 'authors');
  if (authors.length) {
    const before = asAuthors(parse(authors[0].old_json));
    const written = asAuthors(parse(authors[authors.length - 1].new_json));
    // Calibre files an author under an existing author's spelling when the two differ only by
    // case (stage 4 wrote 株式会社newspiral, Calibre holds 株式会社NewSpiral).
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (
      before &&
      written &&
      written.length === current.authors.length &&
      written.every((a, i) => same(a, current.authors[i]))
    )
      out.authors = before;
  }
  return out;
}
