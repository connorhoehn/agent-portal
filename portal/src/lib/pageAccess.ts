// A page this role may not open (UX walk, 9 November 2026, defect 1).
//
// RequireRole used to fall back to the tenant's front door, so a deep link,
// a bookmark or a voice `open` to a gated page landed on the empty "My
// initiatives" view with no word about why. The route now keeps its URL and
// renders a "no access" page (components/NoAccessPage.tsx), and the palette,
// the rail and the voice `open` refusal all name the same next step, decided
// here:
//
//   1. switch — the session already holds a role that opens the page
//      (`switchable[tenant]`, the G58 pattern: POST /api/session/role);
//   2. request — the Access catalog has an item for a role that opens it, and
//      the viewer has a directory account to grant it to: the in-tenant quick
//      request (POST /api/access-requests/quick) files it;
//   3. ask — nothing to switch to and nothing requestable: ask an org-leader.
//
// Presentation only: the server still gates every read. No React — node:test runs it.

/** Least to most privileged; the first role in this order that opens a page is the one named. */
export const ROLE_ORDER = ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin'] as const;

/**
 * The tenant roles the Access catalog offers as requestable items (`role:<tenant>:<role>`), mirroring
 * middleware/src/mock/access-catalog.ts (a test reads that file and fails on drift). orgiq `hr-admin` and
 * `program-owner` are standing grants an org-leader assigns, never requested.
 */
export const REQUESTABLE_ROLES: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['sme', 'org-leader'],
  assessment: ['assessor', 'lead-assessor'],
  social: ['moderator'],
  pipelines: ['operator'],
};

/** The catalog item a (tenant, role) grant is requested as (middleware lib/access/items.ts roleItemId). */
export const roleItemId = (tenant: string, role: string): string => `role:${tenant}:${role}`;

/** Who to ask when nothing can be switched to or requested. */
const ASK_WHOM: Readonly<Record<string, string>> = {
  orgiq: 'an org-leader', assessment: 'a program lead', social: 'a Social moderator', pipelines: 'a pipeline admin', access: 'an access admin',
};

export interface AccessSession {
  role: string;
  tenant: string;
  switchable?: Readonly<Record<string, readonly string[]>> | null;
}

export type AccessNextStep =
  | { kind: 'switch'; role: string; label: string }
  | { kind: 'request'; role: string; itemId: string; label: string }
  | { kind: 'ask'; label: string };

const rank = (r: string) => { const i = (ROLE_ORDER as readonly string[]).indexOf(r); return i < 0 ? ROLE_ORDER.length : i; };
const byRank = (a: string, b: string) => rank(a) - rank(b);

/** Whether `role` passes a gate that names `roles` (none named: open to every role; `admin` passes every gate). */
export function roleOpens(role: string, roles: readonly string[] | null | undefined): boolean {
  return !roles || roles.length === 0 || role === 'admin' || roles.includes(role);
}

/** "org-leader or hr-admin" — the roles a page needs, least privileged first. */
export function rolesPhrase(roles: readonly string[]): string {
  const list = [...new Set(roles)].filter((r) => r !== 'admin').sort(byRank);
  if (list.length <= 1) return list[0] ?? 'admin';
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

/**
 * What a viewer can do about a page gated to `roles`, or null when their role already opens it.
 * `canRequest` false (a session with no directory account, such as the cookie-less demo persona)
 * never offers a request: the quick request route would refuse it.
 */
export function accessNextStep(session: AccessSession | null | undefined, roles: readonly string[] | null | undefined, opts: { canRequest?: boolean } = {}): AccessNextStep | null {
  if (!session) return { kind: 'ask', label: 'Sign in to open this page' };
  if (roleOpens(session.role, roles)) return null;
  const gate = roles ?? [];
  const held = session.switchable?.[session.tenant] ?? [];
  const switchTo = held.filter((r) => r !== session.role && roleOpens(r, gate)).sort(byRank)[0];
  if (switchTo) return { kind: 'switch', role: switchTo, label: `Switch to ${switchTo}` };
  const requestable = (REQUESTABLE_ROLES[session.tenant] ?? []).filter((r) => gate.includes(r)).sort(byRank)[0];
  if (requestable && opts.canRequest !== false) {
    return { kind: 'request', role: requestable, itemId: roleItemId(session.tenant, requestable), label: `Request ${requestable} access` };
  }
  return { kind: 'ask', label: `Ask ${ASK_WHOM[session.tenant] ?? 'an admin'} for ${rolesPhrase(gate)}` };
}

/** Whether a gated page is still worth offering in the palette or rail: the viewer opens it, or can switch into a role that does. */
export function offerPage(session: AccessSession | null | undefined, roles: readonly string[] | null | undefined): { offer: boolean; switchTo: string | null } {
  if (!session) return { offer: false, switchTo: null };
  const step = accessNextStep(session, roles);
  if (step == null) return { offer: true, switchTo: null };
  return step.kind === 'switch' ? { offer: true, switchTo: step.role } : { offer: false, switchTo: null };
}

/** The refusal sentence a page gate gives (the no-access page's body and the voice `open` refusal share it). */
export function noAccessReason(label: string, role: string, roles: readonly string[]): string {
  return `${label} opens for ${rolesPhrase(roles)}; you are signed in as ${role}.`;
}
