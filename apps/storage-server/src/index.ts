import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';

if (!AUTH_TOKEN) {
  console.error('Fatal: AUTH_TOKEN environment variable is required');
  process.exit(1);
}

const DATA_ROOT = path.resolve(DATA_DIR);

if (!existsSync(DATA_ROOT)) {
  console.error(`Fatal: DATA_DIR does not exist: ${DATA_ROOT}`);
  process.exit(1);
}

const app = express();

app.use(cors({ origin: CORS_ORIGIN }));
// Parse body as raw Buffer for all content types (needed for binary file uploads)
app.use(express.raw({ type: '*/*', limit: '200mb' }));

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// GET /file only: also accepts ?token= as a fallback when no Authorization header is present.
// This lets <img src> load cover images without custom headers.
// Write endpoints always require the Authorization header.
function requireAuthGetFile(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header === `Bearer ${AUTH_TOKEN}`) {
    next();
    return;
  }
  const queryToken = req.query.token as string | undefined;
  if (queryToken && queryToken === AUTH_TOKEN) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Resolve a client-supplied relative path to an absolute path inside DATA_ROOT.
 * Throws if the resolved path escapes DATA_ROOT.
 */
function resolveSafe(clientPath: string): string {
  // Strip leading slashes so path.resolve doesn't treat it as absolute
  const stripped = clientPath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(DATA_ROOT, stripped);
  if (resolved !== DATA_ROOT && !resolved.startsWith(DATA_ROOT + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/**
 * Extract the numeric timestamp embedded in a progress filename.
 * Format: progress_<book_id>_<chapter_idx>_<timestamp>_<ratio>.json
 * The timestamp is the second-to-last underscore-delimited segment.
 */
function extractProgressTimestamp(filename: string): number | null {
  if (!filename.startsWith('progress_') || !filename.endsWith('.json')) return null;
  const bare = filename.slice(0, -5); // strip .json
  const parts = bare.split('_');
  // Minimum valid parts: ['progress', bookId, chapterIdx, timestamp, ratio] = 5
  if (parts.length < 5) return null;
  const ts = Number(parts[parts.length - 2]);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

// ---------------------------------------------------------------------------
// GET /list?path=<dir>
// Returns [{name, isDirectory, size, lastModified}] or [] if dir missing.
// ---------------------------------------------------------------------------
app.get('/list', requireAuth, async (req: Request, res: Response): Promise<void> => {
  let absPath: string;
  try {
    absPath = resolveSafe((req.query.path as string) ?? '');
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  try {
    const entries = await fs.readdir(absPath, { withFileTypes: true });
    const result = await Promise.all(
      entries.map(async (entry) => {
        const stat = await fs.stat(path.join(absPath, entry.name));
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isFile() ? stat.size : 0,
          lastModified: stat.mtimeMs,
        };
      }),
    );
    res.json(result);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.json([]);
    } else {
      console.error('GET /list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /file?path=<file>
// Returns file bytes with Last-Modified header, or 404.
// ---------------------------------------------------------------------------
app.get('/file', requireAuthGetFile, async (req: Request, res: Response): Promise<void> => {
  let absPath: string;
  try {
    absPath = resolveSafe((req.query.path as string) ?? '');
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  try {
    const stat = await fs.stat(absPath);
    const data = await fs.readFile(absPath);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Content-Length', String(stat.size));
    res.status(200).send(data);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Not found' });
    } else {
      console.error('GET /file error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---------------------------------------------------------------------------
// PUT /file?path=<file>
// Uploads raw bytes. Creates parent dirs as needed.
// For progress_*.json: rejects with 409 if any existing progress file in the
// same directory has a newer timestamp than the one being uploaded.
// Returns {lastModified} on success.
// ---------------------------------------------------------------------------
app.put('/file', requireAuth, async (req: Request, res: Response): Promise<void> => {
  let absPath: string;
  try {
    absPath = resolveSafe((req.query.path as string) ?? '');
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const filename = path.basename(absPath);

  // Timestamp-reject logic for progress files
  if (filename.startsWith('progress_') && filename.endsWith('.json')) {
    const incomingTs = extractProgressTimestamp(filename);
    if (incomingTs !== null) {
      const dir = path.dirname(absPath);
      try {
        const siblings = await fs.readdir(dir);
        for (const sibling of siblings) {
          if (sibling === filename) continue;
          if (!sibling.startsWith('progress_') || !sibling.endsWith('.json')) continue;
          const existingTs = extractProgressTimestamp(sibling);
          if (existingTs !== null && existingTs > incomingTs) {
            console.log(
              `409: rejecting ${filename} (ts=${incomingTs}) — ${sibling} (ts=${existingTs}) is newer`,
            );
            res.status(409).json({ error: 'Conflict: existing progress file is newer' });
            return;
          }
        }
      } catch (err: any) {
        // If the directory doesn't exist yet, there are no conflicting files
        if (err.code !== 'ENOENT') {
          console.error('PUT /file conflict check error:', err);
          res.status(500).json({ error: 'Internal server error' });
          return;
        }
      }
    }
  }

  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const body = req.body as Buffer;
    await fs.writeFile(absPath, body);
    const stat = await fs.stat(absPath);
    console.log(`PUT /file: ${absPath} (${stat.size} bytes)`);
    res.json({ lastModified: stat.mtimeMs });
  } catch (err) {
    console.error('PUT /file write error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /file?path=<file>
// Returns 200 or 404.
// ---------------------------------------------------------------------------
app.delete('/file', requireAuth, async (req: Request, res: Response): Promise<void> => {
  let absPath: string;
  try {
    absPath = resolveSafe((req.query.path as string) ?? '');
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  try {
    await fs.unlink(absPath);
    console.log(`DELETE /file: ${absPath}`);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Not found' });
    } else {
      console.error('DELETE /file error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /mkdir?path=<dir>
// Creates directory, idempotent. Returns 200.
// ---------------------------------------------------------------------------
app.post('/mkdir', requireAuth, async (req: Request, res: Response): Promise<void> => {
  let absPath: string;
  try {
    absPath = resolveSafe((req.query.path as string) ?? '');
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  try {
    await fs.mkdir(absPath, { recursive: true });
    console.log(`POST /mkdir: ${absPath}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /mkdir error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /rmdir?path=<dir>
// Deletes directory recursively. Returns 200 or 404.
// ---------------------------------------------------------------------------
app.delete('/rmdir', requireAuth, async (req: Request, res: Response): Promise<void> => {
  let absPath: string;
  try {
    absPath = resolveSafe((req.query.path as string) ?? '');
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  // Refuse to delete the data root itself
  if (absPath === DATA_ROOT) {
    res.status(400).json({ error: 'Cannot delete data root' });
    return;
  }

  try {
    await fs.rm(absPath, { recursive: true, force: false });
    console.log(`DELETE /rmdir: ${absPath}`);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Not found' });
    } else {
      console.error('DELETE /rmdir error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`ttsu storage server running on port ${PORT}`);
  console.log(`Data root: ${DATA_ROOT}`);
  console.log(`CORS origin: ${CORS_ORIGIN}`);
});
