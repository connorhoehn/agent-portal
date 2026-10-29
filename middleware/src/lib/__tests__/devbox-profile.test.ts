// DE-40 at the library: parsing, the model rule (never a silent fallback),
// lifetime tightening, the SDLC model_allowlist default, the write-once box
// stamp, and the reaper's per-box policy lookup.

import {
  parseProfileInput, resolveTaskModel, tightenLifetime, lifetimeOf, withProfileModelAllowlist,
  lifetimePoliciesFor, profileForBox, DEFAULT_PROFILE_INPUT,
} from '../devbox-profile.js';
import { registerBox, setBoxProfile, getBox, _resetFleet, type FleetBox } from '../devbox-fleet.js';
import { evaluatePolicy } from '../sdlc-policy.js';

interface Row {
  id: string; version: number; models: string[]; task_timeout_s: number; idle_minutes: number;
  max_lifetime_minutes: number; network_class: string; org_access: string; created_by: string; reason: string; created_at: string;
}
const store: { rows: Row[]; down: boolean } = { rows: [], down: false };
const row = (id: string, version: number, over: Partial<Row> = {}): Row => ({
  id, version, models: ['us.anthropic.claude-haiku-4-5-20251001-v1:0'], task_timeout_s: 840, idle_minutes: 20,
  max_lifetime_minutes: 240, network_class: 'public', org_access: 'none', created_by: 't', reason: 't', created_at: '', ...over,
});

jest.mock('../../providers/devbox-profiles.js', () => {
  const guard = () => { if (store.down) throw new Error('aurora down'); };
  const latest = (id: string) => store.rows.filter((r) => r.id === id).sort((a, b) => b.version - a.version)[0] ?? null;
  return {
    latestProfile: jest.fn(async (id: string) => { guard(); return latest(id); }),
    getProfileVersion: jest.fn(async (id: string, v: number) => { guard(); return store.rows.find((r) => r.id === id && r.version === v) ?? null; }),
    ensureDefaultProfile: jest.fn(async () => { guard(); return latest('default'); }),
    initiativeProfileId: jest.fn(async () => { guard(); return null; }),
  };
});

