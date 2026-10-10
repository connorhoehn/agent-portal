// The library's `activity()` and `pipeline()` features, mounted on the BFF
// gateway under this host's channel authority (lib/gateway/authority.ts over
// lib/tenant-channels.ts).
//
// Since realtime-modules 0.107 both are configured, not wrapped:
//
//  pipeline  `channelFor` maps the wire `pipeline:run:<id>` onto this host's
//            `pipelines:run:<id>` family (Cedar ViewPipelines, active tenant
//            `pipelines`, re-asked on every subscribe by the router's
//            `authorize`). The firehoses are off (the library default) and
//            answer PIPELINE_CHANNEL_REFUSED. Events leave through the
//            service's `emitEvent` onto the same `pipelines:run:<id>`.
//
//            A flow run id (`sum-…`, `sdk-…`, `adr-…`, lib/flow-runs/channel.ts) maps
//            instead onto its requester-private `<tenant>:flowrun:<id>`, and
//            every FlowRunStore move (claimed/progress/completed/failed) is
//            emitted there through the same `emitEvent` (publishFlowRunMove).
//
//  activity  Library defaults: no client publish, no broadcast auto-subscribe,
//            history only where the router's `checkChannel` admits a
//            subscribe (fail closed). Producers call the service's
//            `publish(channel, event)`, which writes that channel's history
//            and delivers `activity:event` frames carrying `channel`.
//
// A producer only publishes to a channel some family in the allowlist names:
// default-deny holds on the way out as well as in.

import { pipeline, activity, defineFeature, type RealtimeFeature } from '@connorhoehnslalom/realtime-modules/server';
import { producerChannelAllowed } from './gateway/authority.js';
import { flowRunChannel, flowRunTenant } from './flow-runs/channel.js';
import { onFlowRunMove, type FlowRunMove } from './flow-runs/events.js';

const RUN_WIRE_PREFIX = 'pipeline:run:';
const RUN_FAMILY_PREFIX = 'pipelines:run:';

/** `pipeline:run:<id>` → `pipelines:run:<id>`, or a flow run's `<tenant>:flowrun:<id>`;
 * anything else (the firehoses, junk) → null. */
export function pipelineFamilyChannel(wire: unknown): string | null {
  if (typeof wire !== 'string' || !wire.startsWith(RUN_WIRE_PREFIX)) return null;
  const id = wire.slice(RUN_WIRE_PREFIX.length);
  if (!id || id.length > 256 || /\s/.test(id)) return null;
  if (flowRunTenant(id)) return flowRunChannel(id);
  const channel = `${RUN_FAMILY_PREFIX}${id}`;
  return producerChannelAllowed(channel) ? channel : null;
}

interface EmitterService { emitEvent(channel: string, eventType: string, payload: unknown, envelope?: Record<string, unknown>): Promise<void> }
interface ActivityProducer { publish(channel: string, event: { eventType: string; detail?: Record<string, unknown>; userId?: string | null; displayName?: string }): Promise<unknown> }
let pipelineEmitter: EmitterService | null = null;
let activityProducer: ActivityProducer | null = null;
let stopFlowRunFeed: (() => void) | null = null;

/** Drop the live targets (a gateway closing, or a test). */
export function resetGatewayRunFeed(): void {
  pipelineEmitter = null; activityProducer = null;
  stopFlowRunFeed?.(); stopFlowRunFeed = null;
}

/** Remember the service a feature creates, so producers reach `services.<name>`. */
function capture<T>(feature: RealtimeFeature, keep: (service: T) => void): RealtimeFeature {
  return defineFeature({ ...feature, create(ctx) {
    const service = feature.create(ctx);
    keep(service as unknown as T);
    return service;
  } });
}

export function tenantPipeline(): RealtimeFeature {
  return capture<EmitterService>(pipeline({ channelFor: wire => pipelineFamilyChannel(wire) }), s => {
    pipelineEmitter = s;
    stopFlowRunFeed?.();
    stopFlowRunFeed = onFlowRunMove(publishFlowRunMove);
  });
}

