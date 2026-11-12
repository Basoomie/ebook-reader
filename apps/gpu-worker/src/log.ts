/**
 * The worker's log: worker.log in the log folder, rotated to worker.log.1 at logMaxMB
 * (one old file is kept). Lines also go to the console. Never throws: a log that can't
 * be written must not stop the worker.
 */
import fs from 'fs';
import path from 'path';

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export function fileLogger(dir: string, maxMb: number, toConsole = true): Logger {
  const file = path.join(dir, 'worker.log');
  const max = Math.max(1024, Math.round(maxMb * 1024 * 1024));
  let ready = false;
  const line = (level: string, message: string) => {
    const text = `${new Date().toISOString()} ${level} ${message}`;
    if (toConsole) (level === 'ERROR' ? console.error : console.log)(text);
    try {
      if (!ready) {
        fs.mkdirSync(dir, { recursive: true });
        ready = true;
      }
      try {
        if (fs.statSync(file).size > max) fs.renameSync(file, `${file}.1`);
      } catch {
        // No log yet.
      }
      fs.appendFileSync(file, `${text}\n`, 'utf8');
    } catch {
      // Logging is best effort.
    }
  };
  return {
    info: (m) => line('INFO', m),
    error: (m) => line('ERROR', m),
  };
}

/** For tests: keeps the lines. */
export function memoryLogger(lines: string[] = []): Logger & { lines: string[] } {
  return {
    lines,
    info: (m) => lines.push(`INFO ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
  };
}
