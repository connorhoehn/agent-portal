import type { Session } from '../lib/session.js';
import { getKnowledgeDoc } from './assessment.js';
import { documentWorkflowAccess } from './document-canvas.js';

export type WorkflowOperation =
  | { kind: 'lifecycle' | 'review-requests' | 'reviews'; method: 'GET' }
  | { kind: 'transition' | 'ownership' | 'request-review'; method: 'POST'; body: Record<string, unknown> }
  | { kind: 'update-review'; method: 'PATCH'; requestKey: string; body: Record<string, unknown> }
  | { kind: 'items'; method: 'GET'; sectionId: string }
  | { kind: 'item-ack' | 'item-answer'; method: 'POST'; sectionId: string; itemId: string; body: Record<string, unknown> };

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
    case 'reviews': return '/reviews';
    case 'review-requests': case 'request-review': return '/review-requests';
    case 'transition': return '/lifecycle/transitions';
    case 'ownership': return '/lifecycle/ownership';
    case 'update-review': return `/review-requests/${segment(operation.requestKey)}`;
    case 'items': return `/sections/${segment(operation.sectionId)}/items`;
    case 'item-ack': case 'item-answer': return `/sections/${segment(operation.sectionId)}/items/${segment(operation.itemId)}/${operation.kind === 'item-ack' ? 'ack' : 'answer'}`;
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
  const access = await documentWorkflowAccess(source, session);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(access.documentId)) {
    throw new DocumentWorkflowError(503, 'Document mapping is unavailable');
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
  return { status: response.status, body: { ...body, ...(response.ok ? { documentId: access.documentId } : {}) } };
}
