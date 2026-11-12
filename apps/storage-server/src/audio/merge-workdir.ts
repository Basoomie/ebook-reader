/**
 * WP15f: the merge job's scratch folder, CACHE_DIR/audio-merge/<job>/. ffmpeg's file
 * list, the chapter file and ffmpeg's output live here, never in the audiobooks folder:
 * only audio-write.ts copies the finished file there. Everything here is regenerable, so
 * the whole folder is emptied at start.
 *
 * Every path is checked to be inside the work folder, and the work folder must not
 * overlap the audiobooks folder (or the server refuses to merge).
 */
import fs from 'fs/promises';
import path from 'path';
import { isInside } from '../db/database';

export class MergeWorkdir {
  readonly root: string;

  constructor(cacheDir: string, audiobooksRoot: string) {
    this.root = path.resolve(cacheDir, 'audio-merge');
    const audio = path.resolve(audiobooksRoot);
    if (isInside(audio, this.root) || isInside(this.root, audio)) {
      throw new Error(
        `The merge work folder (${this.root}) and the audiobooks folder (${audio}) overlap`,
      );
    }
  }

  private inside(p: string): string {
    const abs = path.resolve(p);
    if (abs === this.root || !isInside(this.root, abs)) {
      throw new Error(`Not inside the merge work folder: ${p}`);
    }
    return abs;
  }

  jobDir(jobId: number): string {
    return this.inside(path.join(this.root, String(jobId)));
  }

  /** Where ffmpeg writes the merged file. */
  outputPath(jobId: number): string {
    return this.inside(path.join(this.jobDir(jobId), 'merged.m4b'));
  }

  /** An empty folder for one job. */
  async prepare(jobId: number): Promise<string> {
    const dir = this.jobDir(jobId);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async writeText(jobId: number, name: string, text: string): Promise<string> {
    const file = this.inside(path.join(this.jobDir(jobId), name));
    await fs.writeFile(file, text, 'utf8');
    return file;
  }

  async remove(jobId: number): Promise<void> {
    await fs.rm(this.jobDir(jobId), { recursive: true, force: true });
  }

  /** At start: nothing in here is needed any more. */
  async clear(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const entry of await fs.readdir(this.root)) {
      await fs.rm(this.inside(path.join(this.root, entry)), { recursive: true, force: true });
    }
  }
}
