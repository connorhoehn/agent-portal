// /api/interview-invite: the candidate's door (docs/interviews-tenant-plan.md, row I2.1; decision 3).
//
// Mounted in index.ts outside /api/interviews and without any staff gate, because the person using it has
// no account here. Exactly two routes, and nothing else a guest can reach this round:
//
//   POST /exchange    the link's token (in the body) for a guest session cookie (lib/interviews/invite/guest.ts).
//                     Unauthenticated and throttled as routes/drop.ts is. A wrong, malformed, expired or
//                     revoked token, or one whose interview is closed, gets the same status, the same body
//                     and (padded to a floor) the same time, so a link cannot be probed.
//   GET /interview    the guest's own interview: the opening's title, the round's name and length, the time.
//                     No panel names, nothing from the candidate's record, no state the panel has not shown.
//
// The token and its hash never reach a log line, an error message, a metric label or a Referer: nothing
// here prints them, the answers say `Referrer-Policy: no-referrer`, and the link carries the token in the
// fragment, which the portal page reads and removes. With INTERVIEWS_ENABLED off both are not-found.
//
// The other four things decision 3 lets a guest reach (the call, its chat, the pad, runs) are later rows.

import express, { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { runWithDbTenant } from '../providers/db-tenant.js';
import { interviewsStore } from '../lib/interviews/store-select.js';
import { INTERVIEWS_TENANT, type Interview } from '../lib/interviews/types.js';
import { GUEST_REFUSAL, newGuestSession, requireGuest, setGuestCookie } from '../lib/interviews/invite/guest.js';
import { inviteDeadReason, inviteExpiresAt } from '../lib/interviews/invite/rules.js';
import { inviteStore } from '../lib/interviews/invite/store.js';
import { hashInviteToken, wellFormedToken } from '../lib/interviews/invite/token.js';
import { interviewsFlagGate } from './interviews.js';

export const interviewInviteRouter: Router = Router();

// ── the throttle (routes/drop.ts's, kept separate so one door's flood does not close the other) ──
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const hits = new Map<string, { count: number; resetAt: number }>();
function throttled(key: string): boolean {
  const now = Date.now();
  const slot = hits.get(key);
  if (!slot || now >= slot.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (hits.size > 5000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    return false;
  }
  slot.count++;
  return slot.count > MAX_REQUESTS_PER_WINDOW;
}
/** For tests: start every client's window afresh. */
export function resetInviteThrottle(): void { hits.clear(); }

function rateLimit(req: Request, res: Response, next: express.NextFunction): void {
  if (throttled(req.ip || req.socket.remoteAddress || 'unknown')) {
    res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    return;
  }
  next();
}

/** Every exchange answers no sooner than this, so a refusal and a success take the same time to arrive. */
export const EXCHANGE_FLOOR_MS = 200;
const settle = async (startedAt: number): Promise<void> => {
  const wait = EXCHANGE_FLOOR_MS - (Date.now() - startedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};

/** A token that cannot match, hashed in place of a malformed one so every refusal costs the same work. */
const NEVER = 'A'.repeat(43);

/** What the guest may read about their interview. */
export interface GuestInterviewView {
  opening: { title: string };
  round: { name: string; minutes: number };
  scheduledAt: string | null;
}

async function guestView(interview: Interview): Promise<GuestInterviewView | null> {
  const store = interviewsStore();
  const [applications, openings] = await Promise.all([store.listApplications(), store.listOpenings()]);
  const application = applications.find((a) => a.id === interview.applicationId);
  const opening = application ? openings.find((o) => o.id === application.openingId) : undefined;
  if (!opening) return null;
  const round = opening.kit.rounds.find((r) => r.id === interview.roundId);
  return {
    opening: { title: opening.title },
    round: { name: round?.name ?? (interview.type === 'technical' ? 'Technical interview' : 'Interview'), minutes: interview.minutes },
    scheduledAt: interview.scheduledAt,
  };
}

function guestHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

interviewInviteRouter.post('/exchange', interviewsFlagGate, rateLimit, asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  guestHeaders(res);
  const token = (req.body as Record<string, unknown> | undefined)?.['token'];
  const hash = hashInviteToken(wellFormedToken(token) ? token : NEVER);
  const opened = await runWithDbTenant(INTERVIEWS_TENANT, async () => {
    const invites = inviteStore();
    const invite = await invites.findInviteByHash(hash);
    const interview = invite ? (await interviewsStore().listInterviews()).find((i) => i.id === invite.interviewId) ?? null : null;
    const now = new Date();
    if (!invite || !interview || inviteDeadReason(invite, interview, now) !== null) return null;
    const view = await guestView(interview);
    if (!view) return null;
    // Reuse: the link keeps working, every opening is recorded, and this session replaces the one before.
    const { sid, sessionHash } = newGuestSession();
    const recorded = await invites.recordOpening(invite.id, now.toISOString(), sessionHash);
    if (!recorded) return null;
    return { sid, invite: recorded, view, expiresAt: inviteExpiresAt(recorded, interview) };
  });
  if (!opened) {
    await settle(startedAt);
    res.status(404).json(GUEST_REFUSAL);
    return;
  }
  await setGuestCookie(res, opened.invite.id, opened.sid, opened.expiresAt);
  await settle(startedAt);
  res.json({ interview: opened.view });
}));

interviewInviteRouter.get('/interview', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  guestHeaders(res);
  const interview = (await interviewsStore().listInterviews()).find((i) => i.id === req.guest!.interviewId);
  const view = interview ? await guestView(interview) : null;
  if (!view) { res.status(404).json(GUEST_REFUSAL); return; }
  res.json({ interview: view });
}));
