// Which drafter mode writes a deck's narrative for which tenant. Mirrors the
// per-mode guard in agents/assessment-drafter (MODE_TENANTS / deck_narrative.py):
// a mode runs only for its own tenant, so the BFF refuses a mismatch before
// invoking and a forged one is refused again by the agent.

export const DECK_NARRATIVE_MODE_BY_TENANT = {
  assessment: 'draft-review-deck',
  orgiq: 'initiative-status-deck',
  pipelines: 'pipeline-run-deck',
  social: 'social-deck',
} as const;

export type DeckNarrativeTenant = keyof typeof DECK_NARRATIVE_MODE_BY_TENANT;
export type DeckNarrativeMode = (typeof DECK_NARRATIVE_MODE_BY_TENANT)[DeckNarrativeTenant];

export const INITIATIVE_STATUS_DECK_MODE: DeckNarrativeMode = 'initiative-status-deck';
export const PIPELINE_RUN_DECK_MODE: DeckNarrativeMode = 'pipeline-run-deck';
export const SOCIAL_DECK_MODE: DeckNarrativeMode = 'social-deck';

/** True only when `mode` is the narrative mode that `tenant` owns. */
export function narrativeModeAllowed(mode: string, tenant: string): boolean {
  return (DECK_NARRATIVE_MODE_BY_TENANT as Record<string, string>)[tenant] === mode;
}

// The revise modes (the deck editor's Revise…): one per tenant that has a
// tenant-owned reviser. Assessment keeps `revise-review-deck`.
export const DECK_REVISE_MODE_BY_TENANT = {
  assessment: 'revise-review-deck',
  orgiq: 'revise-initiative-status-deck',
  pipelines: 'revise-pipeline-run-deck',
  social: 'revise-social-deck',
} as const;

export type DeckReviseTenant = keyof typeof DECK_REVISE_MODE_BY_TENANT;

/** True only when `mode` is the revise mode that `tenant` owns. */
export function reviseModeAllowed(mode: string, tenant: string): boolean {
  return (DECK_REVISE_MODE_BY_TENANT as Record<string, string>)[tenant] === mode;
}
