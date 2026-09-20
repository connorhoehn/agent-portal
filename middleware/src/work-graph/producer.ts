/**
 * Authenticated producer for the Active now projection.
 *
 * This process never accepts an actor, organisation, or credential identifier
 * from a browser, paired machine, or AgentCore callback.  The lifecycle hook
 * supplies only a durable owner already established by pairing/provisioning;
 * the organisation and service credential come from this service's deployment
 * configuration.  Platform-api performs the second, authoritative source
 * account join before committing the projection.
 */
import { SERVICE_AUTH_HEADER, signEnvelope } from '@connorhoehn/service-runtime';
import { AppError } from '../lib/async-handler.js';

export const WORK_GRAPH_PRODUCER_SERVICE_ID = 'aws-agentcore';

export interface WorkGraphProducerContext {
  actor: { actorId: string; organizationId: string; sourceSubject: string };
  producer: { serviceId: typeof WORK_GRAPH_PRODUCER_SERVICE_ID; organizationId: string; credentialId: string };
  receivedAt: string;
}

export interface WorkGraphProducerEvent {
  eventId: string;
  source: 'cloud-compute' | 'local-compute';
  actor: WorkGraphProducerContext['actor'];
  producer: WorkGraphProducerContext['producer'];
}

export class WorkGraphDeliveryError extends AppError {
  constructor(readonly responseStatus: number | null, message: string) {
    // Source lifecycle callbacks must surface a retryable outage to their
    // machine caller rather than reporting success for a transition that was
    // not durably committed by the graph service.
    super(responseStatus !== null && responseStatus >= 400 && responseStatus < 500 ? 502 : 503, message);
    this.name = 'WorkGraphDeliveryError';
  }
}

export interface WorkGraphProducerConfig {
  platformApiUrl: string;
  secret: string;
  organizationId: string;
  credentialId: string;
  attempts: number;
  retryDelayMs: number;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Configuration is deliberately all-or-nothing.  A partially configured
 * producer must not manufacture a tenant or pretend that an unsigned event
 * reached the graph.  Keeping this lookup live also lets a rotated secret take
 * effect without leaving a stale value closed over in a long-lived listener.
 */
export function workGraphProducerConfig(env: NodeJS.ProcessEnv = process.env): WorkGraphProducerConfig | null {
  const platformApiUrl = nonEmpty(env['PLATFORM_API_URL']);
  // This is the existing service-runtime v1 secret, not a source-specific
  // token format. The explicit name permits least-privilege injection while
  // SERVICE_AUTH_SECRET keeps parity with platform-api's receiver.
  const secret = nonEmpty(env['WORK_GRAPH_SERVICE_AUTH_SECRET']) ?? nonEmpty(env['SERVICE_AUTH_SECRET']);
  const organizationId = nonEmpty(env['WORK_GRAPH_ORGANIZATION_ID']);
  const credentialId = nonEmpty(env['WORK_GRAPH_SOURCE_CREDENTIAL_ID']);
  if (!platformApiUrl || !secret || !organizationId || !credentialId) return null;
  const parsedAttempts = Number(env['WORK_GRAPH_INGEST_ATTEMPTS'] ?? 3);
  const parsedDelay = Number(env['WORK_GRAPH_INGEST_RETRY_DELAY_MS'] ?? 150);
  return {
    platformApiUrl: platformApiUrl.replace(/\/$/, ''),
    secret,
    organizationId,
    credentialId,
    attempts: Number.isInteger(parsedAttempts) && parsedAttempts >= 1 && parsedAttempts <= 5 ? parsedAttempts : 3,
    retryDelayMs: Number.isFinite(parsedDelay) && parsedDelay >= 0 && parsedDelay <= 5_000 ? parsedDelay : 150,
  };
}

/** A context can only be constructed from a source-owned durable owner id. */
export function workGraphContextForOwner(
  ownerId: string | undefined | null,
  receivedAt = new Date().toISOString(),
  env: NodeJS.ProcessEnv = process.env,
): WorkGraphProducerContext | null {
  const config = workGraphProducerConfig(env);
  const owner = nonEmpty(ownerId ?? undefined);
  if (!config || !owner) return null;
  return {
    actor: { actorId: owner, organizationId: config.organizationId, sourceSubject: owner },
    producer: {
      serviceId: WORK_GRAPH_PRODUCER_SERVICE_ID,
      organizationId: config.organizationId,
      credentialId: config.credentialId,
    },
    receivedAt,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs directly to the platform's durable ingestion boundary. A successful
 * response means the platform has completed its source-account join and
 * projection commit; it is never a fire-and-forget proxy acknowledgement.
 */
export async function publishWorkGraphEvent(
  event: WorkGraphProducerEvent,
  config = workGraphProducerConfig(),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!config) throw new WorkGraphDeliveryError(null, 'work graph producer is not configured');
  const url = `${config.platformApiUrl}/internal/work-graph/ingest`;
  let lastError: WorkGraphDeliveryError | null = null;
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SERVICE_AUTH_HEADER]: signEnvelope(event as object, {
            secret: config.secret,
            serviceId: WORK_GRAPH_PRODUCER_SERVICE_ID,
          }),
        },
        body: JSON.stringify(event),
      });
      if (response.ok) return;
      // 4xx means either source-account authorization or contract validation
      // failed; retrying cannot turn an invalid claim into an authorized one.
      const retryable = response.status >= 500 || response.status === 429;
      lastError = new WorkGraphDeliveryError(response.status, `work graph ingestion rejected (${response.status})`);
      if (!retryable) throw lastError;
    } catch (error) {
      if (error instanceof WorkGraphDeliveryError && error.responseStatus !== null && error.responseStatus < 500 && error.responseStatus !== 429) throw error;
      lastError = error instanceof WorkGraphDeliveryError
        ? error
        : new WorkGraphDeliveryError(null, `work graph ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < config.attempts) await wait(config.retryDelayMs * attempt);
  }
  throw lastError ?? new WorkGraphDeliveryError(null, 'work graph ingestion failed');
}
