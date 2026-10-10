// A team discussion message's assessment-dimension reference, resolved by the
// BFF for THIS reader (GET /api/page-references/resolve). The message stores
// only `{kind, id}`; the title, trail and route come from the reader's own
// current assessment authority, and nothing here derives them from the sender.

export const ASSESSMENT_DIMENSION_KIND = 'assessment-dimension';
const ID = /^(TEAM-[A-Za-z0-9-]{1,120}):([A-Za-z0-9_.-]{1,64})$/;

export interface AssessmentDimensionDescriptor { kind: typeof ASSESSMENT_DIMENSION_KIND; id: string }
export type AssessmentDimensionPageReference =
  | (AssessmentDimensionDescriptor & { status: 'unavailable' })
  | (AssessmentDimensionDescriptor & {
      status: 'available'; title: string; href: string;
      team: { id: string; name: string; href: string };
      breadcrumbs: { title: string; href: string }[];
    });

export function parseAssessmentDimensionId(id: unknown): { teamId: string; dimensionId: string } | null {
  if (typeof id !== 'string') return null;
  const m = ID.exec(id);
  return m ? { teamId: m[1]!, dimensionId: m[2]! } : null;
}
export const assessmentTeamHref = (teamId: string) => `/assessment/teams/${encodeURIComponent(teamId)}`;
export const assessmentDimensionHref = (teamId: string, dimensionId: string) =>
  `${assessmentTeamHref(teamId)}?dimension=${encodeURIComponent(dimensionId)}`;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Strict: canonical routes recomputed from the id, never accepted from the payload. */
export function readAssessmentDimensionReference(value: unknown): AssessmentDimensionPageReference | null {
  if (!record(value) || value.kind !== ASSESSMENT_DIMENSION_KIND) return null;
  const parts = parseAssessmentDimensionId(value.id);
  if (!parts) return null;
  const descriptor: AssessmentDimensionDescriptor = { kind: ASSESSMENT_DIMENSION_KIND, id: value.id as string };
  if (value.status === 'unavailable') return { ...descriptor, status: 'unavailable' };
  if (value.status !== 'available' || !text(value.title) || !record(value.team) || !text(value.team.name)
    || !Array.isArray(value.breadcrumbs)) return null;
  const href = assessmentDimensionHref(parts.teamId, parts.dimensionId);
  const teamHref = assessmentTeamHref(parts.teamId);
  const allowed = [href, teamHref, '/assessment/teams'];
  if (value.href !== href || value.team.id !== parts.teamId || value.team.href !== teamHref
    || !value.breadcrumbs.every(crumb => record(crumb) && text(crumb.title) && allowed.includes(String(crumb.href)))) return null;
  return { ...descriptor, status: 'available', title: value.title, href,
    team: { id: parts.teamId, name: value.team.name, href: teamHref },
    breadcrumbs: value.breadcrumbs.map(crumb => ({ title: String((crumb as Record<string, unknown>).title), href: String((crumb as Record<string, unknown>).href) })) };
}

/** Throws on a failed request or a response for a different reference. */
export async function resolveAssessmentDimensionReference(id: string, signal?: AbortSignal,
  request: typeof fetch = (...args) => fetch(...args)): Promise<AssessmentDimensionPageReference> {
  const query = new URLSearchParams({ kind: ASSESSMENT_DIMENSION_KIND, id });
  const response = await request(`/api/page-references/resolve?${query}`, { credentials: 'include', cache: 'no-store', ...(signal ? { signal } : {}) });
  const body: unknown = await response.json().catch(() => null);
  const reference = record(body) ? readAssessmentDimensionReference(body.pageReference) : null;
  if (!response.ok || !reference || reference.id !== id) throw new Error('Page reference unavailable');
  return reference;
}
