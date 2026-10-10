// /api/social/plane — the Social application plane for a session standing in
// ANOTHER tenant (docs/social-tenant-design.md §4.6 "Communication"): the
// orgiq, assessment and pipelines Communication pages render the Social
// workspace and read and write here.
//
// Mounted in index.ts BEFORE the `requireTenant('social')` mount. Every route
// is the tenant router's OWN handler (routes/social.ts, `sharedSocialHandler`)
// — no second copy of any read or write — behind the SAME gate, `socialGate`
// (lib/social-authority.ts, the one Social permission path): the actor's
// CURRENT directory grants, epoch and masquerade actor, A asked against each
// granted Social role, rechecked after the policy call. The only difference
// between the two mounts is the tenant boundary in front of /api/social/*
// (`requireTenant('social')`), which the plane deliberately lacks.
//
// The session keeps its source tenant and role; the handlers read only its
// `sub`, and platform-api receives the caller's own realtime token (whose
// `tenants` claim its partition rule reads). The gateway's channel and lobby
// guards are unchanged: a join here makes the caller a member, and only then
// does the gateway admit their subscribe.
//
//   GET    /capabilities                    which Social actions the actor's grants allow (the plane's can())
//   GET    /channels                        public directory + private ones you are in        (ViewSocial)
//   POST   /channels                        create; you become its owner                       (ManageChannels)
//   POST   /channels/:slug/join             join a public channel                              (PostMessage)
//   POST   /channels/:slug/leave            leave                                              (ViewSocial)
//   GET    /dms                             your DMs                                           (ViewSocial)
//   GET    /people                          everyone holding a Social grant                    (ViewSocial)
//   GET    /rooms   POST /rooms             rooms; create                                      (ViewSocial / ManageChannels)
//   GET    /teams   POST /teams             your teams; create                                 (ViewSocial / ManageTeams)
//   GET    /teams/:teamId                   one team                                           (ViewSocial)
//   PATCH  /teams/:teamId/me                your pin                                           (ViewSocial)
//   POST   /teams/:teamId/members           add someone (the owner)                            (ManageTeams)
//   DELETE /teams/:teamId/members/:userId   leave (ViewSocial) or remove someone (ManageTeams)
//   GET    /recordings[/:id/playback|/transcript]                                              (ViewSocial)
//   POST   /recordings/:id/share   DELETE /recordings/:id                                      (ManageRecordings)
//   GET    /calls                           your Social call log                               (ViewSocial)
//   GET    /conversations/:id/shared-work   what was shared into a conversation you are in     (ViewSocial)

import { Router } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { socialActionRole } from '../lib/live-principal.js';
import { currentSocialActionSession, socialGate } from '../lib/social-authority.js';
import type { Session } from '../lib/session.js';
import { sharedSocialHandler as handler, teamMemberAction } from './social.js';
import { buildActivePeople } from '../lib/work-graph/plane-active.js';
import { buildSharedWork, grantView, sharingViewerContext, todayQuery } from '../lib/work-graph/shared-work.js';
import { createWorkSharing, parseNewWorkSharing, transitionWorkSharing, workSharingStore, WORK_SHARING_ORG, type WorkSharingAction } from '../lib/work-graph/sharing.js';
import { parseWorkGraphQuery, type SocialWorkGraphSubject } from '../lib/work-graph/snapshot.js';
import { buildSocialViewerWorkGraph } from '../lib/work-graph/build.js';
import { respondWithWorkGraph, WORK_GRAPH_UNAVAILABLE } from '../lib/work-graph/respond.js';
import { SOCIAL_CONVERSATION_ID } from '../lib/tenant-channels.js';
import { listTeams } from '../providers/social-platform.js';

export const socialPlaneRouter = Router();

const PLANE_ACTIONS = ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'ManageRecordings'] as const;
socialPlaneRouter.get('/capabilities', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const session = req.session as Session;
  const actions: Record<string, boolean> = {};
  for (const action of PLANE_ACTIONS) actions[action] = (await socialActionRole(session, action)) !== null;
  // A policy call can outlive revocation: recheck before answering.
  await currentSocialActionSession(session, 'ViewSocial');
  res.set('Cache-Control', 'no-store');
  res.json({ tenant: session.tenant, actions });
}));