beforeEach(() => {
  store.rows = [row('default', 1, { models: [...DEFAULT_PROFILE_INPUT.models] })];
  store.down = false;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('parseProfileInput', () => {
  const ok = { models: ['us.anthropic.claude-sonnet-5'], task_timeout_s: 600, idle_minutes: 20, max_lifetime_minutes: 120, network_class: 'public', org_access: 'none' };
  it('accepts a sound profile and dedupes models', () => {
    expect(parseProfileInput({ ...ok, models: ['us.anthropic.claude-sonnet-5', 'us.anthropic.claude-sonnet-5'] }))
      .toMatchObject({ models: ['us.anthropic.claude-sonnet-5'], task_timeout_s: 600 });
  });
  it.each([
    [{ ...ok, models: [] }, /models/],
    [{ ...ok, task_timeout_s: 4000 }, /task_timeout_s/],
    [{ ...ok, idle_minutes: 60 }, /idle_minutes/],
    [{ ...ok, max_lifetime_minutes: 481 }, /max_lifetime_minutes/],
    [{ ...ok, network_class: 'private' }, /network_class/],
    [{ ...ok, org_access: 'write' }, /org_access/],
    [{ ...ok, models: ['rm -rf /'] }, /not an inference-profile id/],
  ])('refuses %o with a sentence', (input, msg) => {
    expect(parseProfileInput(input)).toEqual(expect.stringMatching(msg));
  });
});

describe('resolveTaskModel', () => {
  const p = { id: 'r', version: 3, models: ['a.one', 'a.two'] };
  it('defaults to the first listed model', () => expect(resolveTaskModel(p, undefined)).toEqual({ ok: true, model: 'a.one' }));
  it('passes a listed model', () => expect(resolveTaskModel(p, 'a.two')).toEqual({ ok: true, model: 'a.two' }));
  it('refuses an unlisted one, naming the allowed set — never a fallback', () => {
    expect(resolveTaskModel(p, 'a.three')).toEqual({ ok: false, error: expect.stringMatching(/r@3.*a\.one, a\.two/), allowed: ['a.one', 'a.two'] });
  });
});

describe('lifetime tightening', () => {
  it('a running box gets the shorter of its stamped and the latest version, field by field', () => {
    const stamped = lifetimeOf({ idle_minutes: 20, max_lifetime_minutes: 240, task_timeout_s: 840 });
    const latest = lifetimeOf({ idle_minutes: 30, max_lifetime_minutes: 60, task_timeout_s: 600 });
    expect(tightenLifetime(stamped, latest)).toMatchObject({ idleMs: 20 * 60_000, boxCeilingMs: 60 * 60_000, taskMaxS: 600 });
  });

  it('lifetimePoliciesFor applies a shrunk newer version to a box stamped on the older', async () => {
    store.rows.push(row('short', 1, { max_lifetime_minutes: 240 }), row('short', 2, { max_lifetime_minutes: 60 }));
    const b = { id: 'b-1', profileId: 'short', profileVersion: 1 } as FleetBox;
    const m = await lifetimePoliciesFor([b]);
    expect(m.get('b-1')?.boxCeilingMs).toBe(60 * 60_000);
  });

  it('lifetimePoliciesFor never widens: a longer newer version leaves the stamped numbers', async () => {
    store.rows.push(row('long', 1, { max_lifetime_minutes: 60 }), row('long', 2, { max_lifetime_minutes: 240 }));
    const m = await lifetimePoliciesFor([{ id: 'b-2', profileId: 'long', profileVersion: 1 } as FleetBox]);
    expect(m.get('b-2')?.boxCeilingMs).toBe(60 * 60_000);
  });
});

describe('store outage', () => {
  it('profileForBox falls back to the in-code default rather than throwing', async () => {
    store.down = true;
    const p = await profileForBox({ profileId: 'x', profileVersion: 1, projectId: 'p-1' } as FleetBox);
    expect(p).toMatchObject({ id: 'default', version: 1, models: [...DEFAULT_PROFILE_INPUT.models] });
  });
});

describe('withProfileModelAllowlist (SDLC review and dispatch agree)', () => {
  const profile = { id: 'r', version: 2, models: ['a.one'] };
  it('adds the profile\'s list when the set has no model_allowlist row', () => {
    const out = withProfileModelAllowlist([], profile);
    expect(out).toEqual([expect.objectContaining({ kind: 'model_allowlist', config: { models: ['a.one'] }, action: 'require_approval' })]);
  });
  it('the derived row routes an unlisted or unknown model to a person — never passes, never hard-blocks', () => {
    const [row] = withProfileModelAllowlist([], profile);
    const facts = { files: [] as string[], reviewVerdict: null, costUsd: null, costBasis: 'unknown' as const };
    expect(evaluatePolicy(row!, { ...facts, model: 'a.one' })).toBeNull();
    expect(evaluatePolicy(row!, { ...facts, model: 'amazon.nova-pro-v1:0' })!.outcome).toBe('requires_approval');
    expect(evaluatePolicy(row!, { ...facts, model: null })!.outcome).toBe('requires_approval');
  });
  it('an explicit policy row wins', () => {
    const explicit = { id: 'p', name: 'p', enabled: true, kind: 'model_allowlist', config: { models: ['z'] }, action: 'warn' } as never;
    expect(withProfileModelAllowlist([explicit], profile)).toEqual([explicit]);
  });
});

describe('setBoxProfile is write-once', () => {
  it('keeps the first stamp', () => {
    _resetFleet();
    const b = registerBox({ sessionId: 'devbox-ddddddddddddddddddddddddddddddddd' });
    expect(setBoxProfile(b.id, { id: 'a', version: 1 })).toEqual({ id: 'a', version: 1 });
    expect(setBoxProfile(b.id, { id: 'b', version: 9 })).toEqual({ id: 'a', version: 1 });
    expect(getBox(b.id)).toMatchObject({ profileId: 'a', profileVersion: 1 });
  });
});
