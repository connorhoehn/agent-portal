// FlowRunStore: durable run state for agentic flows, any tenant. Aurora
// `flow_runs` (schema/flow_runs_schema.sql) or the registered mock fixture.
// ⚠️ The Aurora SQL has not run against a live cluster; tests assert its shape
// and run one contract against the fixture.
//
// Guarantees the callers rely on:
//   - claim() hands a queued run to exactly one owner (SQL: FOR UPDATE SKIP
//     LOCKED inside a single UPDATE; fixture: synchronous check-and-set).
//   - progress()/finish() are fenced on the lease owner, so a node that lost its
//     lease cannot overwrite the run its replacement is executing.
//   - reads for a person go through getFor(), which filters on the requester.

import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../config.js';
import { clock } from '../../mock/core/index.js';
import { WAITING_APPROVAL, flowRunsFixture, type FlowRunRow, type FlowRunStep } from '../../mock/flow-runs.js';
import { exec } from '../../providers/aurora.js';
import { emitFlowRunMove } from './events.js';

export type { FlowRunRow, FlowRunStep };
export { isWaitingApproval } from '../../mock/flow-runs.js';
const waiting: FlowRunRow['status'] = WAITING_APPROVAL;

export interface NewFlowRun {
  tenant: string; kind: string; requestedBy: string; scope: string;
  input: Record<string, unknown> | null; progress?: FlowRunStep[]; maxAttempts?: number; idPrefix?: string;
}

const str = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const maybe = (name: string, value: string | null | undefined): SqlParameter =>
  value == null ? { name, value: { isNull: true } } : str(name, value);
const int = (name: string, value: number): SqlParameter => ({ name, value: { longValue: Math.trunc(value) } });
const json = (name: string, value: unknown): SqlParameter =>
  value == null ? { name, value: { isNull: true } } : { name, value: { stringValue: JSON.stringify(value) } };
const parse = <T>(raw: unknown, fallback: T): T => {
  if (raw == null) return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
};
const iso = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const COLS = `id, tenant, kind, requested_by, scope, status, progress::text AS progress, input::text AS input,
  result::text AS result, meta::text AS meta, error, attempts, max_attempts, lease_owner,
  ${iso('lease_expires_at')} AS lease_expires_at, ${iso('created_at')} AS created_at,
  ${iso('updated_at')} AS updated_at, ${iso('finished_at')} AS finished_at`;

const orNull = (v: unknown): string | null => (v == null ? null : String(v));
const fromRow = (r: Record<string, unknown>): FlowRunRow => ({
  id: String(r['id']), tenant: String(r['tenant']), kind: String(r['kind']), requestedBy: String(r['requested_by']),
  scope: String(r['scope'] ?? ''), status: String(r['status']) as FlowRunRow['status'],
  progress: parse<FlowRunStep[]>(r['progress'], []), input: parse<Record<string, unknown> | null>(r['input'], null),
  result: parse<unknown>(r['result'], null), meta: parse<Record<string, unknown>>(r['meta'], {}),
  error: orNull(r['error']), attempts: Number(r['attempts']), maxAttempts: Number(r['max_attempts']),
  leaseOwner: orNull(r['lease_owner']), leaseExpiresAt: orNull(r['lease_expires_at']),
  createdAt: String(r['created_at']), updatedAt: String(r['updated_at']), finishedAt: orNull(r['finished_at']),
});

const mock = (): boolean => config.mock.aurora;
const rows = (): FlowRunRow[] => flowRunsFixture.rows();
const nowMs = (): number => clock.now().getTime();
const KEY_RE = /^[a-z][A-Za-z0-9]{0,39}$/;
const LEASE_EXPIRED = 'The worker lost its lease and the run could not be retried.';

