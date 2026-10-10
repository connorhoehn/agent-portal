import type { DocumentEditProposal } from '../lib/document-proposals.js';
import { defineFixture } from './core/fixture.js';

/** Proposals are created from the live drafter result; reset clears draft metadata. */
export const documentProposalsFixture = defineFixture<DocumentEditProposal>({
  key: 'assessment.document-proposals',
  scenarios: { default: () => [], empty: () => [] },
});