export function tenantActivity(): RealtimeFeature {
  return capture<ActivityProducer>(activity(), s => { activityProducer = s; });
}

const PIPELINE_EVENT: Record<string, string> = {
  running: 'pipeline:run:started',
  claimed: 'pipeline:run:started',
  awaiting_approval: 'pipeline:approval:requested',
  completed: 'pipeline:run:completed',
  failed: 'pipeline:run:failed',
  cancelled: 'pipeline:run:completed',
  rejected: 'pipeline:run:completed',
};

/** A run's status moved: one library `pipeline:event` frame and one activity row on `pipelines:run:<id>`. */
export async function publishPipelineRunMove(run: { id: string; status: string; error?: string | null; definitionId?: string | null }): Promise<void> {
  const channel = `${RUN_FAMILY_PREFIX}${run.id}`;
  if (!producerChannelAllowed(channel)) return;
  try {
    const eventType = PIPELINE_EVENT[run.status];
    if (eventType && pipelineEmitter) {
      const failed = run.status === 'cancelled' || run.status === 'rejected';
      await pipelineEmitter.emitEvent(channel, eventType, {
        runId: run.id, pipelineId: run.definitionId ?? undefined, status: run.status,
        ...(run.error ? { error: run.error } : failed ? { error: run.status === 'cancelled' ? 'Cancelled' : 'Rejected' } : {}),
      }, { emittedAt: Date.now() });
    }
    await publishChannelActivity(channel, `run.${run.status}`, { runId: run.id, status: run.status, ...(run.error ? { error: run.error } : {}) });
  } catch (err) {
    console.warn(`[gateway-run-feed] could not publish run ${run.id}: ${(err as Error).message}`);
  }
}

const FLOW_RUN_EVENT: Record<FlowRunMove['kind'], string> = {
  claimed: 'pipeline:run:started',
  progress: 'pipeline:step:started',
  waiting: 'pipeline:approval:requested',
  completed: 'pipeline:run:completed',
  failed: 'pipeline:run:failed',
};

/**
 * A flow run moved: one library `pipeline:event` frame on its requester-private
 * `<tenant>:flowrun:<id>`. The frame is a hint, not the record — it names the
 * run, its status and the step in flight; the result and the full progress stay
 * behind the REST read the portal fetches on every frame. The router re-asks
 * `authorize` for every recipient (requester, fresh row) before delivery.
 */
export async function publishFlowRunMove(move: FlowRunMove): Promise<void> {
  const channel = flowRunChannel(move.runId);
  if (!channel || !pipelineEmitter) return;
  const steps = move.steps ?? [];
  const step = steps.find(s => s.status === 'running') ?? [...steps].reverse().find(s => s.status !== 'pending');
  const status = move.kind === 'claimed' || move.kind === 'progress' ? 'running' : move.kind === 'waiting' ? 'waiting-approval' : move.kind;
  try {
    await pipelineEmitter.emitEvent(channel, FLOW_RUN_EVENT[move.kind], {
      runId: move.runId, status, ...(step ? { stepId: step.id } : {}),
      ...(move.kind === 'failed' ? { error: move.error || 'The run failed.' } : {}),
    }, { emittedAt: Date.now() });
  } catch (err) {
    console.warn(`[gateway-run-feed] could not publish flow run ${move.runId}: ${(err as Error).message}`);
  }
}

/** One server-produced activity row on a channel some family admits. Fire-and-forget safe. */
export async function publishChannelActivity(channel: string, eventType: string, detail: Record<string, unknown> = {},
  actor?: { userId: string | null; displayName?: string }): Promise<void> {
  if (!activityProducer || !producerChannelAllowed(channel)) return;
  try {
    await activityProducer.publish(channel, {
      eventType, detail, userId: actor?.userId ?? null, displayName: actor?.displayName ?? actor?.userId ?? 'System',
    });
  } catch (err) { console.warn(`[gateway-run-feed] activity on ${channel} failed: ${(err as Error).message}`); }
}
