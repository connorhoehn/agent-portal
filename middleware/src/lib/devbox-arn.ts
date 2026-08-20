// Reaching the devbox runtime: its ARN, and the client that talks to it.
//
// Extracted from routes/devbox.ts because two other things now need it — the
// reaper, which stops sessions on a timer, and the project runner, which
// executes a task and then measures the repository. Both are background work
// with no request behind them, so neither can live in a route handler, and
// duplicating ARN resolution would mean two caches that can disagree about
// which runtime is current.

import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { config } from '../config.js';

export const DEVBOX_RUNTIME_NAME = process.env['DEVBOX_RUNTIME_NAME'] ?? 'orgiq_devbox';

/** Long enough to matter, short enough that a redeploy is picked up. */
const ARN_CACHE_TTL_MS = 5 * 60_000;

let _data: BedrockAgentCoreClient | null = null;
let _control: BedrockAgentCoreControlClient | null = null;
let _arnCache: { ts: number; arn: string | null } | null = null;

export function devboxDataClient(): BedrockAgentCoreClient {
  return (_data ??= new BedrockAgentCoreClient({ region: config.region }));
}

function controlClient(): BedrockAgentCoreControlClient {
  return (_control ??= new BedrockAgentCoreControlClient({ region: config.region }));
}

/**
 * The devbox runtime's ARN.
 *
 * Returns null rather than throwing when the runtime is not deployed — that is
 * a normal state for an environment that has not run the devbox stack, and
 * callers say so in their own words.
 */
export async function resolveDevboxArn(): Promise<string | null> {
  const fromEnv = process.env['DEVBOX_RUNTIME_ARN'];
  if (fromEnv) return fromEnv;

  const now = Date.now();
  if (_arnCache && now - _arnCache.ts < ARN_CACHE_TTL_MS) return _arnCache.arn;

  try {
    let nextToken: string | undefined;
    do {
      const resp = await controlClient().send(
        new ListAgentRuntimesCommand({ maxResults: 50, ...(nextToken ? { nextToken } : {}) }),
      );
      for (const rt of resp.agentRuntimes ?? []) {
        if (rt.agentRuntimeName === DEVBOX_RUNTIME_NAME && rt.agentRuntimeArn) {
          _arnCache = { ts: now, arn: rt.agentRuntimeArn };
          return rt.agentRuntimeArn;
        }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
  } catch (err) {
    console.warn('[devbox] runtime ARN lookup failed:', (err as Error).message);
  }
  _arnCache = { ts: now, arn: null };
  return null;
}

/** Test hooks — the route module has equivalents for its own clients. */
export const _arnInternal = {
  setDataClient(c: BedrockAgentCoreClient | null): void { _data = c; },
  setControlClient(c: BedrockAgentCoreControlClient | null): void { _control = c; },
  reset(): void { _arnCache = null; },
};
