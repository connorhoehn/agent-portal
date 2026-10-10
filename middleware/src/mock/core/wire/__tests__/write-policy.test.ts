// The write half of the wire capture: the policy, and the snapshot it produces.
//
// The GET sweep can be trusted to a snapshot alone, because a GET is a
// question. A write is an act, so the thing that most needs testing here is not
// the capture — it is the DECISION about what may be replayed at all. These
// tests hold the policy to its own contract: every write route resolves to
// either an allowlist entry with a stated reason or a refusal rule with a
// stated reason, nothing falls between, and nothing dangerous can be reached by
// adding an allowlist entry.

import { readFileSync } from 'node:fs';

import { enumerateRoutes, routeKey } from '../routes.js';
import { snapshotPath, readWritesSnapshot, hasWritesSnapshot, buildVocabulary, readSnapshot } from '../vocabulary.js';
import {
  REFUSAL_RULES,
  WRITE_SPECS,
  classifyWrite,
  objectsWith,
  str,
  type Intercepted,
  type MockProvider,
} from '../write-policy.js';
import { PERSONAS, firstAtPath } from '../http.js';

const writeRoutes = enumerateRoutes().routes.filter((r) => r.method !== 'GET').map(routeKey);

/**
 * A server running every mock provider — what `dev:mock` is, and the world the
 * committed snapshot was captured against. Passed explicitly wherever a test
 * is asking "would this replay on a mock server?", because `classifyWrite`
 * with no second argument deliberately means "nothing is known to be
 * intercepted" and refuses every spec that leans on one.
 */
const FULLY_MOCKED: Intercepted = new Set<MockProvider>(['aurora', 'agentcore', 'guardrails', 'cloudwatch']);

