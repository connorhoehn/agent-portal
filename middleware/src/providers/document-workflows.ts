import type { Session } from '../lib/session.js';
import { getKnowledgeDoc } from './assessment.js';

export type WorkflowOperation =
  | { kind: 'lifecycle' | 'write-policy' | 'review-requests' | 'reviews'; method: 'GET' }
  | { kind: 'transition' | 'ownership' | 'request-review'; method: 'POST'; body: Record<string, unknown> }
  | { kind: 'update-review'; method: 'PATCH'; requestKey: string; body: Record<string, unknown> }
  | { kind: 'items'; method: 'GET'; sectionId: string }
  | { kind: 'item-ack' | 'item-answer'; method: 'POST'; sectionId: string; itemId: string; body: Record<string, unknown> }
  // Document comments (platform-api routes/documentComments.ts). The grant's
  // `comment` operation covers all four; author-only edits and the owner rule
  // on delete stay platform-api's to enforce.
  | { kind: 'comments'; method: 'GET'; cursor?: string }
  | { kind: 'comment-create'; method: 'POST'; body: Record<string, unknown> }
  | { kind: 'comment-update'; method: 'PATCH'; commentId: string; body: Record<string, unknown> }
  | { kind: 'comment-delete'; method: 'DELETE'; commentId: string };

export class DocumentWorkflowError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function segment(value: string): string {
  // Dot segments are normalized by URL/fetch even when escaped. Reject them
  // along with separators rather than treating them as document resources.
  if (!value || value.length > 512 || value === '.' || value === '..' || /[\\/\u0000-\u001f]/.test(value)) {
    throw new DocumentWorkflowError(400, 'Invalid workflow resource');
  }
  return encodeURIComponent(value);
}

function route(operation: WorkflowOperation): string {
  switch (operation.kind) {
    case 'lifecycle': return '/lifecycle';
    case 'write-policy': return '/lifecycle/write-policy';
    case 'reviews': return '/reviews';
    case 'review-requests': case 'request-review': return '/review-requests';
    case 'transition': return '/lifecycle/transitions';
    case 'ownership': return '/lifecycle/ownership';
    case 'update-review': return `/review-requests/${segment(operation.requestKey)}`;
    case 'items': return `/sections/${segment(operation.sectionId)}/items`;
    case 'item-ack': case 'item-answer': return `/sections/${segment(operation.sectionId)}/items/${segment(operation.itemId)}/${operation.kind === 'item-ack' ? 'ack' : 'answer'}`;
    case 'comments': return `/comments?limit=200${operation.cursor ? `&cursor=${encodeURIComponent(operation.cursor)}` : ''}`;
    case 'comment-create': return '/comments';
    case 'comment-update': case 'comment-delete': return `/comments/${segment(operation.commentId)}`;
  }
}

/** Fixed document operations only. The browser supplies a source ID; canonical
 * identity, actor and operation scope come from the BFF's revocable grant. */
export async function performDocumentWorkflow(sourceId: string, session: Session, operation: WorkflowOperation): Promise<{ status: number; body: Record<string, unknown> }> {
  const suffix = route(operation);
  const configured = process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
  if (!configured) throw new DocumentWorkflowError(503, 'Document workflows are not configured');
  const base = new URL(configured);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new DocumentWorkflowError(503, 'Invalid document workflow configuration');
  }
  const source = await getKnowledgeDoc(sourceId);
  if (!source) throw new DocumentWorkflowError(404, 'Document not found');
  // Loaded on use: the canvas module pulls in the Tiptap schema, and the
  // assessment router reaches this bridge through the comments provider.
  const { documentWorkflowAccess } = await import('./document-canvas.js');
  const access = await documentWorkflowAccess(source, session);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(access.documentId)) {
    throw new DocumentWorkflowError(503, 'Document mapping is unavailable');
  }
  if (operation.kind === 'request-review') {
    if (!access.canManageWorkflow) throw new DocumentWorkflowError(403, 'Document management permission required');
    const reviewerId = operation.body.reviewerId;
    if (typeof reviewerId !== 'string' || !reviewerId) throw new DocumentWorkflowError(400, 'Reviewer required');
    const { getUser } = await import('./identity.js');
    const reviewer = await getUser(reviewerId, { authoritative: true });
    if (!reviewer || !await eligibleAssessmentReviewer(reviewer)) throw new DocumentWorkflowError(400, 'Reviewer must have current assessment access');
  }
  const response = await fetch(new URL(`/api/documents/${access.documentId}${suffix}`, base), {
    method: operation.method, redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' },
    ...('body' in operation ? { body: JSON.stringify(operation.body) } : {}),
  });
  const raw = await response.text();
  if (raw.length > 2 * 1024 * 1024) throw new DocumentWorkflowError(503, 'Document workflow response is too large');
  const body: unknown = raw ? JSON.parse(raw) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DocumentWorkflowError(503, 'Invalid document workflow response');
  // Keep platform owner/reviewer, state-machine and CAS errors intact. A failed
  // transition is never retried as an ownership claim or with broader grants.
  const lifecycle = (body as { lifecycle?: { ownerId?: unknown } }).lifecycle;
  const capabilities = operation.kind === 'lifecycle' && response.ok ? {
    canManageWorkflow: access.canManageWorkflow === true && lifecycle?.ownerId === session.sub,
    canClaimOwnership: access.canManageWorkflow === true && lifecycle?.ownerId === null,
  } : {};
  return { status: response.status, body: { ...body, ...capabilities, ...(response.ok ? { documentId: access.documentId } : {}) } };
}


async function eligibleAssessmentReviewer(user: import('./identity.js').UserInfo): Promise<boolean> {
  const { isAllowed } = await import('../lib/authz.js');
  for (const role of user.grants['assessment'] ?? []) {
    if (await isAllowed({ sub: user.id, tenant: 'assessment', role }, 'ViewAssessment')) return true;
  }
  return false;
}

/** Eligible real identities for an owner-created review assignment. */
export async function listDocumentReviewers(sourceId: string, session: Session) {
  const workflow = await performDocumentWorkflow(sourceId, session, { kind: 'lifecycle', method: 'GET' });
  if (workflow.status !== 200) throw new DocumentWorkflowError(workflow.status, 'Document ownership is unavailable');
  if (workflow.body.canManageWorkflow !== true) throw new DocumentWorkflowError(403, 'Document ownership required to request reviews');
  const { listUsers } = await import('./identity.js');
  const users = await listUsers();
  const eligible = await Promise.all(users.map(async user => await eligibleAssessmentReviewer(user) ? { id: user.id, displayName: user.displayName } : null));
  return { reviewers: eligible.filter((user): user is { id: string; displayName: string } => user !== null) };
}
