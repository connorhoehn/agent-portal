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

/** The candidate's pad request that waits for the lead's yes (GET/POST /interviews/:id/milo-pad-confirm). */
export interface PadConfirmWaiting { text: string; askedAt: string }
export const padConfirmPath = (id: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/milo-pad-confirm`;
/** How often the lead's room asks whether a pad request waits (it waits two minutes on the server). */
export const PAD_CONFIRM_POLL_MS = 3000;
/** The footer prompt's words: Confirm writes it as "Milo, go ahead" does; Decline drops it. */
export const PAD_CONFIRM_TITLE = 'The candidate asked Milo to change the pad';
export const PAD_CONFIRM_OPTIONS = [{ id: 'confirm', label: 'Confirm', emphasis: 'primary' as const }, { id: 'decline', label: 'Decline' }];
export const PAD_CONFIRM_RECEIPTS = { confirm: 'Pad change confirmed', decline: 'Pad change declined' } as const;

/** What waits for the lead, or null (nothing, not the lead, or the read failed: no news). */
export async function readPadConfirm(id: string, fetcher: typeof fetch = fetch): Promise<PadConfirmWaiting | null> {
  try {
    const res = await fetcher(padConfirmPath(id), { credentials: 'include' });
    if (!res.ok) return null;
    const w = ((await res.json()) as { waiting?: Partial<PadConfirmWaiting> | null }).waiting;
    return w && typeof w.text === 'string' && w.text.trim() ? { text: w.text, askedAt: typeof w.askedAt === 'string' ? w.askedAt : '' } : null;
  } catch { return null; }
}

/** The lead pressed Confirm (`allow`) or Decline: Milo says what he did. */
export async function answerPadConfirm(id: string, allow: boolean): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  const r = await writeJson<{ line?: string }>(padConfirmPath(id), 'POST', { allow });
  return r.ok && r.data?.line ? { ok: true, line: r.data.line } : { ok: false, error: r.error ?? 'Milo could not answer that. Try again.' };
}

export async function introduceMilo(id: string): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  const r = await writeJson<{ line?: string }>(introPath(id), 'POST', {});
  return r.ok && r.data?.line ? { ok: true, line: r.data.line } : { ok: false, error: r.error ?? 'Milo could not introduce itself. Try again.' };
}
