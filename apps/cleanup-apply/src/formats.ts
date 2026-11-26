/**
 * 1.8.0 (books without an EPUB, docs/design/non-epub-books.md): the sidecar's half of the pass.
 *
 * Conversion jobs (Preview and On alike; nothing is written to Calibre): the server hands out one
 * book at a time (/cleanup-apply/formats/claim). In this sidecar's own work folder
 * (<formatTmpDir>/ttsu-format-<job>/, emptied first and removed after):
 *   export   the book's one file, `calibredb export --formats <fmt>` (a read of Calibre);
 *   inspect  what the file is (formats-helper.py with calibre's Python: an archive's entries,
 *            a Kindle file's DRM flag), decided by decideArchive (pure, below);
 *   convert  `ebook-convert` inside the work folder only (its input, output and temp files),
 *            or the one EPUB inside an archive extracted as it is;
 *   measure  the text of the source and of the EPUB, both by calibre's own text output and
 *            counted with the reader's rule (so furigana and markup count alike on both sides);
 *   upload   the EPUB to the server, which checks it with the reader's own import.
 *
 * Write batches (stage 12, FORMATS_STAGE), one book per item, each step reported first:
 *   convert  pending -> verified (the record as selected, still without an EPUB) -> written (the
 *            EPUB the server checked, downloaded into ttsu-format-item-<item>/ and its SHA-256
 *            checked, added with `add_format --dont-replace`); Undo: `remove_format <id> EPUB`.
 *   fold     a proven copy: pending -> verified (both records as selected) -> exported (the copy
 *            exported into the quarantine with stage 1's command, its file's SHA-256 checked) ->
 *            tagged (the copy's file added to its twin when the twin has no such format, the
 *            user's own tags copied to the twin) -> removed (Calibre's trash). Undo: the copy back
 *            (stage 1's restore), then the format it gave the twin taken off again.
 * A write's error or timeout is never taken as "not done" (WP20 lessons 1): Calibre is looked at.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Batch, BatchItem, StepReport } from './api';
import { BOOK_FORMATS, calibreTime, shorten, type Calibredb, type Login } from './calibredb';
import { exists, sha256File, type Quarantine } from './quarantine';

export const FORMATS_STAGE = 12;

// ---------------------------------------------------------------- what a file is (pure)

export interface ArchiveEntry {
  name: string;
  size: number | null;
}

export type FileKind =
  | 'plain'
  | 'drm'
  | 'epub-inside'
  | 'book-inside'
  | 'epub-shaped'
  | 'htmlz'
  | 'html'
  | 'txt-inside'
  | 'images'
  | 'series'
  | 'pdf-inside'
  | 'kfx-inside'
  | 'archive-inside'
  | 'text-archive'
  | 'not-book'
  | 'unknown';

export interface ArchiveDecision {
  kind: FileKind;
  /** The entry to extract (epub-inside, book-inside, html, txt-inside). */
  entry?: string;
  images: number;
  files: number;
  mokuro: boolean;
  detail: string;
}

const IMG = /\.(jpe?g|png|gif|webp|bmp|avif|jxl|tiff?)$/i;
const HTML = /\.(x?html?)$/i;
const BOOK = /\.(azw3|azw|mobi|prc)$/i;
const ARCH = /\.(zip|rar|cbz|cbr|7z|cb7)$/i;
const AUDIO = /\.(mp3|m4a|m4b|wav|flac|ogg|aac|opus)$/i;
const JUNK = /(^|\/)(__MACOSX\/|\.nomedia$|thumbs\.db$|\.ds_store$|desktop\.ini$)/i;