socialPlaneRouter.get('/channels', socialGate('ViewSocial'), handler('get /channels'));
socialPlaneRouter.post('/channels', socialGate('ManageChannels'), handler('post /channels'));
socialPlaneRouter.post('/channels/:slug/join', socialGate('PostMessage'), handler('post /channels/:slug/join'));
socialPlaneRouter.post('/channels/:slug/leave', socialGate('ViewSocial'), handler('post /channels/:slug/leave'));
socialPlaneRouter.get('/dms', socialGate('ViewSocial'), handler('get /dms'));
socialPlaneRouter.get('/people', socialGate('ViewSocial'), handler('get /people'));
socialPlaneRouter.get('/rooms', socialGate('ViewSocial'), handler('get /rooms'));
socialPlaneRouter.post('/rooms', socialGate('ManageChannels'), handler('post /rooms'));
socialPlaneRouter.get('/teams', socialGate('ViewSocial'), handler('get /teams'));
socialPlaneRouter.post('/teams', socialGate('ManageTeams'), handler('post /teams'));
socialPlaneRouter.get('/teams/:teamId', socialGate('ViewSocial'), handler('get /teams/:teamId'));
socialPlaneRouter.patch('/teams/:teamId/me', socialGate('ViewSocial'), handler('patch /teams/:teamId/me'));
socialPlaneRouter.post('/teams/:teamId/members', socialGate('ManageTeams'), handler('post /teams/:teamId/members'));
socialPlaneRouter.delete('/teams/:teamId/members/:userId', socialGate(teamMemberAction), handler('delete /teams/:teamId/members/:userId'));
socialPlaneRouter.get('/recordings', socialGate('ViewSocial'), handler('get /recordings'));
socialPlaneRouter.get('/recordings/:recordingId/playback', socialGate('ViewSocial'), handler('get /recordings/:recordingId/playback'));
socialPlaneRouter.get('/recordings/:recordingId/transcript', socialGate('ViewSocial'), handler('get /recordings/:recordingId/transcript'));
socialPlaneRouter.post('/recordings/:recordingId/share', socialGate('ManageRecordings'), handler('post /recordings/:recordingId/share'));
socialPlaneRouter.delete('/recordings/:recordingId', socialGate('ManageRecordings'), handler('delete /recordings/:recordingId'));
socialPlaneRouter.get('/calls', socialGate('ViewSocial'), handler('get /calls'));
socialPlaneRouter.get('/conversations/:id/shared-work', socialGate('ViewSocial'), handler('get /conversations/:id/shared-work'));

// ── The plane's own reads (docs/communication-plane-goal.md §1.2, §2, §3) ─────

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const GRANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A work-graph query from the request, or today in the viewer's zone when it names none. */
function planeQuery(raw: Record<string, unknown>, drop: string[] = []) {
  const query = { ...raw };
  for (const key of drop) delete query[key];
  return Object.keys(query).length ? parseWorkGraphQuery(query) : todayQuery(typeof raw['timezone'] === 'string' ? raw['timezone'] : 'UTC');
}

socialPlaneRouter.get('/active', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const session = req.session as Session;
  const raw = typeof req.query['users'] === 'string' ? req.query['users'] : '';
  const users = raw ? raw.split(',').map(s => s.trim()).filter(s => USER_ID.test(s)).slice(0, 200) : null;
  const body = await buildActivePeople(session, { users });
  // The reads can outlive revocation: recheck before answering.
  await currentSocialActionSession(session, 'ViewSocial');
  res.set('Cache-Control', 'no-store');
  res.json(body);
}));

socialPlaneRouter.get('/people/:userId/shared-work', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const session = req.session as Session;
  const userId = String(req.params['userId'] ?? '');
  if (!USER_ID.test(userId)) throw new ValidationError('Invalid user id');
  const body = await buildSharedWork(session, userId, planeQuery(req.query as Record<string, unknown>));
  await currentSocialActionSession(session, 'ViewSocial');
  res.set('Cache-Control', 'no-store');
  res.json(body);
}));

