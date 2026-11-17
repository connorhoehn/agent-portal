// POST /api/interviews/candidates (UI round 2, lane DESK-B; contract U13): the recruiter adds a candidate to an opening.
// The write pattern is openings.ts's: the mount gate, ManageCandidates (a guest and every other role is refused), the
// opening in the viewer's scope (404), the input (400, one sentence per field), the duplicate (409), then the write.
// The route checks; the store only writes. The new candidate has no résumé yet; it is uploaded on the profile.

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { interviewsNow } from '../../lib/interviews/clock.js';
import type { FieldProblem } from '../../lib/interviews/kit.js';
import { indexFor } from '../../lib/interviews/request.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import { DuplicateCandidateError } from '../../lib/interviews/store.js';
import type { Application, Candidate } from '../../lib/interviews/types.js';

export const candidatesRouter = Router();
const manage = requireAction('ManageCandidates');

const NO_OPENING = 'There is no opening here that you can open.';
const DUPLICATE = 'This person is already a candidate for this opening.';
export const CANDIDATE_LIMITS = { name: 120, email: 200, headline: 120, location: 80, source: 60 } as const;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const newId = (prefix: string): string => `${prefix}-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

export interface NewCandidateFields { name: string; email: string; headline: string; location: string; source: string; openingId: string }

/** The body, cleaned, or one sentence per field that needs fixing. */
export function checkCandidate(body: unknown): { ok: true; value: NewCandidateFields } | { ok: false; problems: FieldProblem[] } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const problems: FieldProblem[] = [];
  const L = CANDIDATE_LIMITS;
  const name = clean(b['name']);
  if (!name) problems.push({ path: 'name', message: "Give the candidate's name." });
  else if (name.length > L.name) problems.push({ path: 'name', message: `The name is longer than ${L.name} characters.` });
  const email = clean(b['email']).toLowerCase();
  if (!email) problems.push({ path: 'email', message: "Give the candidate's email address." });
  else if (email.length > L.email || !EMAIL.test(email)) problems.push({ path: 'email', message: 'Give an email address that looks like name@example.com.' });
  const optional = (key: 'headline' | 'location' | 'source', noun: string): string => {
    const v = clean(b[key]);
    if (v.length > L[key]) problems.push({ path: key, message: `The ${noun} is longer than ${L[key]} characters.` });
    return v;
  };
  const headline = optional('headline', 'headline');
  const location = optional('location', 'location');
  const source = optional('source', 'source');
  const openingId = clean(b['openingId']);
  if (!openingId) problems.push({ path: 'openingId', message: 'Choose the opening the candidate is applying to.' });
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { name, email, headline, location, source, openingId } };
}

/** Add a candidate and their application to an opening, at the first stage. */
candidatesRouter.post('/candidates', manage, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const checked = checkCandidate(req.body);
  const wanted = clean((req.body as Record<string, unknown> | undefined)?.['openingId']);
  if (wanted) {
    const ix = await indexFor(req);
    if (!ix.openings.get(wanted)) throw new NotFoundError(NO_OPENING);
  }
  if (!checked.ok) {
    res.status(400).json({ error: `The candidate was not added: ${checked.problems.length === 1 ? 'one thing needs' : `${checked.problems.length} things need`} fixing.`, fields: checked.problems });
    return;
  }
  const v = checked.value;
  const store = interviewsStore();
  const [candidates, applications] = await Promise.all([store.listCandidates(), store.listApplications()]);
  const emailOf = new Map(candidates.map((c) => [c.id, c.email.trim().toLowerCase()]));
  if (applications.some((a) => a.openingId === v.openingId && emailOf.get(a.candidateId) === v.email)) {
    res.status(409).json({ error: DUPLICATE });
    return;
  }
  const at = interviewsNow().toISOString();
  const candidate: Candidate = { id: newId('cand'), name: v.name, email: v.email, headline: v.headline, location: v.location, source: v.source, resumeFileId: null, notes: '', createdAt: at };
  const application: Application = {
    id: newId('app'), candidateId: candidate.id, openingId: v.openingId, stage: 'applied', appliedAt: at,
    history: [{ stage: 'applied', at, by: session.sub, reason: null }],
  };
  // The check above answers the usual case; two adds at once both pass it, and the schema's unique rule stops the second.
  let written: Awaited<ReturnType<typeof store.createCandidate>>;
  try {
    written = await store.createCandidate(candidate, application);
  } catch (e) {
    if (e instanceof DuplicateCandidateError) { res.status(409).json({ error: DUPLICATE }); return; }
    throw e;
  }
  if (!written) { res.status(409).json({ error: 'The candidate was being added at the same moment. Try again.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(written);
}));