describe('write policy — the decision', () => {
  it('does not treat Aurora interception as a resettable joined call', () => {
    const decision = classifyWrite('PUT /api/calls/:callId/page', FULLY_MOCKED);
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') expect(decision.rule).toBe('active-call-state');
  });

  it('does not treat Aurora interception as proof that personal team preferences are resettable', () => {
    const decision = classifyWrite('PATCH /api/social/teams/:teamId/me', FULLY_MOCKED);
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') expect(decision.rule).toBe('social-platform-not-verified');
  });

  it('does not treat Aurora interception as proof that chat pin writes are resettable', () => {
    const decision = classifyWrite('POST /api/chat/pins', FULLY_MOCKED);
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') expect(decision.rule).toBe('chat-store-not-verified');
  });

  it('refuses proposal mutations that consult the canonical document service even with Aurora mocked', () => {
    for (const route of [
      'POST /api/assessment/knowledge/doc/proposals',
      'POST /api/assessment/knowledge/doc/proposals/:proposalId/decision',
      'POST /api/assessment/knowledge/doc/proposals/:proposalId/revision',
    ]) {
      const decision = classifyWrite(route, FULLY_MOCKED);
      expect(decision.kind).toBe('refused');
      if (decision.kind === 'refused') expect(decision.rule).toBe('document-service');
    }
  });

  it('classifies every write route on the live surface, with no gap', () => {
    const unclassifiable = writeRoutes.filter((r) => {
      const v = classifyWrite(r);
      return v.kind === 'refused' && !v.reason.trim();
    });
    expect(unclassifiable).toEqual([]);
    // Sanity: the surface is big and the split is real, not "refuse everything".
    expect(writeRoutes.length).toBeGreaterThan(150);
    expect(writeRoutes.filter((r) => classifyWrite(r, FULLY_MOCKED).kind === 'replay').length)
      .toBeGreaterThan(50);
  });

  it('refuses every DELETE but the ones proved restorable, which still need an entry', () => {
    const deletes = writeRoutes.filter((r) => r.startsWith('DELETE '));
    expect(deletes.length).toBeGreaterThan(0);

    // The carve-out is deliberately tiny and deliberately named: a delete is
    // only spared when someone has read the handler and shown that reset puts
    // it back (RESTORABLE_DELETES in write-policy.ts). Anything not on that
    // list is refused whether or not it happens to be restorable, because the
    // list means "somebody proved this", not "everything else destroys".
    const spared = new Set(WRITE_SPECS.filter((s) => s.route.startsWith('DELETE ')).map((s) => s.route));
    expect([...spared].sort()).toEqual([
      'DELETE /api/graph/work-items/:id/decisions/:decisionId',
      'DELETE /api/local-compute/nodes/:id',
    ]);

    for (const r of deletes) {
      const v = classifyWrite(r, FULLY_MOCKED);
      if (spared.has(r)) {
        expect(v.kind).toBe('replay');
        continue;
      }
      expect(v.kind).toBe('refused');
      if (v.kind === 'refused') expect(v.rule).toBe('destructive');
    }
  });

  it('refuses an interception-dependent write until the SERVER says it is intercepted', () => {
    const leaning = WRITE_SPECS.filter((s) => (s.intercepts ?? []).length > 0);
    // If this ever empties, the mechanism has quietly stopped being used.
    expect(leaning.length).toBeGreaterThan(10);

    for (const spec of leaning) {
      // No report at all — the default, and the one this file cares about
      // most: nothing here may decide on its own that a provider is mocked.
      const blind = classifyWrite(spec.route);
      expect(blind.kind).toBe('refused');
      if (blind.kind === 'refused') expect(blind.rule).toBe('not-intercepted');

      // A server running everything EXCEPT what this spec needs.
      const without: Intercepted = new Set(
        [...FULLY_MOCKED].filter((p) => !(spec.intercepts ?? []).includes(p)),
      );
      expect(classifyWrite(spec.route, without).kind).toBe('refused');

      // And the mock server it was written for.
      expect(classifyWrite(spec.route, FULLY_MOCKED).kind).toBe('replay');
    }
  });

  it('a route that spends in every configuration is refused even by a fully mocked server', () => {
    // The interception carve-out must not have leaked into the family that has
    // no mock branch at all. web-qa builds its own BedrockRuntimeClient in the
    // handler; crawl fetches real pages; agents/:id/invoke fires an unawaited
    // session-title Converse (lib/session-titles.ts) after the answer streams —
    // that last one used to be listed here as "invokes an AgentCore runtime",
    // which `mockAgentCore.invokeAgentStreaming` makes false, so the ROUTE
    // stayed refused while the reason had to be replaced.
    for (const r of [
      'POST /api/capabilities/browser/web-qa',
      'POST /api/capabilities/browser/crawl',
      'POST /api/agents/:agentId/invoke',
    ]) {
      const v = classifyWrite(r, FULLY_MOCKED);
      expect(v.kind).toBe('refused');
      if (v.kind === 'refused') expect(v.rule).toBe('spends');
    }
  });

  it('a route whose spend is intercepted but which still arms something is refused as `fires`', () => {
    // `POST /devbox/:sessionId/task` was on the `spends` list above until a
    // re-read: under MOCK_AGENTCORE it invokes `mock/devbox-shell.ts`, not a
    // microVM. It is still refused, because before the invoke it does
    // `getBoxBySession(id) ?? registerBox({ sessionId })` and lib/devbox-fleet.ts
    // holds that Map with no fixture behind it — the same rule-4 problem
    // `POST /devbox/boxes` is refused for. Moving a route between rules must
    // never mean releasing it, and this is the test that says so.
    for (const r of [
      'POST /api/devbox/:sessionId/task',
      'POST /api/agent-projects/:id/runs',
      'POST /api/sdlc/changes/:id/address',
    ]) {
      const v = classifyWrite(r, FULLY_MOCKED);
      expect(v.kind).toBe('refused');
      if (v.kind === 'refused') expect(v.rule).toBe('fires');
    }
  });

  it('never replays a route that mutates the capture’s own session', () => {
    for (const r of writeRoutes.filter((x) => /^[A-Z]+ \/api\/(session|auth)\//.test(x))) {
      expect(classifyWrite(r).kind).toBe('refused');
    }
  });

  it('refuses a write that spends even with Aurora down', () => {
    // This test used to name `POST /harness/trace` as well, on the grounds that
    // it ran Titan and the Nova judge BEFORE any database call, so "it fails
    // offline anyway" was untrue of it. That reading was correct and is now
    // out of date: `lib/trace-sink.ts` embeds through `mock/embedding.ts` and
    // `lib/judge.ts` answers from `mock/answer-check.ts`, both on
    // `config.mock.agentcore`, so the route is on the allowlist behind an
    // `intercepts` declaration and the next assertion covers it. What is left
    // here is a route with no mock branch at any layer: an optimize call
    // creates and optimizes a real Bedrock managed prompt whatever the flags
    // say.
    const v = classifyWrite('POST /api/observability/canary/library/:promptId/optimize');
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.rule).toBe('spends');
  });

  it('refuses the offline judge’s own routes until the SERVER reports agentcore', () => {
    // The corollary of the note above. These four are only safe because the
    // judge and the embedder are intercepted, and this file may not decide
    // that on its own: with no report they refuse, and they refuse again on a
    // server running everything except agentcore.
    const withoutAgentcore: Intercepted = new Set<MockProvider>(['aurora', 'guardrails', 'cloudwatch']);
    for (const r of [
      'POST /api/observability/harness/trace',
      'POST /api/observability/harness/results/:invocationId/rejudge',
      'POST /api/sdlc/changes/:id/rereview',
      'POST /api/agent-projects/:id/clone-command',
    ]) {
      expect(classifyWrite(r).kind).toBe('refused');
      expect(classifyWrite(r, withoutAgentcore).kind).toBe('refused');
      expect(classifyWrite(r, FULLY_MOCKED).kind).toBe('replay');
    }
  });

  it('every refusal rule states a rule, not a shrug', () => {
    for (const rule of REFUSAL_RULES) {
      expect(rule.id).toMatch(/^[a-z-]+$/);
      expect(rule.because.trim().length).toBeGreaterThan(60);
    }
    // The catch-all must be last, or an unread route would slip past it.
    expect(REFUSAL_RULES[REFUSAL_RULES.length - 1]!.id).toBe('unclassified');
  });

  it('every allowlist entry names a live route, a real persona, and both reasons', () => {
    const live = new Set(writeRoutes);
    const personas = new Set(PERSONAS.map((p) => p.name));
    for (const spec of WRITE_SPECS) {
      expect(live.has(spec.route)).toBe(true);
      expect(personas.has(spec.persona)).toBe(true);
      // Same contract as allow.ts: a bare exemption is not an exemption.
      expect(spec.safe.trim().length).toBeGreaterThan(40);
      expect(spec.bodyFrom.trim().length).toBeGreaterThan(20);
    }
  });

  it('no allowlist entry is shadowed by a refusal rule', () => {
    // A shadowed spec is dead code that reads like a decision — the worst kind
    // of stale entry, because it says a route is replayed when it is not.
    const shadowed = WRITE_SPECS
      .filter((s) => classifyWrite(s.route, FULLY_MOCKED).kind !== 'replay')
      .map((s) => s.route);
    expect(shadowed).toEqual([]);
  });

  it('allowlist routes are unique', () => {
    const seen = new Set<string>();
    const dupes = WRITE_SPECS.filter((s) => (seen.has(s.route) ? true : (seen.add(s.route), false)));
    expect(dupes.map((s) => s.route)).toEqual([]);
  });
});

