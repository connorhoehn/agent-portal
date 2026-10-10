// Session bundles — what a Claude Code devbox session is actually running.
//
// Today the whole mechanism is agents/devbox/managed-settings.json baked into
// the image at build time: one SessionStart hook (`lab recall`) and nothing
// else visible. That works, but it is invisible from the portal, it can only
// change via an image rebuild + redeploy, and nobody can tell which skills a
// RUNNING session actually has versus what the library has moved on to. This
// is the release surface for that gap: hooks, bundled skills, config, and the
// drift between what shipped and what the library now holds.
//
// A SessionStart hook is the highest-blast-radius thing in this product — it
// runs unattended on every single session start, fleet-wide, with no human in
// the loop. That is why publish is gated harder than anything else the
// Release phase ships: an approver, a proven dry run, and a structural ban on
// unpinned commands, enforced in decidePublish() rather than left to whoever
// clicks the button.
//
// Mock-first, like design-reviews and prompt-library: publishBundle() mutates
// in-memory state so approve → dry-run → publish → supersede all actually
// happen in a dev session with no Aurora.

import { config } from '../config.js';
// Stamps come from the one clock so a publish is pinnable under freezeClock.
import { clock } from '../mock/core/index.js';
import { MOCK_LIBRARY_VERSIONS, sessionBundles } from '../mock/session-bundle.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface SessionHook {
  event: HookEvent;
  command: string;
  description: string;
  enabled: boolean;
}

export type SkillStatus = 'current' | 'stale' | 'missing';

export interface BundledSkill {
  id: string;
  name: string;
  description: string;
  /** The version this bundle shipped — compared against the library's current
   *  version to derive `status` fresh on every read, never trusted at rest. */
  version: string;
  source: 'library' | 'baked';
  status: SkillStatus;
}

export type BundleStatus = 'live' | 'pending' | 'superseded';

export interface SessionBundle {
  id: string;
  version: string;
  publishedAt: string;
  publishedBy: string;
  hooks: SessionHook[];
  skills: BundledSkill[];
  settings: Record<string, string | boolean | number>;
  /** Box ids this bundle targets, or the literal `'fleet'` for every box. */
  appliesTo: string[];
  status: BundleStatus;
}

// ─── Pure decision rules (unit-tested) ───────────────────────────────────────

/** Newer wins. Library and bundle versions are both the flat integer strings
 *  the library already uses ('1', '2', '3', ...) — no semver here. */
function skillStatus(bundledVersion: string, libraryVersion: string | undefined): SkillStatus {
  if (libraryVersion == null) return 'missing'; // library dropped this skill entirely — an orphan the bundle still ships
  return Number(libraryVersion) > Number(bundledVersion) ? 'stale' : 'current';
}

/**
 * Which bundled skills the library has moved past, and which library skills
 * this bundle never picked up. Both directions matter: `stale` is "this
 * session is running an old copy", `missing` is "this session was never told
 * about it at all" — the two shapes of "why does my session not know X".
 */
export function bundleDrift(
  bundle: Pick<SessionBundle, 'skills'>,
  libraryVersions: Record<string, string>,
): { stale: BundledSkill[]; missing: string[] } {
  const stale = bundle.skills.filter((s) => skillStatus(s.version, libraryVersions[s.id]) === 'stale');
  const bundledIds = new Set(bundle.skills.map((s) => s.id));
  const missing = Object.keys(libraryVersions).filter((id) => !bundledIds.has(id));
  return { stale, missing };
}

/** A SessionStart hook whose command isn't pinned to a fixed script/version —
 *  a `curl … | sh` or an `@latest` install — silently changes behavior for
 *  every session on the next run of whatever it fetches, with no diff to
 *  review. Structural ban, not a judgment call. */
function isUnpinnedCommand(command: string): boolean {
  return /\|\s*(sudo\s+)?(ba)?sh\b/i.test(command) || /@latest\b/i.test(command);
}

export interface PublishContext {
  /** True once the dry-run box has actually been observed firing this
   *  bundle's hooks — a box merely being *picked* for the dry run does not
   *  prove SessionStart ran there (an existing session could be reused). */
  hasHooks: boolean;
  approvedBy: string | null;
  dryRunBoxId: string | null;
}

export type PublishDecision = { ok: true } | { ok: false; reason: string };

/**
 * May this bundle ship to the fleet?
 *
 * Order matters: the unpinned-command check runs first and is unconditional
 * — no dry run or approver can buy back a hook that fetches unpinned code on
 * every session start. The other two gates are the ordinary release
 * discipline: prove it on one box before every box, and name a human who
 * signed off on shipping it.
 */
