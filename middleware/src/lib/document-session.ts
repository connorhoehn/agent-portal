import { DEMO_SUB, demoFallbackAllowed, permissiveGrants, type Session } from './session.js';
import { insecureDevMode } from './insecure-dev-mode.js';
import { getUser } from '../providers/identity.js';

/** The demo persona has no identity row, so it has no stored epoch to revoke
 * against: its cookie is never re-resolved (lib/session.ts) and the epoch a
 * tenant/role switch stamps on it is whatever the in-memory bump returned.
 * Under INSECURE_DEV_MODE, while the demo fallback is live (no Cognito, demo
 * mode on — i.e. `dev:mock`), the session's own epoch is taken as current and
 * the role is checked against the permissive demo grants, so the demo user gets
 * the same canvas as everyone else (read-only unless its role may edit).
 * Production, and any process without the flag, never takes this branch. */
function demoIdentity(sub: string, epoch: number): { epoch: number; grants: Record<string, string[]> } | null {
  if (sub !== DEMO_SUB || !insecureDevMode() || !demoFallbackAllowed()) return null;
  return { epoch, grants: permissiveGrants() };
}

interface DocumentSessionReference {
  role: string;
  epoch: number;
  iat: number;
  actor?: { sub: string; epoch: number };
}

/** Opaque reference carried INSIDE a signed document grant, never a login token. */
export function documentSessionId(session: Session): string {
  const reference: DocumentSessionReference = {
    role: session.role, epoch: session.epoch ?? 0, iat: session.iat,
    ...(session.act ? { actor: { sub: session.act.sub, epoch: session.act.epoch ?? 0 } } : {}),
  };
  return Buffer.from(JSON.stringify(reference)).toString('base64url');
}

/** Called only after grant verification or over the service-authenticated endpoint. */
export async function currentDocumentSessionEpoch(sub: string, tenantId: string, sessionId: string): Promise<number | null> {
  let reference: DocumentSessionReference;
  try {
    if (sessionId.length > 512) return null;
    reference = JSON.parse(Buffer.from(sessionId, 'base64url').toString('utf8'));
    if (!reference || typeof reference.role !== 'string' || !Number.isSafeInteger(reference.epoch)
      || reference.epoch < 0 || !Number.isFinite(reference.iat)) return null;
  } catch { return null; }
  const user = demoIdentity(sub, reference.epoch) ?? await getUser(sub, { authoritative: true });
  if (!user || user.epoch !== reference.epoch || !user.grants[tenantId]?.includes(reference.role)) return null;
  if (reference.actor) {
    if (typeof reference.actor.sub !== 'string' || !Number.isSafeInteger(reference.actor.epoch)) return null;
    const actor = await getUser(reference.actor.sub, { authoritative: true });
    if (!actor || actor.epoch !== reference.actor.epoch || !Object.values(actor.grants).some(roles => roles.includes('admin'))) return null;
  }
  return user.epoch;
}