export const flowRunStore = {
  async create(n: NewFlowRun): Promise<FlowRunRow> {
    const id = `${n.idPrefix ?? 'flow'}-${randomUUID()}`;
    const progress = n.progress ?? [];
    const maxAttempts = Math.max(1, n.maxAttempts ?? 1);
    if (mock()) {
      const at = clock.nowIso();
      const row: FlowRunRow = {
        id, tenant: n.tenant, kind: n.kind, requestedBy: n.requestedBy, scope: n.scope, status: 'queued', progress,
        input: n.input, result: null, meta: {}, error: null, attempts: 0, maxAttempts, leaseOwner: null,
        leaseExpiresAt: null, createdAt: at, updatedAt: at, finishedAt: null,
      };
      rows().push(row);
      return structuredClone(row);
    }
    const out = await exec(
      `INSERT INTO flow_runs (id, tenant, kind, requested_by, scope, status, progress, input, max_attempts)
       VALUES (:id, :tenant, :kind, :requested_by, :scope, 'queued', CAST(:progress AS JSONB), CAST(:input AS JSONB), :max_attempts)
       RETURNING ${COLS}`,
      [str('id', id), str('tenant', n.tenant), str('kind', n.kind), str('requested_by', n.requestedBy), str('scope', n.scope),
        json('progress', progress), json('input', n.input), int('max_attempts', maxAttempts)],
    );
    return fromRow(out[0]!);
  },

  /** Unfiltered by person. Callers that answer a person use getFor(). */
  async get(id: string): Promise<FlowRunRow | null> {
    if (mock()) { const r = rows().find(x => x.id === id); return r ? structuredClone(r) : null; }
    const out = await exec(`SELECT ${COLS} FROM flow_runs WHERE id = :id`, [str('id', id)]);
    return out[0] ? fromRow(out[0]) : null;
  },

  /** A run is its requester's alone: someone else's id is indistinguishable from an unknown one. */
  async getFor(tenant: string, requestedBy: string, id: string): Promise<FlowRunRow | null> {
    const run = await this.get(id);
    return run && run.tenant === tenant && run.requestedBy === requestedBy ? run : null;
  },

  /** The requester's own runs of `kinds` about `scope`, newest first (never anyone else's). */
  async listFor(tenant: string, requestedBy: string, kinds: readonly string[], scope: string, limit = 10): Promise<FlowRunRow[]> {
    if (kinds.length === 0) return [];
    if (mock()) {
      return rows().filter(r => r.tenant === tenant && r.requestedBy === requestedBy && r.scope === scope && kinds.includes(r.kind))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(r => structuredClone(r));
    }
    const names = kinds.map((_, i) => `:k${i}`).join(', ');
    const out = await exec(
      `SELECT ${COLS} FROM flow_runs WHERE tenant = :tenant AND requested_by = :by AND scope = :scope AND kind IN (${names})
        ORDER BY created_at DESC LIMIT :lim`,
      [str('tenant', tenant), str('by', requestedBy), str('scope', scope), int('lim', limit), ...kinds.map((k, i) => str(`k${i}`, k))],
    );
    return out.map(fromRow);
  },


  /** Every person's runs of `kinds` about `scope` in `tenant`, newest first (shared drafts: authority is the caller's gate, not ownership). */
  async listScope(tenant: string, kinds: readonly string[], scope: string, limit = 20): Promise<FlowRunRow[]> {
    if (kinds.length === 0) return [];
    if (mock()) {
      return rows().filter(r => r.tenant === tenant && r.scope === scope && kinds.includes(r.kind))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(r => structuredClone(r));
    }
    const names = kinds.map((_, i) => `:k${i}`).join(', ');
    const out = await exec(
      `SELECT ${COLS} FROM flow_runs WHERE tenant = :tenant AND scope = :scope AND kind IN (${names}) ORDER BY created_at DESC LIMIT :lim`,
      [str('tenant', tenant), str('scope', scope), int('lim', limit), ...kinds.map((k, i) => str(`k${i}`, k))],
    );
    return out.map(fromRow);
  },

  /**
   * Revision CAS: a COMPLETED run whose meta.rev equals `expectedRev` (unset = 1)
   * goes back to the queue with `input`, meta.rev = expectedRev + 1 and
   * meta.reviseId = `reviseId`; the earlier result stays readable until the new
   * one lands. False when someone else revised (or decided) first.
   */
  async requeueRevision(id: string, expectedRev: number, reviseId: string, input: Record<string, unknown>, maxAttempts?: number): Promise<boolean> {
    if (mock()) {
      const run = rows().find(r => r.id === id);
      if (!run || run.status !== 'completed' || run.meta['decision'] != null || Number(run.meta['rev'] ?? 1) !== expectedRev) return false;
      run.status = 'queued'; run.input = structuredClone(input); run.attempts = 0; run.error = null; run.finishedAt = null;
      run.meta['rev'] = String(expectedRev + 1); run.meta['reviseId'] = reviseId; run.updatedAt = clock.nowIso();
      if (maxAttempts) run.maxAttempts = Math.max(run.maxAttempts, maxAttempts);
      return true;
    }
    const out = await exec(
      `UPDATE flow_runs SET status = 'queued', input = CAST(:input AS JSONB), attempts = 0, error = NULL, finished_at = NULL,
              max_attempts = GREATEST(max_attempts, CAST(:max_attempts AS INTEGER)),
              meta = meta || jsonb_build_object('rev', CAST(:next AS TEXT), 'reviseId', CAST(:rid AS TEXT)), updated_at = NOW()
        WHERE id = :id AND status = 'completed' AND meta->>'decision' IS NULL AND COALESCE(meta->>'rev', '1') = CAST(:expected AS TEXT)
        RETURNING id`,
      [str('id', id), json('input', input), str('next', String(expectedRev + 1)), str('rid', reviseId), str('expected', String(expectedRev)), int('max_attempts', maxAttempts ?? 1)],
    );
    return out.length > 0;
  },

  /** The requester's own runs of `kinds` created at or after `sinceIso`, across every scope, newest first (never anyone else's). */
  async listByRequester(tenant: string, requestedBy: string, kinds: readonly string[], sinceIso: string, limit = 50): Promise<FlowRunRow[]> {
    if (kinds.length === 0) return [];
    if (mock()) {
      return rows().filter(r => r.tenant === tenant && r.requestedBy === requestedBy && kinds.includes(r.kind) && (r.finishedAt ?? r.updatedAt) >= sinceIso)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(r => structuredClone(r));
    }
    const names = kinds.map((_, i) => `:k${i}`).join(', ');
    const out = await exec(
      `SELECT ${COLS} FROM flow_runs WHERE tenant = :tenant AND requested_by = :by AND kind IN (${names})
          AND COALESCE(finished_at, updated_at) >= CAST(:since AS TIMESTAMPTZ)
        ORDER BY created_at DESC LIMIT :lim`,
      [str('tenant', tenant), str('by', requestedBy), str('since', sinceIso), int('lim', limit), ...kinds.map((k, i) => str(`k${i}`, k))],
    );
    return out.map(fromRow);
  },

  /** Every person's runs of `kinds` in `tenant` touched at or after `sinceIso`, newest first (shared drafts: authority is the caller's gate, as listScope). */
  async listTenantSince(tenant: string, kinds: readonly string[], sinceIso: string, limit = 200): Promise<FlowRunRow[]> {
    if (kinds.length === 0) return [];
    if (mock()) {
      return rows().filter(r => r.tenant === tenant && kinds.includes(r.kind) && (r.finishedAt ?? r.updatedAt) >= sinceIso)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(r => structuredClone(r));
    }
    const names = kinds.map((_, i) => `:k${i}`).join(', ');
    const out = await exec(
      `SELECT ${COLS} FROM flow_runs WHERE tenant = :tenant AND kind IN (${names})
          AND COALESCE(finished_at, updated_at) >= CAST(:since AS TIMESTAMPTZ)
        ORDER BY created_at DESC LIMIT :lim`,
      [str('tenant', tenant), str('since', sinceIso), int('lim', limit), ...kinds.map((k, i) => str(`k${i}`, k))],
    );
    return out.map(fromRow);
  },

  async countActive(tenant: string, kind: string, requestedBy: string): Promise<number> {
    if (mock()) {
      return rows().filter(r => r.tenant === tenant && r.kind === kind && r.requestedBy === requestedBy
        && (r.status === 'queued' || r.status === 'running' || r.status === waiting)).length;
    }
    const out = await exec(
      `SELECT COUNT(*) AS n FROM flow_runs WHERE tenant = :tenant AND kind = :kind AND requested_by = :by AND status IN ('queued', 'running', 'waiting-approval')`,
      [str('tenant', tenant), str('kind', kind), str('by', requestedBy)],
    );
    return Number(out[0]?.['n'] ?? 0);
  },

  /** Claims one queued run of `kinds` (or exactly `id`) for `owner`; null when none is free. */
  async claim(opts: { kinds: readonly string[]; owner: string; leaseMs: number; id?: string }): Promise<FlowRunRow | null> {
    if (opts.kinds.length === 0) return null;
    if (mock()) {
      const run = rows().filter(r => r.status === 'queued' && opts.kinds.includes(r.kind) && (!opts.id || r.id === opts.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!run) return null;
      run.status = 'running'; run.leaseOwner = opts.owner; run.attempts += 1;
      run.leaseExpiresAt = new Date(nowMs() + opts.leaseMs).toISOString(); run.updatedAt = clock.nowIso();
      emitFlowRunMove({ runId: run.id, kind: 'claimed', steps: structuredClone(run.progress) });
      return structuredClone(run);
    }
    const out = await exec(
      `UPDATE flow_runs
          SET status = 'running', lease_owner = :owner, attempts = attempts + 1, updated_at = NOW(),
              lease_expires_at = NOW() + CAST(:lease_ms AS INTEGER) * INTERVAL '1 millisecond'
        WHERE status = 'queued' AND id = (
          SELECT id FROM flow_runs
           WHERE status = 'queued' AND kind = ANY(string_to_array(:kinds, ',')) AND (CAST(:id AS TEXT) IS NULL OR id = :id)
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING ${COLS}`,
      [str('owner', opts.owner), int('lease_ms', opts.leaseMs), str('kinds', opts.kinds.join(',')), maybe('id', opts.id)],
    );
    const claimed = out[0] ? fromRow(out[0]) : null;
    if (claimed) emitFlowRunMove({ runId: claimed.id, kind: 'claimed', steps: claimed.progress });
    return claimed;
  },

  /** Records progress and extends the lease. False means this owner no longer holds the run. */
  async progress(id: string, owner: string, steps: FlowRunStep[] | null, leaseMs: number): Promise<boolean> {
    if (mock()) {
      const run = rows().find(r => r.id === id);
      if (!run || run.status !== 'running' || run.leaseOwner !== owner) return false;
      if (steps) run.progress = structuredClone(steps);
      run.leaseExpiresAt = new Date(nowMs() + leaseMs).toISOString(); run.updatedAt = clock.nowIso();
      // A heartbeat (steps null) only extends the lease: nothing a reader sees moved.
      if (steps) emitFlowRunMove({ runId: id, kind: 'progress', steps: structuredClone(steps) });
      return true;
    }
    const out = await exec(
      `UPDATE flow_runs SET progress = COALESCE(CAST(:progress AS JSONB), progress), updated_at = NOW(),
              lease_expires_at = NOW() + CAST(:lease_ms AS INTEGER) * INTERVAL '1 millisecond'
        WHERE id = :id AND status = 'running' AND lease_owner = :owner RETURNING id`,
      [str('id', id), str('owner', owner), json('progress', steps), int('lease_ms', leaseMs)],
    );
    if (out.length > 0 && steps) emitFlowRunMove({ runId: id, kind: 'progress', steps: structuredClone(steps) });
    return out.length > 0;
  },

  /** Terminal write, fenced on the owner. The private input is dropped with it. */
  async finish(id: string, owner: string,
    end: { status: 'completed' | 'failed'; result?: unknown; error?: string | null; progress?: FlowRunStep[] }): Promise<boolean> {
    if (mock()) {
      const run = rows().find(r => r.id === id);
      if (!run || run.status !== 'running' || run.leaseOwner !== owner) return false;
      run.status = end.status; run.result = end.result ?? null; run.error = end.error ?? null;
      if (end.progress) run.progress = structuredClone(end.progress);
      run.input = null; run.leaseOwner = null; run.leaseExpiresAt = null;
      run.finishedAt = run.updatedAt = clock.nowIso();
      emitFlowRunMove({ runId: id, kind: end.status, steps: structuredClone(run.progress), error: run.error });
      return true;
    }
    const out = await exec(
      `UPDATE flow_runs SET status = :status, result = CAST(:result AS JSONB), error = :error,
              progress = COALESCE(CAST(:progress AS JSONB), progress), input = NULL,
              lease_owner = NULL, lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW()
        WHERE id = :id AND status = 'running' AND lease_owner = :owner RETURNING id`,
      [str('id', id), str('owner', owner), str('status', end.status), json('result', end.result ?? null),
        maybe('error', end.error ?? null), json('progress', end.progress ?? null)],
    );
    if (out.length > 0) {
      emitFlowRunMove({ runId: id, kind: end.status, ...(end.progress ? { steps: structuredClone(end.progress) } : {}), error: end.error ?? null });
    }
    return out.length > 0;
  },

  /**
   * An executor reached a human-approval step: running -> waiting-approval, fenced on the owner.
   * The lease is released (no node holds the run, so a restart cannot re-run earlier steps), the
   * progress cursor and the private input stay, and meta.waitingSince starts the expiry clock.
   */
  async pause(id: string, owner: string, pause: { result: unknown; progress: FlowRunStep[] }): Promise<boolean> {
    if (mock()) {
      const run = rows().find(r => r.id === id);
      if (!run || run.status !== 'running' || run.leaseOwner !== owner) return false;
      run.status = waiting; run.result = structuredClone(pause.result); run.progress = structuredClone(pause.progress);
      run.leaseOwner = null; run.leaseExpiresAt = null; run.updatedAt = clock.nowIso(); run.meta['waitingSince'] = run.updatedAt;
      delete run.meta['apprReq'];
      emitFlowRunMove({ runId: id, kind: 'waiting', steps: structuredClone(run.progress) });
      return true;
    }
    const out = await exec(
      `UPDATE flow_runs SET status = 'waiting-approval', result = CAST(:result AS JSONB), progress = CAST(:progress AS JSONB),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW(),
              meta = (meta - 'apprReq') || jsonb_build_object('waitingSince', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        WHERE id = :id AND status = 'running' AND lease_owner = :owner RETURNING id`,
      [str('id', id), str('owner', owner), json('result', pause.result), json('progress', pause.progress)],
    );
    if (out.length > 0) emitFlowRunMove({ runId: id, kind: 'waiting', steps: structuredClone(pause.progress) });
    return out.length > 0;
  },

  /**
   * The once-only decision on a paused run: waiting-approval -> queued, with `patch` merged into its
   * input (the approval verdict and, for an approve, the approver's identity), meta.apprReq =
   * `requestId` and attempts reset so the resumed loop gets its own claims. False when another
   * decision (or an expiry) won first; `repeat` is the caller's check for the same requestId.
   */
  async resumeWaiting(id: string, requestId: string, patch: Record<string, unknown>, maxAttempts?: number): Promise<boolean> {
    if (mock()) {
      const run = rows().find(r => r.id === id);
      if (!run || run.status !== waiting || run.meta['apprReq'] != null) return false;
      run.status = 'queued'; run.input = { ...(run.input ?? {}), ...structuredClone(patch) }; run.attempts = 0; run.error = null;
      run.meta['apprReq'] = requestId; run.updatedAt = clock.nowIso();
      if (maxAttempts) run.maxAttempts = Math.max(run.maxAttempts, maxAttempts);
      return true;
    }
    const out = await exec(
      `UPDATE flow_runs SET status = 'queued', input = COALESCE(input, '{}'::jsonb) || CAST(:patch AS JSONB), attempts = 0, error = NULL,
              max_attempts = GREATEST(max_attempts, CAST(:max_attempts AS INTEGER)),
              meta = meta || jsonb_build_object('apprReq', CAST(:rid AS TEXT)), updated_at = NOW()
        WHERE id = :id AND status = 'waiting-approval' AND meta->>'apprReq' IS NULL RETURNING id`,
      [str('id', id), json('patch', patch), str('rid', requestId), int('max_attempts', maxAttempts ?? 1)],
    );
    return out.length > 0;
  },

  /**
   * A pause nobody decided within `ttlMs` is re-queued with an `expire` verdict so its executor ends the
   * loop visibly (no lease, no authority needed to say "nobody answered"). Returns the run ids.
   */
  async expireWaiting(ttlMs: number): Promise<string[]> {
    if (mock()) {
      const ids: string[] = [];
      const cutoff = nowMs() - ttlMs;
      for (const run of rows()) {
        if (run.status !== waiting || run.meta['apprReq'] != null) continue;
        if (Date.parse(String(run.meta['waitingSince'] ?? run.updatedAt)) > cutoff) continue;
        run.status = 'queued'; run.input = { ...(run.input ?? {}), approval: { verb: 'expire' } }; run.attempts = 0;
        run.meta['apprReq'] = 'expired'; run.updatedAt = clock.nowIso(); ids.push(run.id);
      }
      return ids;
    }
    const out = await exec(
      `UPDATE flow_runs SET status = 'queued', input = COALESCE(input, '{}'::jsonb) || '{"approval":{"verb":"expire"}}'::jsonb, attempts = 0,
              meta = meta || '{"apprReq":"expired"}'::jsonb, updated_at = NOW()
        WHERE status = 'waiting-approval' AND meta->>'apprReq' IS NULL
          AND updated_at < NOW() - CAST(:ttl_ms AS INTEGER) * INTERVAL '1 millisecond' RETURNING id`,
      [int('ttl_ms', ttlMs)],
    );
    return out.map(r => String(r['id']));
  },

  /** Every run of `kind` in `scope` of `tenant` paused for a decision, oldest first (the caller's gate decides who may see them). */
  async listWaiting(tenant: string, kind: string, scope: string, limit = 20): Promise<FlowRunRow[]> {
    if (mock()) {
      return rows().filter(r => r.tenant === tenant && r.kind === kind && r.scope === scope && r.status === waiting)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(r => structuredClone(r));
    }
    const out = await exec(
      `SELECT ${COLS} FROM flow_runs WHERE tenant = :tenant AND kind = :kind AND scope = :scope AND status = 'waiting-approval'
        ORDER BY created_at LIMIT :lim`,
      [str('tenant', tenant), str('kind', kind), str('scope', scope), int('lim', limit)],
    );
    return out.map(fromRow);
  },

  /** Sets meta[key] only if it is unset. True for the one caller that set it. */
  async setMetaOnce(id: string, requestedBy: string | null, key: string, value: string): Promise<boolean> {
    if (!KEY_RE.test(key)) throw new Error('invalid meta key');
    if (mock()) {
      const run = rows().find(r => r.id === id && (requestedBy === null || r.requestedBy === requestedBy));
      if (!run || run.meta[key] != null) return false;
      run.meta[key] = value; run.updatedAt = clock.nowIso();
      return true;
    }
    const out = await exec(
      `UPDATE flow_runs SET meta = jsonb_set(meta, ARRAY[CAST(:key AS TEXT)], to_jsonb(CAST(:value AS TEXT))), updated_at = NOW()
        WHERE id = :id AND (CAST(:by AS TEXT) IS NULL OR requested_by = :by) AND meta->>CAST(:key AS TEXT) IS NULL RETURNING id`,
      [str('id', id), maybe('by', requestedBy), str('key', key), str('value', value)],
    );
    return out.length > 0;
  },

  /** Removes meta[key] only while it still equals value (releases a claim whose follow-on write failed). */
  async releaseMeta(id: string, key: string, value: string): Promise<boolean> {
    if (!KEY_RE.test(key)) throw new Error('invalid meta key');
    if (mock()) {
      const run = rows().find(r => r.id === id);
      if (!run || run.meta[key] !== value) return false;
      delete run.meta[key]; run.updatedAt = clock.nowIso();
      return true;
    }
    const out = await exec(
      `UPDATE flow_runs SET meta = meta - CAST(:key AS TEXT), updated_at = NOW() WHERE id = :id AND meta->>CAST(:key AS TEXT) = :value RETURNING id`,
      [str('id', id), str('key', key), str('value', value)],
    );
    return out.length > 0;
  },

  /**
   * Startup/periodic recovery: a running run whose lease lapsed goes back to
   * the queue while attempts remain, and is failed (visibly) once they do not.
   */
  async expireLeases(): Promise<{ requeued: FlowRunRow[]; failed: FlowRunRow[] }> {
    if (mock()) {
      const requeued: FlowRunRow[] = []; const failed: FlowRunRow[] = [];
      const t = nowMs();
      for (const run of rows()) {
        if (run.status !== 'running' || !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) >= t) continue;
        run.leaseOwner = null; run.leaseExpiresAt = null; run.updatedAt = clock.nowIso();
        if (run.attempts < run.maxAttempts) { run.status = 'queued'; requeued.push(structuredClone(run)); }
        else {
          run.status = 'failed'; run.error = LEASE_EXPIRED; run.input = null; run.finishedAt = run.updatedAt;
          for (const s of run.progress) if (s.status === 'running') s.status = 'failed';
          failed.push(structuredClone(run));
        }
      }
      for (const run of failed) emitFlowRunMove({ runId: run.id, kind: 'failed', steps: run.progress, error: run.error });
      return { requeued, failed };
    }
    const requeued = await exec(
      `UPDATE flow_runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE status = 'running' AND lease_expires_at < NOW() AND attempts < max_attempts RETURNING ${COLS}`);
    const failed = await exec(
      `UPDATE flow_runs SET status = 'failed', error = :error, input = NULL, lease_owner = NULL, lease_expires_at = NULL,
              finished_at = NOW(), updated_at = NOW()
        WHERE status = 'running' AND lease_expires_at < NOW() AND attempts >= max_attempts RETURNING ${COLS}`,
      [str('error', LEASE_EXPIRED)]);
    const lapsed = failed.map(fromRow);
    for (const run of lapsed) emitFlowRunMove({ runId: run.id, kind: 'failed', steps: run.progress, error: run.error });
    return { requeued: requeued.map(fromRow), failed: lapsed };
  },

  /** Deletes finished runs of `kind` not touched for `olderThanMs`. */
  async prune(kind: string, olderThanMs: number): Promise<void> {
    if (mock()) {
      const all = rows(); const cutoff = nowMs() - olderThanMs;
      for (let i = all.length - 1; i >= 0; i--) {
        const r = all[i]!;
        if (r.kind === kind && (r.status === 'completed' || r.status === 'failed') && Date.parse(r.updatedAt) < cutoff) all.splice(i, 1);
      }
      return;
    }
    await exec(
      `DELETE FROM flow_runs WHERE kind = :kind AND status IN ('completed', 'failed')
          AND updated_at < NOW() - CAST(:age_ms AS INTEGER) * INTERVAL '1 millisecond'`,
      [str('kind', kind), int('age_ms', olderThanMs)],
    );
  },
};