describe('write policy — the body helpers', () => {
  it('objectsWith finds every object carrying the named keys, at any depth', () => {
    const body = { sections: [{ key: 'a', nodes: [{ id: 'x', kind: 'doc' }] }, { key: 'b', nodes: [] }] };
    expect(objectsWith(body, 'key').map((o) => o['key'])).toEqual(['a', 'b']);
    expect(objectsWith(body, 'id', 'kind')).toHaveLength(1);
    expect(objectsWith(body, 'nope')).toEqual([]);
    expect(objectsWith(null, 'key')).toEqual([]);
  });

  it('firstAtPath resolves an exact key path and never falls back to another field', () => {
    // The shape that made this necessary: a fuzzy id search over the guardrail
    // returns the GUARDRAIL's `name`, and `PATCH /guardrail/topics/:name` then
    // 404s against a topic that does not exist.
    const guardrail = {
      name: 'orgiq-guardrail',
      deniedTopics: [{ name: 'Competitor Analysis' }, { name: 'Legal Advice' }],
    };
    expect(firstAtPath(guardrail, 'deniedTopics[].name')).toBe('Competitor Analysis');
    expect(firstAtPath(guardrail, 'piiFilters[].type')).toBeNull();

    // `[]` skips a row that yields nothing rather than giving up on it — the
    // offline node whose sessions are hidden sits in front of the one that is
    // actually announcing.
    const nodes = {
      nodes: [
        { id: 'node-a', presence: { sessions: [] } },
        { id: 'node-b', presence: { sessions: [{ sessionId: 'local-session-1' }] } },
      ],
    };
    expect(firstAtPath(nodes, 'nodes[].presence.sessions[].sessionId')).toBe('local-session-1');
  });

  it('str accepts only a non-empty string', () => {
    expect(str('x')).toBe('x');
    expect(str('')).toBeNull();
    expect(str(3)).toBeNull();
    expect(str(null)).toBeNull();
    expect(str(undefined)).toBeNull();
  });
});

