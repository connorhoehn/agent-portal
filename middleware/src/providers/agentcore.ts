// AgentCore provider — talks to Bedrock AgentCore control plane (runtimes) and
// data plane (code-interp + browser sessions). Falls back cleanly to empty
// arrays when no resources are deployed yet, since this stack scales to zero.
//
// Metric fields on AgentRuntimeSummary (latency/invocations/errors/tokens) are
// out of scope here — they're hydrated by the CloudWatch provider in Wave 2.

import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
  GetAgentRuntimeCommand,
  type ListAgentRuntimesCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  Statistic,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import {
  BedrockAgentCoreClient,
  GetBrowserSessionCommand,
  InvokeAgentRuntimeCommand,
  InvokeBrowserCommand,
  InvokeCodeInterpreterCommand,
  ListBrowserSessionsCommand,
  ListCodeInterpreterSessionsCommand,
  StartBrowserSessionCommand,
  StartCodeInterpreterSessionCommand,
  StopBrowserSessionCommand,
  StopCodeInterpreterSessionCommand,
  type ListBrowserSessionsCommandOutput,
  type ListCodeInterpreterSessionsCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import WebSocket from 'ws';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Sha256 } from '@aws-crypto/sha256-js';

import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import type {
  AgentCoreProvider,
  AgentRuntimeSummary,
  AgentMetrics,
  AgentInvokeResult,
  BrowserScreenshot,
  CodeExecutionResult,
  CodeSession,
  BrowserSession,
} from './types.js';

import { attempt, reached, unreachable, type Upstream } from '../lib/upstream.js';

import { mockAgents } from '../mock/agent-statuses.js';
import { browserSessions, codeSessions } from '../mock/capabilities.js';
import { selectMockResponse } from '../mock/responses.js';

// ─── Non-streaming agents → AG-UI events ────────────────────────────
//
// Only the supervisor speaks AG-UI over SSE. The other seven Strands agents
// (search, scoring, advisor, ingestion, graph-builder, assessment-scorer,
// assessment-drafter) answer with a SINGLE JSON envelope —
// `{agent, response, invocationId, toolCalls[]}`, or `{agent, error}` — which
// AgentCore returns as `contentType: application/json`, not
// `text/event-stream`.
//
// That framing difference silently ate every direct invoke of those seven. The
// reader in invokeAgentStreaming only forwards lines starting with `data: `, so
// a bare JSON body matched nothing and the generator ended having yielded zero
// events; the route in `routes/agents.ts` then wrapped its own
// RUN_STARTED/RUN_FINISHED around nothing and the caller got an empty,
// successful-looking answer. Verified against the deployed fleet: orgiq_search
// answered correctly, naming a real person with a real expertise score, and the
// middleware discarded it. Nothing logged, HTTP 200 — an empty that lies.
//
// So framing is normalized HERE, in the transport, and the envelope is
// projected onto the AG-UI events the route and portal already implement.
// Every downstream consumer stays unchanged.
function* envelopeToAguiEvents(raw: string): Generator<unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return;

  let env: Record<string, unknown>;
  try {
    env = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Neither SSE nor JSON. Report the body rather than nothing — a truncated
    // response or an HTML error page is exactly what the silent path hid.
    yield { type: 'RUN_ERROR', message: `Agent returned an unparseable response: ${trimmed.slice(0, 300)}` };
    return;
  }

  // The agents' own failure shape. The route re-throws on RUN_ERROR, so this
  // reaches the caller as an error instead of a blank answer.
  const err = env['error'];
  if (typeof err === 'string' && err) {
    yield { type: 'RUN_ERROR', message: err };
    return;
  }

  // Tool calls first, so citation chips are in place before the text lands —
  // the order the streaming agent produces and the portal expects.
  const toolCalls = Array.isArray(env['toolCalls']) ? env['toolCalls'] : [];
  for (const entry of toolCalls) {
    const tc = (entry ?? {}) as Record<string, unknown>;
    const id = typeof tc['id'] === 'string' && tc['id'] ? tc['id'] : randomUUID();
    const name = typeof tc['name'] === 'string' && tc['name'] ? tc['name'] : 'unknown';
    yield { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name };
    const args = tc['args'];
    if (args !== undefined && args !== null) {
      yield {
        type: 'TOOL_CALL_ARGS',
        toolCallId: id,
        delta: typeof args === 'string' ? args : JSON.stringify(args),
      };
    }
    yield { type: 'TOOL_CALL_END', toolCallId: id };
    if (tc['result'] !== undefined) {
      yield { type: 'TOOL_CALL_RESULT', toolCallId: id, content: tc['result'] };
    }
  }

  // `response` is the field all seven set; the others are accepted so an agent
  // spelling it differently degrades to "renders anyway" rather than "blank".
  let text = '';
  for (const key of ['response', 'message', 'text', 'output'] as const) {
    const v = env[key];
    if (typeof v === 'string' && v) { text = v; break; }
  }

  if (text) {
    const messageId = randomUUID();
    yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text };
    yield { type: 'TEXT_MESSAGE_END', messageId };
    return;
  }

  // Parsed cleanly, no error, and still no answer. That is a contract break by
  // the agent, not an empty answer — say so, rather than return the blank this
  // function exists to prevent. A tool-call-only turn is legitimate, so it is
  // not treated as an anomaly.
  if (toolCalls.length === 0) {
    yield {
      type: 'RUN_ERROR',
      message: `Agent returned no answer field (keys: ${Object.keys(env).join(', ') || 'none'})`,
    };
  }
}


// ─── Clients (lazy, shared) ───────────────────────────────────────────────────

let _control: BedrockAgentCoreControlClient | null = null;
let _data: BedrockAgentCoreClient | null = null;

function controlClient(): BedrockAgentCoreControlClient {
  if (!_control) {
    _control = new BedrockAgentCoreControlClient({ region: config.region });
  }
  return _control;
}

function dataClient(): BedrockAgentCoreClient {
  if (!_data) {
    _data = new BedrockAgentCoreClient({ region: config.region });
  }
  return _data;
}

// ─── Status mapping ───────────────────────────────────────────────────────────

type AwsRuntimeStatus =
  | 'CREATING'
  | 'CREATE_FAILED'
  | 'UPDATING'
  | 'UPDATE_FAILED'
  | 'READY'
  | 'DELETING'
  | string;

