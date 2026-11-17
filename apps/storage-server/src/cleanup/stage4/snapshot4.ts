/**
 * What stage 4 reads from the reader's metadata.db snapshot beyond stage 2's book facts: the
 * series, its number and the description (comments), the current values its proposals start
 * from. Read-only.
 */
import Database from 'better-sqlite3';

export interface Stage4Extras {
  series: string | null;
  seriesIndex: number | null;
  comments: string | null;
}

export function readStage4Extras(file: string): Map<number, Stage4Extras> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const out = new Map<number, Stage4Extras>();
    for (const r of db.prepare('SELECT id, series_index FROM books').all() as {
      id: number;
      series_index: number | null;
    }[]) {
      out.set(r.id, { series: null, seriesIndex: r.series_index, comments: null });
    }
    for (const r of db
      .prepare('SELECT l.book, s.name FROM books_series_link l JOIN series s ON s.id = l.series')
      .all() as { book: number; name: string }[]) {
      const e = out.get(r.book);
      if (e) e.series = r.name;
    }
    for (const r of db.prepare('SELECT book, text FROM comments').all() as {
      book: number;
      text: string | null;
    }[]) {
      const e = out.get(r.book);
      if (e) e.comments = r.text;
    }
    // A book without a series has Calibre's default number (1.0); it means nothing then.
    for (const e of out.values()) if (e.series === null) e.seriesIndex = null;
    return out;
  } finally {
    db.close();
  }
}