/** A volume number in a folder name ("vol1", "v01", "第01巻", "巻3", "(2)"), or null. */
export function volumeOfFolder(name: string): number | null {
  const m =
    /(?:vol(?:ume)?\.?\s*|(?<![a-z])v|第\s*|巻\s*)(\d{1,3})/i.exec(name) ??
    /(\d{1,3})\s*巻/.exec(name) ??
    /[(（](\d{1,3})[)）]\s*$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * What an archive is, from its entries (and the book's title, for mokuro). Several books in one
 * archive are a "series" (listed, left: splitting one archive is a job of its own); one EPUB
 * inside is extracted as it is; an EPUB-shaped ZIP (mokuro's output, or an EPUB named .zip) is
 * rebuilt by calibre; pictures are a picture book; text in HTML or one TXT is converted.
 */
export function decideArchive(all: ArchiveEntry[], title: string): ArchiveDecision {
  const files = all.filter((e) => !e.name.endsWith('/') && !JUNK.test(e.name));
  const names = files.map((e) => e.name.replace(/\\/g, '/'));
  const lower = names.map((n) => n.toLowerCase());
  const count = (re: RegExp) => names.filter((n) => re.test(n)).length;
  const images = count(IMG);
  const epubs = names.filter((n) => /\.epub$/i.test(n));
  const books = names.filter((n) => BOOK.test(n));
  const kfx = count(/\.kfx$/i);
  const pdfs = count(/\.pdf$/i);
  const archives = names.filter((n) => ARCH.test(n));
  const audio = count(AUDIO);
  const txts = names.filter((n) => /\.txt$/i.test(n));
  const mokuro =
    /mokuro/i.test(title) ||
    lower.some((n) => n.includes('mokuro') || n.startsWith('_ocr/') || n.includes('/_ocr/'));
  const base = { images, files: files.length, mokuro };
  const say = (kind: FileKind, detail: string, entry?: string): ArchiveDecision => ({
    kind,
    detail,
    ...(entry ? { entry } : {}),
    ...base
  });
  if (files.length === 0) return say('unknown', 'The archive is empty');
  const inner = epubs.length + books.length + kfx + archives.length;
  if (epubs.length >= 2 || inner >= 2) return say('series', `${inner} books inside one archive`);
  if (epubs.length === 1) return say('epub-inside', 'One EPUB inside', epubs[0]);
  if (books.length === 1) return say('book-inside', 'One Kindle book inside', books[0]);
  if (kfx === 1) return say('kfx-inside', 'A KFX book inside');
  if (archives.length === 1) return say('archive-inside', 'An archive inside the archive');
  if (audio > 0 && audio >= files.length / 2) return say('not-book', `${audio} audio files`);
  if (pdfs > 0 && images === 0 && !names.some((n) => HTML.test(n)))
    return say('pdf-inside', `${pdfs} PDF files`);
  // Picture folders that are volumes of their own ("vol1/", "第01巻/") make a series.
  const folders = new Map<string, number>();
  for (const n of names) {
    if (!IMG.test(n)) continue;
    const parts = n.split('/');
    if (parts.length < 2) continue;
    // The innermost folder holding the pictures.
    const dir = parts[parts.length - 2];
    folders.set(dir, (folders.get(dir) ?? 0) + 1);
  }
  const volumes = new Set(
    [...folders.keys()].map(volumeOfFolder).filter((v): v is number => v !== null)
  );
  if (volumes.size >= 2) return say('series', `${volumes.size} volume folders of pictures`);
  if (names.some((n) => n.toLowerCase() === 'meta-inf/container.xml'))
    return say('epub-shaped', mokuro ? 'An EPUB-shaped mokuro archive' : 'An EPUB-shaped archive');
  // HTML: calibre's HTMLZ (index.html + metadata.opf at the root), or one page of text.
  const rootHtml = names.filter((n) => !n.includes('/') && HTML.test(n));
  const html = names.filter((n) => HTML.test(n) && !/_files\//i.test(n));
  if (lower.includes('index.html') && lower.includes('metadata.opf'))
    return say('htmlz', 'An HTMLZ book');
  if (!mokuro && html.length === 1) {
    const size = files.find((e) => e.name.replace(/\\/g, '/') === html[0])?.size ?? null;
    // A page with little text beside many pictures is a picture book's page list.
    if (images === 0 || size === null || size >= 20_000)
      return say('html', 'One HTML page of text', html[0]);
  }
  if (html.length >= 2 && (mokuro || rootHtml.length >= 2))
    return say('series', `${html.length} HTML books inside one archive`);
  if (images > 0) return say('images', `${images} pictures${mokuro ? ' (mokuro)' : ''}`);
  if (txts.length === 1) return say('txt-inside', 'One text file inside', txts[0]);
  if (txts.length > 1) return say('text-archive', `${txts.length} text files`);
  return say('unknown', `Nothing readable among ${files.length} files`);
}

/** What a job does with a file, by its kind: convert, extract, or list and leave. */
export type Method = 'convert' | 'extract' | 'comic' | 'rebuild' | 'html' | 'htmlz' | 'txt';

/** The ebook-convert arguments of a method (paths only inside the job's work folder). */
export function convertArgs(method: Method, input: string, output: string, work: string): string[] {
  const root = path.resolve(work) + path.sep;
  for (const p of [input, output]) {
    if (!path.resolve(p).startsWith(root))
      throw new Error('ebook-convert runs only in its work folder');
  }
  if (!/\.epub$/i.test(output) && !/\.txt$/i.test(output))
    throw new Error('ebook-convert writes only an EPUB or a text file');
  if (method === 'comic' && /\.epub$/i.test(output))
    return [input, output, '--no-process', '--dont-grayscale', '--keep-aspect-ratio'];
  return [input, output];
}

/** The characters the reader counts (get-character-count.ts's rule), as one number. */
const NOT_COUNTED =
  /[^0-9A-Z○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー０-９Ａ-Ｚｦ-ﾝ\p{Radical}\p{Unified_Ideograph}]+/gimu;
export function countedChars(text: string): number {
  return Array.from(text.replace(NOT_COUNTED, '')).length;
}

// ---------------------------------------------------------------- the conversion job

export interface FormatJob {
  id: number;
  calibreId: number;
  uuid: string;
  title: string;
  /** The format to read (the server's choice among the book's files). */
  format: string;
  timeoutSeconds: number;
  calibreLibrary?: string | null;
}

export type JobOutcome = 'converted' | 'gone' | 'drm' | 'listed' | 'failed';

export interface JobResult {
  outcome: JobOutcome;
  kind: FileKind | null;
  method: Method | null;
  detail: string | null;
  /** The source file as exported (its size and SHA-256: the server checks the library's file). */
  sourceSize: number | null;
  sourceSha256: string | null;
  /** Counted characters of calibre's text of the source and of the EPUB (text books). */
  sourceChars: number | null;
  epubChars: number | null;
  /** Pictures in the source archive (picture books). */
  sourceImages: number | null;
  epubSha256: string | null;
  epubSize: number | null;
  ms: number;
  entries: number | null;
}

export interface FormatApi {
  claimFormatJob(): Promise<{ job: FormatJob | null }>;
  formatJobAlive(jobId: number): Promise<unknown>;
  uploadFormatEpub(jobId: number, file: string, sha256: string, size: number): Promise<unknown>;
  finishFormatJob(jobId: number, result: JobResult): Promise<unknown>;
  downloadFormatEpub(itemId: number, file: string): Promise<{ sha256: string | null }>;
}

export interface FormatPrograms {
  ebookConvert: string;
  calibreDebug: string;
  helperScript: string;
  /** For tests: arguments before the program's own (a node script). */
  prefixArgs?: string[];
}

export interface FormatContext {
  calibredb: Calibredb;
  quarantine: Quarantine;
  api: FormatApi;
  tmpDir: string;
  programs: FormatPrograms;
  log: { info(m: string): void; error(m: string): void };
  isStopped(): boolean;
  retry<T>(fn: () => Promise<T>): Promise<T>;
  report(batch: Batch, item: BatchItem, report: StepReport): Promise<void>;
  pollUntil<T>(until: number, check: () => Promise<T | null>): Promise<T | null>;
  /** Stage 1's Undo of a removed copy (trash, else the quarantine export), with a step after. */
  undoRemoval(
    batch: Batch,
    item: BatchItem,
    plan: unknown,
    after: () => Promise<void>
  ): Promise<void>;
  waits: { writeWaitSeconds: number; removeWaitSeconds: number };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const KINDS_LISTED: FileKind[] = [
  'series',
  'pdf-inside',
  'kfx-inside',
  'archive-inside',
  'text-archive',
  'not-book',
  'unknown'
];

export class FormatWorker {
  private child: ChildProcess | null = null;

  constructor(private readonly ctx: FormatContext) {}

  /** Stops a running conversion (the sidecar is stopping). */
  kill(): void {
    this.child?.kill('SIGKILL');
  }

  /** The job's own folder: <tmpDir>/ttsu-format-<id>. */
  workDir(jobId: number): string {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('Bad job id');
    return path.join(this.ctx.tmpDir, `ttsu-format-${jobId}`);
  }

  private run(program: string, args: string[], work: string, timeoutMs: number): Promise<Run> {
    return new Promise((resolve, reject) => {
      const tmp = path.join(work, 'tmp');
      fs.mkdirSync(tmp, { recursive: true });
      const child = spawn(program, [...(this.ctx.programs.prefixArgs ?? []), ...args], {
        cwd: work,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TMPDIR: tmp,
          CALIBRE_TEMP_DIR: tmp,
          TTSU_WORK_DIR: work
        },
        windowsHide: true
      });
      this.child = child;
      try {
        // Conversions are background work: Calibre's content server goes first (the container
        // is Linux: renice of its own child). Never on Windows: there a child whose priority is
        // set right after its start never finished (40 of 40 in the tests' stand-in, 2026-11-26).
        if (child.pid && process.platform !== 'win32') os.setPriority(child.pid, 10);
      } catch {
        // Not allowed here: run at the normal priority.
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(
          new Error(`${path.basename(program)} took longer than ${Math.round(timeoutMs / 1000)} s`)
        );
      }, timeoutMs);
      child.stdout?.setEncoding('utf8').on('data', (d: string) => {
        if (stdout.length < 5_000_000) stdout += d;
      });
      child.stderr?.setEncoding('utf8').on('data', (d: string) => {
        if (stderr.length < 200_000) stderr += d;
      });
      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(`${path.basename(program)} could not start: ${err.message}`));
      });
      child.on('close', (code) => {
        this.child = null;
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /** formats-helper.py through calibre-debug; its one answer line. */
  private async helper(args: string[], work: string, timeoutMs: number): Promise<unknown> {
    const r = await this.run(
      this.ctx.programs.calibreDebug,
      ['-e', this.ctx.programs.helperScript, ...args],
      work,
      timeoutMs
    );
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('@@ttsu '));
    if (!line) throw new Error(`The helper gave no answer: ${shorten(r.stderr.trim(), 300)}`);
    const a = JSON.parse(line.slice(7)) as { ok: boolean; result?: unknown; error?: string };
    if (!a.ok) throw new Error(`The helper: ${a.error ?? 'failed'}`);
    return a.result;
  }

  private async convert(
    method: Method,
    input: string,
    output: string,
    work: string,
    timeoutMs: number
  ): Promise<void> {
    const r = await this.run(
      this.ctx.programs.ebookConvert,
      convertArgs(method, input, output, work),
      work,
      timeoutMs
    );
    if (r.code !== 0 || !(await exists(output))) {
      const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
      throw new Error(`ebook-convert failed (exit ${r.code}): ${shorten(tail, 400)}`);
    }
  }

  private async textChars(
    input: string,
    name: string,
    work: string,
    timeoutMs: number
  ): Promise<number> {
    const out = path.join(work, `${name}.txt`);
    await this.convert('convert', input, out, work, timeoutMs);
    const n = countedChars(await fsp.readFile(out, 'utf8'));
    await fsp.rm(out, { force: true });
    return n;
  }

  /** One job if the server has one; returns whether there was one. */
  async cycle(login: Login): Promise<boolean> {
    const { job } = await this.ctx.retry(() => this.ctx.api.claimFormatJob());
    if (!job) return false;
    this.ctx.log.info(`Format job ${job.id}: book ${job.calibreId}, its ${job.format}`);
    const alive = setInterval(
      () => void this.ctx.api.formatJobAlive(job.id).catch(() => {}),
      60_000
    );
    let result: JobResult;
    const work = this.workDir(job.id);
    try {
      result = await this.doJob(login, job, work);
    } catch (err) {
      if (this.ctx.isStopped()) {
        clearInterval(alive);
        return true; // claimed again after the restart
      }
      result = emptyResult('failed', shorten((err as Error).message, 1000));
    } finally {
      clearInterval(alive);
    }
    try {
      if (result.outcome === 'converted') {
        const epub = path.join(work, 'out.epub');
        await this.ctx.retry(() =>
          this.ctx.api.uploadFormatEpub(job.id, epub, result.epubSha256!, result.epubSize!)
        );
      }
      await this.ctx.retry(() => this.ctx.api.finishFormatJob(job.id, result));
      this.ctx.log.info(
        `Format job ${job.id} (${job.calibreId}, ${job.format}): ${result.outcome}${result.kind ? ` ${result.kind}` : ''}${result.detail ? `: ${shorten(result.detail, 200)}` : ''} in ${(result.ms / 1000).toFixed(1)} s`
      );
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }

  async doJob(login: Login, job: FormatJob, work: string): Promise<JobResult> {
    const t0 = Date.now();
    const timeoutMs = Math.max(60, job.timeoutSeconds) * 1000;
    const fmt = job.format.toUpperCase();
    if (!(BOOK_FORMATS as readonly string[]).includes(fmt) || fmt === 'EPUB')
      return { ...emptyResult('listed', `${fmt} is not converted`), ms: 0 };
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(path.join(work, 'export'), { recursive: true });
    const book = await this.ctx.calibredb.book(login, job.calibreId);
    if (!book || book.uuid !== job.uuid)
      return {
        ...emptyResult('gone', 'The book is no longer in Calibre as selected'),
        ms: Date.now() - t0
      };
    if (
      !book.formats.some(
        (f) => path.basename(f).toUpperCase().endsWith(`.${fmt}`) || f.toUpperCase() === fmt
      )
    )
      return {
        ...emptyResult('gone', `The book has no ${fmt} in Calibre any more`),
        ms: Date.now() - t0
      };
    await this.ctx.calibredb.ok('export', login, [
      '--to-dir',
      path.join(work, 'export'),
      '--single-dir',
      '--dont-update-metadata',
      '--dont-write-opf',
      '--dont-save-cover',
      '--formats',
      fmt.toLowerCase(),
      '--template',
      'book',
      String(job.calibreId)
    ]);
    const exported = (await fsp.readdir(path.join(work, 'export'))).find((n) =>
      n.toLowerCase().endsWith(`.${fmt.toLowerCase()}`)
    );
    if (!exported) throw new Error(`The export has no ${fmt} file`);
    const src = path.join(work, 'export', exported);
    const sourceSha256 = await sha256File(src);
    const sourceSize = (await fsp.stat(src)).size;
    const res: JobResult = {
      ...emptyResult('failed', null),
      sourceSize,
      sourceSha256
    };
    const out = path.join(work, 'out.epub');
    const done = async (
      method: Method,
      kind: FileKind,
      measureText: boolean,
      images: number | null
    ) => {
      res.method = method;
      res.kind = kind;
      res.sourceImages = images;
      if (measureText) {
        res.sourceChars = await this.textChars(
          textSource(method, src, work),
          'source',
          work,
          timeoutMs
        );
        res.epubChars = await this.textChars(out, 'epub', work, timeoutMs);
      }
      res.outcome = 'converted';
      res.epubSha256 = await sha256File(out);
      res.epubSize = (await fsp.stat(out)).size;
      res.ms = Date.now() - t0;
      return res;
    };
    if (['AZW3', 'AZW', 'MOBI', 'PRC'].includes(fmt)) {
      const facts = (await this.helper(['inspect', src], work, timeoutMs)) as {
        drm?: boolean | null;
      };
      if (facts.drm)
        return {
          ...res,
          outcome: 'drm',
          kind: 'drm',
          detail: 'Locked with DRM',
          ms: Date.now() - t0
        };
      await this.convert('convert', src, out, work, timeoutMs);
      return done('convert', 'plain', true, null);
    }
    if (['TXT', 'HTML', 'HTMLZ'].includes(fmt)) {
      await this.convert('convert', src, out, work, timeoutMs);
      return done('convert', 'plain', true, null);
    }
    // ZIP, CBZ, RAR, CBR: what is inside decides.
    const facts = (await this.helper(['inspect', src], work, timeoutMs)) as {
      entries?: ArchiveEntry[] | null;
    };
    if (!facts.entries) throw new Error('The archive could not be read');
    res.entries = facts.entries.length;
    const d = decideArchive(facts.entries, job.title);
    res.kind = d.kind;
    res.detail = d.detail;
    if (KINDS_LISTED.includes(d.kind)) return { ...res, outcome: 'listed', ms: Date.now() - t0 };
    const rar = fmt === 'RAR' || fmt === 'CBR';
    switch (d.kind) {
      case 'epub-inside': {
        await this.helper(['extract', src, d.entry!, out], work, timeoutMs);
        return done('extract', d.kind, false, null);
      }
      case 'book-inside':
      case 'txt-inside': {
        const inner = path.join(work, `inner${path.extname(d.entry!).toLowerCase()}`);
        await this.helper(['extract', src, d.entry!, inner], work, timeoutMs);
        if (d.kind === 'book-inside') {
          const f = (await this.helper(['inspect', inner], work, timeoutMs)) as {
            drm?: boolean | null;
          };
          if (f.drm)
            return {
              ...res,
              outcome: 'drm',
              kind: 'drm',
              detail: 'The book inside is locked with DRM',
              ms: Date.now() - t0
            };
        }
        await this.convert('convert', inner, out, work, timeoutMs);
        return done(d.kind === 'txt-inside' ? 'txt' : 'convert', d.kind, true, null);
      }
      case 'epub-shaped': {
        // mokuro's output (or an EPUB named .zip): calibre reads it as an EPUB and writes a whole one.
        const asEpub = path.join(work, 'in.epub');
        await fsp.copyFile(src, asEpub);
        try {
          await this.convert('rebuild', asEpub, out, work, timeoutMs);
          return done('rebuild', d.kind, false, d.images);
        } catch (err) {
          if (d.images === 0) throw err;
          // Not rebuildable, but it has pictures: a picture book (decided at stop 1).
          this.ctx.log.info(
            `Job ${job.id}: rebuild failed, made as a picture book: ${shorten((err as Error).message, 200)}`
          );
          await fsp.rm(out, { force: true });
          const comic = path.join(work, 'in.cbz');
          await fsp.rename(asEpub, comic);
          await this.convert('comic', comic, out, work, timeoutMs);
          return done('comic', 'images', false, d.images);
        }
      }
      case 'htmlz': {
        const asHtmlz = path.join(work, 'in.htmlz');
        await fsp.copyFile(src, asHtmlz);
        await this.convert('htmlz', asHtmlz, out, work, timeoutMs);
        return done('htmlz', d.kind, true, null);
      }
      case 'html': {
        const dir = path.join(work, 'html');
        await this.helper(['extractall', src, dir], work, timeoutMs);
        const page = path.join(dir, d.entry!);
        await this.convert('html', page, out, work, timeoutMs);
        return done('html', d.kind, true, null);
      }
      case 'images': {
        const comic = path.join(work, rar ? 'in.cbr' : 'in.cbz');
        await fsp.copyFile(src, comic);
        await this.convert('comic', comic, out, work, timeoutMs);
        return done('comic', d.kind, false, d.images);
      }
      default:
        return { ...res, outcome: 'listed', ms: Date.now() - t0 };
    }
  }

  // ------------------------------------------------------------ the write batches (stage 12)

  private async listedPatiently(login: Login, id: number) {
    const until = Date.now() + this.ctx.waits.writeWaitSeconds * 1000;
    const r = await this.ctx.pollUntil(until, async () => ({
      b: await this.ctx.calibredb.book(login, id)
    }));
    if (!r) throw new Error("Calibre didn't answer a list of the book");
    return r.b;
  }

  /** Waits (after a write's error or timeout) until Calibre shows `done`; false if it never does. */
  private async waitFor(login: Login, id: number, done: (formats: string[]) => boolean) {
    const until = Date.now() + this.ctx.waits.writeWaitSeconds * 1000;
    const r = await this.ctx.pollUntil(until, async () => {
      const b = await this.ctx.calibredb.book(login, id);
      return b && done(b.formats) ? true : null;
    });
    return r === true;
  }

  async applyItem(batch: Batch, item: BatchItem, login: Login): Promise<void> {
    const f = item.format;
    if (!f) throw new Error('The item has no format details');
    if (f.kind === 'convert') return this.applyConvert(batch, item, login);
    return this.applyFold(batch, item, login);
  }

  private async applyConvert(batch: Batch, item: BatchItem, login: Login): Promise<void> {
    const f = item.format!;
    if (item.state === 'pending') {
      const book = await this.listedPatiently(login, item.calibreId);
      const problem = recordProblem(book, item, f.sourceFormat);
      if (problem) {
        await this.ctx.report(batch, item, { step: 'skipped', detail: problem });
        return;
      }
      if (hasFormat(book!.formats, 'EPUB')) {
        await this.ctx.report(batch, item, {
          step: 'skipped',
          detail: 'The book has an EPUB in Calibre now'
        });
        return;
      }
      await this.ctx.report(batch, item, { step: 'verified' });
    }
    if (item.state === 'verified') {
      const dir = path.join(this.ctx.tmpDir, `ttsu-format-item-${item.itemId}`);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      try {
        const file = path.join(dir, 'book.epub');
        await this.ctx.retry(() => this.ctx.api.downloadFormatEpub(item.itemId, file));
        const sha = await sha256File(file);
        if (sha !== f.epubSha256) {
          await this.ctx.report(batch, item, {
            step: 'failed',
            detail: `The EPUB from the server differs from the checked one (${sha.slice(0, 12)}…); nothing was added`
          });
          return;
        }
        // Right before the write: still the same record, still without an EPUB.
        const book = await this.listedPatiently(login, item.calibreId);
        const problem = recordProblem(book, item, f.sourceFormat);
        if (problem) {
          await this.ctx.report(batch, item, { step: 'skipped', detail: problem });
          return;
        }
        if (!hasFormat(book!.formats, 'EPUB')) {
          try {
            await this.ctx.calibredb.addFormat(login, item.calibreId, file, [this.ctx.tmpDir]);
          } catch (err) {
            if (this.ctx.isStopped()) throw err;
            this.ctx.log.info(
              `add_format ${item.calibreId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre added it`
            );
            if (!(await this.waitFor(login, item.calibreId, (fs2) => hasFormat(fs2, 'EPUB'))))
              throw err;
          }
        }
        const after = await this.listedPatiently(login, item.calibreId);
        if (!after || !hasFormat(after.formats, 'EPUB'))
          throw new Error('Calibre does not list the EPUB after add_format');
        await this.ctx.report(batch, item, { step: 'written' });
        this.ctx.log.info(`Added an EPUB to ${item.calibreId}: ${item.title}`);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async exportCopy(batch: Batch, item: BatchItem, login: Login): Promise<string> {
    const f = item.format!;
    const bdir = this.ctx.quarantine.batchDir(batch.id);
    for (let n = 1; n < 1000; n++) {
      const candidate = path.join(bdir, `${item.calibreId}${n === 1 ? '' : `-${n}`}`);
      if (!(await exists(candidate))) break;
      const file = await this.ctx.quarantine.bookFileIn(candidate, f.sourceFormat);
      if (file && (await sha256File(file)) === f.sourceSha256) return candidate;
    }
    const dir = await this.ctx.quarantine.freshName(bdir, String(item.calibreId));
    await fsp.mkdir(dir);
    await this.ctx.calibredb.ok('export', login, [
      '--to-dir',
      dir,
      '--single-dir',
      '--dont-update-metadata',
      '--template',
      'book',
      String(item.calibreId)
    ]);
    return dir;
  }

  /** Written right before a fold's add_format (a restart then knows the format was its own). */
  private addedNote(batch: Batch, item: BatchItem): string {
    return path.join(this.ctx.quarantine.batchDir(batch.id), `${item.calibreId}.add-format.json`);
  }

  private async applyFold(batch: Batch, item: BatchItem, login: Login): Promise<void> {
    const f = item.format!;
    const twinProblem = async () => {
      const twin = await this.listedPatiently(login, item.kept.calibreId);
      if (!twin) return 'The EPUB book to keep is no longer in Calibre';
      if (twin.uuid !== item.kept.uuid)
        return 'The id of the EPUB book to keep belongs to another book now';
      if (!hasFormat(twin.formats, 'EPUB')) return 'The book to keep has no EPUB any more';
      return null;
    };
    if (item.state === 'pending') {
      const book = await this.listedPatiently(login, item.calibreId);
      const problem = recordProblem(book, item, f.sourceFormat) ?? (await twinProblem());
      if (problem) {
        await this.ctx.report(batch, item, { step: 'skipped', detail: problem });
        return;
      }
      if (hasFormat(book!.formats, 'EPUB')) {
        await this.ctx.report(batch, item, {
          step: 'skipped',
          detail: 'The copy has an EPUB in Calibre now'
        });
        return;
      }
      await this.ctx.report(batch, item, { step: 'verified' });
    }
    if (item.state === 'verified') {
      const dir = await this.exportCopy(batch, item, login);
      const file = await this.ctx.quarantine.bookFileIn(dir, f.sourceFormat);
      if (!file) throw new Error(`The export has no ${f.sourceFormat} file`);
      const sha = await sha256File(file);
      if (sha !== f.sourceSha256) {
        await this.ctx.report(batch, item, {
          step: 'failed',
          detail: `The exported file differs from the compared one (${sha.slice(0, 12)}…); nothing was changed`
        });
        return;
      }
      await this.ctx.quarantine.createOnce(
        path.join(this.ctx.quarantine.batchDir(batch.id), `${item.calibreId}.json`),
        JSON.stringify(
          {
            removed: {
              calibreId: item.calibreId,
              uuid: item.uuid,
              title: item.title,
              formats: item.formats
            },
            foldedInto: item.kept,
            addFormat: f.addFormat,
            sha256: f.sourceSha256,
            exportedTo: path.basename(dir),
            exportedAt: new Date().toISOString()
          },
          null,
          2
        )
      );
      await this.ctx.report(batch, item, {
        step: 'exported',
        quarantineDir: dir,
        exportSha256: sha
      });
      item.quarantineDir = dir;
    }
    if (item.state === 'exported') {
      const problem = await twinProblem();
      if (problem) {
        await this.ctx.report(batch, item, { step: 'skipped', detail: problem });
        return;
      }
      // The format this fold gave the twin (reported: Undo takes off exactly that one).
      let added: string | null = null;
      if (f.addFormat) {
        const twin = await this.listedPatiently(login, item.kept.calibreId);
        if (!hasFormat(twin!.formats, f.addFormat)) {
          const dir = item.quarantineDir;
          const file = dir ? await this.ctx.quarantine.bookFileIn(dir, f.addFormat) : null;
          if (!file) throw new Error(`The quarantine export has no ${f.addFormat} file`);
          await this.ctx.quarantine.createOnce(
            this.addedNote(batch, item),
            JSON.stringify({ twin: item.kept, format: f.addFormat, at: new Date().toISOString() })
          );
          try {
            await this.ctx.calibredb.addFormat(login, item.kept.calibreId, file, [
              this.ctx.quarantine.root
            ]);
          } catch (err) {
            if (this.ctx.isStopped()) throw err;
            this.ctx.log.info(
              `add_format ${item.kept.calibreId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre added it`
            );
            if (
              !(await this.waitFor(login, item.kept.calibreId, (x) => hasFormat(x, f.addFormat!)))
            )
              throw err;
          }
          const after = await this.listedPatiently(login, item.kept.calibreId);
          if (!after || !hasFormat(after.formats, f.addFormat))
            throw new Error(`Calibre does not list the ${f.addFormat} on the book to keep`);
          added = f.addFormat;
        } else if (await exists(this.addedNote(batch, item))) {
          // An earlier attempt added it and stopped before its report.
          added = f.addFormat;
        }
      }
      if (item.addTags.length > 0) {
        const twin = await this.listedPatiently(login, item.kept.calibreId);
        const have = new Set(twin!.tags.map((t) => t.toLowerCase()));
        const missing = item.addTags.filter((t) => !have.has(t.toLowerCase()));
        if (missing.length > 0) {
          await this.ctx.calibredb.setTags(login, item.kept.calibreId, [...twin!.tags, ...missing]);
          const after = await this.listedPatiently(login, item.kept.calibreId);
          const now = new Set((after?.tags ?? []).map((t) => t.toLowerCase()));
          if (!missing.every((t) => now.has(t.toLowerCase())))
            throw new Error('Calibre did not keep the added tags');
        }
      }
      await this.ctx.report(batch, item, { step: 'tagged', fixed: added ? [added] : [] });
    }
    if (item.state === 'tagged') {
      const present = await this.listedPatiently(login, item.calibreId);
      if (present && present.uuid === item.uuid) {
        const problem = await twinProblem();
        if (problem) {
          await this.ctx.report(batch, item, { step: 'skipped', detail: problem });
          return;
        }
        if (f.addFormat) {
          const twin = await this.listedPatiently(login, item.kept.calibreId);
          if (!hasFormat(twin!.formats, f.addFormat)) {
            await this.ctx.report(batch, item, {
              step: 'skipped',
              detail: `The book to keep has no ${f.addFormat} any more; the copy stays`
            });
            return;
          }
        }
        try {
          await this.ctx.calibredb.ok('remove', login, [String(item.calibreId)]);
        } catch (err) {
          if (this.ctx.isStopped()) throw err;
          this.ctx.log.info(
            `Remove ${item.calibreId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre removes it`
          );
          const until = Date.now() + this.ctx.waits.removeWaitSeconds * 1000;
          const gone = await this.ctx.pollUntil(until, async () => {
            const b = await this.ctx.calibredb.book(login, item.calibreId);
            return !b || b.uuid !== item.uuid ? true : null;
          });
          if (gone !== true) throw err;
        }
      }
      const still = await this.ctx.calibredb.book(login, item.calibreId);
      if (still && still.uuid === item.uuid)
        throw new Error('Calibre still lists the copy after remove');
      await this.ctx.report(batch, item, { step: 'removed' });
      this.ctx.log.info(`Folded ${item.calibreId} into ${item.kept.calibreId}: ${item.title}`);
    }
  }

  async undoItem(batch: Batch, item: BatchItem, login: Login, plan: unknown): Promise<void> {
    const f = item.format;
    if (!f) throw new Error('The item has no format details');
    if (f.kind === 'convert') {
      const book = await this.listedPatiently(login, item.calibreId);
      if (!book || book.uuid !== item.uuid) {
        await this.ctx.report(batch, item, {
          step: 'failed',
          detail: 'The book is no longer in Calibre'
        });
        return;
      }
      if (hasFormat(book.formats, 'EPUB')) {
        try {
          await this.ctx.calibredb.removeFormat(login, item.calibreId, 'EPUB');
        } catch (err) {
          if (this.ctx.isStopped()) throw err;
          this.ctx.log.info(
            `remove_format ${item.calibreId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre removed it`
          );
          if (!(await this.waitFor(login, item.calibreId, (x) => !hasFormat(x, 'EPUB')))) throw err;
        }
      }
      const after = await this.listedPatiently(login, item.calibreId);
      if (after && hasFormat(after.formats, 'EPUB'))
        throw new Error('Calibre still lists the EPUB after remove_format');
      await this.ctx.report(batch, item, {
        step: 'restored',
        method: 'trash',
        calibreId: item.calibreId,
        uuid: item.uuid
      });
      this.ctx.log.info(`Took the added EPUB off ${item.calibreId} again: ${item.title}`);
      return;
    }
    // A fold: the copy comes back (stage 1's restore), then the format it gave its twin goes.
    await this.ctx.undoRemoval(batch, item, plan, async () => {
      const fmt = f.removeFormat;
      if (!fmt) return;
      const twin = await this.listedPatiently(login, item.kept.calibreId);
      if (!twin || twin.uuid !== item.kept.uuid || !hasFormat(twin.formats, fmt)) return;
      try {
        await this.ctx.calibredb.removeFormat(login, item.kept.calibreId, fmt);
      } catch (err) {
        if (this.ctx.isStopped()) throw err;
        if (!(await this.waitFor(login, item.kept.calibreId, (x) => !hasFormat(x, fmt)))) throw err;
      }
    });
  }
}

function emptyResult(outcome: JobOutcome, detail: string | null): JobResult {
  return {
    outcome,
    kind: null,
    method: null,
    detail,
    sourceSize: null,
    sourceSha256: null,
    sourceChars: null,
    epubChars: null,
    sourceImages: null,
    epubSha256: null,
    epubSize: null,
    ms: 0,
    entries: null
  };
}

/** The file whose text stands for the source (an archive's text is read from what was extracted). */
function textSource(method: Method, src: string, work: string): string {
  if (method === 'txt' || method === 'convert') {
    const inner = ['inner.azw3', 'inner.azw', 'inner.mobi', 'inner.prc', 'inner.txt'].map((n) =>
      path.join(work, n)
    );
    const found = inner.find((p) => fs.existsSync(p));
    return found ?? src;
  }
  if (method === 'htmlz') return path.join(work, 'in.htmlz');
  return src;
}

/** Whether Calibre lists this format for a book (formats are file paths or names). */
export function hasFormat(formats: string[], fmt: string): boolean {
  const want = fmt.toUpperCase();
  return formats.some((f) => {
    const u = f.toUpperCase();
    return u === want || u.endsWith(`.${want}`);
  });
}

/** Why the record is not the one selected any more (null: it is). */
export function recordProblem(
  book: { uuid: string; last_modified: string; formats: string[] } | null,
  item: BatchItem,
  sourceFormat: string
): string | null {
  if (!book) return 'The book is no longer in Calibre';
  if (book.uuid !== item.uuid) return 'The Calibre id now belongs to another book';
  if (!hasFormat(book.formats, sourceFormat))
    return `The book has no ${sourceFormat} in Calibre any more`;
  const then = calibreTime(item.lastModified);
  const now = calibreTime(book.last_modified);
  if (then !== null && now !== null && Math.abs(now - then) > 1000)
    return 'The book was changed in Calibre since it was looked at';
  return null;
}
