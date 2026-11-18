// The lead's two controls for Milo's interview tools (docs/interviews-tenant-plan.md, "Milo's interview tools"): Introduce Milo
// in the call bar (POST /interviews/:id/milo-intro) and the pad's "Candidate can ask Milo" switch (PUT /interviews/:id/milo-settings).
import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export interface MiloSettingsView { settings: { candidateMayAsk: boolean }; introduced: boolean }

export const miloSettingsPath = (id: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/milo-settings`;
const introPath = (id: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/milo-intro`;

/** The switch's label and what it means, in the room's words. */
export const PAD_HELP_LABEL = 'Candidate can ask Milo';
export const PAD_HELP_TOOLTIP = 'Lets the candidate ask Milo for test cases, an import or a helper in the pad. Milo never writes the solution. You can always ask.';

export async function setCandidateMayAsk(id: string, on: boolean): Promise<{ ok: true; on: boolean } | { ok: false; error: string }> {
  const r = await writeJson<{ settings?: { candidateMayAsk: boolean } }>(miloSettingsPath(id), 'PUT', { candidateMayAsk: on });
  return r.ok && r.data?.settings ? { ok: true, on: r.data.settings.candidateMayAsk } : { ok: false, error: r.error ?? 'The setting could not be saved. Try again.' };
}

export async function introduceMilo(id: string): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  const r = await writeJson<{ line?: string }>(introPath(id), 'POST', {});
  return r.ok && r.data?.line ? { ok: true, line: r.data.line } : { ok: false, error: r.error ?? 'Milo could not introduce itself. Try again.' };
}
