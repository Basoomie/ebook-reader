/**
 * WP20e: the check "Changed in Calibre after the cleanup wrote it" measured on a copy of the
 * finished stage-4 cleanup.db, with the old comparison (JSON text) and the new one
 * (stillAsWritten). Covers are read from Calibre's cover.jpg (read-only; the library share).
 * Nothing is written anywhere.
 *
 *   npx ts-node --transpile-only scripts/wp20e-changed-check.ts --db <copy/cleanup.db>
 *     --metadata <copy/metadata.db> --library <library folder> [--out report.json]
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { differenceHash } from '../src/cleanup/file-metadata';
import { stillAsWritten } from '../src/cleanup/stage4/proposals';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const db = new Database(arg('db')!, { readonly: true });
  const meta = new Database(arg('metadata')!, { readonly: true });
  const lib = arg('library')!;
  const sameDistance = 5;
  const rows = db
    .prepare(
      `SELECT p.field, p.calibre_uuid, p.old_json, p.class, p.review_reason, p.evidence_json, a.value_json,
              a.last_modified_after
       FROM proposed_changes p JOIN applied_values a
         ON a.library_id = p.library_id AND a.calibre_uuid = p.calibre_uuid AND a.field = p.field
       WHERE p.stage = 4 AND p.state = 'proposed'`,
    )
    .all() as {
    field: string;
    calibre_uuid: string;
    old_json: string;
    class: string;
    review_reason: string | null;
    evidence_json: string;
    value_json: string;
    last_modified_after: string | null;
  }[];
  const out: Record<string, Record<string, number>> = {};
  const changed: unknown[] = [];
  const t0 = Date.now();
  let read = 0;
  for (const r of rows) {
    const o = (out[r.field] ??= {
      proposals: 0,
      flaggedBefore: 0,
      flaggedNow: 0,
      flaggedBeforeUnchangedNow: 0,
      coverIdentical: 0,
      coverDhashSame: 0,
      coverUnreadable: 0,
    });
    o.proposals++;
    const flaggedBefore = r.review_reason === 'Changed in Calibre after the cleanup wrote it';
    if (flaggedBefore) o.flaggedBefore++;
    const written = JSON.parse(r.value_json);
    const current = JSON.parse(r.old_json);
    let cover;
    if (r.field === 'cover') {
      const b = meta
        .prepare('SELECT path, has_cover, last_modified FROM books WHERE uuid = ?')
        .get(r.calibre_uuid) as
        | { path: string; has_cover: number; last_modified: string }
        | undefined;
      let now = null;
      if (b?.has_cover) {
        try {
          const bytes = readFileSync(path.join(lib, b.path, 'cover.jpg'));
          read++;
          now = {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            dhash: await differenceHash(bytes),
          };
        } catch {
          o.coverUnreadable++;
        }
      }
      const ev = JSON.parse(r.evidence_json) as { fileDhash?: string | null };
      if (now && now.sha256 === written.sha256) o.coverIdentical++;
      cover = {
        hasCover: !!b?.has_cover,
        now,
        fileDhash: ev.fileDhash ?? null,
        sameDistance,
        lastModified: b?.last_modified ?? null,
        writtenLastModified: r.last_modified_after,
      };
      if (now && now.sha256 !== written.sha256 && stillAsWritten('cover', written, current, cover))
        o.coverDhashSame++;
    }
    const still = stillAsWritten(r.field, written, current, cover);
    if (!still) {
      o.flaggedNow++;
      if (changed.length < 50)
        changed.push({
          field: r.field,
          uuid: r.calibre_uuid,
          written,
          current: cover?.now ?? current,
        });
    } else if (flaggedBefore) o.flaggedBeforeUnchangedNow++;
  }
  const report = {
    rows: rows.length,
    coversRead: read,
    seconds: (Date.now() - t0) / 1000,
    out,
    changed,
  };
  console.log(JSON.stringify(report, null, 1));
  if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
}

void main();
