// The Auth Migration fixtures the coverage tests share (10 November): the Work tab as the page publishes it, the
// initiative's work tree, its sprints and decisions, as the mock serves them.

import type { PublishedPage } from '../pageContext.ts';

export const P = 'p-auth-migration';
const href = (id: string) => `/iq/projects/${P}?item=${id}`;
/** The Work tab of Auth Migration as the page publishes it: owner, sprint and what a blocked row waits on. */
export const AUTH_PAGE: PublishedPage = {
  path: `/iq/projects/${P}`, record: { ref: `initiative:${P}`, title: 'Auth Migration' }, rowsLabel: 'work items',
  rows: [
    { ref: 'work-item:wi-auth-e1-s3', title: 'Session cookie hardening: max-age, rotation on switch', status: 'in_review', priority: 'high', assignee: 'Nora DaSilva', sprint: 'spr-auth-s2', href: href('wi-auth-e1-s3') },
    { ref: 'work-item:wi-auth-e2-s2', title: 'Tenant-by-tenant cutover runbook with rollback', status: 'open', priority: 'high', assignee: 'Simone Chang', sprint: 'spr-auth-s2', blockedOn: 'Cutover order for legacy SSO tenants', href: href('wi-auth-e2-s2') },
    { ref: 'work-item:wi-auth-e2-b3', title: 'Logout leaves the legacy shim cookie alive', status: 'open', priority: 'medium', assignee: 'Vera Green', sprint: 'spr-auth-s2', href: href('wi-auth-e2-b3') },
    { ref: 'work-item:wi-auth-e1-s1', title: 'BFF authorization-code + PKCE flow behind the middleware', status: 'done', priority: 'critical', assignee: 'Simone Chang', sprint: 'spr-auth-s1', href: href('wi-auth-e1-s1') },
  ],
};
export const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, type: 'story', projectId: P, status: 'open', priority: 'high', labels: [], ...over });
export const AUTH_TREE = [{
  ...item('wi-auth-e2', 'Legacy SSO decommission', { type: 'epic' }), children: [
    item('wi-auth-e2-s2', 'Tenant-by-tenant cutover runbook with rollback', { assigneeName: 'Simone Chang', sprintId: 'spr-auth-s2', labels: ['decom', 'blocked'], blockedByDecisionId: 'd-cognito-cutover', blockedReason: 'Waits on the cutover order' }),
    item('wi-auth-e2-b3', 'Logout leaves the legacy shim cookie alive', { type: 'bug', priority: 'medium', assigneeName: 'Vera Green', sprintId: 'spr-auth-s2', nextStep: 'Reproduce the logout with the shim cookie set.', summary: 'The shim cookie outlives logout.' }),
    item('wi-auth-e2-s1', 'Inventory every consumer still on the SAML shim', { status: 'done', assigneeName: 'Nora DaSilva', sprintId: 'spr-auth-s1' }),
  ],
}];
export const AUTH_SPRINTS = { sprints: [
  { id: 'spr-auth-s2', name: 'Sprint 10 — Session hygiene', status: 'active', startsOn: '2026-11-01', endsOn: '2026-11-14' },
  { id: 'spr-auth-s1', name: 'Sprint 9 — OIDC core', status: 'done', startsOn: '2026-10-18', endsOn: '2026-10-31' },
] };
export const DETAIL = { id: P, name: 'Auth Migration', contributors: [{ personId: 'p-002', name: 'Vera Green' }, { personId: 'p-004', name: 'Nora DaSilva' }, { personId: 'p-051', name: 'Simone Chang' }] };
export const AUTH_DECISIONS = [{ id: 'd-cognito-cutover', topic: 'Cutover order for legacy SSO tenants', status: 'escalated' }];