export function decidePublish(
  bundle: Pick<SessionBundle, 'hooks'>,
  ctx: PublishContext,
): PublishDecision {
  const sessionStartHooks = bundle.hooks.filter((h) => h.event === 'SessionStart' && h.enabled);
  const unpinned = sessionStartHooks.find((h) => isUnpinnedCommand(h.command));
  if (unpinned) {
    return {
      ok: false,
      reason: `SessionStart hook runs an unpinned command ("${unpinned.command}") — this executes on every session start fleet-wide; pin it before publishing`,
    };
  }
  if (!ctx.dryRunBoxId) {
    return { ok: false, reason: 'no dry run yet — verify this bundle on at least one box before it reaches the fleet' };
  }
  if (sessionStartHooks.length > 0 && !ctx.hasHooks) {
    return { ok: false, reason: 'the dry run box has not confirmed the SessionStart hook actually fired — verify it before publishing' };
  }
  if (!ctx.approvedBy) {
    return { ok: false, reason: 'no approver — a fleet-wide publish needs someone named to have signed off' };
  }
  return { ok: true };
}

const LIVE_BOX_STATUSES: ReadonlySet<string> = new Set(['provisioning', 'idle', 'running', 'waiting']);

/**
 * How many live sessions a publish would restart. `appliesTo` of `'fleet'`
 * means every box currently live; otherwise only the boxes named. Publishing
 * blind — with no idea how many sessions are about to reload their config —
 * is the failure mode this exists to prevent before the confirm dialog, not after.
 */
export function sessionsAffected(
  bundle: Pick<SessionBundle, 'appliesTo'>,
  boxes: Array<{ id: string; status: string }>,
): number {
  const fleetWide = bundle.appliesTo.includes('fleet');
  return boxes.filter((b) => LIVE_BOX_STATUSES.has(b.status) && (fleetWide || bundle.appliesTo.includes(b.id))).length;
}

// ─── Mock state ──────────────────────────────────────────────────────────────
//
// The bundles themselves live in mock/session-bundle.ts, behind a registered
// fixture, so a publish — which supersedes the live bundle, not just the one
// it names — is undone by `POST /api/__mock/reset`.

/** One bundle as it is stored: `status` per skill is derived, never held. */
export interface RawSkill {
  id: string; name: string; description: string; version: string; source: 'library' | 'baked';
}

export interface RawBundle {
  id: string; version: string; publishedAt: string; publishedBy: string;
  hooks: SessionHook[]; skills: RawSkill[];
  settings: Record<string, string | boolean | number>;
  appliesTo: string[]; status: BundleStatus;
}

function toBundle(raw: RawBundle): SessionBundle {
  return {
    id: raw.id, version: raw.version, publishedAt: raw.publishedAt, publishedBy: raw.publishedBy,
    hooks: raw.hooks,
    skills: raw.skills.map((s) => ({ ...s, status: skillStatus(s.version, MOCK_LIBRARY_VERSIONS[s.id]) })),
    settings: raw.settings,
    appliesTo: raw.appliesTo,
    status: raw.status,
  };
}

// ─── Provider ────────────────────────────────────────────────────────────────

export async function listBundles(): Promise<SessionBundle[]> {
  // Aurora path not yet built — mock-first like the rest of Release. void
  // config to keep the shape honest about what's actually wired.
  void config;
  return sessionBundles.rows().slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(toBundle);
}

export async function getLiveBundle(): Promise<SessionBundle | null> {
  const raw = sessionBundles.rows().find((b) => b.status === 'live');
  return raw ? toBundle(raw) : null;
}

export async function getBundle(id: string): Promise<SessionBundle | null> {
  const raw = sessionBundles.rows().find((b) => b.id === id);
  return raw ? toBundle(raw) : null;
}

/**
 * Publish a bundle to the fleet. Refused per decidePublish(); on success the
 * previously-live bundle supersedes and this one takes its place — exactly
 * the transition a rollback would need to reverse, which is why `superseded`
 * is a status rather than a deletion.
 */
export async function publishBundle(
  id: string, ctx: PublishContext,
): Promise<{ ok: true; bundle: SessionBundle } | { ok: false; reason: string } | null> {
  const rows = sessionBundles.rows();
  const raw = rows.find((b) => b.id === id);
  if (!raw) return null;

  const decision = decidePublish(raw, ctx);
  if (!decision.ok) return decision;

  for (const b of rows) {
    if (b.status === 'live') b.status = 'superseded';
  }
  raw.status = 'live';
  raw.publishedAt = clock.nowIso();
  if (ctx.approvedBy) raw.publishedBy = ctx.approvedBy;

  return { ok: true, bundle: toBundle(raw) };
}
