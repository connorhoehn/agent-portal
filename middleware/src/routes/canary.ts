// Canary surface — A/B prompt comparison + judge scoring.
//
// Two prompt-management ARNs (subject A, subject B) are invoked side-by-side
// per ask. A weighted router (weight_b = 0..100) picks which version runs
// for a given request. Results are scored by an LLM judge fire-and-forget;
// the same events stream over SSE to the portal so operators can watch the
// experiment live.
//
// Mounted at /api/observability/canary in index.ts ABOVE the ViewObservability
// gate so the unauthenticated portal can hit /prompts and /events for the
// canary landing page. Mutation routes (/weight, /halt) are individually
// Cedar-gated by `ManageCanary`.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  BedrockAgentClient,
  GetPromptCommand,
} from '@aws-sdk/client-bedrock-agent';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { requireAction } from '../lib/authz.js';
import { config } from '../config.js';
import { canaryBroker } from '../lib/canary-broker.js';
import { pickVersion } from '../lib/canary-router.js';
import {
  getWeightB,
  setWeightB,
  getControl,
  setControl,
  getSubjectAArn,
  getSubjectBArn,
  setSubjectArns,
} from '../lib/weight-cache.js';
import { resetLocalController } from '../lib/canary-local-controller.js';
import { fireJudge } from '../lib/canary-judge.js';
import { offlineSubjectAnswer } from '../mock/canary-ask.js';
import { findMockPrompt } from '../mock/canary-library.js';
import type { CanaryEvent, CanaryVersionLabel } from '../lib/canary-types.js';

export const canaryRouter = Router();

const PREVIEW_MAX_CHARS = 240;

let _bedrockRt: BedrockRuntimeClient | null = null;
function bedrock(): BedrockRuntimeClient {
  if (!_bedrockRt) _bedrockRt = new BedrockRuntimeClient({ region: config.region });
  return _bedrockRt;
}

