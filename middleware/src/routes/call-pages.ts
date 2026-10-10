import { Router } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { resolveSession } from '../lib/authz.js';
import { callPageRuntime, CallPageConflict, type CallPageDescriptor } from '../lib/call-pages.js';
import type { Session } from '../lib/session.js';
import type { Request } from 'express';

export const callPagesRouter = Router();
function session(req: Request): Session {
  const value = resolveSession(req);
  if (!value) throw new AppError(401, 'Unauthenticated');
  return value;
}
function callId(req: Request): string {
  const value = req.params['callId'];
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(value)) throw new ValidationError('Invalid call id');
  return value;
}
function body(req: Request, write: boolean): { expectedRevision: number; page?: CallPageDescriptor } {
  const value = req.body as Record<string, unknown> | null;
  const allowed = write ? ['expectedRevision', 'page'] : ['expectedRevision'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ValidationError(`Send only ${allowed.join(' and ')}`);
  }
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) throw new ValidationError('expectedRevision must be a non-negative integer');
  if (!write) return { expectedRevision: Number(value.expectedRevision) };
  const page = value.page as Record<string, unknown> | null;
  if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).some(key => !['kind', 'id'].includes(key))
    || !['initiative', 'work-item'].includes(String(page.kind)) || typeof page.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(page.id)) {
    throw new ValidationError('page must contain only kind (initiative or work-item) and a valid id');
  }
  return { expectedRevision: Number(value.expectedRevision), page: page as unknown as CallPageDescriptor };
}
callPagesRouter.get('/:callId/page', asyncHandler(async (req, res) => {
  res.json(await callPageRuntime().get(callId(req), session(req)));
}));
function mutation(method: 'put' | 'delete') {
  return asyncHandler(async (req, res) => {
    const input = body(req, method === 'put');
    try {
      const service = callPageRuntime();
      res.json(method === 'put'
        ? await service.put(callId(req), session(req), input.expectedRevision, input.page!)
        : await service.clear(callId(req), session(req), input.expectedRevision));
    } catch (error) {
      if (error instanceof CallPageConflict) { res.status(409).json({ error: error.message, snapshot: error.snapshot }); return; }
      throw error;
    }
  });
}
callPagesRouter.put('/:callId/page', mutation('put'));
callPagesRouter.delete('/:callId/page', mutation('delete'));
