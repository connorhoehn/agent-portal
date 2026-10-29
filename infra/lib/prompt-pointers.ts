/**
 * DE-4 prompt promotion: the pointer model and the pure planners behind
 * `scripts/prompt-pointers.ts` and the canary stack's per-agent controller.
 *
 * Bedrock Prompt Management has versions (`1`, `2`, …) but no alias, so the
 * alias is two SSM parameters per agent:
 *
 *   /<prefix>/prompts/<agent>/live       {"promptId":"…","version":"7"}
 *   /<prefix>/prompts/<agent>/candidate  {"promptId":"…","version":"8","weight":10}
 *
 * `agents/_shared/prompt_source.py` reads them; nothing in CDK writes them
 * (a pointer names a version that exists only after a publish). The planners
 * here return data — parameter writes/deletes, `prompt_version_meta`
 * lifecycle transitions and the `aws` argv that would carry them out — and
 * never call AWS, so they are testable offline and the CLI's `--dry-run` is
 * the plan printed.
 *
 * Lifecycle (schema/observability_sprint6_prompt_history_schema.sql):
 *   publish → published; candidate → deployed; promote → promoted (old live →
 *   superseded); rollback → rolled_back.
 */

export const LIFECYCLE_STATUSES = ['draft', 'published', 'deployed', 'promoted', 'rolled_back', 'superseded'] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** The eight Strands agents that read a pointer (mirrors AGENT_NAMES in agentcore-runtime-stack.ts). */
export const POINTER_AGENTS = [
  'supervisor', 'search', 'scoring', 'advisor', 'ingestion', 'graph-builder', 'assessment-scorer', 'assessment-drafter',
] as const;

export const DEFAULT_CANDIDATE_WEIGHT = 10;

export interface Pointer {
  readonly promptId: string;
  /** A numbered version. DRAFT is parsed (prompt_source.py serves it off-production) but never written here. */
  readonly version: string;
  /** Candidate only: traffic share in percent, 0–100. */
  readonly weight?: number;
}

export interface PointerNames { readonly live: string; readonly candidate: string }

export interface Transition {
  readonly promptId: string;
  readonly version: string;
  readonly lifecycleStatus: LifecycleStatus;
}

export interface ParameterWrite { readonly name: string; readonly value: string }

export interface PointerPlan {
  readonly action: 'bootstrap' | 'candidate' | 'promote' | 'rollback';
  readonly agent: string;
  readonly writes: readonly ParameterWrite[];
  readonly deletes: readonly string[];
  readonly transitions: readonly Transition[];
  /** Human-readable reasons; a plan with `refused` set must not be applied. */
  readonly refused?: string;
  readonly notes: readonly string[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION_RE = /^[1-9]\d*$/;
const AGENT_RE = /^[a-z][a-z0-9-]{0,39}$/;

export function pointerPath(prefix: string, agent: string): string {
  if (!AGENT_RE.test(agent)) throw new Error(`not an agent name: "${agent}"`);
  return `/${prefix}/prompts/${agent}`;
}

export function pointerNames(prefix: string, agent: string): PointerNames {
  const path = pointerPath(prefix, agent);
  return { live: `${path}/live`, candidate: `${path}/candidate` };
}

/**
 * Parse a parameter value the way prompt_source.py does: strict, and `null`
 * for anything malformed (the agent then treats it as absent → baked).
 */
export function parsePointer(raw: unknown, opts: { candidate?: boolean } = {}): Pointer | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  if (typeof o.promptId !== 'string' || !ID_RE.test(o.promptId)) return null;
  const rawVersion: unknown = typeof o.version === 'number' && Number.isInteger(o.version) ? String(o.version) : o.version;
  if (typeof rawVersion !== 'string' || !rawVersion.trim()) return null;
  let version: string = rawVersion.trim();
  if (version.toUpperCase() === 'DRAFT') version = 'DRAFT';
  else if (!VERSION_RE.test(version)) return null;
  if (!opts.candidate) return { promptId: o.promptId, version };
  const weight = o.weight ?? 0;
  if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0 || weight > 100) return null;
  return { promptId: o.promptId, version, weight };
}

export function serializePointer(p: Pointer): string {
  return p.weight === undefined
    ? JSON.stringify({ promptId: p.promptId, version: p.version })
    : JSON.stringify({ promptId: p.promptId, version: p.version, weight: p.weight });
}

