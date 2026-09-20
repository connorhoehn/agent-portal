import { computeCapabilitySources } from './compute-capability-source.js';
import { createComputeCapabilitySessions } from './compute-capability-sessions.js';

const organizationId = (process.env['WORK_GRAPH_ORGANIZATION_ID'] ?? '').trim();

export const computeCapabilitySessions = createComputeCapabilitySessions({
  organizationId,
  sources: computeCapabilitySources,
  maxTtlMs: Number(process.env['WORK_GRAPH_CAPABILITY_MAX_TTL_MS'] ?? 5 * 60_000),
});

export function computeCapabilityConfigured(): boolean {
  return organizationId.length > 0
    && ((process.env['WORK_GRAPH_SERVICE_AUTH_SECRET'] ?? process.env['SERVICE_AUTH_SECRET'] ?? '').trim().length > 0);
}

export function invalidateComputeCapabilitySource(
  source: 'cloud-compute' | 'local-compute',
  revocationKey: string,
): number {
  return computeCapabilitySessions.invalidateByRevocationKey(source, revocationKey);
}
