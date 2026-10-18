import test from 'node:test';
import assert from 'node:assert/strict';
import { auditProof } from '../../meeting-rooms-proof.mjs';

const proof = () => ({
  revision: { sourceDigest: 'source', uiComponents: '2.480.3' }, strictCoverage: true, unclassified: [],
  cases: ['light', 'dark'].flatMap(theme => [1440, 900].map(width => ({
    tenant: 'orgiq', route: '/iq/projects/p-observability', state: 'call-rooms-pane', theme, width,
    issues: [], measuredElements: 150, samples: [{ selector: '[data-testid="breakout-create"]' }],
  }))),
});

test('E3 proof rejects stale source, missing cases, findings, and an unmeasured rooms pane', () => {
  auditProof(proof(), 'source', '2.480.3');
  const mutations = [
    p => { p.revision.sourceDigest = 'old'; },
    p => { p.cases.pop(); },
    p => { p.cases[0].issues = [{ rule: 'text.contrast' }]; },
    p => { p.cases[0].samples = []; },
    p => { p.strictCoverage = false; },
    p => { p.unclassified = ['button']; },
  ];
  for (const mutate of mutations) { const p = proof(); mutate(p); assert.throws(() => auditProof(p, 'source', '2.480.3')); }
});
