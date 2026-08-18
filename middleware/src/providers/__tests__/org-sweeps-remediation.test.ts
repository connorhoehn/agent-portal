// Remediation tests. These prompts are what a worker is actually told to do,
// so the properties that matter are: the remedy fits the sweep that produced
// the finding, it carries the evidence the worker needs (a devbox has no
// database access), the artifact path is deterministic so re-runs update
// rather than fork, and an unknown sweep is still promotable.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { remediationFor, type Finding } from '../org-sweeps.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'find-1', sweep: 'bus_factor', severity: 'warning',
    title: 'MLOps: 2 holders org-wide', detail: 'thin coverage',
    entityType: 'skill', entityId: 'sk-mlops',
    evidence: { holders: 2, holderNames: ['Ada Lovelace', 'Grace Hopper'] },
    status: 'open', jobId: null,
    firstSeenAt: '2026-08-18T00:00:00Z', lastSeenAt: '2026-08-18T00:00:00Z',
    fingerprint: 'skill:sk-mlops',
    ...over,
  };
}

describe('bus factor', () => {
  it('carries the holders inline, since the worker cannot query the graph', () => {
    const r = remediationFor(finding());
    expect(r.prompt).toContain('Ada Lovelace, Grace Hopper');
    expect(r.prompt).toContain('Current holders (2)');
  });

  it('escalates a single-holder skill above a two-holder one', () => {
    const solo = remediationFor(finding({ evidence: { holders: 1, holderNames: ['Ada Lovelace'] } }));
    const pair = remediationFor(finding());
    expect(solo.priority).toBeLessThan(pair.priority);
  });

  it('asks for a cross-training plan, not a generic write-up', () => {
    expect(remediationFor(finding()).prompt).toMatch(/cross-training/i);
  });
});

describe('per-sweep divergence', () => {
  it('gives a stale doc an extraction diagnosis, not a coverage plan', () => {
    const r = remediationFor(finding({
      sweep: 'stale_docs', severity: 'info',
      title: 'Unlinked document: OrgIQ Secures $50M',
      evidence: { source: 'news_article', ingestedAt: '2026-08-17' },
    }));
    expect(r.prompt).toMatch(/entity extraction/i);
    expect(r.prompt).toContain('news_article');
    expect(r.prompt).not.toMatch(/cross-training/i);
  });

  it('gives an orphan decision an ownership question set', () => {
    const r = remediationFor(finding({
      sweep: 'orphan_decisions', title: 'Decision with no owner: pick Aurora',
      evidence: { decidedAt: '2026-06-01' },
    }));
    expect(r.prompt).toMatch(/ownership|who to ask/i);
    expect(r.prompt).toContain('2026-06-01');
  });
});

describe('artifact paths', () => {
  it('are deterministic for the same finding, so a re-run updates one file', () => {
    const a = remediationFor(finding());
    const b = remediationFor(finding());
    expect(a.prompt).toBe(b.prompt);
  });

  it('are filesystem-safe even when the title is full of punctuation', () => {
    const r = remediationFor(finding({
      sweep: 'stale_docs',
      title: 'Unlinked document: OrgIQ Chooses Aurora/Postgres Over Neptune: A "Strategic" Move?',
      evidence: {},
    }));
    const path = /`linking\/([^`]+)\.md`/.exec(r.prompt)?.[1] ?? '';
    expect(path).toMatch(/^[a-z0-9-]+$/);
    expect(path.length).toBeLessThanOrEqual(60);
  });

  it('never emits a leading or trailing dash from surrounding punctuation', () => {
    const r = remediationFor(finding({ sweep: 'stale_docs', title: '...Leading and trailing...', evidence: {} }));
    const path = /`linking\/([^`]+)\.md`/.exec(r.prompt)?.[1] ?? '';
    expect(path.startsWith('-')).toBe(false);
    expect(path.endsWith('-')).toBe(false);
  });
});

describe('unknown sweeps', () => {
  it('are still promotable on the day they ship', () => {
    const r = remediationFor(finding({ sweep: 'brand_new_sweep', evidence: { anything: 1 } }));
    expect(r.prompt).toContain('findings/');
    expect(r.prompt).toContain('"anything":1');
  });

  it('map severity to priority so criticals still jump the queue', () => {
    const crit = remediationFor(finding({ sweep: 'unknown', severity: 'critical' }));
    const info = remediationFor(finding({ sweep: 'unknown', severity: 'info' }));
    expect(crit.priority).toBeLessThan(info.priority);
  });
});

describe('idempotence instruction', () => {
  it('tells the worker not to duplicate an artifact that already covers it', () => {
    // The MLOps run really did hit this: a second job for the same finding
    // found the plan already committed. Without this rule it would have
    // written a near-duplicate file and reported success.
    for (const sweep of ['bus_factor', 'stale_docs', 'orphan_decisions', 'unknown']) {
      expect(remediationFor(finding({ sweep })).prompt).toMatch(/do NOT\s+duplicate/i);
    }
  });
});
