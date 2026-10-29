// DE-4 prompt promotion, BFF half: the pointer model, the planners and the
// IO behind `routes/prompt-pointers.ts`.
//
// A pointer per agent is the alias (Bedrock Prompt Management has none):
//   /orgiq/prompts/<agent>/live       {"promptId":"…","version":"7"}
//   /orgiq/prompts/<agent>/candidate  {"promptId":"…","version":"8","weight":10}
// `agents/_shared/prompt_source.py` reads them. The planners mirror
// `infra/lib/prompt-pointers.ts` (same refusals, same lifecycle transitions);
// they return data and never touch AWS. Offline (`config.mock.agentcore` /
// `config.mock.aurora`) the IO goes to `mock/prompt-pointers.ts`.

import {
  SSMClient, GetParametersCommand, PutParameterCommand, DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import { BedrockAgentClient, GetPromptCommand, ListPromptsCommand } from '@aws-sdk/client-bedrock-agent';
import { config } from '../config.js';
import { exec } from '../providers/aurora.js';
import { findMockPrompt, MOCK_PROMPT_LIBRARY } from '../mock/canary-library.js';
import {
  mockGetLifecycle, mockReadPointers, mockSetLifecycle, mockWritePointers, type PointerRef,
} from '../mock/prompt-pointers.js';

export type LifecycleStatus = 'draft' | 'published' | 'deployed' | 'promoted' | 'rolled_back' | 'superseded';
export interface Pointer extends PointerRef {}
export interface CurrentPointers { live: Pointer | null; candidate: Pointer | null }
export interface Transition { promptId: string; version: string; lifecycleStatus: LifecycleStatus }
export interface PointerPlan {
  action: 'candidate' | 'promote' | 'rollback';
  agent: string;
  writes: Array<{ kind: 'live' | 'candidate'; pointer: Pointer }>;
  deletes: Array<'live' | 'candidate'>;
  transitions: Transition[];
  refused?: string;
  notes: string[];
}

export const PREFIX = 'orgiq';
export const DEFAULT_CANDIDATE_WEIGHT = 10;
/** The eval pass-rate bar, the same 80 % `decideDeploy` uses. */
export const EVAL_FLOOR = 0.8;
export const AGENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION_RE = /^[1-9]\d*$/;

export const pointerNames = (agent: string): { live: string; candidate: string } => ({
  live: `/${PREFIX}/prompts/${agent}/live`,
  candidate: `/${PREFIX}/prompts/${agent}/candidate`,
});

export function parsePointer(raw: unknown, candidate = false): Pointer | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  if (typeof o['promptId'] !== 'string' || !ID_RE.test(o['promptId'])) return null;
  const v = typeof o['version'] === 'number' ? String(o['version']) : o['version'];
  if (typeof v !== 'string') return null;
  const version = v.trim().toUpperCase() === 'DRAFT' ? 'DRAFT' : v.trim();
  if (version !== 'DRAFT' && !VERSION_RE.test(version)) return null;
  if (!candidate) return { promptId: o['promptId'], version };
  const weight = o['weight'] ?? 0;
  if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0 || weight > 100) return null;
  return { promptId: o['promptId'], version, weight };
}

const serialize = (p: Pointer): string => JSON.stringify(
  p.weight === undefined ? { promptId: p.promptId, version: p.version } : { promptId: p.promptId, version: p.version, weight: p.weight },
);

function deployable(version: string, what: string): string | undefined {
  if (version === 'DRAFT') return `${what}: DRAFT is the studio working copy and is never deployable; publish a version first`;
  if (!VERSION_RE.test(version)) return `${what}: "${version}" is not a numbered Bedrock prompt version`;
  return undefined;
}