describe('write snapshot', () => {
  const snapshot = readWritesSnapshot();

  it('exists — without it every write response shape is unpinned', () => {
    expect(hasWritesSnapshot()).toBe(true);
    expect(snapshot).not.toBeNull();
  });

  it('covers every write route on the live surface', () => {
    const recorded = new Set(Object.keys(snapshot?.routes ?? {}));
    const missing = writeRoutes.filter((r) => !recorded.has(r));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} write route(s) are not in writes.json — recapture it:\n  ${missing.join('\n  ')}\n\n` +
          '  cd middleware && npx tsx src/mock/core/wire/capture-writes.ts',
      );
    }
  });

  it('records a reason for everything it did not capture', () => {
    for (const [route, cap] of Object.entries(snapshot?.routes ?? {})) {
      if (cap.shape) continue;
      const reason = cap.refused?.reason ?? cap.skipped ?? '';
      // A blank reason is the failure mode this whole file exists to prevent:
      // an assumed-away gap reads exactly like a covered route.
      expect(`${route}: ${reason.trim()}`).not.toMatch(/: $/);
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  it('replayed a real share of the surface — an empty capture proves nothing', () => {
    const captured = Object.values(snapshot?.routes ?? {}).filter((c) => c.shape);
    expect(captured.length).toBeGreaterThan(30);
  });

  it('feeds write response shapes into the same vocabulary the GET sweep feeds', () => {
    const vocab = buildVocabulary(readSnapshot(), snapshot);
    expect(vocab.writeCapturedCount).toBeGreaterThan(30);
    // The point of the whole exercise: a fixture standing in for a write
    // response is now measured against a real one.
    const fromWrites = vocab.objects.filter((o) => !o.route.startsWith('GET '));
    expect(fromWrites.length).toBeGreaterThan(30);
  });

  it('a route this policy refuses was not replayed anyway', () => {
    // Judged against the world the capture RECORDED, not against a world this
    // test assumed: a snapshot taken on a server running fewer mock providers
    // is a different snapshot, and re-judging it under `dev:mock`'s flags
    // would report every honest `not-intercepted` refusal as a contradiction.
    const world: Intercepted = new Set(snapshot?.intercepted ?? []);
    for (const [route, cap] of Object.entries(snapshot?.routes ?? {})) {
      if (classifyWrite(route, world).kind !== 'refused') continue;
      expect(cap.shape).toBeUndefined();
      expect(cap.status).toBeUndefined();
    }
  });

  it('records which providers the captured server said it was intercepting', () => {
    // Half of the decision. Without it a `not-intercepted` refusal in the
    // snapshot cannot be told from a policy change.
    expect(Array.isArray(snapshot?.intercepted)).toBe(true);
  });

  it('was taken against the same server the GET snapshot was', () => {
    const wire = JSON.parse(readFileSync(snapshotPath(), 'utf8')) as { baseUrl: string };
    expect(snapshot?.baseUrl).toBe(wire.baseUrl);
  });
});
