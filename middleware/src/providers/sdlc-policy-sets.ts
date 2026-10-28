// SDLC policy as versioned, per-initiative data (DE-46), and the loosening
// proposals that wait for a second person (DE-43).
//
// A version is a snapshot of a whole policy set — a handful of rows — so the
// audit trail is a diff of two snapshots, a revert is a new version copying an
// old one, and a change pinned to `(scope, version)` keeps being judged by the
// rules it was captured under. `scope` is `'org'` or an initiative id
// (`projects.id`). Writes append; nothing here updates or deletes a version.
//
// Who may write is not decided here: lib/sdlc-policy-governance.ts holds the
// route-side rules (org-wide role for `org`, steward for an initiative, the
// self-gate, the two-person rule). This file only stores.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { DEFAULT_POLICIES, type SdlcPolicy } from '../lib/sdlc-policy.js';
import {
  defaultPolicySet, mockLatestPolicyVersion, mockGetPolicyVersion, mockListPolicyVersions,
  mockHasPolicyScope, mockInsertPolicyVersion, mockCreatePolicyProposal, mockGetPolicyProposal,
  mockListPolicyProposals, mockDecidePolicyProposal,
} from '../mock/sdlc.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function n(name: string, value: number): SqlParameter { return { name, value: { longValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

export const ORG_SCOPE = 'org';

export interface PolicySetVersion {
  scope: string;
  version: number;
  policies: SdlcPolicy[];
  basedOn: number | null;
  changedBy: string;
  reason: string;
  createdAt: string;
}

function rowToVersion(r: Record<string, unknown>): PolicySetVersion {
  return {
    scope: toStr(r['scope']),
    version: toNum(r['version']),
    policies: parseJson<SdlcPolicy[]>(r['policies'], []),
    basedOn: r['based_on'] == null ? null : toNum(r['based_on']),
    changedBy: toStr(r['changed_by']),
    reason: toStr(r['reason']),
    createdAt: toStr(r['created_at']),
  };
}

/** The current version of a scope, or null when the scope has none. */
export async function latestPolicySet(scope: string): Promise<PolicySetVersion | null> {
  if (config.mock.aurora) return mockLatestPolicyVersion(scope);
  const rows = await exec(
    `SELECT * FROM sdlc_policy_versions WHERE scope = :scope ORDER BY version DESC LIMIT 1`,
    [s('scope', scope)],
  );
  return rows[0] ? rowToVersion(rows[0]) : null;
}

export async function getPolicySetVersion(scope: string, version: number): Promise<PolicySetVersion | null> {
  if (config.mock.aurora) return mockGetPolicyVersion(scope, version);
  const rows = await exec(
    `SELECT * FROM sdlc_policy_versions WHERE scope = :scope AND version = :v`,
    [s('scope', scope), n('v', version)],
  );
  return rows[0] ? rowToVersion(rows[0]) : null;
}

/** Every version of a scope, newest first — the history with author, reason, time. */
export async function listPolicySetVersions(scope: string): Promise<PolicySetVersion[]> {
  if (config.mock.aurora) return mockListPolicyVersions(scope);
  const rows = await exec(
    `SELECT * FROM sdlc_policy_versions WHERE scope = :scope ORDER BY version DESC LIMIT 200`,
    [s('scope', scope)],
  );
  return rows.map(rowToVersion);
}

/**
 * Insert `version` for a scope. Null when that version already exists: the
 * primary key is what makes a concurrent edit lose, not a read-then-write.
 */
async function insertVersion(input: Omit<PolicySetVersion, 'createdAt'>): Promise<PolicySetVersion | null> {
  if (config.mock.aurora) return mockInsertPolicyVersion(input);
  const rows = await exec(
    `INSERT INTO sdlc_policy_versions (scope, version, policies, based_on, changed_by, reason)
     VALUES (:scope, :v, :policies::jsonb, :based, :by, :reason)
     ON CONFLICT (scope, version) DO NOTHING RETURNING *`,
    [s('scope', input.scope), n('v', input.version), s('policies', JSON.stringify(input.policies)),
      input.basedOn == null ? nul('based') : n('based', input.basedOn), s('by', input.changedBy), s('reason', input.reason)],
  );
  return rows[0] ? rowToVersion(rows[0]) : null;
}

