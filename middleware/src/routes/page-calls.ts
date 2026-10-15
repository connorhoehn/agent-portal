// Call history for the non-Social tenants' page huddles, read from the SAME
// rows Social's Calls pane reads (platform-api's per-person call log through
// providers/social-platform.ts `listCallRows`) — no store of its own.
//
//   GET /api/calls?lobby=<lobby>   the caller's calls in one page lobby
//                                  (`orgiq:initiative:<id>`, `assessment:team:<TEAM-id>`,
//                                  `assessment:doc:<id>`, `pipelines:run:<id>`)
//   GET /api/calls/tenant          the caller's calls across the ACTIVE tenant's
//                                  page lobbies, with the missed count
//
// Authority is the lobby's own, asked fresh (live-principal.ts
// `admitLobbyRead`: the family's read action, the page existing now,
// the partition rule): a lobby in another tenant is a 404, a reader without the
// family's action is a 403, a page that no longer exists is a 404. The tenant
// list asks the tenant's own read action, the one that gates its pages.
import { Router, type Request } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { withCallAvatars } from '../lib/call-log-avatars.js';
import { isAllowed, requireSession, resolveSession } from '../lib/authz.js';
import { sessionGatewayContext } from '../lib/live-principal.js';
import { admitLobbyRead } from '../lib/gateway/authority.js';
import { ADMIN_ROLE, type Session } from '../lib/session.js';
import { tenantChannelFamily, TENANT_PARTITIONS } from '../lib/tenant-channels.js';
import { listCallRows, socialPlatformBackend, type SocialCallLogRow } from '../providers/social-platform.js';

export const pageCallsRouter = Router();

/** The action that gates each tenant's pages (null: every signed-in orgiq role reads them). */
export const TENANT_CALLS_ACTION: Readonly<Record<string, string | null>> = { orgiq: null, assessment: 'ViewAssessment', pipelines: 'ViewPipelines' };

function sessionOf(req: Request): Session {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Unauthenticated');
  return session;
}

const missedFor = (rows: readonly SocialCallLogRow[]) => rows.filter((r) => r.outcome === 'missed' && r.direction === 'incoming').length;
const source = () => (socialPlatformBackend() === 'platform' ? 'platform-api' : 'mock');

pageCallsRouter.get('/', requireSession('ReadPageCalls'), asyncHandler(async (req, res) => {
  const session = sessionOf(req);
  const lobby = typeof req.query['lobby'] === 'string' ? req.query['lobby'] : '';
  if (!lobby || lobby.length > 256) throw new ValidationError('lobby is required');
  const family = tenantChannelFamily(lobby);
  if (!family || !family.lobby || !TENANT_PARTITIONS.has(family.tenant)) throw new NotFoundError('no such call lobby');
  // Another tenant's lobby does not exist from here.
  if (family.tenant !== session.tenant && session.role !== ADMIN_ROLE) throw new NotFoundError('no such call lobby');
  const verdict = await admitLobbyRead(sessionGatewayContext(session), lobby);
  if (verdict === 'not-a-lobby' || verdict === 'gone') throw new NotFoundError('no such call lobby');
  if (verdict === 'denied') throw new AppError(403, 'You cannot read this page’s calls');
  const calls = (await listCallRows(session)).filter((r) => r.lobbyName === lobby);
  res.json({ source: source(), lobby, calls: await withCallAvatars(calls), counts: { total: calls.length, missed: missedFor(calls) } });
}));

pageCallsRouter.get('/tenant', requireSession('ReadPageCalls'), asyncHandler(async (req, res) => {
  const session = sessionOf(req);
  const tenant = session.tenant;
  if (!(tenant in TENANT_CALLS_ACTION)) throw new NotFoundError('this tenant has no page calls');
  const action = TENANT_CALLS_ACTION[tenant];
  if (action && !await isAllowed({ sub: session.sub, tenant, role: session.role }, action)) throw new AppError(403, 'Forbidden');
  const rows = (await listCallRows(session)).filter((r) => {
    const family = tenantChannelFamily(r.lobbyName);
    return !!family?.lobby && family.tenant === tenant;
  });
  // The tenant's action admits the list; each LOBBY still asks its own read
  // rule (the family's action, the page existing now, the partition), exactly
  // as `GET /api/calls?lobby=` does above — a member's own row in a lobby
  // they may no longer read (a page gone, a family their role cannot read)
  // is not theirs to list. One verdict per lobby, asked fresh for this request.
  const ctx = sessionGatewayContext(session);
  const verdicts = new Map<string, Promise<boolean>>();
  const readable = (lobby: string) => {
    let verdict = verdicts.get(lobby);
    if (!verdict) { verdict = admitLobbyRead(ctx, lobby).then((v) => v === 'ok', () => false); verdicts.set(lobby, verdict); }
    return verdict;
  };
  const admitted = await Promise.all(rows.map((r) => readable(r.lobbyName)));
  const calls = rows.filter((_, i) => admitted[i]);
  res.json({ source: source(), tenant, calls: await withCallAvatars(calls), counts: { total: calls.length, missed: missedFor(calls) } });
}));