function mapRuntimeStatus(s: AwsRuntimeStatus | undefined): AgentRuntimeSummary['status'] {
  switch (s) {
    case 'READY':
      return 'healthy';
    case 'CREATING':
    case 'UPDATING':
      return 'deploying';
    case 'CREATE_FAILED':
    case 'UPDATE_FAILED':
      return 'offline';
    default:
      // DELETING + anything unrecognized — still up but unhealthy
      return 'degraded';
  }
}

function mapServerProtocol(p: string | undefined): AgentRuntimeSummary['protocol'] {
  // AgentCore server protocols: MCP | HTTP | A2A | AGUI. Our shape only models
  // 'ag-ui' and 'a2a'. AGUI/HTTP/MCP collapse to 'ag-ui' for now.
  return p === 'A2A' ? 'a2a' : 'ag-ui';
}

function runtimeEndpoint(id: string | undefined): string {
  if (!id) return '';
  return `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/${id}/invocations`;
}

// ─── Runtime ARN resolution (friendly id → ARN) ───────────────────────────────

// Portal sends URLs like `/api/agents/orgiq-supervisor/invoke`, but the AWS
// runtime name is `orgiq_supervisor` and the runtime ID is
// `orgiq_supervisor-0D95cZBsPU`. Cache the lookup so we don't list every call.

const ARN_CACHE_TTL_MS = 60_000;
let _arnCache: { ts: number; map: Map<string, string> } | null = null;

async function resolveRuntimeArn(agentId: string): Promise<string | null> {
  const now = Date.now();
  if (!_arnCache || now - _arnCache.ts > ARN_CACHE_TTL_MS) {
    const map = new Map<string, string>();
    try {
      let nextToken: string | undefined = undefined;
      do {
        const resp: ListAgentRuntimesCommandOutput = await controlClient().send(
          new ListAgentRuntimesCommand({ maxResults: 50, nextToken }),
        );
        for (const rt of resp.agentRuntimes ?? []) {
          const arn = rt.agentRuntimeArn;
          if (!arn) continue;
          if (rt.agentRuntimeId) map.set(rt.agentRuntimeId, arn);
          if (rt.agentRuntimeName) {
            map.set(rt.agentRuntimeName, arn);
            map.set(rt.agentRuntimeName.replace(/_/g, '-'), arn);
          }
        }
        nextToken = resp.nextToken;
      } while (nextToken);
      _arnCache = { ts: now, map };
    } catch (err) {
      console.warn('[agentcore] resolveRuntimeArn list failed:', (err as Error).message);
      if (_arnCache) return _arnCache.map.get(agentId) ?? null;
      return null;
    }
  }

  return (
    _arnCache.map.get(agentId) ??
    _arnCache.map.get(agentId.replace(/-/g, '_')) ??
    null
  );
}

async function streamToString(stream: unknown): Promise<string> {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  if (stream instanceof Uint8Array) return new TextDecoder().decode(stream);
  // Smithy SDK byte streams expose transformToString().
  const s = stream as { transformToString?: () => Promise<string>; transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof s.transformToString === 'function') {
    return await s.transformToString();
  }
  if (typeof s.transformToByteArray === 'function') {
    return new TextDecoder().decode(await s.transformToByteArray());
  }
  // Fallback: async-iterate chunks.
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

// ─── Runtime metric hydration ─────────────────────────────────────────────────

let _cwClient: CloudWatchClient | null = null;
function cwClient(): CloudWatchClient {
  if (!_cwClient) _cwClient = new CloudWatchClient({ region: config.region });
  return _cwClient;
}

interface RuntimeMetrics {
  invocations: number;
  errors: number;
  /** null when CloudWatch returned no latency samples for this runtime. */
  avgLatencyMs: number | null;
}

// Pull Invocations + Errors + Latency for every runtime ARN in one batched
// call. We use GetMetricData (not GetMetricStatistics) so we can fetch 3 series
// per runtime in a single API hit. Returns metrics aligned by the input array.
async function fetchRuntimeMetrics(arns: string[]): Promise<(RuntimeMetrics | null)[]> {
  if (arns.length === 0) return [];
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  const queries: MetricDataQuery[] = [];
  for (let i = 0; i < arns.length; i++) {
    const arn = arns[i];
    if (!arn) continue;
    // Pull the runtime name from the ARN (`...:runtime/<name>-<hash>`) and
    // build the `<name>::DEFAULT` dimension that CloudWatch requires.
    const runtimeId = arn.split('/').pop() ?? '';
    const runtimeBaseName = runtimeId.replace(/-[A-Za-z0-9]{10}$/, '');
    const dimensions = [
      { Name: 'Resource', Value: arn },
      { Name: 'Operation', Value: 'InvokeAgentRuntime' },
      { Name: 'Name', Value: `${runtimeBaseName}::DEFAULT` },
    ];
    // 1-hour buckets — summed client-side. Period 86400 (one big bucket)
    // tends to return zero datapoints in practice because CloudWatch's bucket
    // boundaries don't align with our query window.
    queries.push({
      Id: `inv_${i}`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock-AgentCore', MetricName: 'Invocations', Dimensions: dimensions },
        Period: 3600,
        Stat: Statistic.Sum,
      },
      ReturnData: true,
    });
    queries.push({
      Id: `err_${i}`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock-AgentCore', MetricName: 'SystemErrors', Dimensions: dimensions },
        Period: 3600,
        Stat: Statistic.Sum,
      },
      ReturnData: true,
    });
    queries.push({
      Id: `lat_${i}`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock-AgentCore', MetricName: 'Latency', Dimensions: dimensions },
        Period: 3600,
        Stat: Statistic.Average,
      },
      ReturnData: true,
    });
  }

  if (queries.length === 0) return arns.map(() => null);

  const resp = await cwClient().send(
    new GetMetricDataCommand({
      MetricDataQueries: queries,
      StartTime: start,
      EndTime: end,
      ScanBy: 'TimestampDescending',
    }),
  );

  // Sum (or average) all bucket values per query id.
  const sumById = new Map<string, number>();
  const countById = new Map<string, number>();
  for (const r of resp.MetricDataResults ?? []) {
    if (!r.Id) continue;
    const values = r.Values ?? [];
    const sum = values.reduce((a, b) => a + b, 0);
    sumById.set(r.Id, sum);
    countById.set(r.Id, values.length);
  }

  return arns.map((_, i) => {
    const latencySum = sumById.get(`lat_${i}`) ?? 0;
    const latencyCount = countById.get(`lat_${i}`) ?? 0;
    return {
      invocations: Math.round(sumById.get(`inv_${i}`) ?? 0),
      errors: Math.round(sumById.get(`err_${i}`) ?? 0),
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    };
  });
}

