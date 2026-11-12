/**
 * The server's recent log lines for the bug report (WP18). console.log/info/warn/error
 * still print as before; each line is also kept in memory, with tokens, pairing codes and
 * the old sync's AUTH_TOKEN (when still set) removed as it is captured, so nothing secret is ever held. Memory
 * only: lines from before the last restart are gone (`docker logs` still has them).
 */
import { format } from 'util';
import { redactText } from './redact';

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogLine {
  time: number;
  level: LogLevel;
  text: string;
}

export const DEFAULT_LOG_BUFFER_LINES = 2000;
/** A longer line is cut (a stack trace or a big object stays readable, memory bounded). */
export const MAX_LOG_LINE_CHARS = 8192;

export class RecentLogs {
  readonly startedAt: number;
  private lines: LogLine[] = [];
  private dropped = 0;
  private secrets: string[] = [];

  constructor(
    private maxLines = DEFAULT_LOG_BUFFER_LINES,
    now = Date.now(),
  ) {
    this.startedAt = now;
  }

  /** Sets the size (LOG_BUFFER_LINES) and the exact secrets to remove (AUTH_TOKEN). */
  configure({ maxLines, secrets }: { maxLines?: number; secrets?: readonly string[] }): void {
    if (maxLines !== undefined) {
      this.maxLines = Math.max(1, Math.floor(maxLines));
      this.trim();
    }
    if (secrets) this.secrets = secrets.filter((s) => typeof s === 'string' && s.length > 0);
    // Lines kept before the secrets were known are cleaned again.
    this.lines = this.lines.map((l) => ({ ...l, text: this.clean(l.text) }));
  }

  add(level: LogLevel, args: unknown[], now = Date.now()): void {
    let text: string;
    try {
      text = format(...args);
    } catch {
      text = '[a log line that could not be formatted]';
    }
    if (text.length > MAX_LOG_LINE_CHARS) {
      text = `${text.slice(0, MAX_LOG_LINE_CHARS)}… (${text.length - MAX_LOG_LINE_CHARS} more characters cut)`;
    }
    this.lines.push({ time: now, level, text: this.clean(text) });
    this.trim();
  }

  snapshot(): { startedAt: number; maxLines: number; dropped: number; lines: LogLine[] } {
    return {
      startedAt: this.startedAt,
      maxLines: this.maxLines,
      dropped: this.dropped,
      // Cleaned once more on the way out.
      lines: this.lines.map((l) => ({ ...l, text: this.clean(l.text) })),
    };
  }

  private clean(text: string): string {
    try {
      return redactText(text, { secrets: this.secrets });
    } catch {
      return '[a log line that could not be checked for secrets]';
    }
  }

  private trim(): void {
    const extra = this.lines.length - this.maxLines;
    if (extra > 0) {
      this.lines.splice(0, extra);
      this.dropped += extra;
    }
  }
}

/** The process-wide buffer (configured and attached to the console in index.ts). */
export const serverLogs = new RecentLogs();

const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error'];

/**
 * Keeps a copy of every console line in `logs`. The original methods still print.
 * Returns a function that puts the console back (tests). Never throws while logging.
 */
export function captureConsole(logs: RecentLogs, target: Console = console): () => void {
  const originals = new Map<LogLevel, (...args: unknown[]) => void>();
  for (const level of LEVELS) {
    const original = target[level].bind(target) as (...args: unknown[]) => void;
    originals.set(level, target[level] as (...args: unknown[]) => void);
    target[level] = (...args: unknown[]) => {
      original(...args);
      try {
        logs.add(level, args);
      } catch {
        // Never break logging.
      }
    };
  }
  return () => {
    for (const [level, original] of originals) target[level] = original;
  };
}
