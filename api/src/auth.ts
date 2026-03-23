import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { generateAlias } from './alias.js';
import { logger } from './logger.js';
import type { Request, Response } from 'express';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-32-chars-min';

export interface JWTPayload {
  sub: string;
  alias: string;
  iat: number;
  exp: number;
}

export interface AuthContext {
  user: JWTPayload;
  fingerprint: string;
  isNewUser: boolean;
  token: string;
}

export function fingerprintFromSub(sub: string): string {
  return createHash('sha256').update(sub).digest('hex');
}

export function createToken(sub?: string): { token: string; payload: JWTPayload } {
  const userId = sub || uuidv4();
  const alias = generateAlias(userId);
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: userId,
    alias,
    iat: now,
    exp: now + 30 * 24 * 60 * 60, // 30 days
  };

  const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
  return { token, payload };
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JWTPayload;
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response): AuthContext {
  const authHeader = req.headers.authorization;
  let isNewUser = false;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);

    if (payload) {
      return {
        user: payload,
        fingerprint: fingerprintFromSub(payload.sub),
        isNewUser: false,
        token,
      };
    }
  }

  // Auto-generate new JWT
  const { token, payload } = createToken();
  isNewUser = true;

  // Set the new token in response header
  res.setHeader('X-Auth-Token', token);

  logger.info({ message: 'New user token generated', alias: payload.alias });

  return {
    user: payload,
    fingerprint: fingerprintFromSub(payload.sub),
    isNewUser,
    token,
  };
}
