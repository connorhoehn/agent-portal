// The per-resource half of a page's REST read, for the realtime families whose
// page 404s an unknown resource (lib/tenant-channels.ts `lobbyResource` /
// `channelResource`). The gateway asks these on every decision against the
// durable row read now — no positive cache — after the family's grant/policy
// check and before its final session reload (live-principal.ts).
//
//   assessment-team  GET /api/assessment/teams/:id → provider.teamExists
//   pipelines-run    GET /api/pipelines/runs/:id   → the run projection
//                    (the pipelines tenant's unscoped view: every run)
//   orgiq-initiative GET /api/graph/projects/:id   → providers/projects.ts
//                    projectExists (the `projects` row, or the mock fixture)

export type PageResourceKind = 'assessment-team' | 'pipelines-run' | 'orgiq-initiative';

const PREFIX: Record<PageResourceKind, string> = {
  'assessment-team': 'assessment:team:',
  'pipelines-run': 'pipelines:run:',
  'orgiq-initiative': 'orgiq:initiative:',
};

/** Unknown, malformed or unreadable (store error) is one refusal. */
export async function pageResourceVisible(kind: PageResourceKind, bare: string): Promise<boolean> {
  const prefix = PREFIX[kind];
  if (!bare.startsWith(prefix)) return false;
  const id = bare.slice(prefix.length);
  if (!id) return false;
  try {
    if (kind === 'assessment-team') {
      const { teamExists } = await import('../providers/assessment.js');
      return await teamExists(id);
    }
    if (kind === 'orgiq-initiative') {
      const { projectExists } = await import('../providers/projects.js');
      return await projectExists(id);
    }
    const { loadProjection } = await import('../providers/pipeline-runs.js');
    return (await loadProjection()).runs.some(run => run.id === id);
  } catch { return false; }
}
