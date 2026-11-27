// POST /api/interviews/candidates (UI round 2, lane DESK-B; contract U13): the recruiter adds a candidate to an opening.
// The write pattern is openings.ts's: the mount gate, ManageCandidates (a guest and every other role is refused), the
// opening in the viewer's scope (404), the input (400, one sentence per field), an opening that is not open (409), the
// duplicate (409), then the write.
// The route checks; the store only writes. The new candidate has no résumé yet; it is uploaded on the profile. An address
// already on a candidate (not erased) adds an application to that candidate instead of a second record, and the answer
// is that candidate: the caller holds ManageCandidates and already reads every candidate, so nothing new is revealed.
//
// PATCH /api/interviews/candidates/:id (gap audit 2026-11-20 §6): the recruiter (ManageCandidates) edits the name, email,
// headline and location. Body `{ version, name, email, headline, location }`, `version` being the profile's
// `candidate.version` (the last edit's time, else when the record was added): a compare-and-set, 409 with the record as
// it now is when someone saved first. The fields are checked as the create checks them (400, one sentence per field).
// The candidate outside the viewer's scope is not found (404); an erased candidate is refused (409) and stays erased; an
// address that belongs to another candidate who is not erased is refused (409) and nothing is merged. No history is
// written: the profile's only history is each application's stage moves, and an edit is not a stage move.

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { interviewsNow } from '../../lib/interviews/clock.js';
import type { FieldProblem } from '../../lib/interviews/kit.js';
import { indexFor } from '../../lib/interviews/request.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import { DuplicateCandidateError } from '../../lib/interviews/store.js';
import { isRedacted } from '../../lib/interviews/retention/rules.js';
import { candidateVersion, type Application, type Candidate, type CandidateEdit } from '../../lib/interviews/types.js';
import { param } from '../../lib/interviews/request.js';

export const candidatesRouter = Router();
const manage = requireAction('ManageCandidates');

const NO_OPENING = 'There is no opening here that you can open.';
const DUPLICATE = 'This person is already a candidate for this opening.';
const NOT_OPEN = 'This opening is not open, so it takes no new candidates. Open it again first.';
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

/** The edit's body, cleaned: the create's rules for the four fields it changes. */
export function checkCandidateEdit(body: unknown): { ok: true; value: CandidateEdit } | { ok: false; problems: FieldProblem[] } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  // The create's own check, with the opening and the source it does not ask for here filled in so they pass.
  const checked = checkCandidate({ name: b['name'], email: b['email'], headline: b['headline'], location: b['location'], openingId: '-' });
  if (!checked.ok) return { ok: false, problems: checked.problems.filter((p) => p.path !== 'source') };
  const { name, email, headline, location } = checked.value;
  return { ok: true, value: { name, email, headline, location } };
}

const NO_CANDIDATE = 'There is no candidate here that you can open.';
const ERASED = "This candidate's details were deleted, so they cannot be edited.";
const TAKEN = 'Another candidate already has this email address. Check the address, or open that candidate instead.';
const EDIT_STALE = 'Someone else changed this candidate while you were looking. The page now shows what was saved: check it, then try again.';

/** Edit a candidate's name, email, headline and location. */
candidatesRouter.patch('/candidates/:id', manage, asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const c = ix.candidates.get(param(req, 'id'));
  if (!c) throw new NotFoundError(NO_CANDIDATE);
  res.setHeader('Cache-Control', 'no-store');
  const version = (req.body as Record<string, unknown> | undefined)?.['version'];
  if (typeof version !== 'string' || Number.isNaN(Date.parse(version))) {
    res.status(400).json({ error: 'This page is out of date. Reload it and try again.', fields: [] });
    return;
  }
  if (isRedacted(c)) { res.status(409).json({ error: ERASED }); return; }
  const checked = checkCandidateEdit(req.body);
  if (!checked.ok) {
    res.status(400).json({ error: `The details were not saved: ${checked.problems.length === 1 ? 'one thing needs' : `${checked.problems.length} things need`} fixing.`, fields: checked.problems });
    return;
  }
  const v = checked.value;
  const store = interviewsStore();
  // One person, one record: an address another live candidate holds is refused, never merged (the create's rule, retention/rules.ts).
  const others = (await store.listCandidates()).filter((o) => o.id !== c.id && !isRedacted(o) && o.email.trim().toLowerCase() === v.email);
  if (others.length) { res.status(409).json({ error: TAKEN, fields: [{ path: 'email', message: TAKEN }] }); return; }
  // Strictly after the version it replaces, so two edits in one millisecond still tell apart.
  const at = new Date(Math.max(interviewsNow().getTime(), Date.parse(candidateVersion(c)) + 1)).toISOString();
  let written: Awaited<ReturnType<typeof store.updateCandidate>>;
  try {
    written = await store.updateCandidate(c.id, v, at, version);
  } catch (e) {
    if (e instanceof DuplicateCandidateError) { res.status(409).json({ error: TAKEN, fields: [{ path: 'email', message: TAKEN }] }); return; }
    throw e;
  }
  if (!written.ok && written.reason === 'not-found') { res.status(409).json({ error: ERASED }); return; }
  const fresh = await indexFor(req);
  const now = fresh.candidates.get(c.id);
  const record = now ? fresh.candidateRecord(now).candidate : null;
  if (!written.ok) { res.status(409).json({ error: EDIT_STALE, candidate: record }); return; }
  res.json({ candidate: record });
}));

