// The tenant/mode matrix for deck narrative: a mode is allowed only for the
// tenant that owns it (mirrors agents/assessment-drafter/test_deck_narrative.py).
import { DECK_NARRATIVE_MODE_BY_TENANT, DECK_REVISE_MODE_BY_TENANT, narrativeModeAllowed, reviseModeAllowed } from '../narrative-modes.js';

const TENANTS = ['assessment', 'orgiq', 'pipelines', 'social', ''];
const MODES = ['draft-review-deck', 'initiative-status-deck', 'pipeline-run-deck', 'social-deck', 'revise-review-deck', 'story'];

describe('deck narrative mode/tenant matrix', () => {
  it('allows exactly the owning tenant for each mode', () => {
    for (const mode of MODES) {
      for (const tenant of TENANTS) {
        const owns = (DECK_NARRATIVE_MODE_BY_TENANT as Record<string, string>)[tenant] === mode;
        expect(narrativeModeAllowed(mode, tenant)).toBe(owns);
      }
    }
  });
  it('names the two new modes', () => {
    expect(DECK_NARRATIVE_MODE_BY_TENANT).toEqual({
      assessment: 'draft-review-deck', orgiq: 'initiative-status-deck', pipelines: 'pipeline-run-deck', social: 'social-deck',
    });
  });
});

describe('social-deck narrative mode', () => {
  it('a social session is allowed; every other tenant is refused', () => {
    expect(narrativeModeAllowed('social-deck', 'social')).toBe(true);
    for (const t of ['assessment', 'orgiq', 'pipelines', '']) expect(narrativeModeAllowed('social-deck', t)).toBe(false);
    expect(narrativeModeAllowed('draft-review-deck', 'social')).toBe(false);
  });
});

describe('deck revise mode/tenant matrix', () => {
  const REVISE = ['revise-review-deck', 'revise-initiative-status-deck', 'revise-pipeline-run-deck', 'revise-social-deck', 'draft-review-deck'];
  it('allows exactly the owning tenant for each revise mode', () => {
    for (const mode of REVISE) {
      for (const tenant of TENANTS) {
        const owns = (DECK_REVISE_MODE_BY_TENANT as Record<string, string>)[tenant] === mode;
        expect(reviseModeAllowed(mode, tenant)).toBe(owns);
      }
    }
  });
  it('a social session cannot use the orgiq revise mode, and vice versa', () => {
    expect(reviseModeAllowed('revise-initiative-status-deck', 'social')).toBe(false);
    expect(reviseModeAllowed('revise-social-deck', 'orgiq')).toBe(false);
    expect(reviseModeAllowed('revise-pipeline-run-deck', 'assessment')).toBe(false);
    expect(narrativeModeAllowed('revise-social-deck', 'social')).toBe(false);
  });
});
