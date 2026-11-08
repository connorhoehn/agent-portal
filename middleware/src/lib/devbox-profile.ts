// Devbox policy profiles (DE-40): the rule set a box runs under, and the ONE
// resolver every path that starts work reads.
//
// A profile is a versioned row (schema/devbox_profiles_schema.sql); an
// initiative points at one (`projects.devbox_profile_id`, null = `default`);
// a box records the (id, version) it was created under on its fleet row and
// keeps it, so a running box never changes rules mid-task. What the BFF
// enforces from a profile without a redeploy:
//
//   1. Model — an unlisted model is a 400 naming the allowed set, never a
//      silent fallback (`resolveTaskModel`). The BFF always sends `model`.
//   2. Timeout — min(requested ?? profile.task_timeout_s, profile.task_timeout_s)
//      through lib/devbox-lifetime.ts's one cap.
//   3. Lifetime — the reaper reads idle and ceiling from the box's profile
//      (`lifetimePoliciesFor`), tightened by a newer version if one shrank.
//   4. SDLC `model_allowlist` — evaluated against the profile's list when the
//      pinned policy set has no explicit row (`withProfileModelAllowlist`).
//
// Network class and org access stay deploy-time (AgentCore fixes them per
// runtime); a profile names a class and never carries an ARN. `egress-allowlist`
// routes an initiative's queued work to the microVM runner (lib/microvm-enqueue.ts,
// docs/microvm-runner-design.md §5); `public` keeps the fleet.
//
// The provider (Aurora + mock) is loaded lazily, inside the async functions:
// providers import config.ts, whose `import.meta` the CommonJS jest build of
// routes/devbox.ts cannot load. Everything synchronous here is pure.

import type { FleetBox } from './devbox-fleet.js';
import {
  lifetimePolicy, type LifetimePolicy, TASK_MAX_S,
} from './devbox-lifetime.js';
import type { SdlcPolicy } from './sdlc-policy.js';

export type NetworkClass = 'public' | 'egress-allowlist';
export type OrgAccess = 'none' | 'read';

export interface DevboxProfile {
  id: string;
  version: number;
  /** Allowlisted inference-profile ids; the first is the default. */
  models: string[];
  task_timeout_s: number;
  idle_minutes: number;
  max_lifetime_minutes: number;
  network_class: NetworkClass;
  org_access: OrgAccess;
  created_by: string;
  reason: string;
  created_at: string;
}

/** The editable half of a profile — what `PUT /api/devbox/profiles/:id` takes. */
export type DevboxProfileInput = Pick<
  DevboxProfile, 'models' | 'task_timeout_s' | 'idle_minutes' | 'max_lifetime_minutes' | 'network_class' | 'org_access'
>;

export const DEFAULT_PROFILE_ID = 'default';
/** The microVM runner's seeded profile (schema/devbox_profiles_schema.sql). */
export const RESTRICTED_PROFILE_ID = 'restricted';
export const RESTRICTED_PROFILE_INPUT: Readonly<DevboxProfileInput> = Object.freeze({
  models: ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'us.anthropic.claude-sonnet-5'],
  task_timeout_s: 840,
  idle_minutes: 5,
  max_lifetime_minutes: 60,
  network_class: 'egress-allowlist',
  org_access: 'none',
});
export const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Version 1 of `default`, exactly as schema/devbox_profiles_schema.sql seeds
 * it: the pre-profile deployment's values. The BFF bootstraps this row when
 * the table is empty so a cluster the SQL has not reached is still governed.
 */
export const DEFAULT_PROFILE_INPUT: Readonly<DevboxProfileInput> = Object.freeze({
  models: [
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'us.anthropic.claude-sonnet-5',
    'us.anthropic.claude-opus-4-8',
  ],
  task_timeout_s: 840,
  idle_minutes: 20,
  max_lifetime_minutes: 240,
  network_class: 'public',
  org_access: 'none',
});

const NETWORK_CLASSES: readonly NetworkClass[] = ['public', 'egress-allowlist'];
const ORG_ACCESS: readonly OrgAccess[] = ['none', 'read'];
/** The shape of a Bedrock inference-profile or foundation-model id. */
const MODEL_ID_RE = /^[a-z]{2}\.[a-z0-9.-]+(?::\d+)?$|^[a-z0-9.-]+(?::\d+)?$/i;

/**
 * Parse a submitted profile body, or say why it is not one. Mirrors the
 * table's CHECK constraints so the API refuses with a sentence instead of a
 * constraint-violation error.
 */
