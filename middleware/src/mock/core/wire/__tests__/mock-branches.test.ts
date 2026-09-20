// The static scanner behind the widened halves of rules 3 and 4.
//
// A judge is only worth what its analysis is worth, so these tests pin the
// two directions that matter: the shapes it MUST find (the bugs it was written
// for) and the shapes it must NOT (the false positives that made the first
// sweep unreadable — 179 findings, nearly all of them a route "reaching" a
// provider it cannot reach offline).

import { scanProviderMockMints, scanWriteRoutesWithoutMockBranch, documentServiceBoundary, DOCUMENT_SERVICE_BOUNDARIES } from '../mock-branches.js';

// These are slow-ish: both parse every module under src/{routes,lib,providers}.
const mints = scanProviderMockMints();
const writes = scanWriteRoutesWithoutMockBranch();

jest.setTimeout(60_000);

describe('rule 3, widened — wall-clock mints in a provider mock branch', () => {
  it('finds nothing in providers/agent-projects.ts, whose markCloned was the bug', () => {
    expect(mints.filter((f) => f.where.startsWith('src/providers/agent-projects.ts'))).toEqual([]);
  });

  it('reports a file:line and says what to use instead', () => {
    for (const f of mints) {
      expect(f.where).toMatch(/^src\/providers\/.+\.ts:\d+$/);
      expect(f.what).toContain('mock/core/clock.ts');
    }
  });

  it('leaves the real (Aurora) path alone — a mint there is not a fixture stamp', () => {
    // providers/aurora.ts is the Data API client. It has no mock branch at all,
    // so nothing in it can be inside one, and a rule that flagged its timing
    // code would be flagging a stopwatch.
    expect(mints.some((f) => f.where.startsWith('src/providers/aurora.ts'))).toBe(false);
  });
});

describe('rule 4, widened — write routes reaching an unmocked provider', () => {
  it('reports durable document service boundaries explicitly without exempting new functions', () => {
    for (const [key, reason] of Object.entries(DOCUMENT_SERVICE_BOUNDARIES)) {
      expect(reason.length).toBeGreaterThan(40);
      expect(writes.some(finding => finding.provider.replace(/:\d+ (\w+)\(\)$/, ':$1') === key)).toBe(true);
    }
    const example = writes.find(finding => documentServiceBoundary(finding))!;
    expect(example).toBeDefined();
    expect(documentServiceBoundary({ ...example, provider: 'src/providers/document-source.ts:1 newlyAddedNetworkCall()' })).toBeUndefined();
    expect(writes.some(finding => finding.provider.includes('pageId()'))).toBe(false);
  });
  it('clears the four agent-projects write paths that were fixed', () => {
    const routes = new Set(writes.map((f) => f.route));
    expect(routes.has('POST /api/agent-projects')).toBe(false);
    expect(routes.has('DELETE /api/agent-projects/:id')).toBe(false);
    expect(routes.has('POST /api/agent-projects/:id/cloned')).toBe(false);
    expect(routes.has('POST /api/agent-projects/runs/:runId/finish')).toBe(false);
  });

  it('never reports a GET — that half is the wire capture’s job', () => {
    expect(writes.some((f) => f.route.startsWith('GET '))).toBe(false);
  });

  it('names the provider function, never the transport underneath it', () => {
    // `exec` in providers/aurora.ts is the wire. Reporting it turns every write
    // route in the middleware into a finding that says nothing.
    expect(writes.some((f) => f.provider.includes('src/providers/aurora.ts'))).toBe(false);
    expect(writes.some((f) => /\b(exec|safeExec|execWrite|execOne)\(\)$/.test(f.provider))).toBe(false);
  });

  it('does not descend past a guarded function into its Aurora side', () => {
    // providers/identity.ts falls back to FALLBACK_USERS when the cluster is
    // unconfigured (`auroraConfigured()`), which is the dev:mock case. Every
    // session route reaches it, and calling those a gap would be wrong.
    expect(writes.some((f) => f.provider.includes('src/providers/identity.ts'))).toBe(false);
  });

  it('each finding carries the route, the leaf and a source position', () => {
    for (const f of writes) {
      expect(f.route).toMatch(/^(POST|PUT|PATCH|DELETE) \/.+/);
      // Providers AND lib. The scan reported only providers until 2026-09,
      // which is exactly how the whole governed-run and change-delivery
      // surface — 503 offline at `lib/devbox-arn.ts` — stayed off the list.
      expect(f.provider).toMatch(/^src\/(providers|lib)\/.+\.ts:\d+ \w+\(\)$/);
      expect(f.where).toMatch(/^src\/routes\/.+\.ts:\d+$/);
    }
  });

  it('follows routes → lib → providers and reports leaves in both layers', () => {
    expect(writes.some((f) => f.provider.startsWith('src/providers/'))).toBe(true);
    expect(writes.some((f) => f.provider.startsWith('src/lib/'))).toBe(true);
  });

  it('names the lib function, never the devbox wire underneath it', () => {
    // `runDevboxShell` IS the devbox transport, by the same argument that
    // excludes `exec`: every governance probe goes through it, so reporting it
    // buries the function above it that decides whether there is an offline
    // path at all.
    expect(writes.some((f) => /\brunDevboxShell\(\)$/.test(f.provider))).toBe(false);
  });

  it('treats open-mode authz and the dev signing key as the offline branches they are', () => {
    // `lib/authz.ts` answers from the Cedar seed matrix when POLICY_STORE_ID is
    // unset, and `lib/session.ts` signs with a deterministic dev key when no
    // secret ARN is set. `dev:mock` takes both. Without those guard tokens the
    // widened scan reported every gated write route in the middleware as
    // reaching live AWS through its own auth check — sixty-odd findings that
    // named the guard rather than a gap.
    expect(writes.some((f) => f.provider.includes('src/lib/authz.ts'))).toBe(false);
    expect(writes.some((f) => f.provider.includes('src/lib/session.ts'))).toBe(false);
  });

  it('has no finding left on the three lib blockers this slice closed', () => {
    // devbox-arn (the 503 itself), change-reviewer (the Bedrock Converse) and
    // change-delivery (the push + PR) all carry a config.mock branch now, so
    // the scan stops at each of them rather than descending to the SDK call.
    for (const mod of ['src/lib/devbox-arn.ts', 'src/lib/change-reviewer.ts', 'src/lib/change-delivery.ts']) {
      expect(writes.some((f) => f.provider.includes(mod))).toBe(false);
    }
  });
});
