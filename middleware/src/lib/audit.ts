// Structured audit log for authorization decisions. Today this just emits
// JSON lines on stdout — Docker / ECS log drivers ship them to CloudWatch.

import type { Session } from './session.js';

interface AuthzEvent {
  decision: 'ALLOW' | 'DENY';
  action: string;
  sub: string;
  role: string;
  reason?: string;
  path?: string;
}

export function logAuthz(ev: AuthzEvent): void {
  process.stdout.write(JSON.stringify({
    type: 'authz',
    ts: new Date().toISOString(),
    ...ev,
  }) + '\n');
}

export function eventFromSession(session: Session, action: string, decision: 'ALLOW' | 'DENY', extra?: Partial<AuthzEvent>): AuthzEvent {
  return {
    decision,
    action,
    sub: session.sub,
    role: session.role,
    ...extra,
  };
}
