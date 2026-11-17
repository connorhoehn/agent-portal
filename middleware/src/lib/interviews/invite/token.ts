// The invite link's token (docs/interviews-tenant-plan.md, row I2.1; decision 3).
//
// 32 random bytes, base64url: 256 bits, so guessing one is not the worry. Only
// its SHA-256 is stored (the invites table, store.ts), so a read of the table
// hands nobody a working link. The comparison is constant-time.
//
// The token and its hash never reach a log line, an error message, a metric
// label or a Referer: nothing in this folder prints either, and the link
// carries the token in the fragment, which no browser sends to a server.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const INVITE_TOKEN_BYTES = 32;
/** base64url of 32 bytes, no padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

/** SHA-256, hex. A malformed token still hashes, so every refusal costs the same work. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether `token` has the shape a minted token has. A wrong shape is refused like a wrong token. */
export function wellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

/** Two hex hashes, compared without an early exit. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  if (x.length !== 32 || y.length !== 32) return false;
  return timingSafeEqual(x, y);
}

/** An invite row's id: opaque, and never derived from the token. */
export const newInviteId = (): string => `inv-${randomUUID()}`;
