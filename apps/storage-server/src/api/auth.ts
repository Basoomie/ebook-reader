import type Database from 'better-sqlite3';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authenticateToken, AuthenticatedToken, type TokenScope } from '../db/tokens';
import { sendError } from './errors';

function requireScope(db: Database.Database, scope: TokenScope): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const auth = match ? authenticateToken(db, match[1]) : null;
    if (!auth) {
      sendError(res, 401, 'unauthorized', 'Missing, unknown or revoked token');
      return;
    }
    if (auth.token.scope !== scope) {
      sendError(
        res,
        403,
        'wrong_token',
        scope === 'user'
          ? "The GPU worker's token can only be used by the worker"
          : 'Only a GPU worker token can be used here',
      );
      return;
    }
    res.locals.auth = auth;
    next();
  };
}

/**
 * Accepts only per-user tokens (Authorization: Bearer ttsu_...). The old sync's
 * AUTH_TOKEN is never accepted, and (WP16) neither is a GPU worker's token.
 */
export function requireUser(db: Database.Database): RequestHandler {
  return requireScope(db, 'user');
}

/** WP16: only the GPU worker's token (`cli token worker`), for /api/v1/worker/*. */
export function requireWorker(db: Database.Database): RequestHandler {
  return requireScope(db, 'worker');
}

/** The authenticated user and token for a request that passed requireUser/requireWorker. */
export function getAuth(res: Response): AuthenticatedToken {
  return res.locals.auth as AuthenticatedToken;
}