/**
 * The org set, bootstrapping `('org', 1)` when there is none — the migration
 * DE-46 describes, run lazily so an environment the script has not reached is
 * still governed. Version 1 is the existing `sdlc_policies` rows (their ids
 * become the keys), or `DEFAULT_POLICIES` when that table is empty or absent.
 * Idempotent under a race: the loser's insert conflicts and it re-reads.
 */
export async function ensureOrgPolicySet(): Promise<PolicySetVersion> {
  const current = await latestPolicySet(ORG_SCOPE);
  if (current) return current;
  let policies: SdlcPolicy[];
  if (config.mock.aurora) {
    policies = defaultPolicySet();
  } else {
    let legacy: SdlcPolicy[] = [];
    try {
      const rows = await exec(`SELECT * FROM sdlc_policies ORDER BY created_at`);
      legacy = rows.map((r) => ({
        id: toStr(r['id']), name: toStr(r['name']),
        enabled: r['enabled'] === true || r['enabled'] === 'true',
        kind: toStr(r['kind']) as SdlcPolicy['kind'],
        config: parseJson<Record<string, unknown>>(r['config'], {}),
        action: toStr(r['action'], 'require_approval') as SdlcPolicy['action'],
      }));
    } catch { /* no legacy table: the defaults below */ }
    policies = legacy.length > 0 ? legacy : DEFAULT_POLICIES.map((p, i) => ({ ...p, id: `default-${i + 1}` }));
  }
  const inserted = await insertVersion({
    scope: ORG_SCOPE, version: 1, policies, basedOn: null,
    changedBy: 'migration', reason: 'Migrated from sdlc_policies (DE-46).',
  });
  return inserted ?? (await latestPolicySet(ORG_SCOPE))!;
}

/** The scope a change on this initiative resolves to: the initiative's own set if it has one, else `org`. */
export async function resolvePolicyScope(orgProjectId: string | null): Promise<string> {
  if (!orgProjectId) return ORG_SCOPE;
  if (config.mock.aurora) return mockHasPolicyScope(orgProjectId) ? orgProjectId : ORG_SCOPE;
  const rows = await exec(`SELECT 1 FROM sdlc_policy_versions WHERE scope = :scope LIMIT 1`, [s('scope', orgProjectId)]);
  return rows.length > 0 ? orgProjectId : ORG_SCOPE;
}

/**
 * Append the next version of a scope. `baseVersion` is the version the editor
 * started from (0 for a scope with none yet); anything but the current one is
 * a conflict, answered with the current version so the client can re-base.
 */
export async function writePolicySet(input: {
  scope: string; policies: SdlcPolicy[]; baseVersion: number; changedBy: string; reason: string;
}): Promise<{ ok: true; version: PolicySetVersion } | { ok: false; conflict: true; currentVersion: number }> {
  const current = input.scope === ORG_SCOPE ? await ensureOrgPolicySet() : await latestPolicySet(input.scope);
  const currentVersion = current?.version ?? 0;
  if (input.baseVersion !== currentVersion) return { ok: false, conflict: true, currentVersion };
  const inserted = await insertVersion({
    scope: input.scope, version: currentVersion + 1, policies: input.policies,
    basedOn: current ? currentVersion : null, changedBy: input.changedBy, reason: input.reason,
  });
  if (!inserted) return { ok: false, conflict: true, currentVersion: (await latestPolicySet(input.scope))?.version ?? currentVersion };
  return { ok: true, version: inserted };
}

// ─── Loosening proposals (DE-43 §4) ─────────────────────────────────────────