// ─── Browser CDP helpers ──────────────────────────────────────────────────────

// Track the current URL per session so listBrowserSessions can show it. CDP
// doesn't push "current url changed" events without subscription, and AWS
// doesn't expose it via GetBrowserSession, so we cache locally.
const _browserUrlState = new Map<string, { url: string; title: string; requests: number }>();

async function getCdpEndpoint(sessionId: string): Promise<string | null> {
  const browserId = config.agentcore.browserId;
  if (!browserId) return null;
  const resp = await dataClient().send(
    new GetBrowserSessionCommand({
      browserIdentifier: browserId,
      sessionId,
    }),
  );
  return resp.streams?.automationStream?.streamEndpoint ?? null;
}

// Sign a GET request to the WebSocket URL with SigV4 (service=bedrock-agentcore).
// The returned headers are passed to the WebSocket upgrade so AWS can validate
// caller identity before promoting the connection to a CDP stream.
async function signedWsHeaders(wsUrl: string): Promise<Record<string, string>> {
  const u = new URL(wsUrl.replace(/^wss:/, 'https:'));
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: config.region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  const req = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: u.hostname,
    path: u.pathname + (u.search || ''),
    headers: {
      host: u.hostname,
    },
  });
  const signed = await signer.sign(req);
  return signed.headers as Record<string, string>;
}