export function parseProfileInput(raw: unknown): DevboxProfileInput | string {
  if (!raw || typeof raw !== 'object') return 'a profile object is required';
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['models']) || r['models'].length === 0) return 'models must be a non-empty array of inference-profile ids';
  const models: string[] = [];
  for (const m of r['models']) {
    if (typeof m !== 'string' || !m.trim() || !MODEL_ID_RE.test(m.trim()) || m.length > 200) return `models: "${String(m)}" is not an inference-profile id`;
    if (!models.includes(m.trim())) models.push(m.trim());
  }
  const int = (name: string, lo: number, hi: number): number | string => {
    const v = Number(r[name]);
    if (!Number.isInteger(v)) return `${name} must be an integer`;
    if (v < lo || v > hi) return `${name} must be between ${lo} and ${hi}`;
    return v;
  };
  const task = int('task_timeout_s', 60, TASK_MAX_S);
  if (typeof task === 'string') return task;
  const idle = int('idle_minutes', 1, 59);
  if (typeof idle === 'string') return idle;
  const life = int('max_lifetime_minutes', 1, 480);
  if (typeof life === 'string') return life;
  const network = r['network_class'];
  if (!NETWORK_CLASSES.includes(network as NetworkClass)) return `network_class must be one of ${NETWORK_CLASSES.join(', ')}`;
  const org = r['org_access'];
  if (!ORG_ACCESS.includes(org as OrgAccess)) return `org_access must be one of ${ORG_ACCESS.join(', ')}`;
  // The allowlist has no Aurora or knowledge-base path (docs/microvm-runner-design.md §5).
  if (network === 'egress-allowlist' && org === 'read') return 'an egress-allowlist profile cannot have org_access read: the allowlist reaches no org data';
  return {
    models, task_timeout_s: task, idle_minutes: idle, max_lifetime_minutes: life,
    network_class: network as NetworkClass, org_access: org as OrgAccess,
  };
}

export type ModelResolution =
  | { ok: true; model: string }
  | { ok: false; error: string; allowed: string[] };

/**
 * The model a task runs with: the requested one when the profile lists it,
 * the profile's first model when none was asked for, and a refusal naming
 * the allowed set otherwise. Never a silent fallback — the old container
 * behaviour, which `agents/devbox/main.py` has also stopped doing.
 */
export function resolveTaskModel(profile: Pick<DevboxProfile, 'models' | 'id' | 'version'>, requested: unknown): ModelResolution {
  const allowed = profile.models;
  const wanted = typeof requested === 'string' ? requested.trim() : '';
  if (!wanted) {
    const first = allowed[0];
    return first ? { ok: true, model: first } : { ok: false, error: `profile ${profile.id}@${profile.version} allows no model`, allowed: [] };
  }
  if (allowed.includes(wanted)) return { ok: true, model: wanted };
  return {
    ok: false,
    error: `model "${wanted}" is not allowed by profile ${profile.id}@${profile.version}; allowed: ${allowed.join(', ')}`,
    allowed: [...allowed],
  };
}

/** The lifetime numbers a profile implies (DE-48 rule 5). */
export function lifetimeOf(profile: Pick<DevboxProfile, 'idle_minutes' | 'max_lifetime_minutes' | 'task_timeout_s'>): LifetimePolicy {
  return lifetimePolicy(profile);
}

/** The tighter of two policies, field by field — how a newer, shorter version reaches a running box. */
export function tightenLifetime(stamped: LifetimePolicy, latest: LifetimePolicy): LifetimePolicy {
  return {
    idleMs: Math.min(stamped.idleMs, latest.idleMs),
    boxCeilingMs: Math.min(stamped.boxCeilingMs, latest.boxCeilingMs),
    taskDefaultS: Math.min(stamped.taskDefaultS, latest.taskDefaultS),
    taskMaxS: Math.min(stamped.taskMaxS, latest.taskMaxS),
    graceMs: Math.min(stamped.graceMs, latest.graceMs),
  };
}

/**
 * DE-40 change 4: when the pinned SDLC policy set carries no explicit
 * `model_allowlist` row, the profile's list is the rule — so review and
 * dispatch agree about which models may author a change that ships. A set
 * that has its own row is left alone; an explicit policy wins.
 *
 * The derived row routes to a person (`require_approval`), it never
 * hard-blocks: changes also come from runners that never went through devbox
 * dispatch (an AgentCore Nova run, a run whose model was not recorded), and
 * an inferred rule must not refuse what an operator never wrote a rule
 * against. An explicit `model_allowlist` row with `action: 'block'` still
 * blocks a known, unlisted model.
 */
export function withProfileModelAllowlist(policies: readonly SdlcPolicy[], profile: Pick<DevboxProfile, 'models' | 'id' | 'version'> | null): SdlcPolicy[] {
  if (!profile || policies.some((p) => p.kind === 'model_allowlist')) return [...policies];
  return [...policies, {
    id: `profile-${profile.id}-models`,
    name: `Models allowed by devbox profile ${profile.id}@${profile.version}`,
    enabled: true,
    kind: 'model_allowlist',
    config: { models: [...profile.models] },
    action: 'require_approval',
  }];
}

