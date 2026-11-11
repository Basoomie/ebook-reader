/**
 * /api/v1/fonts (WP13), behind requireUser.
 *
 *   GET  /fonts                                          size limit and live fonts
 *   POST /fonts?name=<font name>&fileName=<file name>   raw font body -> stored + record
 *   GET  /fonts/:id/file                                 the font file
 *
 * Deleting (and restoring) a font is a change of its "font" sync record; nothing is
 * deleted on the server, so a deleted font can come back.
 */
import express, { Router } from 'express';
import { pipeline } from 'stream/promises';
import { getAuth } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { UUID_RE } from '../sync/kinds';
import { FONT_CONTENT_TYPES } from './font-format';
import { FontError, type FontService, type StoredFont } from './service';

function apiError(err: unknown): never {
  if (err instanceof FontError) throw new ApiError(err.status, err.code, err.message);
  throw err;
}

/** Reads and drops a request body, so a refusal reaches the client instead of a reset. */
function drain(req: express.Request): Promise<void> {
  return new Promise<void>((resolve) => {
    if (req.readableEnded) {
      resolve();
      return;
    }
    req.on('end', resolve);
    req.on('error', () => resolve());
    req.resume();
  });
}

export function fontJson(font: StoredFont) {
  return {
    id: font.id,
    name: font.name,
    fileName: font.fileName,
    format: font.format,
    size: font.size,
    sha256: font.sha256,
    createdAt: font.createdAt,
  };
}

export function createFontRouter(fonts: FontService): Router {
  const router = express.Router();

  // The size limit and the live fonts (devices learn of fonts from their records;
  // this answers "is the server taking fonts, and up to what size").
  router.get('/fonts', (_req, res) => {
    const { user } = getAuth(res);
    res.json({ maxBytes: fonts.maxBytes, fonts: fonts.liveFonts(user.id).map(fontJson) });
  });

  router.post(
    '/fonts',
    asyncHandler(async (req, res) => {
      const auth = getAuth(res);
      const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
      const fileName = typeof req.query.fileName === 'string' ? req.query.fileName : '';
      const deviceId = auth.token.deviceId;
      try {
        if (!deviceId) {
          throw new FontError(
            409,
            'device_not_registered',
            'Register this device first (POST /api/v1/devices/register)',
          );
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > fonts.maxBytes) {
          throw new FontError(
            413,
            'too_large',
            `The file is larger than ${Math.round(fonts.maxBytes / 1024 / 1024)} MB`,
          );
        }
        fonts.checkName(auth.user.id, name);
      } catch (err) {
        await drain(req);
        apiError(err);
      }
      try {
        const { font, existing } = await fonts.upload(
          auth.user.id,
          deviceId as string,
          name,
          fileName,
          req,
        );
        res.status(existing ? 200 : 201).json({ font: fontJson(font), existing });
      } catch (err) {
        apiError(err);
      }
    }),
  );

  router.get(
    '/fonts/:id/file',
    asyncHandler(async (req, res) => {
      const { user } = getAuth(res);
      const notFound = () => new ApiError(404, 'not_found', 'No such font');
      if (!UUID_RE.test(req.params.id)) throw notFound();
      const font = fonts.getFont(user.id, req.params.id);
      if (!font) throw notFound();
      const fileMissing = () =>
        new ApiError(404, 'file_missing', 'The font file was not found on the server');
      const stat = await fonts.store.stat(font.filePath);
      if (!stat) throw fileMissing();
      let stream;
      try {
        stream = await fonts.store.openStream(font.filePath);
      } catch {
        throw fileMissing();
      }
      res.set('Content-Type', FONT_CONTENT_TYPES[font.format]);
      res.set('Content-Length', String(stat.size));
      res.set('ETag', `"${font.sha256}"`);
      // A font id never changes its bytes.
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      try {
        await pipeline(stream, res);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        throw err;
      }
    }),
  );

  return router;
}
