// Assessment team discussions (`assessment:team:<TEAM-id>`) may carry a
// reference to one dimension of that team's scorecard. As with DM page
// references (dm-page-references.ts), the stored message holds only
// `{ kind: 'assessment-dimension', id: '<TEAM-id>:<dimensionId>' }`; the
// title, trail and route are resolved on read under the READER's current
// assessment authority (GET /api/page-references/resolve).
import { defineFeature, type RealtimeFeature } from '@connorhoehnslalom/realtime-modules/server';
import { AppError, ValidationError } from './async-handler.js';
import { currentLiveSession, getLivePrincipal } from './live-principal.js';
import { holdsFamilyAuthority } from './gateway/authority.js';
import type { Session } from './session.js';

export const ASSESSMENT_DIMENSION_KIND = 'assessment-dimension';
const ID = /^(TEAM-[A-Za-z0-9-]{1,120}):([A-Za-z0-9_.-]{1,64})$/;
const TEAM_CHANNEL = /^assessment:team:(TEAM-[A-Za-z0-9-]{1,120})$/;

export interface AssessmentDimensionDescriptor { kind: typeof ASSESSMENT_DIMENSION_KIND; id: string }
export type AssessmentDimensionReference =
  | (AssessmentDimensionDescriptor & { status: 'unavailable' })
  | (AssessmentDimensionDescriptor & { status: 'available'; title: string; href: string;
      team: { id: string; name: string; href: string }; breadcrumbs: { title: string; href: string }[] });

/** `TEAM-001:7` → its parts; null for anything else. */
export function parseAssessmentDimensionId(id: unknown): { teamId: string; dimensionId: string } | null {
  if (typeof id !== 'string') return null;
  const m = ID.exec(id);
  return m ? { teamId: m[1]!, dimensionId: m[2]! } : null;
}

/** Exactly `{kind, id}`, well formed; anything else (extra keys, titles, URLs) is null. */
export function assessmentDimensionDescriptor(value: unknown): AssessmentDimensionDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => key !== 'kind' && key !== 'id') || row.kind !== ASSESSMENT_DIMENSION_KIND
    || !parseAssessmentDimensionId(row.id)) return null;
  return { kind: ASSESSMENT_DIMENSION_KIND, id: row.id as string };
}

export const teamHref = (teamId: string) => `/assessment/teams/${encodeURIComponent(teamId)}`;
export const dimensionHref = (teamId: string, dimensionId: string) =>
  `${teamHref(teamId)}?dimension=${encodeURIComponent(dimensionId)}`;

/** The team family's authority (read or write) for this session, asked fresh (lib/gateway/authority.ts). */
function holdsTeamAuthority(session: Session, teamId: string, kind: 'subscribe' | 'publish'): Promise<boolean> {
  return holdsFamilyAuthority(session, `assessment:team:${teamId}`, kind);
}

/** The team's name and the dimension's title, or null when either is unknown. */
async function lookupDimension(teamId: string, dimensionId: string): Promise<{ teamName: string; title: string } | null> {
  const { getTeamDetail } = await import('../providers/assessment.js');
  const detail = await getTeamDetail(teamId);
  const dimension = detail?.dimensions.find(d => d.id === dimensionId);
  return detail && dimension ? { teamName: detail.team.name, title: dimension.title } : null;
}

/** Resolve for THIS reader: available only under current active-tenant ViewAssessment and a real team + dimension. */
export async function resolveAssessmentDimensionReference(descriptor: AssessmentDimensionDescriptor, source: Session): Promise<AssessmentDimensionReference> {
  const unavailable: AssessmentDimensionReference = { ...descriptor, status: 'unavailable' };
  const { teamId, dimensionId } = parseAssessmentDimensionId(descriptor.id)!;
  let session = await currentLiveSession(source);
  if (!await holdsTeamAuthority(session, teamId, 'subscribe')) return unavailable;
  let found: Awaited<ReturnType<typeof lookupDimension>>;
  try { found = await lookupDimension(teamId, dimensionId); } catch { return unavailable; }
  if (!found) return unavailable;
  // The provider read can outlive a revocation or epoch bump.
  session = await currentLiveSession(session);
  if (!await holdsTeamAuthority(session, teamId, 'subscribe')) return unavailable;
  const title = `${dimensionId}. ${found.title}`;
  const href = dimensionHref(teamId, dimensionId);
  const team = { id: teamId, name: found.teamName, href: teamHref(teamId) };
  return { ...descriptor, status: 'available', title, href, team,
    breadcrumbs: [{ title: 'Teams', href: '/assessment/teams' }, { title: team.name, href: team.href }, { title, href }] };
}

/**
 * Compose around the chat service: a send/edit on `assessment:team:*` that
 * carries `metadata.pageReference` stores it only as a validated descriptor
 * for a dimension of THAT team, under the sender's current write authority.
 * Other channels are untouched.
 */
export function withAssessmentPageReferences(feature: RealtimeFeature): RealtimeFeature {
  return defineFeature({ ...feature, create(context) {
    const service = feature.create(context);
    const handle = service.handleAction.bind(service);
    service.handleAction = async (clientId, action, data) => {
      const metadata = data.metadata;
      const row = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
      const team = typeof data.channel === 'string' ? TEAM_CHANNEL.exec(data.channel) : null;
      if (!team || !['send', 'edit'].includes(action) || !row || !Object.hasOwn(row, 'pageReference')) return handle(clientId, action, data);
      const captured = context.router.getClientData?.(clientId)?.userContext;
      try {
        const page = assessmentDimensionDescriptor(row.pageReference);
        if (!page) throw new ValidationError('A page reference contains only an assessment-dimension kind and id');
        const { teamId, dimensionId } = parseAssessmentDimensionId(page.id)!;
        if (teamId !== team[1]) throw new ValidationError('A page reference must name a dimension of this team');
        const principal = await getLivePrincipal(captured ?? null);
        if (!await holdsTeamAuthority(principal.session, teamId, 'publish')) throw new AppError(403, 'Assessment access is required to attach this dimension');
        if (!await lookupDimension(teamId, dimensionId)) throw new AppError(404, 'Dimension not found');
        const latest = await getLivePrincipal(captured ?? null);
        if (latest.session.sub !== principal.session.sub || !await holdsTeamAuthority(latest.session, teamId, 'publish')) {
          throw new AppError(403, 'Dimension or team access changed');
        }
        if (!context.router.isClientLive?.(clientId)
          || context.router.getClientData?.(clientId)?.userContext !== captured) return;
        // Nothing resource-derived crosses into chat metadata; the chat
        // service still runs its own publish authority before persistence.
        await handle(clientId, action, { ...data, metadata: { ...row, pageReference: page } });
      } catch (error) {
        if (context.router.getClientData?.(clientId)?.userContext !== captured) return;
        const status = error instanceof AppError ? error.status : 503;
        const message = error instanceof AppError ? error.message : 'Page reference verification is unavailable';
        context.router.sendToClient(clientId, { type: 'error', service: 'chat', action, channel: data.channel,
          code: 'PAGE_REFERENCE_DENIED', error: { code: 'PAGE_REFERENCE_DENIED', message }, status });
      }
    };
    return service;
  } });
}
