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
import { mockDevboxClient } from '../mock/devbox-shell.js';

export const DEVBOX_RUNTIME_NAME = process.env['DEVBOX_RUNTIME_NAME'] ?? 'orgiq_devbox';

/** Long enough to matter, short enough that a redeploy is picked up. */
const ARN_CACHE_TTL_MS = 5 * 60_000;

let _data: BedrockAgentCoreClient | null = null;
let _control: BedrockAgentCoreControlClient | null = null;
let _arnCache: { ts: number; arn: string | null } | null = null;

/**
 * An offline runtime's ARN.
 *
 * Built from the same region and account the real one would carry, with an
 * account of all zeroes when none is configured, and a runtime id that says
 * what it is. Nothing dereferences it offline — `mockDevboxClient` ignores the
 * ARN entirely, and so does `mockAgentCore.invokeAgent` — so the only job it
 * has is to be recognisable in a log line as a runtime that was never
 * deployed.
 *
 * WHY IT TAKES A NAME. It was `mockDevboxArn()`, private, because the devbox
 * was the only runtime `dev:mock` had to name. `routes/invocations.ts`'s
 * replay needs the same sentence for a *fleet* runtime, and the alternative
 * was a second spelling of "-MOCK" in another file — the drift this repo has
 * already been bitten by twice. One function, two callers, one suffix.
 */
export function mockRuntimeArn(runtimeName: string): string {
  const account = config.accountId || '000000000000';
  return `arn:aws:bedrock-agentcore:${config.region}:${account}:runtime/${runtimeName}-MOCK`;
}

/**
 * The client every devbox caller uses.
 *
 * Offline this is `mockDevboxClient()` — a fake microVM (see
 * `mock/devbox-shell.ts`) rather than a mock branch in each caller, so
 * `project-runner.ts` and `sdlc-pipeline.ts` run their real sequencing and
 * their real failure handling against it and only the sandbox is imaginary.
 */
export function devboxDataClient(): BedrockAgentCoreClient {
  if (_data) return _data;
  return (_data = config.mock.agentcore
    ? mockDevboxClient()
    : new BedrockAgentCoreClient({ region: config.region }));
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

  // Offline the answer is "yes, there is a runtime" and it is a fake one.
  // Returning null here instead was the single blocker that made the whole
  // governed-run and delivery surface 503 in `dev:mock` — every caller of this
  // says "the devbox runtime is not deployed" and stops, before any provider
  // (mocked or not) is reached. Not cached: the cache exists to bound a live
  // ListAgentRuntimes call, and there is none to bound.
  if (config.mock.agentcore) return mockRuntimeArn(DEVBOX_RUNTIME_NAME);

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
