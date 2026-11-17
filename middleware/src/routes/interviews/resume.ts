// /api/interviews/candidates/:id/resume (docs/interviews-tenant-plan.md, row I1.6; decisions 2, 3, 4 and 17):
// a candidate's résumé file. Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   PUT    /candidates/:id/resume        the recruiter only (ManageCandidates). The body IS the file:
//                                        `Content-Type: application/pdf`, the name in `X-File-Name` (percent-encoded).
//                                        Replaces the current résumé. 200 `{ resume }`.
//   GET    /candidates/:id/resume        the record without its storage key: `{ resume }`.
//   GET    /candidates/:id/resume/file   the bytes, inline, in a sandbox.
//   DELETE /candidates/:id/resume        the recruiter only. 200 `{ ok: true }`.
//
// Who may read: exactly the people who may open the candidate; scope.ts already decides that (the recruiter, the
// opening's hiring manager, an interviewer with a round on that candidate), so the reads go through `indexFor`.
// Outside that scope, with the flag off (the mount's own gate), or with no résumé: the ordinary not-found, 404.
//
// The writes run the openings' checks in order: the mount, the authority (403 for everyone but the recruiter, on
// every id alike), the candidate in scope (404), then the body. The body is read only after those, by a raw
// parser limited to RESUME_MAX_BYTES (there is no multipart parser in this service and none is added); the buffer is
// checked again by rules.ts. The app's JSON parser ignores `application/pdf`, and the browser-origin guard in
// index.ts runs ahead of this router for every write, unchanged.
//
// A résumé's contents and name are personal data: they are never written to a log line or a notification.

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { indexFor, param, peopleLookup } from '../../lib/interviews/request.js';
import { NO_STORAGE_SENTENCE, ResumeStorageUnavailableError } from '../../lib/interviews/resume/bytes-store.js';
import { RESUME_MAX_BYTES, inlineDisposition } from '../../lib/interviews/resume/rules.js';
import { readResume, removeResumeFor, resumeRows, storeResume } from '../../lib/interviews/resume/service.js';
import type { ResumeRecord } from '../../lib/interviews/resume/types.js';

export const resumeRouter = Router();
const manage = requireAction('ManageCandidates');

const NO_CANDIDATE = 'There is no candidate here that you can open.';
const NO_RESUME = 'This candidate has no résumé attached.';

/** The record as the routes answer it: everything but where the bytes are, with the uploader by name. */
async function shape(r: ResumeRecord) {
  return {
    id: r.id, candidateId: r.candidateId, fileName: r.fileName, sizeBytes: r.sizeBytes, contentType: r.contentType, sha256: r.sha256,
    uploadedBy: (await peopleLookup())(r.uploadedBy), uploadedAt: r.uploadedAt,
  };
}

/** The candidate in the viewer's scope, else not-found. Sets `res.locals.candidateId`. */
const inScope = asyncHandler(async (req, res, next) => {
  const ix = await indexFor(req);
  const c = ix.candidates.get(param(req, 'id'));
  if (!c) throw new NotFoundError(NO_CANDIDATE);
  res.locals['candidateId'] = c.id;
  next();
});

/** Reads the body as raw bytes, at most the limit; a refusal here is a plain sentence, not the parser's own error. */
function readBody(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('application/pdf')) { res.status(415).json({ error: 'Send the résumé as a PDF file.' }); return; }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > RESUME_MAX_BYTES) { res.status(413).json({ error: 'That file is larger than 10 MB. Choose a smaller PDF.' }); return; }
  express.raw({ type: 'application/pdf', limit: RESUME_MAX_BYTES })(req, res, (err?: unknown) => {
    if ((err as { type?: string } | undefined)?.type === 'entity.too.large') { res.status(413).json({ error: 'That file is larger than 10 MB. Choose a smaller PDF.' }); return; }
    if (err) { res.status(400).json({ error: 'The file could not be read. Choose the résumé again.' }); return; }
    next();
  });
}

resumeRouter.put('/candidates/:id/resume', manage, inScope, readBody, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const result = await storeResume({ candidateId: String(res.locals['candidateId']), bytes: body, rawName: req.get('x-file-name'), uploadedBy: session.sub });
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ resume: await shape(result.resume) });
  } catch (err) {
    if (err instanceof ResumeStorageUnavailableError) { res.status(503).json({ error: NO_STORAGE_SENTENCE }); return; }
    throw err;
  }
}));

resumeRouter.get('/candidates/:id/resume', inScope, asyncHandler(async (_req, res) => {
  const row = await resumeRows().get(String(res.locals['candidateId']));
  if (!row) throw new NotFoundError(NO_RESUME);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ resume: await shape(row) });
}));

resumeRouter.get('/candidates/:id/resume/file', inScope, asyncHandler(async (_req, res) => {
  const found = await readResume(String(res.locals['candidateId']));
  if (!found) throw new NotFoundError(NO_RESUME);
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', inlineDisposition(found.resume.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Content-Length', String(found.bytes.length));
  res.end(found.bytes);
}));

resumeRouter.delete('/candidates/:id/resume', manage, inScope, asyncHandler(async (_req, res) => {
  if (!(await removeResumeFor(String(res.locals['candidateId'])))) throw new NotFoundError(NO_RESUME);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
}));
