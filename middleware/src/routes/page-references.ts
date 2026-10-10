// GET /api/page-references/resolve — a stored chat page reference resolved for
// THIS reader. Session floor only (not requireTenant): a reader without the
// resource's current authority gets `status: 'unavailable'`, never a 403 that
// would distinguish an existing resource from a refused one.
import { Router } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { assessmentDimensionDescriptor, resolveAssessmentDimensionReference } from '../lib/assessment-page-references.js';

export const pageReferencesRouter = Router();
pageReferencesRouter.get('/resolve', asyncHandler(async (req, res) => {
  if (!req.session) throw new AppError(401, 'Unauthenticated');
  const descriptor = assessmentDimensionDescriptor({ kind: req.query['kind'], id: req.query['id'] });
  if (!descriptor) throw new ValidationError('Name an assessment-dimension kind and a <TEAM-id>:<dimensionId> id');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ pageReference: await resolveAssessmentDimensionReference(descriptor, req.session) });
}));
