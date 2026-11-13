/**
 * WP17: the chapters and sentences a generated audiobook reads, made by the reader's own
 * import code (the counter bundle, vendor/epub-count.cjs, `bookScriptForServer`). Runs in a
 * short-lived child process (book-script-child.ts), stopped after a time limit.
 */
import { fork } from 'child_process';
import os from 'os';
import path from 'path';
import { COUNTER_BUNDLE } from '../counts/counter-bundle';

export interface ScriptSentence {
  text: string;
  reading: string;
  position: number;
  paragraphEnd: boolean;
}

export interface ScriptChapter {
  index: number;
  title: string;
  startCharacter: number;
  characters: number;
  sentences: ScriptSentence[];
}

export interface BookScript {
  version: number;
  characters: number;
  chapters: ScriptChapter[];
}

const RUNNING_TS = path.extname(__filename) === '.ts';
const CHILD_SCRIPT = path.join(__dirname, `book-script-child${RUNNING_TS ? '.ts' : '.js'}`);
const CHILD_EXEC_ARGV = RUNNING_TS ? ['-r', 'ts-node/register/transpile-only'] : [];
const SERVER_ROOT = path.resolve(__dirname, '..', '..');

export type ScriptReader = (
  file: string,
  options: { importOptions: unknown; maxSentence: number; timeoutMs: number },
) => Promise<BookScript>;

/** Reads a book's script with the counter bundle in a child process. */
export const readBookScript: ScriptReader = (file, { importOptions, maxSentence, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [COUNTER_BUNDLE], {
      cwd: SERVER_ROOT,
      execArgv: [...CHILD_EXEC_ARGV, '--max-old-space-size=2048'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // Lower priority is a nicety only.
    }
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000);
    });
    let settled = false;
    const done = (err: Error | null, script?: BookScript) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (err) reject(err);
      else resolve(script!);
    };
    const timer = setTimeout(
      () => done(new Error(`Reading the book took longer than ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    child.on('message', (m: { ok: boolean; script?: BookScript; message?: string }) => {
      if (m.ok && m.script) done(null, m.script);
      else done(new Error(`The book could not be read: ${m.message ?? 'unknown error'}`));
    });
    child.on('error', (err) => done(err));
    child.on('exit', (code) => {
      const last = stderr.trim().split(/\r?\n/).pop();
      done(new Error(`The book could not be read (exit ${code}${last ? `: ${last}` : ''})`));
    });
    child.send({ file, options: importOptions, maxSentence });
  });

/** The sentences of a chapter for a preview: about `seconds` of speech from its start. */
export function previewSentences(
  chapter: ScriptChapter,
  seconds: number,
  charsPerSecond = 5,
): ScriptSentence[] {
  const budget = Math.max(20, Math.round(seconds * charsPerSecond));
  const out: ScriptSentence[] = [];
  let used = 0;
  for (const s of chapter.sentences) {
    if (out.length > 0 && used + s.text.length > budget) break;
    out.push(s);
    used += s.text.length;
  }
  return out;
}
