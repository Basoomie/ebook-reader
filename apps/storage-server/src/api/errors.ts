import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Every /api/v1 error has the shape { error: { code, message } }.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra fields of the error object (e.g. the span of a search error). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  res.status(status).json({ error: { ...details, code, message } });
}

/** Express 4 does not catch rejected promises; route async handlers through this. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function notFound(req: Request, res: Response): void {
  sendError(res, 404, 'not_found', `No API route for ${req.method} ${req.baseUrl}${req.path}`);
}

// Express recognizes error middleware by its four parameters.
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ApiError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
    return;
  }
  if (type === 'entity.too.large') {
    sendError(res, 413, 'too_large', 'Request body is too large');
    return;
  }
  console.error('API error:', err);
  sendError(res, 500, 'internal', 'Internal server error');
}