export function planCandidate(input: {
  agent: string; current: CurrentPointers; promptId: string; version: string; weight?: number; gate: GateResult;
}): PointerPlan {
  const weight = input.weight ?? DEFAULT_CANDIDATE_WEIGHT;
  const base = { action: 'candidate' as const, agent: input.agent, writes: [], deletes: [], transitions: [], notes: [] };
  const bad = deployable(input.version, 'candidate');
  if (bad) return { ...base, refused: bad };
  if (!ID_RE.test(input.promptId)) return { ...base, refused: `candidate: "${input.promptId}" is not a prompt id` };
  if (!Number.isInteger(weight) || weight < 1 || weight > 100) return { ...base, refused: `candidate: weight must be 1–100 (got ${weight})` };
  if (!input.gate.passed) return { ...base, refused: `candidate: version ${input.version} did not pass the offline gate: ${input.gate.reason}; nothing written` };
  const { live, candidate } = input.current;
  if (live && live.promptId === input.promptId && live.version === input.version) return { ...base, refused: `candidate: version ${input.version} is already live` };
  if (live && live.promptId !== input.promptId) return { ...base, refused: `candidate: live points at prompt ${live.promptId}, not ${input.promptId}; one prompt per agent` };
  if (candidate) return { ...base, refused: `candidate: ${candidate.version} is already the candidate (weight ${candidate.weight}); promote or roll it back first` };
  return {
    ...base,
    writes: [{ kind: 'candidate', pointer: { promptId: input.promptId, version: input.version, weight } }],
    transitions: [{ promptId: input.promptId, version: input.version, lifecycleStatus: 'deployed' }],
    notes: [live ? `live stays ${live.version}; ${weight}% of invocations serve ${input.version}` : `no live pointer: ${weight}% of invocations leave the baked prompt`],
  };
}

export function planPromote(input: { agent: string; current: CurrentPointers }): PointerPlan {
  const base = { action: 'promote' as const, agent: input.agent, writes: [], deletes: [], transitions: [], notes: [] };
  const cand = input.current.candidate;
  if (!cand) return { ...base, refused: 'promote: no candidate pointer; nothing to promote' };
  const bad = deployable(cand.version, 'promote');
  if (bad) return { ...base, refused: bad };
  const live = input.current.live;
  const transitions: Transition[] = [{ promptId: cand.promptId, version: cand.version, lifecycleStatus: 'promoted' }];
  if (live && live.version !== 'DRAFT') transitions.push({ promptId: live.promptId, version: live.version, lifecycleStatus: 'superseded' });
  return {
    ...base,
    writes: [{ kind: 'live', pointer: { promptId: cand.promptId, version: cand.version } }],
    deletes: ['candidate'],
    transitions,
    notes: [live ? `live ${live.version} → ${cand.version}` : `live set to ${cand.version} (was absent)`],
  };
}

export function planRollback(input: { agent: string; current: CurrentPointers }): PointerPlan {
  const base = { action: 'rollback' as const, agent: input.agent, writes: [], deletes: [], transitions: [], notes: [] };
  const cand = input.current.candidate;
  if (!cand) return { ...base, refused: 'rollback: no candidate pointer; nothing to roll back' };
  return {
    ...base,
    deletes: ['candidate'],
    transitions: cand.version === 'DRAFT' ? [] : [{ promptId: cand.promptId, version: cand.version, lifecycleStatus: 'rolled_back' }],
    notes: [input.current.live ? `live stays ${input.current.live.version}` : 'no live pointer: the fleet keeps its baked prompt'],
  };
}

// ─── IO ──────────────────────────────────────────────────────────────────────

let _ssm: SSMClient | null = null;
const ssm = (): SSMClient => (_ssm ??= new SSMClient({ region: config.region }));
let _agent: BedrockAgentClient | null = null;
const bedrock = (): BedrockAgentClient => (_agent ??= new BedrockAgentClient({ region: config.region }));

export async function readPointers(agent: string): Promise<CurrentPointers> {
  if (config.mock.agentcore) return mockReadPointers(agent);
  const names = pointerNames(agent);
  const out = await ssm().send(new GetParametersCommand({ Names: [names.live, names.candidate] }));
  const by = new Map((out.Parameters ?? []).map((p) => [p.Name, p.Value]));
  return { live: parsePointer(by.get(names.live)), candidate: parsePointer(by.get(names.candidate), true) };
}

/** Apply a plan's parameter writes and deletes. Never called for a refused plan. */
export async function applyPointerPlan(plan: PointerPlan): Promise<void> {
  if (plan.refused) throw new Error(plan.refused);
  if (config.mock.agentcore) {
    const patch: { live?: Pointer | null; candidate?: Pointer | null } = {};
    for (const w of plan.writes) patch[w.kind] = { ...w.pointer };
    for (const d of plan.deletes) patch[d] = null;
    mockWritePointers(plan.agent, patch);
    return;
  }
  const names = pointerNames(plan.agent);
  for (const w of plan.writes) {
    await ssm().send(new PutParameterCommand({ Name: names[w.kind], Type: 'String', Overwrite: true, Value: serialize(w.pointer) }));
  }
  for (const d of plan.deletes) {
    try { await ssm().send(new DeleteParameterCommand({ Name: names[d] })); }
    catch (err) { if ((err as { name?: string }).name !== 'ParameterNotFound') throw err; }
  }
}