export interface PolicyProposal {
  id: string;
  scope: string;
  baseVersion: number;
  policies: SdlcPolicy[];
  /** Why this edit is loosening, one sentence per change. */
  loosening: string[];
  proposedBy: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedVersion: number | null;
  createdAt: string;
}

function rowToProposal(r: Record<string, unknown>): PolicyProposal {
  return {
    id: toStr(r['id']),
    scope: toStr(r['scope']),
    baseVersion: toNum(r['base_version']),
    policies: parseJson<SdlcPolicy[]>(r['policies'], []),
    loosening: parseJson<string[]>(r['loosening'], []),
    proposedBy: toStr(r['proposed_by']),
    reason: toStr(r['reason']),
    status: toStr(r['status'], 'pending') as PolicyProposal['status'],
    decidedBy: r['decided_by'] ? toStr(r['decided_by']) : null,
    decidedAt: r['decided_at'] ? toStr(r['decided_at']) : null,
    decisionNote: r['decision_note'] ? toStr(r['decision_note']) : null,
    appliedVersion: r['applied_version'] == null ? null : toNum(r['applied_version']),
    createdAt: toStr(r['created_at']),
  };
}

export async function createPolicyProposal(input: {
  scope: string; baseVersion: number; policies: SdlcPolicy[]; loosening: string[]; proposedBy: string; reason: string;
}): Promise<PolicyProposal> {
  if (config.mock.aurora) return mockCreatePolicyProposal(input);
  const rows = await exec(
    `INSERT INTO sdlc_policy_proposals (scope, base_version, policies, loosening, proposed_by, reason)
     VALUES (:scope, :base, :policies::jsonb, :loosening::jsonb, :by, :reason) RETURNING *`,
    [s('scope', input.scope), n('base', input.baseVersion), s('policies', JSON.stringify(input.policies)),
      s('loosening', JSON.stringify(input.loosening)), s('by', input.proposedBy), s('reason', input.reason)],
  );
  return rowToProposal(rows[0]!);
}

export async function getPolicyProposal(id: string): Promise<PolicyProposal | null> {
  if (config.mock.aurora) return mockGetPolicyProposal(id);
  if (!isUuid(id)) return null;
  const rows = await exec(`SELECT * FROM sdlc_policy_proposals WHERE id = :id::uuid`, [s('id', id)]);
  return rows[0] ? rowToProposal(rows[0]) : null;
}

export async function listPolicyProposals(opts: { scope?: string; status?: string } = {}): Promise<PolicyProposal[]> {
  if (config.mock.aurora) return mockListPolicyProposals(opts);
  const where: string[] = [];
  const params: SqlParameter[] = [];
  if (opts.scope) { where.push('scope = :scope'); params.push(s('scope', opts.scope)); }
  if (opts.status) { where.push('status = :status'); params.push(s('status', opts.status)); }
  const rows = await exec(
    `SELECT * FROM sdlc_policy_proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(rowToProposal);
}

/** Close a pending proposal; false when it was no longer pending (someone else decided first). */
export async function closePolicyProposal(id: string, patch: {
  status: 'approved' | 'rejected' | 'superseded'; decidedBy: string; decisionNote: string | null; appliedVersion: number | null;
}): Promise<boolean> {
  if (config.mock.aurora) return mockDecidePolicyProposal(id, patch);
  const rows = await exec(
    `UPDATE sdlc_policy_proposals
        SET status = :status, decided_by = :by, decided_at = NOW(), decision_note = :note, applied_version = :applied
      WHERE id = :id::uuid AND status = 'pending' RETURNING id`,
    [s('id', id), s('status', patch.status), s('by', patch.decidedBy),
      patch.decisionNote ? s('note', patch.decisionNote) : nul('note'),
      patch.appliedVersion == null ? nul('applied') : n('applied', patch.appliedVersion)],
  );
  return rows.length > 0;
}
