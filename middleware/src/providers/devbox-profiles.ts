// Devbox policy profiles as versioned data (DE-40): storage only.
//
// A version is one row of `devbox_profiles`; an edit appends (id, version+1)
// and the primary key is what makes a concurrent edit lose, not a
// read-then-write. `projects.devbox_profile_id` points an initiative at an id
// (never a version: a box pins the version it was created under on its own
// fleet row). Who may write is decided at the routes
// (routes/devbox-profiles.ts, routes/projects.ts); this file only stores.
//
// Degradation: a cluster this schema has not reached answers "no profile",
// which every reader turns into the bootstrapped `default`.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import {
  DEFAULT_PROFILE_ID, DEFAULT_PROFILE_INPUT, type DevboxProfile, type DevboxProfileInput,
} from '../lib/devbox-profile.js';
import {
  mockLatestProfile, mockGetProfileVersion, mockListProfiles, mockListProfileVersions, mockInsertProfileVersion,
} from '../mock/devbox-profiles.js';
import { initiatives } from '../mock/initiatives.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function n(name: string, value: number): SqlParameter { return { name, value: { longValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
const toStr = (v: unknown, f = ''): string => (typeof v === 'string' ? v : v == null ? f : String(v));
const toNum = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

function parseModels(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') { try { const p = JSON.parse(v) as unknown; return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
}

function rowToProfile(r: Record<string, unknown>): DevboxProfile {
  return {
    id: toStr(r['id']),
    version: toNum(r['version']),
    models: parseModels(r['models']),
    task_timeout_s: toNum(r['task_timeout_s']),
    idle_minutes: toNum(r['idle_minutes']),
    max_lifetime_minutes: toNum(r['max_lifetime_minutes']),
    network_class: toStr(r['network_class'], 'public') as DevboxProfile['network_class'],
    org_access: toStr(r['org_access'], 'none') as DevboxProfile['org_access'],
    created_by: toStr(r['created_by']),
    reason: toStr(r['reason']),
    created_at: toStr(r['created_at']),
  };
}

/** A missing table is "no rows", never a crash: the reader bootstraps `default`. */
async function query(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  try {
    return await exec(sql, params);
  } catch (err) {
    if (/relation .*devbox_profiles.* does not exist|column .*devbox_profile_id.* does not exist/i.test((err as Error).message ?? '')) {
      console.warn('[devbox-profiles] schema/devbox_profiles_schema.sql has not been applied — profiles fall back to default');
      return [];
    }
    throw err;
  }
}

export async function latestProfile(id: string): Promise<DevboxProfile | null> {
  if (config.mock.aurora) return mockLatestProfile(id);
  const rows = await query(`SELECT * FROM devbox_profiles WHERE id = :id ORDER BY version DESC LIMIT 1`, [s('id', id)]);
  return rows[0] ? rowToProfile(rows[0]) : null;
}

export async function getProfileVersion(id: string, version: number): Promise<DevboxProfile | null> {
  if (config.mock.aurora) return mockGetProfileVersion(id, version);
  const rows = await query(`SELECT * FROM devbox_profiles WHERE id = :id AND version = :v`, [s('id', id), n('v', version)]);
  return rows[0] ? rowToProfile(rows[0]) : null;
}

/** The latest version of every profile id. */
export async function listProfiles(): Promise<DevboxProfile[]> {
  if (config.mock.aurora) return mockListProfiles();
  const rows = await query(
    `SELECT DISTINCT ON (id) * FROM devbox_profiles ORDER BY id, version DESC`,
  );
  return rows.map(rowToProfile);
}

export async function listProfileVersions(id: string): Promise<DevboxProfile[]> {
  if (config.mock.aurora) return mockListProfileVersions(id);
  const rows = await query(`SELECT * FROM devbox_profiles WHERE id = :id ORDER BY version DESC LIMIT 200`, [s('id', id)]);
  return rows.map(rowToProfile);
}

async function insertVersion(input: Omit<DevboxProfile, 'created_at'>): Promise<DevboxProfile | null> {
  if (config.mock.aurora) return mockInsertProfileVersion(input);
  const rows = await exec(
    `INSERT INTO devbox_profiles
       (id, version, models, task_timeout_s, idle_minutes, max_lifetime_minutes, network_class, org_access, created_by, reason)
     VALUES (:id, :v, :models::jsonb, :task, :idle, :life, :network, :org, :by, :reason)
     ON CONFLICT (id, version) DO NOTHING RETURNING *`,
    [s('id', input.id), n('v', input.version), s('models', JSON.stringify(input.models)),
      n('task', input.task_timeout_s), n('idle', input.idle_minutes), n('life', input.max_lifetime_minutes),
      s('network', input.network_class), s('org', input.org_access), s('by', input.created_by), s('reason', input.reason)],
  );
  return rows[0] ? rowToProfile(rows[0]) : null;
}