/** Record the lifecycle transitions (prompt_version_meta). */
export async function recordTransitions(transitions: Transition[]): Promise<void> {
  for (const t of transitions) {
    if (config.mock.aurora) { mockSetLifecycle(t.promptId, t.version, t.lifecycleStatus); continue; }
    const stamp = t.lifecycleStatus === 'deployed' ? ', deployed_at = now()' : t.lifecycleStatus === 'superseded' ? ', superseded_at = now()' : '';
    await exec(
      'INSERT INTO observability.prompt_version_meta (prompt_id, version, lifecycle_status) VALUES (:promptId, :version, :status) '
      + `ON CONFLICT (prompt_id, version) DO UPDATE SET lifecycle_status = EXCLUDED.lifecycle_status${stamp}`,
      [
        { name: 'promptId', value: { stringValue: t.promptId } },
        { name: 'version', value: { stringValue: t.version } },
        { name: 'status', value: { stringValue: t.lifecycleStatus } },
      ],
    );
  }
}

/** The Bedrock prompt id for an agent's `orgiq-<agent>-system-prompt`, or null. */
export async function findPromptId(agent: string): Promise<string | null> {
  const name = `${PREFIX}-${agent}-system-prompt`;
  if (config.mock.agentcore) return MOCK_PROMPT_LIBRARY.find((p) => p.name === name)?.id ?? null;
  let token: string | undefined;
  do {
    const out = await bedrock().send(new ListPromptsCommand({ maxResults: 100, ...(token ? { nextToken: token } : {}) }));
    const hit = out.promptSummaries?.find((p) => p.name === name);
    if (hit?.id) return hit.id;
    token = out.nextToken;
  } while (token);
  return null;
}

// ─── The gate ────────────────────────────────────────────────────────────────

export interface GateResult { passed: boolean; reason: string; evalPassRate: number | null }

/**
 * The offline gate for a candidate. Structural, no model call: the version
 * must exist and be published, its template must be non-empty, and, when an
 * eval pass rate is recorded for it, that rate must reach the 80 % bar. An
 * unrecorded rate does not block (the full golden set is DE-5's runner).
 */
export async function runPromotionGate(promptId: string, version: string): Promise<GateResult> {
  let template: string | null = null;
  let evalPassRate: number | null = null;
  if (config.mock.agentcore) {
    template = findMockPrompt(promptId)?.versions.find((v) => v.version === version)?.variant.templateText ?? null;
  } else {
    try {
      const out = await bedrock().send(new GetPromptCommand({ promptIdentifier: promptId, promptVersion: version }));
      template = out.variants?.[0]?.templateConfiguration?.text?.text ?? null;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
    }
  }
  if (config.mock.aurora) {
    evalPassRate = mockGetLifecycle(promptId, version)?.evalPassRate ?? null;
  } else {
    const rows = await exec(
      'SELECT eval_pass_rate FROM observability.prompt_version_meta WHERE prompt_id = :promptId AND version = :version',
      [{ name: 'promptId', value: { stringValue: promptId } }, { name: 'version', value: { stringValue: version } }],
    ).catch(() => [] as Record<string, unknown>[]);
    const raw = rows[0]?.['eval_pass_rate'];
    evalPassRate = raw == null ? null : Number(raw);
  }
  if (template === null) return { passed: false, reason: `version ${version} of ${promptId} does not exist; publish it first`, evalPassRate };
  if (!template.trim()) return { passed: false, reason: `version ${version} has an empty template`, evalPassRate };
  if (evalPassRate != null && evalPassRate < EVAL_FLOOR) {
    return { passed: false, reason: `eval pass rate ${Math.round(evalPassRate * 100)}% is below the ${Math.round(EVAL_FLOOR * 100)}% bar`, evalPassRate };
  }
  return { passed: true, reason: evalPassRate == null ? 'structural checks passed; no eval rate recorded' : `eval pass rate ${Math.round(evalPassRate * 100)}%`, evalPassRate };
}