let _bedrockAgent: BedrockAgentClient | null = null;
function bedrockAgent(): BedrockAgentClient {
  if (!_bedrockAgent) _bedrockAgent = new BedrockAgentClient({ region: config.region });
  return _bedrockAgent;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /ask — Invoke subject A or B (weighted) and stream the response back.
// Read-only at the model layer (no DB writes) — ungated. Judge call is
// fire-and-forget via fireJudge() which publishes its own events.
// ─────────────────────────────────────────────────────────────────────────────

interface AskBody {
  person_name?: unknown;
  topic?: unknown;
  summary?: unknown;
}

canaryRouter.post('/ask', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as AskBody;
  const personName = typeof body.person_name === 'string' ? body.person_name : '';
  const topic = typeof body.topic === 'string' ? body.topic : '';
  const summary = typeof body.summary === 'string' ? body.summary : '';
  if (!personName) throw new ValidationError('person_name is required');
  if (!topic) throw new ValidationError('topic is required');
  if (!summary) throw new ValidationError('summary is required');

  const [weightB, control, aArn, bArn] = await Promise.all([
    getWeightB(),
    getControl(),
    getSubjectAArn(),
    getSubjectBArn(),
  ]);
  const version: CanaryVersionLabel = control.halted ? 'A' : pickVersion(weightB);
  const promptArn = version === 'A' ? aArn : bArn;

  if (!promptArn) {
    res.status(500).json({ error: `Canary subject ${version} ARN not configured` });
    return;
  }

  const requestId = randomUUID();
  const startedAt = Date.now();

  initSSE(res);

  // Tell the client which version was picked + the request id up front so the
  // UI can scope the timeline before any deltas arrive. `meta` is a
  // client-only frame — not a CanaryEvent (so we don't publish to the broker).
  writeSSE(res, { type: 'meta', request_id: requestId, version, weight_b: weightB });

  const question = `${topic} — ${personName}`;
  const startedEvent: CanaryEvent = {
    type: 'invocation_started',
    request_id: requestId,
    version_arn: promptArn,
    version_label: version,
    question,
    ts: new Date(startedAt).toISOString(),
  };
  canaryBroker.publish(startedEvent);

  let fullText = '';
  let streamErr: Error | null = null;

  try {
    if (config.mock.agentcore) {
      // Offline, the subject's answer is DECLARED rather than generated — a
      // mock cannot write prose any more than it can write code. The branch is
      // here because this handler is what owns the ConverseStream client; the
      // text, and the reason each subject has the text it has, are in
      // mock/canary-ask.ts. Everything after this block — the broker events,
      // the judge, the EMF record — is the real path, unchanged.
      const declared = offlineSubjectAnswer(version, { personName, topic });
      if (declared === null) {
        throw new Error(
          `mock canary: no declared answer for subject ${version} in the current scenario`,
        );
      }
      // Chunked the way a model streams, so the client's incremental render is
      // exercised rather than handed one frame.
      for (const chunk of declared.match(/\S+\s*/g) ?? []) {
        if (res.writableEnded) break;
        fullText += chunk;
        writeSSE(res, { type: 'delta', text: chunk });
      }
    } else {
      const out = await bedrock().send(new ConverseStreamCommand({
        modelId: promptArn,
        promptVariables: {
          person_name: { text: personName },
          topic: { text: topic },
          summary: { text: summary },
        },
      }));

      if (out.stream) {
        for await (const event of out.stream) {
          if (res.writableEnded) break;
          const deltaText = event.contentBlockDelta?.delta?.text;
          if (typeof deltaText === 'string' && deltaText.length > 0) {
            fullText += deltaText;
            writeSSE(res, { type: 'delta', text: deltaText });
          }
        }
      }
    }
  } catch (err) {
    streamErr = err as Error;
    console.warn(`[canary] ConverseStream failed for ${version}:`, streamErr.message);
    writeSSE(res, { type: 'error', message: streamErr.message });
  }

  const latencyMs = Date.now() - startedAt;
  const responsePreview = fullText.slice(0, PREVIEW_MAX_CHARS);

  const completeEvent: CanaryEvent = {
    type: 'invocation_complete',
    request_id: requestId,
    latency_ms: latencyMs,
    response_preview: responsePreview,
    ts: new Date().toISOString(),
  };
  canaryBroker.publish(completeEvent);

  writeSSE(res, completeEvent);

  // Fire-and-forget judge call. Must NOT await — the judge model is slower
  // than the subject model and we want the SSE response back to the user as
  // soon as the subject finishes streaming. fireJudge publishes its own
  // judge_score event + emits EMF internally.
  if (!streamErr && fullText.length > 0) {
    setImmediate(() => {
      fireJudge({
        requestId,
        question,
        personName,
        topic,
        response: fullText,
        versionLabel: version,
        versionArn: promptArn,
        latencyMs,
        canaryName: config.canary.name,
      });
    });
  }

  endSSE(res);
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /events — Long-lived SSE stream of canary lifecycle events.
// Replays the in-memory buffer on connect so a freshly-opened tab catches up.
// ─────────────────────────────────────────────────────────────────────────────

canaryRouter.get('/events', (req, res) => {
  initSSE(res);
  for (const ev of canaryBroker.replay()) {
    writeSSE(res, ev);
  }
  const unsubscribe = canaryBroker.subscribe((ev) => writeSSE(res, ev));
  req.on('close', () => {
    unsubscribe();
    endSSE(res);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /prompts — Resolve the configured ARNs + (best-effort) template text.
// Template fetches use GetPrompt; any failure (perms, throttle, missing) is
// swallowed and we just return the ARN. The UI degrades gracefully.
// ─────────────────────────────────────────────────────────────────────────────

interface PromptInfo {
  arn: string;
  label: string;
  template?: string;
}

interface PromptsResponse {
  subject_a: PromptInfo;
  subject_b: PromptInfo;
  judge: { arn: string };
}

async function fetchTemplate(arn: string): Promise<string | undefined> {
  if (!arn) return undefined;
  if (config.mock.agentcore) {
    // The subject ARNs the fixture stores are ARNs of prompts in the offline
    // library (mock/canary-library.ts), so the template is a lookup rather
    // than a GetPrompt. Resolving it here is what keeps "which prompt is
    // subject B" and "what does subject B say" from disagreeing offline.
    const id = arn.split('/').pop()?.split(':')[0] ?? '';
    return findMockPrompt(id)?.versions[0]?.variant.templateText;
  }
  try {
    const out = await bedrockAgent().send(new GetPromptCommand({ promptIdentifier: arn }));
    // Pick the default variant, falling back to the first one.
    const variants = out.variants ?? [];
    const def = variants.find((v) => v.name === out.defaultVariant) ?? variants[0];
    const cfg = def?.templateConfiguration;
    if (cfg && 'text' in cfg && cfg.text) {
      return cfg.text.text ?? undefined;
    }
    return undefined;
  } catch (err) {
    console.warn(`[canary] GetPrompt(${arn}) failed:`, (err as Error).message);
    return undefined;
  }
}

canaryRouter.get('/prompts', asyncHandler(async (_req, res) => {
  const judgeArn = config.canary.judgeArn;

  const [aArn, bArn] = await Promise.all([getSubjectAArn(), getSubjectBArn()]);

  const [aTemplate, bTemplate] = await Promise.all([
    fetchTemplate(aArn),
    fetchTemplate(bArn),
  ]);

  const subjectA: PromptInfo = {
    arn: aArn,
    label: 'A',
    ...(aTemplate ? { template: aTemplate } : {}),
  };
  const subjectB: PromptInfo = {
    arn: bArn,
    label: 'B',
    ...(bTemplate ? { template: bTemplate } : {}),
  };
  const out: PromptsResponse = {
    subject_a: subjectA,
    subject_b: subjectB,
    judge: { arn: judgeArn },
  };
  res.json(out);
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /weight — Current weight + control state. Ungated.
// ─────────────────────────────────────────────────────────────────────────────

canaryRouter.get('/weight', asyncHandler(async (_req, res) => {
  const [weightB, control] = await Promise.all([getWeightB(), getControl()]);
  res.json({ weight_b: weightB, control });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PUT /weight — Manually override the canary weight. Cedar-gated.
// Sets manual_override_until = now+10min so the controller stops touching the
// weight until the override expires.
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_OVERRIDE_MS = 10 * 60 * 1000;

canaryRouter.put('/weight', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { weight_b?: unknown };
  const raw = body.weight_b;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) {
    throw new ValidationError('weight_b must be an integer between 0 and 100');
  }
  await setWeightB(n, 'manual');
  const overrideUntil = new Date(Date.now() + MANUAL_OVERRIDE_MS).toISOString();
  await setControl({ manual_override_until: overrideUntil });

  const ev: CanaryEvent = {
    type: 'weight_changed',
    weight_b: n,
    source: 'manual',
    ts: new Date().toISOString(),
  };
  canaryBroker.publish(ev);

  res.json({ ok: true, weight_b: n });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /halt — Emergency stop. Sets weight_b=0 + halted=true. Cedar-gated.
// All subsequent /ask requests force version=A (the baseline) until halted
// is cleared via PUT /weight.
// ─────────────────────────────────────────────────────────────────────────────

canaryRouter.post('/halt', requireAction('ManageCanary'), asyncHandler(async (_req, res) => {
  await setWeightB(0, 'halt');
  await setControl({ halted: true });

  const ev: CanaryEvent = {
    type: 'weight_changed',
    weight_b: 0,
    source: 'halt',
    ts: new Date().toISOString(),
  };
  canaryBroker.publish(ev);

  res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /start — Start a new canary experiment. Stores subject ARNs in SSM,
// sets initial weight, and resets the local controller. Cedar-gated.
// ─────────────────────────────────────────────────────────────────────────────

interface StartBody {
  subject_a_arn?: unknown;
  subject_b_arn?: unknown;
  initial_weight_b?: unknown;
}

canaryRouter.post('/start', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as StartBody;
  const aArn = typeof body.subject_a_arn === 'string' ? body.subject_a_arn.trim() : '';
  const bArn = typeof body.subject_b_arn === 'string' ? body.subject_b_arn.trim() : '';
  if (!aArn) throw new ValidationError('subject_a_arn is required');
  if (!bArn) throw new ValidationError('subject_b_arn is required');

  const rawWeight = body.initial_weight_b;
  const parsedWeight = typeof rawWeight === 'number'
    ? rawWeight
    : (typeof rawWeight === 'string' ? Number(rawWeight) : NaN);
  const initialWeight = Number.isFinite(parsedWeight)
    ? Math.max(1, Math.min(50, Math.trunc(parsedWeight)))
    : 10;

  await setSubjectArns(aArn, bArn);
  await setWeightB(initialWeight, 'controller');
  await setControl({ halted: false, manual_override_until: '', cooldown_until: '' });
  resetLocalController(initialWeight);

  const ev: CanaryEvent = {
    type: 'weight_changed',
    weight_b: initialWeight,
    source: 'controller',
    ts: new Date().toISOString(),
  };
  canaryBroker.publish(ev);

  res.json({ ok: true, subject_a_arn: aArn, subject_b_arn: bArn, weight_b: initialWeight });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /reset — Reset experiment back to A-only. Cedar-gated.
// ─────────────────────────────────────────────────────────────────────────────

canaryRouter.post('/reset', requireAction('ManageCanary'), asyncHandler(async (_req, res) => {
  await setWeightB(0, 'halt');
  await setControl({ halted: false });
  resetLocalController(0);

  const ev: CanaryEvent = {
    type: 'weight_changed',
    weight_b: 0,
    source: 'halt',
    ts: new Date().toISOString(),
  };
  canaryBroker.publish(ev);

  res.json({ ok: true });
}));
