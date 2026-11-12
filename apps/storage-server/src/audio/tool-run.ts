/**
 * WP17: small helpers to run ffmpeg/ffprobe for generated audiobooks and voice clips
 * (the merge service keeps its own runner). Lower priority; the last stderr line is the
 * error message.
 */
import { execFile } from 'child_process';
import os from 'os';

export function runTool(
  bin: string,
  args: string[],
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (err, stdout, stderr) => {
        if (err) {
          const last = String(stderr ?? '')
            .trim()
            .split(/\r?\n/)
            .pop();
          reject(new Error(last || err.message));
        } else resolve(String(stdout));
      },
    );
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // Lower priority is a nicety only.
    }
  });
}

export interface Probe {
  duration: number;
  hasAudio: boolean;
  chapters: number;
  sampleRate: number | null;
  codec: string | null;
}

export async function probeFile(
  ffprobe: string,
  file: string,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<Probe> {
  const out = await runTool(
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,sample_rate:chapter=id',
      '-of',
      'json',
      file,
    ],
    { timeoutMs, signal },
  );
  const json = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; sample_rate?: string }[];
    chapters?: unknown[];
  };
  const audio = (json.streams ?? []).find((s) => s.codec_type === 'audio');
  return {
    duration: Number(json.format?.duration ?? NaN),
    hasAudio: Boolean(audio),
    chapters: (json.chapters ?? []).length,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    codec: audio?.codec_name ?? null,
  };
}