/** Add a candidate and their application to an opening, at the first stage. */
candidatesRouter.post('/candidates', manage, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const checked = checkCandidate(req.body);
  const wanted = clean((req.body as Record<string, unknown> | undefined)?.['openingId']);
  const ix = wanted ? await indexFor(req) : null;
  if (ix && !ix.openings.get(wanted)) throw new NotFoundError(NO_OPENING);
  if (!checked.ok) {
    res.status(400).json({ error: `The candidate was not added: ${checked.problems.length === 1 ? 'one thing needs' : `${checked.problems.length} things need`} fixing.`, fields: checked.problems });
    return;
  }
  const v = checked.value;
  // A paused or closed opening takes no one new: its rounds could not be assigned (assign.ts) and nobody would move them.
  if (ix?.openings.get(v.openingId)?.state !== 'open') {
    res.status(409).json({ error: NOT_OPEN, fields: [{ path: 'openingId', message: NOT_OPEN }] });
    return;
  }
  const store = interviewsStore();
  const [candidates, applications] = await Promise.all([store.listCandidates(), store.listApplications()]);
  const emailOf = new Map(candidates.map((c) => [c.id, c.email.trim().toLowerCase()]));
  if (applications.some((a) => a.openingId === v.openingId && emailOf.get(a.candidateId) === v.email)) {
    res.status(409).json({ error: DUPLICATE });
    return;
  }
  const at = interviewsNow().toISOString();
  const application = (candidateId: string): Application => ({
    id: newId('app'), candidateId, openingId: v.openingId, stage: 'applied', appliedAt: at,
    history: [{ stage: 'applied', at, by: session.sub, reason: null }],
  });
  // One person, one record: the address already on a candidate (case and spaces aside) adds an application to them
  // rather than a second record. Never a candidate without an address, and never an erased one (retention/rules.ts).
  // The oldest record wins where earlier adds left two; nothing stored is merged or changed.
  const known = candidates.filter((c) => !isRedacted(c) && c.email.trim() !== '' && c.email.trim().toLowerCase() === v.email)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (known) {
    let added: Application | null;
    try {
      added = await store.createApplication(application(known.id));
    } catch (e) {
      if (e instanceof DuplicateCandidateError) { res.status(409).json({ error: DUPLICATE }); return; }
      throw e;
    }
    if (!added) { res.status(409).json({ error: 'The candidate was being added at the same moment. Try again.' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ candidate: known, application: added });
    return;
  }
  const candidate: Candidate = { id: newId('cand'), name: v.name, email: v.email, headline: v.headline, location: v.location, source: v.source, resumeFileId: null, notes: '', createdAt: at };
  // The check above answers the usual case; two adds at once both pass it, and the schema's unique rule stops the second.
  let written: Awaited<ReturnType<typeof store.createCandidate>>;
  try {
    written = await store.createCandidate(candidate, application(candidate.id));
  } catch (e) {
    if (e instanceof DuplicateCandidateError) { res.status(409).json({ error: DUPLICATE }); return; }
    throw e;
  }
  if (!written) { res.status(409).json({ error: 'The candidate was being added at the same moment. Try again.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(written);
}));
