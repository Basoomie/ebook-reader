/**
 * /api/v1/fonts (WP13), behind requireUser.
 *
 *   GET  /fonts                                          size limit and live fonts
 *   POST /fonts?name=<font name>&fileName=<file name>   raw font body -> stored + record
 *   GET  /fonts/:id/file[?weight=700]                    the font file (or another weight)
 *   GET  /fonts/google                                   Google's Japanese families (Phase 10)
 *   POST /fonts/google  { family }                       add one: stored + record
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
import { FontError, type FontService, type StoredFace, type StoredFont } from './service';

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

/** A font as the API answers it; a Google font also has its license and other weights. */
export function fontJson(font: StoredFont, faces: readonly StoredFace[] = []) {
  const json: Record<string, unknown> = {
    id: font.id,
    name: font.name,
    fileName: font.fileName,
    format: font.format,
    size: font.size,
    sha256: font.sha256,
    createdAt: font.createdAt,
  };
  if (font.source === 'google') {
    json.source = 'google';
    json.copyright = font.copyright;
    json.licenseUrl = font.licenseUrl;
    json.faces = faces.map(({ weight, format, size, sha256 }) => ({
      weight,
      format,
      size,
      sha256,
    }));
  }
  return json;
}

export function createFontRouter(fonts: FontService): Router {
  const router = express.Router();

  // The size limit and the live fonts (devices learn of fonts from their records;
  // this answers "is the server taking fonts, and up to what size").
  router.get('/fonts', (_req, res) => {
    const { user } = getAuth(res);
    res.json({
      maxBytes: fonts.maxBytes,
      google: !!fonts.google,
      fonts: fonts.liveFonts(user.id).map((f) => fontJson(f, fonts.faces(f.id))),
    });
  });

  // Phase 10: Google's Japanese families, fetched from Google on each call.
  router.get(
    '/fonts/google',
    asyncHandler(async (_req, res) => {
      const { user } = getAuth(res);
      try {
        res.json({ families: await fonts.googleFamilies(user.id) });
      } catch (err) {
        apiError(err);
      }
    }),
  );

  // Phase 10: the server downloads a Google family (regular, and bold where it has one).
  router.post(
    '/fonts/google',
    asyncHandler(async (req, res) => {
      const auth = getAuth(res);
      const family = typeof req.body?.family === 'string' ? req.body.family.trim() : '';
      try {
        if (!auth.token.deviceId) {
          throw new FontError(
            409,
            'device_not_registered',
            'Register this device first (POST /api/v1/devices/register)',
          );
        }
        if (!family) throw new FontError(400, 'invalid_name', 'Name a Google Fonts family');
        const font = await fonts.addGoogleFont(auth.user.id, auth.token.deviceId, family);
        res.status(201).json({ font: fontJson(font, fonts.faces(font.id)) });
      } catch (err) {
        apiError(err);
      }
    }),
  );

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
      // Another weight of the font (a Google font's bold), or the regular file.
      let file: { filePath: string; format: StoredFont['format']; sha256: string } = font;
      if (req.query.weight !== undefined) {
        const weight = Number(req.query.weight);
        const face = fonts.faces(font.id).find((f) => f.weight === weight);
        if (!face) throw new ApiError(404, 'not_found', 'The font has no such weight');
        file = {
          filePath: face.filePath,
          format: face.format as StoredFont['format'],
          sha256: face.sha256,
        };
      }
      const fileMissing = () =>
        new ApiError(404, 'file_missing', 'The font file was not found on the server');
      const stat = await fonts.store.stat(file.filePath);
      if (!stat) throw fileMissing();
      let stream;
      try {
        stream = await fonts.store.openStream(file.filePath);
      } catch {
        throw fileMissing();
      }
      res.set('Content-Type', FONT_CONTENT_TYPES[file.format]);
      res.set('Content-Length', String(stat.size));
      res.set('ETag', `"${file.sha256}"`);
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
