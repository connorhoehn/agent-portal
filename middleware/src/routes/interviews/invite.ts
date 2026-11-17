// /api/interviews invite routes (docs/interviews-tenant-plan.md, row I2.1; decision 3): the recruiter's side of
// the candidate's link. Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   POST   /interviews/:id/invite   issue a link (revoking the one before). Answers the link ONCE, no-store:
//                                   only its hash is kept, so it can never be shown again.
//   GET    /interviews/:id/invite   the latest link's status: issued, expires, opened, revoked. Never the token.
//   DELETE /interviews/:id/invite   revoke the live link; answers the status.
//
// The checks run in the openings writes' order (routes/interviews/openings.ts): the mount, the authority
// (ManageCandidates: the recruiter's and the cross-tenant admin's, 403 for everyone else on every id
// alike), the row (in the viewer's scope, else 404), then the rule (rules.ts: an interview that is
// declined, cancelled or over, or whose time has long passed, gets no link: 409 with one plain sentence).
// No page uses these yet; the upcoming table puts the action on its rows.

import { Router, type Request } from 'express';
import { config } from '../../config.js';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { indexFor, param, peopleLookup } from '../../lib/interviews/request.js';
import { inviteCeiling, inviteStatus, issuable, type InviteStatus } from '../../lib/interviews/invite/rules.js';
import { inviteStore, type Invite } from '../../lib/interviews/invite/store.js';
import { hashInviteToken, newInviteToken } from '../../lib/interviews/invite/token.js';
import type { Interview } from '../../lib/interviews/types.js';

export const inviteRouter = Router();
const manage = requireAction('ManageCandidates');

const NO_INTERVIEW = 'There is no interview here that you can open.';
const CLOSED = 'This interview is declined, cancelled or over, so it cannot have a link.';
const PAST = 'This interview\'s time has passed, so a link made now would not work. Set a new time first.';

/** Where the candidate's page lives in the portal. The token rides in the fragment, which no browser sends to a server. */
export const GUEST_PAGE_PATH = '/join';

async function interviewInScope(req: Request): Promise<Interview> {
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((i) => i.id === param(req, 'id'));
  if (!interview) throw new NotFoundError(NO_INTERVIEW);
  return interview;
}

export interface InviteStatusView extends Omit<InviteStatus, 'issuedBy'> { issuedBy: { id: string; name: string } | null }

async function statusView(invite: Invite | null, interview: Interview): Promise<InviteStatusView> {
  const s = inviteStatus(invite, interview, new Date());
  const people = await peopleLookup();
  return { ...s, issuedBy: s.issuedBy ? people(s.issuedBy) : null };
}

function portalOrigin(req: Request): string {
  const configured = config.cognito?.portalOrigin ?? '';
  if (configured) return configured.replace(/\/$/, '');
  const origin = req.get('origin') ?? '';
  return /^https?:\/\/[^\s/]+$/.test(origin) ? origin : '';
}

inviteRouter.post('/interviews/:id/invite', manage, asyncHandler(async (req, res) => {
  const interview = await interviewInScope(req);
  const now = new Date();
  const verdict = issuable(interview, now);
  if (verdict !== 'ok') { res.status(409).json({ error: verdict === 'closed' ? CLOSED : PAST }); return; }
  const token = newInviteToken();
  const issuedAt = now.toISOString();
  const invite = await inviteStore().issueInvite({
    interviewId: interview.id, tokenHash: hashInviteToken(token), issuedBy: resolveSession(req)!.sub, issuedAt, expiresAt: inviteCeiling(issuedAt),
  });
  const linkPath = `${GUEST_PAGE_PATH}#${token}`;
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ link: `${portalOrigin(req)}${linkPath}`, linkPath, invite: await statusView(invite, interview) });
}));

inviteRouter.get('/interviews/:id/invite', manage, asyncHandler(async (req, res) => {
  const interview = await interviewInScope(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ invite: await statusView(await inviteStore().latestInvite(interview.id), interview) });
}));

inviteRouter.delete('/interviews/:id/invite', manage, asyncHandler(async (req, res) => {
  const interview = await interviewInScope(req);
  const latest = await inviteStore().revokeInvite(interview.id, new Date().toISOString(), resolveSession(req)!.sub);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ invite: await statusView(latest, interview) });
}));