function assertDeployable(version: string, what: string): string | undefined {
  if (version === 'DRAFT') return `${what}: DRAFT is the studio working copy and is never deployable; publish a version first`;
  if (!VERSION_RE.test(version)) return `${what}: "${version}" is not a numbered Bedrock prompt version`;
  return undefined;
}

export interface CurrentPointers { readonly live: Pointer | null; readonly candidate: Pointer | null }

/**
 * Make `version` the candidate at `weight` percent. Refused when the version
 * fails the offline gate (the caller passes `gatePassed`), equals live, or
 * when a candidate is already in flight (promote or roll it back first).
 */
export function planCandidate(input: {
  prefix: string; agent: string; current: CurrentPointers; promptId: string; version: string;
  weight?: number; gatePassed: boolean;
}): PointerPlan {
  const names = pointerNames(input.prefix, input.agent);
  const weight = input.weight ?? DEFAULT_CANDIDATE_WEIGHT;
  const base = { action: 'candidate' as const, agent: input.agent, writes: [], deletes: [], transitions: [], notes: [] };
  const bad = assertDeployable(input.version, 'candidate');
  if (bad) return { ...base, refused: bad };
  if (!ID_RE.test(input.promptId)) return { ...base, refused: `candidate: "${input.promptId}" is not a prompt id` };
  if (!Number.isInteger(weight) || weight < 1 || weight > 100) return { ...base, refused: `candidate: weight must be 1–100 (got ${weight})` };
  if (!input.gatePassed) return { ...base, refused: `candidate: version ${input.version} did not pass the offline eval gate; nothing written` };
  if (input.current.live && input.current.live.promptId === input.promptId && input.current.live.version === input.version) {
    return { ...base, refused: `candidate: version ${input.version} is already live` };
  }
  if (input.current.live && input.current.live.promptId !== input.promptId) {
    return { ...base, refused: `candidate: live points at prompt ${input.current.live.promptId}, not ${input.promptId}; one prompt per agent` };
  }
  if (input.current.candidate) {
    return { ...base, refused: `candidate: ${input.current.candidate.version} is already the candidate (weight ${input.current.candidate.weight}); promote or roll it back first` };
  }
  return {
    ...base,
    writes: [{ name: names.candidate, value: serializePointer({ promptId: input.promptId, version: input.version, weight }) }],
    transitions: [{ promptId: input.promptId, version: input.version, lifecycleStatus: 'deployed' }],
    notes: input.current.live
      ? [`live stays ${input.current.live.version}; ${weight}% of invocations serve ${input.version}`]
      : [`no live pointer yet: only ${weight}% of invocations leave the baked prompt (bootstrap writes live)`],
  };
}

/** Copy candidate → live, delete candidate. */
export function planPromote(input: { prefix: string; agent: string; current: CurrentPointers }): PointerPlan {
  const names = pointerNames(input.prefix, input.agent);
  const base = { action: 'promote' as const, agent: input.agent, writes: [], deletes: [], transitions: [], notes: [] };
  const cand = input.current.candidate;
  if (!cand) return { ...base, refused: 'promote: no candidate pointer; nothing to promote' };
  const bad = assertDeployable(cand.version, 'promote');
  if (bad) return { ...base, refused: bad };
  const transitions: Transition[] = [{ promptId: cand.promptId, version: cand.version, lifecycleStatus: 'promoted' }];
  const live = input.current.live;
  if (live && live.version !== 'DRAFT' && !(live.promptId === cand.promptId && live.version === cand.version)) {
    transitions.push({ promptId: live.promptId, version: live.version, lifecycleStatus: 'superseded' });
  }
  return {
    ...base,
    writes: [{ name: names.live, value: serializePointer({ promptId: cand.promptId, version: cand.version }) }],
    deletes: [names.candidate],
    transitions,
    notes: [live ? `live ${live.version} → ${cand.version}` : `live set to ${cand.version} (was absent)`],
  };
}