// Open one signed WebSocket to a session's CDP endpoint and run the supplied
// async block over it. Handles target attach + sequential JSON-RPC calls so
// callers can just do `await session.call('Page.navigate', { url })`.
async function withCdpSession<T>(
  sessionId: string,
  fn: (call: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T | null> {
  const wsUrl = await getCdpEndpoint(sessionId);
  if (!wsUrl) return null;

  const headers = await signedWsHeaders(wsUrl);
  // Drop headers `ws` manages itself — leaving them would either be no-ops or
  // confuse the upgrade negotiation. `host` we do want to forward so the server
  // matches it against the signed canonical request.
  const drop = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']);
  const forwarded: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!drop.has(k.toLowerCase())) forwarded[k] = v;
  }

  return new Promise<T | null>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: forwarded, perMessageDeflate: false });
    let nextId = 1;
    let attachedCdpSession: string | null = null;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    const overallTimeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP session timed out'));
    }, 30000);

    const rawCall = (method: string, params: unknown = {}, sessionScope?: string): Promise<unknown> => {
      return new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        const msg: Record<string, unknown> = { id, method, params };
        if (sessionScope) msg.sessionId = sessionScope;
        ws.send(JSON.stringify(msg));
      });
    };

    const call = async (method: string, params: unknown = {}): Promise<unknown> => {
      return rawCall(method, params, attachedCdpSession ?? undefined);
    };

    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const waiter = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`CDP error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else waiter.resolve(msg.result);
      }
      // Other messages (Page events, Target events) are ignored for the one-shot flow.
    });

    ws.on('error', (err) => {
      clearTimeout(overallTimeout);
      reject(err);
    });

    ws.on('open', async () => {
      try {
        // Multi-target: find a page target and attach to it (flatten=true makes
        // commands routed via sessionId on a shared connection).
        const targetsRaw = (await rawCall('Target.getTargets')) as { targetInfos?: Array<{ type?: string; targetId?: string }> };
        const page = (targetsRaw.targetInfos ?? []).find((t) => t.type === 'page');
        if (!page?.targetId) {
          throw new Error('no page target available');
        }
        const attach = (await rawCall('Target.attachToTarget', {
          targetId: page.targetId,
          flatten: true,
        })) as { sessionId?: string };
        attachedCdpSession = attach.sessionId ?? null;
        if (!attachedCdpSession) throw new Error('Target.attachToTarget did not return a sessionId');

        const result = await fn(call);
        clearTimeout(overallTimeout);
        try { ws.close(); } catch {}
        resolve(result);
      } catch (err) {
        clearTimeout(overallTimeout);
        try { ws.close(); } catch {}
        reject(err);
      }
    });
  });
}

const THINKING_RE = /<thinking>[\s\S]*?<\/thinking>/gi;

function extractText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.replace(THINKING_RE, '').trim();
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['response', 'text', 'message', 'output', 'content']) {
      const v = obj[key];
      if (typeof v === 'string') return v.replace(THINKING_RE, '').trim();
    }
    return JSON.stringify(raw);
  }
  return String(raw);
}

// Extract the agent's surfaced tool-call list. Agents project their
// TraceContext.tool_calls onto `toolCalls: [{name, args, result}, ...]` in the
// response dict; we accept anything with a `name` and pass `args` / `result`
// through unchanged. Malformed entries are dropped so a noisy agent response
// can't crash the route.
function extractToolCalls(raw: unknown): import('./types.js').AgentInvokeToolCall[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as Record<string, unknown>)['toolCalls'];
  if (!Array.isArray(list)) return [];
  const out: import('./types.js').AgentInvokeToolCall[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = rec['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    out.push({ name, args: rec['args'] ?? '', result: rec['result'] ?? '' });
  }
  return out;
}

// ─── Real provider ────────────────────────────────────────────────────────────

export const realAgentCore: AgentCoreProvider = {
  /**
   * The fleet, and whether the control plane answered.
   *
   * This used to `return []` on a failed `ListAgentRuntimes`, which is how a
   * rebuilt account came to read as "nothing is deployed" (CLAUDE.md records
   * that incident) and how `GET /api/agent-detail/:id` came to answer
   * `404 No agent runtime matching "orgiq-supervisor"` — a sentence claiming
   * the agent was deleted, about a call that never completed.
   *
   * The paging catch is now the only thing that degrades. The METRIC
   * hydration catch below deliberately does not: CloudWatch failing leaves a
   * true list of runtimes carrying zeroed counters, which is a partial answer
   * about a fleet we did successfully enumerate, and marking the whole listing
   * degraded for it would cry wolf on every account where the metrics have
   * simply not been published yet.
   */
  async listRuntimesResult(): Promise<Upstream<AgentRuntimeSummary[]>> {
    const client = controlClient();
    const out: AgentRuntimeSummary[] = [];
    let nextToken: string | undefined = undefined;
    const arnByIdx: string[] = [];

    try {
      do {
        const resp: ListAgentRuntimesCommandOutput = await client.send(
          new ListAgentRuntimesCommand({ maxResults: 50, nextToken }),
        );
        for (const rt of resp.agentRuntimes ?? []) {
          arnByIdx.push(rt.agentRuntimeArn ?? '');
          out.push({
            id: rt.agentRuntimeId ?? rt.agentRuntimeArn ?? '',
            name: rt.agentRuntimeName ?? rt.agentRuntimeId ?? 'unknown',
            status: mapRuntimeStatus(rt.status),
            protocol: 'ag-ui',
            model: '',
            tools: [],
            guardrails: [],
            endpoint: runtimeEndpoint(rt.agentRuntimeId),
            latencyP50Ms: 0,
            latencyP99Ms: 0,
            invocationsLast24h: 0,
            errorsLast24h: 0,
            tokensLast24h: 0,
          });
        }
        nextToken = resp.nextToken;
      } while (nextToken);
    } catch (err) {
      // Still an empty list for anyone who only wants rows — but the caller
      // can now tell this empty from a fleet that is genuinely not deployed.
      console.warn('[agentcore] listRuntimes failed:', (err as Error).message);
      return unreachable([] as AgentRuntimeSummary[], err, 'ListAgentRuntimes failed');
    }

    // Hydrate metrics in a single GetMetricData call (one call total instead
    // of N×3). Each runtime contributes 3 query IDs: invocations, errors,
    // latency. Sums + average over the last 24h.
    try {
      const metrics = await fetchRuntimeMetrics(arnByIdx);
      for (let i = 0; i < out.length; i++) {
        const m = metrics[i];
        if (!m) continue;
        out[i]!.invocationsLast24h = m.invocations;
        out[i]!.errorsLast24h = m.errors;
        // `avgLatencyMs` is null when CloudWatch returned no latency samples
        // for this runtime. Don't overwrite with a fabricated number — and
        // don't widen `AgentRuntimeSummary` here either: its two latency
        // fields are `number` across the fleet fixture, the architecture graph
        // and two pages, so the honest null has to reach them in one move
        // rather than arriving as a surprise. Tracked as a class-4 candidate.
        if (m.avgLatencyMs != null) {
          out[i]!.latencyP50Ms = m.avgLatencyMs;
          out[i]!.latencyP99Ms = m.avgLatencyMs; // p99 metric not exposed; reuse avg
        }
      }
    } catch (err) {
      console.warn('[agentcore] listRuntimes metric hydration failed:', (err as Error).message);
    }

    return reached(out);
  },

  /** The lossy view — see the interface. Byte-identical to what this method
   *  returned before `listRuntimesResult` existed, including the empty list on
   *  failure, so no unconverted caller changes behaviour. */
  async listRuntimes(): Promise<AgentRuntimeSummary[]> {
    return (await this.listRuntimesResult()).items;
  },

  async getRuntime(agentId: string): Promise<AgentRuntimeSummary | null> {
    try {
      const resp = await controlClient().send(
        new GetAgentRuntimeCommand({ agentRuntimeId: agentId }),
      );
      return {
        id: resp.agentRuntimeId ?? agentId,
        name: resp.agentRuntimeName ?? agentId,
        status: mapRuntimeStatus(resp.status),
        protocol: mapServerProtocol(resp.protocolConfiguration?.serverProtocol),
        model: '',
        tools: [],
        guardrails: [],
        endpoint: runtimeEndpoint(resp.agentRuntimeId),
        latencyP50Ms: 0,
        latencyP99Ms: 0,
        invocationsLast24h: 0,
        errorsLast24h: 0,
        tokensLast24h: 0,
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'ResourceNotFoundException') return null;
      console.warn('[agentcore] getRuntime failed:', (err as Error).message);
      return null;
    }
  },

  async getRuntimeMetrics(agentId: string): Promise<AgentMetrics | null> {
    // Metrics come from CloudWatch — Wave 2 hydrates this. Return zeros so the
    // route still has a typed payload to serve.
    const rt = await this.getRuntime(agentId);
    if (!rt) return null;
    return {
      agentId: rt.id,
      latencyP50Ms: 0,
      latencyP99Ms: 0,
      invocationsLast24h: 0,
      errorsLast24h: 0,
      tokensLast24h: 0,
      successRate: '100.00%',
    };
  },

  async invokeAgent(agentId, payload): Promise<AgentInvokeResult> {
    const arn = await resolveRuntimeArn(agentId);
    if (!arn) {
      throw new Error(`Agent runtime not found for "${agentId}"`);
    }

    const body = JSON.stringify({
      ...payload.structuredInput,
      message: payload.message,
      prompt: payload.message,
      input_text: payload.message,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.userId ? { userId: payload.userId } : {}),
      ...(payload.auth ? { auth: payload.auth } : {}),
      ...(payload.history?.length ? { history: payload.history } : {}),
    });

    const resp = await dataClient().send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: arn,
        qualifier: 'DEFAULT',
        payload: new TextEncoder().encode(body),
        ...(payload.sessionId ? { runtimeSessionId: payload.sessionId } : {}),
      }),
      payload.timeoutMs ? { abortSignal: AbortSignal.timeout(payload.timeoutMs) } : undefined,
    );

    const text = await streamToString(resp.response);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }

    let sandboxExecutions: import('./types.js').SandboxExecution[] | undefined;
    if (raw && typeof raw === 'object') {
      const execs = (raw as Record<string, unknown>)['sandboxExecutions'];
      if (Array.isArray(execs) && execs.length > 0) {
        sandboxExecutions = execs as import('./types.js').SandboxExecution[];
      }
    }

    const toolCalls = extractToolCalls(raw);

    return {
      text: extractText(raw),
      raw,
      runtimeSessionId: resp.runtimeSessionId,
      ...(sandboxExecutions ? { sandboxExecutions } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  },

  async *invokeAgentStreaming(agentId, payload): AsyncGenerator<unknown> {
    const arn = await resolveRuntimeArn(agentId);
    if (!arn) {
      throw new Error(`Agent runtime not found for "${agentId}"`);
    }

    const body = JSON.stringify({
      message: payload.message,
      prompt: payload.message,
      input_text: payload.message,
      stream: true,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.userId ? { userId: payload.userId } : {}),
      ...(payload.auth ? { auth: payload.auth } : {}),
      ...(payload.history?.length ? { history: payload.history } : {}),
    });

    const resp = await dataClient().send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: arn,
        qualifier: 'DEFAULT',
        accept: 'text/event-stream',
        payload: new TextEncoder().encode(body),
        ...(payload.sessionId ? { runtimeSessionId: payload.sessionId } : {}),
      }),
    );

    // Parse SSE lines from the streaming response.
    const stream = resp.response;
    if (!stream) return;

    // The raw body is kept alongside the line buffer because a non-SSE agent
    // (see envelopeToAguiEvents) sends one JSON object with no `data: ` prefix
    // and no trailing newline — the line walk below discards every byte of it.
    // `sawSse` records whether the response ACTUALLY was an event stream, which
    // is the only reliable signal: `accept` is a request header, and asking for
    // text/event-stream does not make an agent produce one.
    let buffer = '';
    let raw = '';
    let sawSse = false;
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      const text = new TextDecoder().decode(chunk);
      raw += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const ev = JSON.parse(jsonStr);
          sawSse = true;
          yield ev;
        } catch {
          // Malformed SSE line — skip.
        }
      }
    }
    // Flush any remaining buffered line.
    if (buffer.startsWith('data: ')) {
      const jsonStr = buffer.slice(6).trim();
      if (jsonStr) {
        try {
          const ev = JSON.parse(jsonStr);
          sawSse = true;
          yield ev;
        } catch { /* skip */ }
      }
    }

    // Not an event stream after all: project the single JSON envelope onto the
    // same AG-UI events an SSE agent would have emitted.
    if (!sawSse) {
      yield* envelopeToAguiEvents(raw);
    }
  },

  /**
   * Code Interpreter sessions, and whether the data plane answered.
   *
   * An unset `CODE_INTERPRETER_ID` is NOT degraded: nothing is misconfigured
   * and nothing failed, the capability is simply not wired here, and reporting
   * that as a failure would put a red banner on every laptop running without
   * `.env.aws`. A failed `ListCodeInterpreterSessions` is degraded — and this
   * is the surface where that matters most, because CLAUDE.md's own gotcha
   * list records that a stale `CODE_INTERPRETER_ID` surviving a rebuild fails
   * as a bare "not found", which the old empty list rendered as "no sandbox is
   * running".
   */
  async listCodeSessionsResult(): Promise<Upstream<CodeSession[]>> {
    const ciId = config.agentcore.codeInterpreterId;
    if (!ciId) return reached([]);

    const out: CodeSession[] = [];
    let nextToken: string | undefined = undefined;
    try {
      do {
        const resp: ListCodeInterpreterSessionsCommandOutput = await dataClient().send(
          new ListCodeInterpreterSessionsCommand({
            codeInterpreterIdentifier: ciId,
            maxResults: 50,
            nextToken,
          }),
        );
        for (const s of resp.items ?? []) {
          const startedAt = s.createdAt ? s.createdAt.toISOString() : new Date(0).toISOString();
          const lastActivityAt = s.lastUpdatedAt
            ? s.lastUpdatedAt.toISOString()
            : startedAt;
          out.push({
            sessionId: s.sessionId ?? '',
            agentName: s.name ?? 'unknown',
            // SDK only exposes READY|TERMINATED — map to our richer enum.
            status: s.status === 'TERMINATED' ? 'TERMINATED' : 'ACTIVE',
            startedAt,
            lastActivityAt,
            executionCount: 0,
            lastCode: '',
            lastOutput: '',
            memoryUsageMb: 0,
          });
        }
        nextToken = resp.nextToken;
      } while (nextToken);
    } catch (err) {
      console.warn('[agentcore] listCodeSessions failed:', (err as Error).message);
      return unreachable(out, err, 'ListCodeInterpreterSessions failed');
    }
    return reached(out);
  },

  /** The lossy view — see the interface. */
  async listCodeSessions(): Promise<CodeSession[]> {
    return (await this.listCodeSessionsResult()).items;
  },

  async terminateCodeSession(sessionId: string): Promise<boolean> {
    const ciId = config.agentcore.codeInterpreterId;
    if (!ciId) return false;
    try {
      await dataClient().send(
        new StopCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: ciId,
          sessionId,
        }),
      );
      return true;
    } catch (err) {
      console.warn('[agentcore] terminateCodeSession failed:', (err as Error).message);
      return false;
    }
  },

  async executeCode(code, language = 'python'): Promise<CodeExecutionResult> {
    const ciId = config.agentcore.codeInterpreterId;
    if (!ciId) {
      return { sessionId: '', output: '', durationMs: 0, error: 'CODE_INTERPRETER_ID not configured' };
    }

    const started = Date.now();
    let sessionId = '';
    try {
      const startResp = await dataClient().send(
        new StartCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: ciId,
          name: `portal-${started}`,
        }),
      );
      sessionId = startResp.sessionId ?? '';

      const invokeResp = await dataClient().send(
        new InvokeCodeInterpreterCommand({
          codeInterpreterIdentifier: ciId,
          sessionId,
          name: 'executeCode',
          arguments: { code, language },
        }),
      );

      // Consume the streaming response — each event is a discriminated union;
      // we collect text content blocks across `result` events.
      const chunks: string[] = [];
      let errored = false;
      for await (const event of invokeResp.stream ?? []) {
        if (!event || typeof event !== 'object') continue;
        const e = event as any;
        if (e.result) {
          if (e.result.isError) errored = true;
          for (const c of e.result.content ?? []) {
            if (c?.text) chunks.push(c.text);
            else chunks.push(JSON.stringify(c));
          }
        } else {
          // Any exception-shaped event terminates the stream.
          const ex = e.accessDeniedException || e.validationException || e.internalServerException;
          if (ex) {
            errored = true;
            chunks.push(typeof ex.message === 'string' ? ex.message : JSON.stringify(ex));
          }
        }
      }

      const output = chunks.join('\n').trim();
      return {
        sessionId,
        output: output || '(no output)',
        durationMs: Date.now() - started,
        ...(errored ? { error: 'Execution returned isError=true' } : {}),
      };
    } catch (err) {
      return {
        sessionId,
        output: '',
        durationMs: Date.now() - started,
        error: (err as Error).message,
      };
    } finally {
      if (sessionId) {
        dataClient().send(
          new StopCodeInterpreterSessionCommand({
            codeInterpreterIdentifier: ciId,
            sessionId,
          }),
        ).catch(() => {});
      }
    }
  },

  /**
   * Browser sessions, and whether the data plane answered.
   *
   * Same split as the code sessions: an unset `BROWSER_ID` is a fact about
   * this deployment, a failed `ListBrowserSessions` is a failure. The second
   * one is the documented soft failure — a `BROWSER_ID` left behind by a
   * rebuilt `OrgIQ-AgentCoreCapabilities` answers "Browser profile not found",
   * and until now the page rendered that as an idle browser.
   */
  async listBrowserSessionsResult(): Promise<Upstream<BrowserSession[]>> {
    const browserId = config.agentcore.browserId;
    if (!browserId) return reached([]);

    const out: BrowserSession[] = [];
    let nextToken: string | undefined = undefined;
    try {
      do {
        const resp: ListBrowserSessionsCommandOutput = await dataClient().send(
          new ListBrowserSessionsCommand({
            browserIdentifier: browserId,
            maxResults: 50,
            nextToken,
          }),
        );
        for (const s of resp.items ?? []) {
          const startedAt = s.createdAt ? s.createdAt.toISOString() : new Date(0).toISOString();
          const lastActivityAt = s.lastUpdatedAt
            ? s.lastUpdatedAt.toISOString()
            : startedAt;
          out.push({
            sessionId: s.sessionId ?? '',
            agentName: s.name ?? 'unknown',
            status: s.status === 'TERMINATED' ? 'CLOSED' : 'ACTIVE',
            startedAt,
            lastActivityAt,
            currentUrl: '',
            pageTitle: '',
            requestCount: 0,
            profileId: config.agentcore.browserProfileId,
          });
        }
        nextToken = resp.nextToken;
      } while (nextToken);
    } catch (err) {
      console.warn('[agentcore] listBrowserSessions failed:', (err as Error).message);
      return unreachable(out, err, 'ListBrowserSessions failed');
    }
    return reached(out);
  },

  /** The lossy view — see the interface. */
  async listBrowserSessions(): Promise<BrowserSession[]> {
    return (await this.listBrowserSessionsResult()).items;
  },

  async createBrowserSession(opts: { agentName: string; url?: string }): Promise<BrowserSession> {
    const browserId = config.agentcore.browserId;
    if (!browserId) {
      throw new Error('createBrowserSession: BROWSER_ID not configured');
    }
    const name = `${opts.agentName}-${Date.now()}`.slice(0, 64);
    const profileConfiguration = config.agentcore.browserProfileId
      ? { profileIdentifier: config.agentcore.browserProfileId }
      : undefined;

    const resp = await dataClient().send(
      new StartBrowserSessionCommand({
        browserIdentifier: browserId,
        name,
        ...(profileConfiguration ? { profileConfiguration } : {}),
      }),
    );

    const startedAt = resp.createdAt ? resp.createdAt.toISOString() : new Date().toISOString();
    return {
      sessionId: resp.sessionId ?? '',
      agentName: opts.agentName,
      status: 'ACTIVE',
      startedAt,
      lastActivityAt: startedAt,
      currentUrl: opts.url ?? 'about:blank',
      pageTitle: '',
      requestCount: 0,
      profileId: config.agentcore.browserProfileId,
    };
  },

  async closeBrowserSession(sessionId: string): Promise<boolean> {
    const browserId = config.agentcore.browserId;
    if (!browserId) return false;
    try {
      await dataClient().send(
        new StopBrowserSessionCommand({
          browserIdentifier: browserId,
          sessionId,
        }),
      );
      return true;
    } catch (err) {
      console.warn('[agentcore] closeBrowserSession failed:', (err as Error).message);
      return false;
    }
  },

  async navigateBrowser(sessionId: string, url: string): Promise<BrowserSession | null> {
    const browserId = config.agentcore.browserId;
    if (!browserId) return null;
    const invoke = (action: Record<string, unknown>) =>
      dataClient().send(new InvokeBrowserCommand({ browserIdentifier: browserId, sessionId, action: action as any }));
    try {
      // Focus the address bar (Ctrl+L), clear it, type the URL, then navigate.
      await invoke({ keyShortcut: { keys: ['ctrl', 'l'] } });
      await new Promise((r) => setTimeout(r, 200));
      await invoke({ keyShortcut: { keys: ['ctrl', 'a'] } });
      await invoke({ keyType: { text: url } });
      await invoke({ keyPress: { key: 'Return', presses: 1 } });
      // Wait for page load.
      await new Promise((r) => setTimeout(r, 3000));

      const prev = _browserUrlState.get(sessionId);
      const requests = (prev?.requests ?? 0) + 1;
      _browserUrlState.set(sessionId, { url, title: '', requests });

      const now = new Date().toISOString();
      return {
        sessionId,
        agentName: 'unknown',
        status: 'ACTIVE',
        startedAt: now,
        lastActivityAt: now,
        currentUrl: url,
        pageTitle: '',
        requestCount: requests,
        profileId: config.agentcore.browserProfileId,
      };
    } catch (err) {
      console.warn('[agentcore] navigateBrowser failed:', (err as Error).message);
      return null;
    }
  },

  async screenshotBrowser(sessionId: string): Promise<BrowserScreenshot | null> {
    const browserId = config.agentcore.browserId;
    if (!browserId) return null;
    try {
      const resp = await dataClient().send(
        new InvokeBrowserCommand({
          browserIdentifier: browserId,
          sessionId,
          action: { screenshot: { format: 'PNG' } as any },
        }),
      );
      const shot = (resp as any).result?.screenshot;
      if (shot?.status && shot.status !== 'SUCCESS' && shot?.error) {
        console.warn('[agentcore] screenshotBrowser action failed:', shot.error);
        return null;
      }
      const bytes: Uint8Array | undefined = shot?.data;
      if (!bytes) {
        console.warn('[agentcore] screenshotBrowser: no image bytes in response', JSON.stringify(resp).slice(0, 200));
        return null;
      }
      const b64 = Buffer.from(bytes).toString('base64');
      return {
        sessionId,
        imageDataUrl: `data:image/png;base64,${b64}`,
        takenAt: new Date().toISOString(),
      };
    } catch (err) {
      console.warn('[agentcore] screenshotBrowser failed:', (err as Error).message);
      return null;
    }
  },

  async evaluateInBrowser(_sessionId: string, _expression: string): Promise<unknown> {
    // AgentCore Browser does not expose a CDP automation stream — the action API
    // only supports mouse/keyboard/screenshot. JS evaluation is unavailable.
    // Callers that need page content should use fetchPageContent() instead.
    return null;
  },

  async clickBrowser(sessionId: string, x: number, y: number): Promise<boolean> {
    const browserId = config.agentcore.browserId;
    if (!browserId) return false;
    try {
      await dataClient().send(
        new InvokeBrowserCommand({
          browserIdentifier: browserId,
          sessionId,
          action: { mouseClick: { button: 'LEFT', x, y, clickCount: 1 } as any },
        }),
      );
      return true;
    } catch (err) {
      console.warn('[agentcore] clickBrowser failed:', (err as Error).message);
      return false;
    }
  },
};

// ─── Mock provider ────────────────────────────────────────────────────────────

// Create/close/terminate calls mutate the fixture's own rows, so they feel
// real to the portal during offline dev and `POST /api/__mock/reset` is what
// takes them back.
//
// These used to be module-scope COPIES of the fixture arrays. That worked
// while the fixtures were frozen literals, but it makes a fixture that can be
// switched or reset invisible here: asking the control plane for the `empty`
// world left both lists exactly as they were at import, and a reset never
// dropped an audit's terminated session. Resolved per call instead — `rows()`
// hands back the live array, and `reset()` replaces it, so a stale reference
// is never held.
const _mockCode = (): CodeSession[] => codeSessions.rows();
const _mockBrowser = (): BrowserSession[] => browserSessions.rows();


/** Milliseconds between mock stream chunks. `MOCK_STREAM_PACE_MS` overrides;
 *  default 12ms in development (a ~100-chunk answer streams for ~1.5s, the
 *  shape of a real one) and 0 under jest so the suites stay instant. */
function mockStreamPaceMs(): number {
  const raw = process.env['MOCK_STREAM_PACE_MS'];
  if (raw !== undefined && raw !== '') return Math.max(0, Number(raw) || 0);
  return process.env['NODE_ENV'] === 'test' ? 0 : 12;
}
function mockStreamTick(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}


/** The supervisor's routing tools → the sub-agent step they open
 *  (agents/supervisor/main.py SUB_AGENT_STEP_NAMES). The seeded mock answers
 *  carry the sub-agent's own graph queries, so an unmapped tool is the search
 *  agent at work. */
const MOCK_SUB_AGENT_STEPS: Record<string, string> = {
  search_organization: 'search',
  get_expertise_scores: 'scoring',
  get_strategic_advice: 'advisor',
};
function mockStepNameFor(toolName: string): string {
  return MOCK_SUB_AGENT_STEPS[toolName] ?? 'search';
}

export const mockAgentCore: AgentCoreProvider = {
  /**
   * The offline half of the degraded answer.
   *
   * `agentFleet`'s `error` scenario THROWS when its rows are read
   * (mock/agent-statuses.ts), which is how an auditor reaches this branch over
   * HTTP — `POST /api/__mock/scenario {"scenario":"error","fixture":"agent-fleet"}`
   * — instead of unplugging a network. Catching it here is what makes the
   * degraded answer and the `empty`-scenario answer two DIFFERENT responses
   * from one route rather than one response with two meanings.
   */
  async listRuntimesResult(): Promise<Upstream<AgentRuntimeSummary[]>> {
    return attempt(
      async () => mockAgents.map((a) => ({ ...a })),
      [] as AgentRuntimeSummary[],
      'ListAgentRuntimes failed',
    );
  },

  /**
   * Deliberately NOT `(await listRuntimesResult()).items`.
   *
   * That route's shape HAS now changed: `GET /api/agents` answers
   * `{ agents, degraded?, error? }` and reads `listRuntimesResult`, so the
   * `error` scenario reaches it as a 200 that says the fleet could not be read
   * rather than as a 500. This lossy variant is kept because the interface
   * declares it and `providers/cloudwatch.ts` still uses the real provider's
   * copy — and it keeps THROWING rather than swallowing, so any future caller
   * that reaches for the lossy read gets a loud failure instead of an empty
   * list with no explanation. Swallowing here would re-create, one layer down,
   * exactly the silence this whole change removed.
   */
  async listRuntimes(): Promise<AgentRuntimeSummary[]> {
    return mockAgents.map((a) => ({ ...a }));
  },

  async getRuntime(agentId: string): Promise<AgentRuntimeSummary | null> {
    const a = mockAgents.find((x) => x.id === agentId);
    return a ? { ...a } : null;
  },

  async getRuntimeMetrics(agentId: string): Promise<AgentMetrics | null> {
    const a = mockAgents.find((x) => x.id === agentId);
    if (!a) return null;
    const successRate =
      a.invocationsLast24h === 0
        ? '100.00%'
        : (((a.invocationsLast24h - a.errorsLast24h) / a.invocationsLast24h) * 100).toFixed(2) + '%';
    return {
      agentId: a.id,
      latencyP50Ms: a.latencyP50Ms,
      latencyP99Ms: a.latencyP99Ms,
      invocationsLast24h: a.invocationsLast24h,
      errorsLast24h: a.errorsLast24h,
      tokensLast24h: a.tokensLast24h,
      successRate,
    };
  },

  async invokeAgent(_agentId, payload): Promise<AgentInvokeResult> {
    const m = selectMockResponse(payload.message);
    return {
      text: m.response,
      toolCalls: m.toolCalls.map((tc) => ({
        name: tc.name,
        args: tc.args,
        result: tc.result,
      })),
    };
  },

  async *invokeAgentStreaming(_agentId, payload): AsyncGenerator<unknown> {
    const m = selectMockResponse(payload.message);
    const msgId = `mock-${Date.now()}`;
    yield { type: 'RUN_STARTED', threadId: payload.sessionId ?? 'mock', runId: msgId };
    // The real supervisor (agents/supervisor/main.py) brackets each routed
    // sub-agent call with STEP_STARTED/STEP_FINISHED named after the sub-agent
    // (search / scoring / advisor), opened on TOOL_CALL_START and closed on
    // TOOL_CALL_RESULT — not on TOOL_CALL_END, which fires when the model has
    // finished streaming ARGUMENTS, before the network call runs. The mock
    // mirrors that sequence per seeded tool call so the portal's step strip
    // and tool-call pills behave the same offline as against the fleet
    // (docs/research-agui-steps-2026-09-16.md).
    //
    // Pace the chunks. Unpaced, the whole run lands in one ~2ms SSE read, React
    // batches every event into a single render, and no in-flight state — the
    // step strip, the streaming bubble, the tool-call pills — is ever painted;
    // a real Nova answer streams for seconds. Jest keeps it instant.
    const pace = mockStreamPaceMs();
    for (const tc of m.toolCalls) {
      const id = randomUUID();
      const step = mockStepNameFor(tc.name);
      yield { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: tc.name };
      yield { type: 'STEP_STARTED', stepName: step };
      await mockStreamTick(pace * 4);
      yield { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args) };
      yield { type: 'TOOL_CALL_END', toolCallId: id };
      await mockStreamTick(pace * 12);
      yield { type: 'TOOL_CALL_RESULT', toolCallId: id, content: tc.result };
      yield { type: 'STEP_FINISHED', stepName: step };
    }
    await mockStreamTick(pace * 4);
    yield { type: 'TEXT_MESSAGE_START', messageId: msgId, role: 'assistant' };
    const words = m.response.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 3) {
      await mockStreamTick(pace);
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId: msgId, delta: words.slice(i, i + 3).join('') };
    }
    yield { type: 'TEXT_MESSAGE_END', messageId: msgId };
    yield { type: 'RUN_FINISHED' };
  },

  async listCodeSessionsResult(): Promise<Upstream<CodeSession[]>> {
    return attempt(
      async () => _mockCode().map((s) => ({ ...s })),
      [] as CodeSession[],
      'ListCodeInterpreterSessions failed',
    );
  },

  async listCodeSessions(): Promise<CodeSession[]> {
    return _mockCode().map((s) => ({ ...s }));
  },

  async terminateCodeSession(sessionId: string): Promise<boolean> {
    const rows = _mockCode();
    const i = rows.findIndex((s) => s.sessionId === sessionId);
    if (i < 0) return false;
    rows[i] = { ...rows[i]!, status: 'TERMINATED' };
    return true;
  },

  async executeCode(code, _language): Promise<CodeExecutionResult> {
    // Fake an output for offline dev — runs no real code.
    const lines = (code.match(/^\s*print\s*\(/gm) ?? []).length;
    return {
      sessionId: `mock-${Date.now()}`,
      output: lines > 0 ? `(mock) Would have printed ${lines} line(s).` : '(mock) Code accepted; no print() calls detected.',
      durationMs: 120,
    };
  },

  async listBrowserSessionsResult(): Promise<Upstream<BrowserSession[]>> {
    return attempt(
      async () => _mockBrowser().map((s) => ({ ...s })),
      [] as BrowserSession[],
      'ListBrowserSessions failed',
    );
  },

  async listBrowserSessions(): Promise<BrowserSession[]> {
    return _mockBrowser().map((s) => ({ ...s }));
  },

  async createBrowserSession(opts: { agentName: string; url?: string }): Promise<BrowserSession> {
    const now = new Date().toISOString();
    const session: BrowserSession = {
      sessionId: `bs-mock-${Math.random().toString(36).slice(2, 10)}`,
      agentName: opts.agentName,
      status: 'ACTIVE',
      startedAt: now,
      lastActivityAt: now,
      currentUrl: opts.url ?? 'about:blank',
      pageTitle: '',
      requestCount: 0,
      profileId: config.agentcore.browserProfileId || 'bp-default',
    };
    _mockBrowser().push(session);
    return { ...session };
  },

  async closeBrowserSession(sessionId: string): Promise<boolean> {
    const rows = _mockBrowser();
    const i = rows.findIndex((s) => s.sessionId === sessionId);
    if (i < 0) return false;
    rows[i] = { ...rows[i]!, status: 'CLOSED' };
    return true;
  },

  async navigateBrowser(sessionId: string, url: string): Promise<BrowserSession | null> {
    const rows = _mockBrowser();
    const i = rows.findIndex((s) => s.sessionId === sessionId);
    if (i < 0) return null;
    rows[i] = {
      ...rows[i]!,
      currentUrl: url,
      pageTitle: `Mock page at ${new URL(url).hostname}`,
      lastActivityAt: new Date().toISOString(),
      requestCount: rows[i]!.requestCount + 1,
    };
    return { ...rows[i]! };
  },

  async screenshotBrowser(sessionId: string): Promise<BrowserScreenshot | null> {
    if (!_mockBrowser().some((s) => s.sessionId === sessionId)) return null;
    // 1x1 transparent PNG as a placeholder
    const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    return {
      sessionId,
      imageDataUrl: `data:image/png;base64,${onePx}`,
      takenAt: new Date().toISOString(),
    };
  },

  async evaluateInBrowser(sessionId: string, _expression: string): Promise<unknown> {
    const s = _mockBrowser().find((x) => x.sessionId === sessionId);
    if (!s) return null;
    return JSON.stringify({
      title: `Mock page at ${new URL(s.currentUrl).hostname}`,
      text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      links: [],
    });
  },

  async clickBrowser(sessionId: string, _x: number, _y: number): Promise<boolean> {
    return _mockBrowser().some((s) => s.sessionId === sessionId);
  },
};
