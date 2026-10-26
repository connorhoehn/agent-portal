// Runtime profile for the BFF: which dependencies are mandatory, validated
// statically before the server listens, then checked live by /health.
//
// `ORGIQ_RUNTIME_PROFILE`:
//   - `local-ephemeral` (default): today's behaviour. Mock domains, memory
//     queues and missing schema report `degraded` with HTTP 200, so dev:mock
//     and partial local stacks keep serving every feature that works.
//   - `durable`: accepted jobs and queue traffic must not be served on
//     substitutes. Aurora, AWS credentials, the job-attempt fencing schema
//     (schema/local_compute_worker_schema.sql) and the message-queue become
//     mandatory; any of them failing, unproven or stale past its budget makes
//     /health 503. A lost router lease stays an immediate 503 in both profiles.
//
// The profile is explicit; it is never inferred from NODE_ENV. Capability
// declarations describe guarantees the adapters were tested for. They never
// probe availability and never replace authorization.

import {
  evaluateCapabilities,
  type CapabilityProvider,
  type CapabilityRequirement,
} from '@connorhoehn/service-runtime/capabilities';
import type { HealthProbeSnapshot } from './health-probe.js';

export type RuntimeProfile = 'local-ephemeral' | 'durable';

export interface ProfileInputs {
  profile?: string;
  /** config.mock: per-domain mock providers. */
  mock: Record<string, boolean>;
  /** True when pipeline queues ride the in-process memory queue. */
  inProcessQueue: boolean;
}

export interface ProfileConfig {
  profile: RuntimeProfile;
  providers: CapabilityProvider[];
  requirements: CapabilityRequirement[];
  configErrors: string[];
}

export function resolveRuntimeProfile(inputs: ProfileInputs): ProfileConfig {
  const configErrors: string[] = [];
  const raw = inputs.profile?.trim() || 'local-ephemeral';
  let profile: RuntimeProfile = 'local-ephemeral';
  if (raw === 'durable' || raw === 'local-ephemeral') profile = raw;
  else configErrors.push(`ORGIQ_RUNTIME_PROFILE must be "local-ephemeral" or "durable", got "${raw}"`);

  const providers: CapabilityProvider[] = [
    // The Data API cluster is the job store; the aurora mock is a memory fixture.
    { id: 'aurora', capabilities: inputs.mock.aurora ? [] : ['persistent', 'conditional-write', 'transactions'] },
    { id: 'aws', capabilities: inputs.mock.agentcore ? [] : ['agent-runtime'] },
    { id: 'message-queue', capabilities: inputs.inProcessQueue ? [] : ['durable-delivery'] },
  ];
  const requirements: CapabilityRequirement[] = profile === 'durable' ? [
    { feature: 'agent-jobs', provider: 'aurora', capabilities: ['persistent', 'conditional-write'] },
    { feature: 'agent-jobs', provider: 'aws', capabilities: ['agent-runtime'] },
    { feature: 'pipeline-queues', provider: 'message-queue', capabilities: ['durable-delivery'] },
  ] : [];
  return { profile, providers, requirements, configErrors };
}

const HINTS: Record<string, string> = {
  aurora: 'MOCK_AURORA keeps jobs in a memory fixture',
  aws: 'MOCK_AGENTCORE replaces the agent runtime',
  'message-queue': 'set MESSAGE_QUEUE_URL and leave MOCK_QUEUE off',
};

/** Static check before the server listens. Returns actionable problems. */
export function validateRuntimeProfile(config: ProfileConfig): string[] {
  const problems = [...config.configErrors];
  for (const issue of evaluateCapabilities(config.providers, config.requirements).issues) {
    if (issue.code === 'missing-capability')
      problems.push(`${issue.feature} needs "${issue.capability}" from ${issue.provider}: ${HINTS[issue.provider ?? ''] ?? 'not declared'}`);
    else problems.push(`${issue.path}: ${issue.code}${issue.provider ? ` (${issue.provider})` : ''}`);
  }
  return problems;
}

export interface DependencyVerdict {
  ok: boolean;
  mandatory: boolean;
  error?: string;
}

/**
 * Judge a cached probe snapshot for readiness. A refreshing snapshot younger
 * than `maxAgeMs` keeps its verdict: health polls arrive slower than the probe
 * TTL, so "stale while its refresh runs" is the steady state, not a fault. An
 * untested, failed or over-age verdict is never ready.
 */
export function judgeSnapshot(snapshot: HealthProbeSnapshot, maxAgeMs: number, now = Date.now()): { ok: boolean; error?: string } {
  if (!snapshot.ok) return { ok: false, error: snapshot.error ?? 'unavailable' };
  if (snapshot.checkedAt !== undefined && now - snapshot.checkedAt > maxAgeMs)
    return { ok: false, error: `last successful check is older than ${Math.round(maxAgeMs / 1000)}s` };
  return { ok: true };
}