/** Sharing into a conversation is posting to it; sharing with a team is managing the team. */
const sharingAction = (audience: { kind: 'conversation' | 'team' }): string => (audience.kind === 'team' ? 'ManageTeams' : 'PostMessage');

/** The owner must belong to the audience NOW: a member of the conversation, or on the team's roster. */
async function assertOwnerInAudience(session: Session, audience: { kind: 'conversation' | 'team'; id: string }): Promise<void> {
  if (audience.kind === 'conversation') {
    if (!SOCIAL_CONVERSATION_ID.test(audience.id)) throw new NotFoundError('no such conversation');
    const context = await sharingViewerContext(session);
    if (!context.conversationIds.has(audience.id)) throw new NotFoundError('no such conversation');
    return;
  }
  const team = (await listTeams(session)).find(t => t.teamId === audience.id && t.role);
  if (!team) throw new NotFoundError('no such team');
}

socialPlaneRouter.post('/work-sharing', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const session = req.session as Session;
  const input = parseNewWorkSharing(req.body, session.sub);
  // The audience decides the action; the owner is always the caller.
  const current = await currentSocialActionSession(session, sharingAction(input.audience));
  await assertOwnerInAudience(current, input.audience);
  const rows = await createWorkSharing(input);
  await currentSocialActionSession(current, sharingAction(input.audience));
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ grant: grantView(rows.current), history: rows.history ? grantView(rows.history) : null });
}));

socialPlaneRouter.post('/work-sharing/:id/transition', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const session = req.session as Session;
  const id = String(req.params['id'] ?? '');
  if (!GRANT_ID.test(id)) throw new ValidationError('Invalid grant id');
  const body = (req.body ?? {}) as { action?: unknown; expectedRevision?: unknown };
  const action = body.action;
  if (action !== 'stop' && action !== 'pause' && action !== 'resume' && action !== 'expire') throw new ValidationError("action must be 'stop', 'pause', 'resume' or 'expire'");
  if (!Number.isSafeInteger(body.expectedRevision)) throw new ValidationError('expectedRevision must be the grant revision you read');
  const store = workSharingStore();
  const row = await store.get(WORK_SHARING_ORG, id);
  // Someone else's grant does not exist from here.
  if (!row || row.ownerId !== session.sub) throw new NotFoundError('no such sharing grant');
  const current = await currentSocialActionSession(session, sharingAction(row.audience));
  const next = await transitionWorkSharing(row, { action: action as WorkSharingAction, expectedRevision: body.expectedRevision as number }, store);
  await currentSocialActionSession(current, sharingAction(row.audience));
  res.set('Cache-Control', 'no-store');
  res.json({ grant: grantView(next) });
}));

/**
 * Social's conversation work graph (routes/social-work-graph.ts), on the plane:
 * the SAME builder, run as the Social role the actor's current grants allow,
 * so the conversation's membership rule and the uniform 404 are Social's own.
 * The request's session is never re-targeted — the builder gets a copy.
 */
socialPlaneRouter.get('/work-graph/conversations/:id/graph', socialGate('ViewSocial'), asyncHandler(async (req, res) => {
  const session = req.session as Session;
  const id = String(req.params['id'] ?? '');
  if (!SOCIAL_CONVERSATION_ID.test(id)) { res.status(404).set('Cache-Control', 'no-store').json(WORK_GRAPH_UNAVAILABLE); return; }
  const role = await socialActionRole(session, 'ViewSocial');
  if (!role) throw new AppError(403, 'Your Social grants do not allow this action');
  const asSocial: Session = { ...session, tenant: 'social', role: role as Session['role'] };
  const subject: SocialWorkGraphSubject = { kind: 'conversation', id };
  respondWithWorkGraph(res, await buildSocialViewerWorkGraph(asSocial, subject, parseWorkGraphQuery(req.query as Record<string, unknown>)));
}));
