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
} from '../write-policy.js';
import { PERSONAS } from '../http.js';

const writeRoutes = enumerateRoutes().routes.filter((r) => r.method !== 'GET').map(routeKey);

describe('write policy — the decision', () => {
  it('classifies every write route on the live surface, with no gap', () => {
    const unclassifiable = writeRoutes.filter((r) => {
      const v = classifyWrite(r);
      return v.kind === 'refused' && !v.reason.trim();
    });
    expect(unclassifiable).toEqual([]);
    // Sanity: the surface is big and the split is real, not "refuse everything".
    expect(writeRoutes.length).toBeGreaterThan(150);
    expect(writeRoutes.filter((r) => classifyWrite(r).kind === 'replay').length).toBeGreaterThan(50);
  });

  it('refuses every DELETE — reset restores fixtures, not module-level arrays', () => {
    const deletes = writeRoutes.filter((r) => r.startsWith('DELETE '));
    expect(deletes.length).toBeGreaterThan(0);
    for (const r of deletes) {
      const v = classifyWrite(r);
      expect(v.kind).toBe('refused');
      if (v.kind === 'refused') expect(v.rule).toBe('destructive');
    }
    // …and no entry can smuggle one back in, because refusals are checked first.
    expect(WRITE_SPECS.some((s) => s.route.startsWith('DELETE '))).toBe(false);
  });

  it('never replays a route that mutates the capture’s own session', () => {
    for (const r of writeRoutes.filter((x) => /^[A-Z]+ \/api\/(session|auth)\//.test(x))) {
      expect(classifyWrite(r).kind).toBe('refused');
    }
  });

  it('refuses the two writes that spend even with Aurora down', () => {
    // harness/trace runs Titan + the Nova judge before any database call, so it
    // is the one route where "it fails offline anyway" is simply untrue.
    for (const r of [
      'POST /api/observability/harness/trace',
      'POST /api/observability/canary/library/:promptId/optimize',
    ]) {
      const v = classifyWrite(r);
      expect(v.kind).toBe('refused');
      if (v.kind === 'refused') expect(v.rule).toBe('spends');
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
    const shadowed = WRITE_SPECS.filter((s) => classifyWrite(s.route).kind !== 'replay').map((s) => s.route);
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
    for (const [route, cap] of Object.entries(snapshot?.routes ?? {})) {
      if (classifyWrite(route).kind !== 'refused') continue;
      expect(cap.shape).toBeUndefined();
      expect(cap.status).toBeUndefined();
    }
  });

  it('was taken against the same server the GET snapshot was', () => {
    const wire = JSON.parse(readFileSync(snapshotPath(), 'utf8')) as { baseUrl: string };
    expect(snapshot?.baseUrl).toBe(wire.baseUrl);
  });
});