// ─── Resolution (async; reaches the provider) ────────────────────────────────

async function provider() {
  return import('../providers/devbox-profiles.js');
}

/** The current version of a profile id, or null. */
export async function latestProfile(id: string): Promise<DevboxProfile | null> {
  try {
    const p = await provider();
    return await p.latestProfile(id);
  } catch (err) {
    storeDown(err);
    return null;
  }
}

/**
 * `default` v1 from code, for when the profile store cannot be reached at all
 * (the provider failed to load, or Aurora threw). The pre-profile values are
 * the conservative answer: a store outage must not 500 every task, and must
 * not widen anything either.
 */
export function inCodeDefaultProfile(): DevboxProfile {
  return {
    id: DEFAULT_PROFILE_ID, version: 1, ...DEFAULT_PROFILE_INPUT, models: [...DEFAULT_PROFILE_INPUT.models],
    created_by: 'seed', reason: 'in-code default (profile store unreachable)', created_at: '',
  };
}

let storeWarned = false;
function storeDown(err: unknown): DevboxProfile {
  if (!storeWarned) {
    storeWarned = true;
    console.warn('[devbox-profile] profile store unreachable — using the in-code default:', (err as Error)?.message ?? err);
  }
  return inCodeDefaultProfile();
}

/** The profile an initiative's boxes are created under: its own, else `default`. */
export async function profileForInitiative(projectId: string | null | undefined): Promise<DevboxProfile> {
  try {
    return await profileForInitiativeFromStore(projectId);
  } catch (err) {
    return storeDown(err);
  }
}

async function profileForInitiativeFromStore(projectId: string | null | undefined): Promise<DevboxProfile> {
  const p = await provider();
  if (projectId) {
    const id = await p.initiativeProfileId(projectId);
    if (id) {
      const own = await p.latestProfile(id);
      if (own) return own;
      console.warn(`[devbox-profile] initiative ${projectId} names profile ${id}, which has no version — using default`);
    }
  }
  return p.ensureDefaultProfile();
}

/**
 * The profile a box runs under. A box that recorded one keeps THAT version
 * (a running box never changes rules); a box with none — minted before
 * profiles existed, or adopted — resolves through its initiative. Null is a
 * box the registry has not seen: it gets the default.
 */
export async function profileForBox(box: Pick<FleetBox, 'profileId' | 'profileVersion' | 'projectId'> | null): Promise<DevboxProfile> {
  if (box?.profileId && box.profileVersion) {
    let pinned: DevboxProfile | null;
    try {
      pinned = await (await provider()).getProfileVersion(box.profileId, box.profileVersion);
    } catch (err) {
      return storeDown(err);
    }
    if (pinned) return pinned;
    console.warn(`[devbox-profile] box names ${box.profileId}@${box.profileVersion}, which does not exist — resolving by initiative`);
  }
  return profileForInitiative(box?.projectId ?? null);
}

/**
 * The lifetime policy of every box the reaper is about to judge: the stamped
 * version's numbers, tightened by the latest version's where it shrank
 * (DE-40 decision: new boxes get a new version; a running box only ever gets
 * the shorter of the two). Boxes sharing a profile share one lookup.
 */
export async function lifetimePoliciesFor(boxes: readonly FleetBox[]): Promise<Map<string, LifetimePolicy>> {
  const out = new Map<string, LifetimePolicy>();
  const byProfile = new Map<string, LifetimePolicy>();
  for (const box of boxes) {
    const key = `${box.profileId ?? ''}@${box.profileVersion ?? ''}#${box.projectId ?? ''}`;
    let policy = byProfile.get(key);
    if (!policy) {
      try {
        const stamped = await profileForBox(box);
        const latest = await latestProfile(stamped.id);
        policy = latest && latest.version !== stamped.version
          ? tightenLifetime(lifetimeOf(stamped), lifetimeOf(latest))
          : lifetimeOf(stamped);
      } catch (err) {
        // The reaper must not stop sweeping because a lookup failed; the
        // deployment default is the conservative answer.
        console.warn('[devbox-profile] could not resolve a box profile for the reaper:', (err as Error).message);
        policy = lifetimePolicy();
      }
      byProfile.set(key, policy);
    }
    out.set(box.id, policy);
  }
  return out;
}

/** `(id, version)` as a fleet-row stamp. */
export function profileStamp(profile: Pick<DevboxProfile, 'id' | 'version'>): { id: string; version: number } {
  return { id: profile.id, version: profile.version };
}
