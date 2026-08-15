import * as crypto from 'crypto';
import { Config } from '../config';
import { Unauthorized } from '../errors/unauthorized';
import { AuthenticatedUser } from './types';

interface AuthDependencies {
  logger: Console;
}

/**
 * Verifies Supabase Auth JWTs. Supabase signs user tokens with the project's
 * JWT secret using HS256; we verify the signature, expiry, and audience here so
 * the same identity the database enforces via RLS (`auth.uid()`) is available to
 * request handlers. Verification is dependency-free (Node `crypto`), matching the
 * hand-rolled AES-GCM handling in `config.ts`.
 */
export default class AuthService {
  private readonly secret: string;
  private readonly audience?: string;
  private readonly logger: Console;

  constructor(config: Config, dependencies: AuthDependencies) {
    if (!config.auth?.jwtSecret) {
      throw new Error('auth.jwtSecret must be configured to verify authentication tokens');
    }
    this.secret = config.auth.jwtSecret;
    this.audience = config.auth.audience;
    this.logger = dependencies.logger;
  }

  /**
   * Verify a bearer token and return its identity, or throw `Unauthorized` if
   * the token is malformed, tampered with, expired, or for the wrong audience.
   */
  verifyToken(token: string): AuthenticatedUser {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Unauthorized('Malformed authentication token');
    }
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = this.decodeSegment(headerB64, 'header');
    if (header.alg !== 'HS256') {
      throw new Unauthorized('Unsupported authentication token algorithm');
    }

    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const provided = Buffer.from(signatureB64, 'base64url');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      throw new Unauthorized('Invalid authentication token signature');
    }

    const payload = this.decodeSegment(payloadB64, 'payload');
    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp === 'number' && now >= payload.exp) {
      throw new Unauthorized('Authentication token has expired');
    }
    if (typeof payload.nbf === 'number' && now < payload.nbf) {
      throw new Unauthorized('Authentication token is not yet valid');
    }

    if (this.audience !== undefined) {
      const aud = payload.aud;
      const matches = Array.isArray(aud) ? aud.includes(this.audience) : aud === this.audience;
      if (!matches) {
        throw new Unauthorized('Authentication token audience mismatch');
      }
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Unauthorized('Authentication token is missing a subject');
    }

    return {
      userId: payload.sub,
      role: typeof payload.role === 'string' ? payload.role : 'authenticated',
      email: typeof payload.email === 'string' ? payload.email : undefined,
      claims: payload,
    };
  }

  private decodeSegment(segment: string, kind: string): Record<string, unknown> {
    try {
      const json = Buffer.from(segment, 'base64url').toString('utf8');
      const parsed = JSON.parse(json);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('segment is not a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      this.logger.debug?.(`Failed to decode JWT ${kind}: ${(err as Error).message}`);
      throw new Unauthorized(`Malformed authentication token ${kind}`);
    }
  }
}
