import { Router } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { resolveDmPageReference } from '../lib/dm-page-references.js';

export const dmPageReferencesRouter = Router();
dmPageReferencesRouter.get('/dms/page-reference', asyncHandler(async (req, res) => {
  if (!req.session) throw new AppError(401, 'Unauthenticated');
  const channel = req.query['channel'], messageId = req.query['messageId'];
  if (typeof channel !== 'string' || typeof messageId !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(messageId)) {
    throw new ValidationError('Name the direct message channel and messageId');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(await resolveDmPageReference(channel, messageId, req.session));
}));
