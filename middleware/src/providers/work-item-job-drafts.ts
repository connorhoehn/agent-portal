// Work-item job drafts — the dispatch drawer's "Save for later"
// (schema/work_item_job_drafts_schema.sql, 2026-10-28).
//
// One draft per work item: the model, the per-run cap, the instruction and the
// codebase a steward prepared but did not dispatch. Reads hand back copies;
// writes go through the three functions below only, so a dispatch can clear
// the draft (routes/bots.ts) and `POST /api/__mock/reset` can restore the
// fixture. Gating lives in routes/bots.ts (DispatchAgentRun + initiative
// scope); this module is persistence only.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import { exec } from './aurora.js';
import { displayNameForSubject } from './identity.js';
import { clock } from '../mock/core/index.js';
import { workItemJobDrafts, type WorkItemJobDraftRow } from '../mock/work-item-job-drafts.js';

export interface JobDraft extends WorkItemJobDraftRow {
  /** `savedBy` resolved through app_users; null when the subject has no account row. */
  savedByName: string | null;
}

export interface JobDraftInput {
  model: string;
  budgetPerRunUsd: number | null;
  instruction: string | null;
  agentProjectId: string | null;
}

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter { return v ? s(name, v) : nul(name); }
function maybeNum(name: string, v: number | null | undefined): SqlParameter { return v != null ? { name, value: { doubleValue: v } } : nul(name); }
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** The RDS Data API hands TIMESTAMPTZ back naive (lib/devbox-fleet-rows.ts::utcIso): read it as UTC. */
function utcIso(raw: unknown): string {
  const text = String(raw ?? '');
  if (!text) return text;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return new Date(text).toISOString();
  return new Date(`${text.replace(' ', 'T')}Z`).toISOString();
}

/** Safe reads: a cluster that predates the table answers "no draft", never a 500. Writes stay loud. */
async function safeExec(sql: string, params: SqlParameter[]): Promise<Record<string, unknown>[]> {
  try {
    return await exec(sql, params);
  } catch (err) {
    if (/does not exist|relation/i.test((err as Error).message ?? '')) return [];
    throw err;
  }
}

const COLUMNS = 'work_item_id, model, budget_per_run_usd::float8 AS budget_per_run_usd, instruction, agent_project_id::text AS agent_project_id, saved_by, saved_at, updated_at';

function rowToDraft(r: Record<string, unknown>): JobDraft {
  const savedBy = String(r['saved_by'] ?? '');
  return {
    workItemId: String(r['work_item_id'] ?? ''),
    model: String(r['model'] ?? ''),
    budgetPerRunUsd: r['budget_per_run_usd'] == null ? null : Number(r['budget_per_run_usd']),
    instruction: str(r['instruction']),
    agentProjectId: str(r['agent_project_id']),
    savedBy,
    savedByName: displayNameForSubject(savedBy),
    savedAt: utcIso(r['saved_at']),
    updatedAt: utcIso(r['updated_at']),
  };
}

const present = (row: WorkItemJobDraftRow): JobDraft => ({ ...structuredClone(row), savedByName: displayNameForSubject(row.savedBy) });

/** The item's draft, or null. */
export async function getJobDraft(workItemId: string): Promise<JobDraft | null> {
  if (config.mock.aurora) {
    const row = workItemJobDrafts.rows().find((d) => d.workItemId === workItemId);
    return row ? present(row) : null;
  }
  const rows = await safeExec(`SELECT ${COLUMNS} FROM work_item_job_drafts WHERE work_item_id = :wid`, [s('wid', workItemId)]);
  return rows[0] ? rowToDraft(rows[0]) : null;
}

/**
 * Save (or replace) the item's draft. An upsert: a second save by anyone
 * replaces the whole setup and the name on it — the draft is the item's, and
 * the last person to prepare it stands behind it. `savedAt` is the first
 * save; `updatedAt` moves on every save.
 */
export async function saveJobDraft(workItemId: string, actor: string, input: JobDraftInput): Promise<JobDraft> {
  if (config.mock.aurora) {
    const rows = workItemJobDrafts.rows();
    const now = clock.nowIso();
    const at = rows.findIndex((d) => d.workItemId === workItemId);
    const row: WorkItemJobDraftRow = {
      workItemId, model: input.model, budgetPerRunUsd: input.budgetPerRunUsd, instruction: input.instruction,
      agentProjectId: input.agentProjectId, savedBy: actor, savedAt: at >= 0 ? rows[at]!.savedAt : now, updatedAt: now,
    };
    if (at >= 0) rows[at] = row; else rows.push(row);
    return present(row);
  }
  const rows = await exec(
    `INSERT INTO work_item_job_drafts (work_item_id, model, budget_per_run_usd, instruction, agent_project_id, saved_by)
     VALUES (:wid, :model, :cap, :instruction, CAST(:apid AS UUID), :actor)
     ON CONFLICT (work_item_id) DO UPDATE
        SET model = EXCLUDED.model, budget_per_run_usd = EXCLUDED.budget_per_run_usd, instruction = EXCLUDED.instruction,
            agent_project_id = EXCLUDED.agent_project_id, saved_by = EXCLUDED.saved_by, updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [s('wid', workItemId), s('model', input.model), maybeNum('cap', input.budgetPerRunUsd), maybe('instruction', input.instruction), maybe('apid', input.agentProjectId), s('actor', actor)],
  );
  return rowToDraft(rows[0]!);
}

/** Remove the item's draft. False when there was none. */
export async function deleteJobDraft(workItemId: string): Promise<boolean> {
  if (config.mock.aurora) {
    const rows = workItemJobDrafts.rows();
    const at = rows.findIndex((d) => d.workItemId === workItemId);
    if (at < 0) return false;
    rows.splice(at, 1);
    return true;
  }
  const rows = await safeExec('DELETE FROM work_item_job_drafts WHERE work_item_id = :wid RETURNING work_item_id', [s('wid', workItemId)]);
  return rows.length > 0;
}
