import type Database from 'better-sqlite3';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authenticateToken, AuthenticatedToken } from '../db/tokens';
import { sendError } from './errors';

/**
 * Accepts only per-user tokens (Authorization: Bearer ttsu_...). The legacy
 * AUTH_TOKEN is deliberately not accepted here.
 */
export function requireUser(db: Database.Database): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const auth = match ? authenticateToken(db, match[1]) : null;
    if (!auth) {
      sendError(res, 401, 'unauthorized', 'Missing, unknown or revoked token');
      return;
    }
    res.locals.auth = auth;
    next();
  };
}

/** The authenticated user and token for a request that passed requireUser. */
export function getAuth(res: Response): AuthenticatedToken {
  return res.locals.auth as AuthenticatedToken;
}