/** Delete the candidate; live is untouched. */
export function planRollback(input: { prefix: string; agent: string; current: CurrentPointers }): PointerPlan {
  const names = pointerNames(input.prefix, input.agent);
  const base = { action: 'rollback' as const, agent: input.agent, writes: [], deletes: [], transitions: [], notes: [] };
  const cand = input.current.candidate;
  if (!cand) return { ...base, refused: 'rollback: no candidate pointer; nothing to roll back' };
  return {
    ...base,
    deletes: [names.candidate],
    transitions: cand.version === 'DRAFT' ? [] : [{ promptId: cand.promptId, version: cand.version, lifecycleStatus: 'rolled_back' }],
    notes: [input.current.live ? `live stays ${input.current.live.version}` : 'no live pointer: the fleet keeps its baked prompt'],
  };
}

/**
 * Day one: every agent without a live pointer gets its current DRAFT published
 * as a numbered version and that version written as live, so nothing an
 * agent says changes when CDK stops setting DRAFT. `publishedVersion` is the
 * number `create-prompt-version` returned; when it is not known yet the plan
 * holds a `create-version` step and no write (the runner fills it in).
 */
export function planBootstrap(input: {
  prefix: string; agent: string; current: CurrentPointers; promptId: string | null; publishedVersion?: string | null;
}): PointerPlan & { readonly createVersion: boolean } {
  const names = pointerNames(input.prefix, input.agent);
  const base = { action: 'bootstrap' as const, agent: input.agent, writes: [], deletes: [], transitions: [], notes: [], createVersion: false };
  if (input.current.live && input.current.live.version !== 'DRAFT') {
    return { ...base, notes: [`live already ${input.current.live.version}; untouched`] };
  }
  if (!input.promptId) return { ...base, refused: `bootstrap: no Bedrock prompt named ${input.prefix}-${input.agent}-system-prompt` };
  if (!input.publishedVersion) {
    return { ...base, createVersion: true, notes: [`publish DRAFT of ${input.promptId} as a new version, then write it as live`] };
  }
  const bad = assertDeployable(input.publishedVersion, 'bootstrap');
  if (bad) return { ...base, refused: bad };
  return {
    ...base,
    writes: [{ name: names.live, value: serializePointer({ promptId: input.promptId, version: input.publishedVersion }) }],
    transitions: [
      { promptId: input.promptId, version: input.publishedVersion, lifecycleStatus: 'published' },
      { promptId: input.promptId, version: input.publishedVersion, lifecycleStatus: 'promoted' },
    ],
    notes: [`live ← ${input.publishedVersion} (the DRAFT text as of now)`],
  };
}

/** The `aws` argv for one plan: writes as `put-parameter --overwrite`, deletes, nothing else. */
export function awsArgvFor(plan: PointerPlan, region: string): string[][] {
  if (plan.refused) return [];
  const argv: string[][] = [];
  for (const w of plan.writes) {
    argv.push(['ssm', 'put-parameter', '--region', region, '--name', w.name, '--type', 'String', '--overwrite', '--value', w.value]);
  }
  for (const d of plan.deletes) argv.push(['ssm', 'delete-parameter', '--region', region, '--name', d]);
  return argv;
}

/** The `prompt_version_meta` update for one transition, as RDS Data API parameters. */
export function lifecycleSql(t: Transition): { sql: string; parameters: Array<{ name: string; value: { stringValue: string } }> } {
  const stamp = t.lifecycleStatus === 'deployed' ? ', deployed_at = now()'
    : t.lifecycleStatus === 'superseded' ? ', superseded_at = now()'
      : t.lifecycleStatus === 'published' ? ', published_at = coalesce(published_at, now())'
        : '';
  return {
    sql: 'INSERT INTO observability.prompt_version_meta (prompt_id, version, lifecycle_status) VALUES (:prompt_id, :version, :status) '
      + `ON CONFLICT (prompt_id, version) DO UPDATE SET lifecycle_status = EXCLUDED.lifecycle_status${stamp}`,
    parameters: [
      { name: 'prompt_id', value: { stringValue: t.promptId } },
      { name: 'version', value: { stringValue: t.version } },
      { name: 'status', value: { stringValue: t.lifecycleStatus } },
    ],
  };
}

/** `aws ssm get-parameters` output → the two parsed pointers for one agent. */
export function pointersFromParameters(prefix: string, agent: string, parameters: Array<{ Name?: string; Value?: string }>): CurrentPointers {
  const names = pointerNames(prefix, agent);
  const byName = new Map(parameters.filter((p) => p.Name).map((p) => [p.Name as string, p.Value]));
  return {
    live: parsePointer(byName.get(names.live)),
    candidate: parsePointer(byName.get(names.candidate), { candidate: true }),
  };
}
