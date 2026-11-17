// GET /api/interviews/consent-effects: what each round runs without, for the recruiter's Upcoming page (docs/interviews-tenant-
// plan.md decision 5, row I2.5). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
// `{ items: [{ interviewId, answered, off, blocked }] }` for every interview in the viewer's scope, and nothing else about the choice:
// no answer times, no notice version, no history. `answered` and `off` follow the panel's read (routes/interviews/consents.ts):
// answers count under the current notice, or, once the call has started, the answers it started with; while nothing counts,
// every part is off. Who may ask: the recruiter (decision 5: told so they can arrange what replaces a part) and the admin.
// The interviewer, the hiring manager and everyone else get the not-found every out-of-scope read gets. Nothing is logged.
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { resolveSession } from '../../lib/authz.js';
import { indexFor } from '../../lib/interviews/request.js';
import { partsOffOf, type OffPart } from '../../lib/interviews/consent/effects.js';
import { consentStore } from '../../lib/interviews/consent/store.js';
import { declinedRequired, requiredConsents } from '../../lib/interviews/consent/required.js';
import { usableAnswers } from '../../lib/interviews/recording-rules.js';

export const consentEffectsRouter = Router();

/** `blocked`: the answers leave off a part this deployment requires (row I6.4), so the round cannot go ahead as set. */
export interface ConsentEffectsItem { interviewId: string; answered: boolean; off: OffPart[]; blocked: boolean }

const READERS: ReadonlySet<string> = new Set(['recruiter', 'admin']);

consentEffectsRouter.get('/consent-effects', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (!READERS.has(session.role)) throw new NotFoundError('Not found');
  const ix = await indexFor(req);
  const required = requiredConsents();
  const items: ConsentEffectsItem[] = await Promise.all(ix.world.interviews.map(async (i) => {
    const answers = usableAnswers(await consentStore().getConsent(i.id), i.state);
    return { interviewId: i.id, answered: answers !== null, off: partsOffOf(answers), blocked: declinedRequired(answers, required).length > 0 };
  }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items });
}));
