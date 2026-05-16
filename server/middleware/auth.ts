import type { Request, Response, NextFunction } from 'express';
import { bearerFromHeader, verifyAppToken } from '../auth/appJwt.js';

export type AuthedRequest = Request & { userId?: string; userEmail?: string; userName?: string };

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  const payload = verifyAppToken(token);
  if (!payload) {
    res.status(401).json({ ok: false, error: 'invalid_token' });
    return;
  }
  req.userId = payload.sub;
  req.userEmail = payload.email;
  req.userName = payload.name;
  next();
}

export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = bearerFromHeader(req.headers.authorization);
  if (token) {
    const payload = verifyAppToken(token);
    if (payload) {
      req.userId = payload.sub;
      req.userEmail = payload.email;
      req.userName = payload.name;
    }
  }
  next();
}