/**
 * The `default` profile, bootstrapping ('default', 1) from the pre-profile
 * deployment values when there is none — the row the SQL seeds, written lazily
 * so an environment the schema has not reached is still governed. Idempotent
 * under a race: the loser's insert conflicts and it re-reads.
 */
export async function ensureDefaultProfile(): Promise<DevboxProfile> {
  const current = await latestProfile(DEFAULT_PROFILE_ID);
  if (current) return current;
  const inserted = await insertVersion({
    id: DEFAULT_PROFILE_ID, version: 1, ...DEFAULT_PROFILE_INPUT, models: [...DEFAULT_PROFILE_INPUT.models],
    created_by: 'seed', reason: 'Seeded from the pre-profile deployment values (DE-40).',
  }).catch((err: Error) => {
    // No table at all: govern from the in-code default rather than fail every task.
    console.warn('[devbox-profiles] could not bootstrap default:', err.message);
    return null;
  });
  return inserted ?? (await latestProfile(DEFAULT_PROFILE_ID)) ?? {
    id: DEFAULT_PROFILE_ID, version: 1, ...DEFAULT_PROFILE_INPUT, models: [...DEFAULT_PROFILE_INPUT.models],
    created_by: 'seed', reason: 'in-code default (devbox_profiles table absent)', created_at: '',
  };
}

/**
 * Append the next version of a profile. `baseVersion` is the version the
 * editor started from (0 for a new id); anything but the current one is a
 * conflict, answered with the current version so the client can re-base.
 */
export async function writeProfileVersion(input: {
  id: string; profile: DevboxProfileInput; baseVersion: number; changedBy: string; reason: string;
}): Promise<{ ok: true; profile: DevboxProfile } | { ok: false; conflict: true; currentVersion: number }> {
  const current = input.id === DEFAULT_PROFILE_ID ? await ensureDefaultProfile() : await latestProfile(input.id);
  const currentVersion = current?.version ?? 0;
  if (input.baseVersion !== currentVersion) return { ok: false, conflict: true, currentVersion };
  const inserted = await insertVersion({
    id: input.id, version: currentVersion + 1, ...input.profile, models: [...input.profile.models],
    created_by: input.changedBy, reason: input.reason,
  });
  if (!inserted) return { ok: false, conflict: true, currentVersion: (await latestProfile(input.id))?.version ?? currentVersion };
  return { ok: true, profile: inserted };
}

// ─── Initiative → profile ────────────────────────────────────────────────────

/** `projects.devbox_profile_id` for an initiative; null = default (or no such initiative). */
export async function initiativeProfileId(projectId: string): Promise<string | null> {
  if (config.mock.aurora) return initiatives.rows().find((p) => p.id === projectId)?.devboxProfileId ?? null;
  const rows = await query(`SELECT devbox_profile_id FROM projects WHERE id = :id`, [s('id', projectId)]);
  const v = rows[0]?.['devbox_profile_id'];
  return v == null || v === '' ? null : String(v);
}

export type ProfileAssignResult =
  | { ok: true }
  | { ok: false; status: 404 | 503; error: string };

/** Point an initiative at a profile id (null clears it back to default). The caller has checked the id exists. */
export async function setInitiativeProfile(projectId: string, profileId: string | null): Promise<ProfileAssignResult> {
  if (config.mock.aurora) {
    const row = initiatives.rows().find((p) => p.id === projectId);
    if (!row) return { ok: false, status: 404, error: 'Project not found' };
    row.devboxProfileId = profileId;
    return { ok: true };
  }
  try {
    const rows = await exec(
      `UPDATE projects SET devbox_profile_id = :pid WHERE id = :id RETURNING id`,
      [s('id', projectId), profileId == null ? nul('pid') : s('pid', profileId)],
    );
    if (rows.length === 0) return { ok: false, status: 404, error: 'Project not found' };
    return { ok: true };
  } catch (err) {
    if (/devbox_profile_id.*does not exist|column.*does not exist/i.test((err as Error).message ?? '')) {
      return { ok: false, status: 503, error: 'projects.devbox_profile_id is missing — apply schema/devbox_profiles_schema.sql first' };
    }
    throw err;
  }
}
