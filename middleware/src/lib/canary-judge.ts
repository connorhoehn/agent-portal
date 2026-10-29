// Async canary judge dispatcher. Fire-and-forget — the agent invocation path
// returns to the user immediately and the judge call runs in the background.
//
// Bounded concurrency via a simple in-process semaphore. If the inflight count
// hits MAX_INFLIGHT we drop the new judge request (and log the request_id so
// it's traceable). This is intentional: better to skip a score than to queue
// unbounded judge calls during a traffic spike.
//
// Behavior is governed by the operator config from judge-config.ts (the
// /iq/evaluations page): enabled gate, sample rate, judge model, and rubric
// weights. The judge prompt template comes from Bedrock prompt management
// (CANARY_JUDGE_PROMPT_ARN); we render it locally and Converse against the
// configured model so the model picker is honored even though the stored
// prompt variant pins its own modelId. If the template can't be fetched we
// fall back to invoking the prompt ARN directly.

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBffCall } from '../providers/spend-ledger.js';
import {
  BedrockAgentClient,
  GetPromptCommand,
} from '@aws-sdk/client-bedrock-agent';
import { emitCanaryScore } from './emf-emitter.js';
import { canaryBroker } from './canary-broker.js';
import { getJudgeConfig, weightedComposite } from './judge-config.js';
import { config } from '../config.js';
import { clock } from '../mock/core/clock.js';
import {
  measureAnswer,
  offlineRubricRationale,
  offlineRubricScores,
  OFFLINE_JUDGE_MODEL,
} from '../mock/answer-check.js';
import type { CanaryVersionLabel } from './canary-types.js';

const MAX_INFLIGHT = 8;
let inflight = 0;

const client = new BedrockRuntimeClient({});
const agentClient = new BedrockAgentClient({});

const JUDGE_PROMPT_ARN = process.env['CANARY_JUDGE_PROMPT_ARN'] ?? '';

// Template cache — the judge prompt text changes rarely; re-fetch every 5 min.
const TEMPLATE_TTL_MS = 5 * 60 * 1000;
let cachedTemplate: { text: string; fetchedAt: number } | null = null;

async function getJudgeTemplate(): Promise<string | null> {
  // Offline the GetPrompt below throws before it reaches Bedrock. There is no
  // judge template to fetch because there is no judge model to send it to —
  // `fireJudge` takes the `config.mock.agentcore` path and reads the answer
  // itself. Saying "no template" is the truthful answer here; returning an
  // invented one would put a string in the cache that no prompt library holds.
  if (config.mock.agentcore) return null;
  if (!JUDGE_PROMPT_ARN) return null;
  const now = Date.now();
  if (cachedTemplate && now - cachedTemplate.fetchedAt < TEMPLATE_TTL_MS) {
    return cachedTemplate.text;
  }
  try {
    const out = await agentClient.send(
      new GetPromptCommand({ promptIdentifier: JUDGE_PROMPT_ARN }),
    );
    const variants = out.variants ?? [];
    const def = variants.find((v) => v.name === out.defaultVariant) ?? variants[0];
    const cfg = def?.templateConfiguration;
    const text = cfg && 'text' in cfg ? cfg.text?.text : undefined;
    if (text) {
      cachedTemplate = { text, fetchedAt: now };
      return text;
    }
    return null;
  } catch (err) {
    console.warn('[canary-judge] GetPrompt failed:', (err as Error).message);
    return cachedTemplate?.text ?? null;
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : '',
  );
}

interface JudgeParams {
  requestId: string;
  question: string;
  personName: string;
  topic: string;
  response: string;
  versionLabel: CanaryVersionLabel;
  versionArn: string;
  latencyMs: number;
  canaryName: string;
}

function clamp01(n: unknown): number {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

export function fireJudge(params: JudgeParams): void {
  if (inflight >= MAX_INFLIGHT) {
    console.warn('[canary-judge] saturated, dropping', params.requestId);
    return;
  }
  inflight++;
  setImmediate(async () => {
    try {
      const cfg = await getJudgeConfig();

      // Operator gates: judging disabled, or sampled out.
      if (!cfg.enabled) return;
      if (cfg.minSampleRate < 100 && Math.random() * 100 >= cfg.minSampleRate) {
        return;
      }

      const vars = {
        person_name: params.personName,
        topic: params.topic,
        response: params.response,
      };

      // OFFLINE. The same reading `lib/judge.ts` takes — `measureAnswer` plus
      // `offlineRubricScores` over the operator's own rubric — not a second
      // judge with a rubric of its own, so a canary score and a trace's
      // judge_score can never disagree about the same text.
      //
      // Two things follow from that reader and both are deliberate. It scores
      // on the 0–10 scale the harness judge speaks, so it is divided by ten
      // onto the canary's 0–1 scale before `weightedComposite`. And it
      // ABSTAINS on a dimension it cannot measure — `tone` for anything that
      // is not a refusal — so that key is ABSENT from the event and the EMF
      // record rather than present as a zero. `weightedComposite` renormalises
      // over the keys it was given, so an abstention costs the composite
      // nothing and buys the answer nothing; a zero would have read as "judged
      // badly", which is a different and false claim.
      //
      // The branch is here, above the Converse, because this function owns the
      // model call — and everything after it is the real tail: the same broker
      // event, the same rubric weighting, the same EMF emission.
      if (config.mock.agentcore) {
        const measurement = measureAnswer(params.question, params.response);
        const tenPoint = offlineRubricScores(measurement, cfg.dimensions);
        const offline: Record<string, number> = {};
        for (const [key, value] of Object.entries(tenPoint)) offline[key] = value / 10;
        const offlineComposite = weightedComposite(offline, cfg.dimensions);
        console.log(`[canary-judge] ${offlineRubricRationale(measurement)}`);
        canaryBroker.publish({
          type: 'judge_score',
          request_id: params.requestId,
          scores: offline,
          composite: offlineComposite,
          pass: offlineComposite * 10 >= cfg.failThreshold,
          judged_by: OFFLINE_JUDGE_MODEL,
          ts: clock.nowIso(),
        });
        await emitCanaryScore({
          canary_name: params.canaryName,
          version_label: params.versionLabel,
          prompt_arn: params.versionArn,
          request_id: params.requestId,
          composite_score: offlineComposite,
          latency_ms: params.latencyMs,
          error: 0,
          judged_by: OFFLINE_JUDGE_MODEL,
          ...offline,
        });
        return;
      }

      // Prefer local render + configured model; fall back to the prompt ARN
      // (which pins its own model) if the template isn't available.
      const template = await getJudgeTemplate();
      const res = await client.send(
        template
          ? new ConverseCommand({
              modelId: cfg.modelId,
              messages: [
                { role: 'user', content: [{ text: renderTemplate(template, vars) }] },
              ],
            })
          : new ConverseCommand({
              modelId: JUDGE_PROMPT_ARN,
              promptVariables: {
                person_name: { text: vars.person_name },
                topic: { text: vars.topic },
                response: { text: vars.response },
              },
            }),
      );
      void recordBffCall({ feature: 'canary-judge', model: template ? cfg.modelId : JUDGE_PROMPT_ARN, usage: res.usage });
      const text = res.output?.message?.content?.[0]?.text ?? '{}';
      // Judges occasionally wrap the JSON in prose or a fence — extract the
      // first {...} block rather than requiring a perfectly clean payload.
      const stripped = text.replace(/```json\n?|\n?```/g, '');
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      const json = JSON.parse(jsonMatch ? jsonMatch[0] : stripped) as Record<
        string,
        unknown
      >;
      const scores = {
        helpfulness: clamp01(json['helpfulness']),
        factuality: clamp01(json['factuality']),
        tone: clamp01(json['tone']),
        conciseness: clamp01(json['conciseness']),
      };
      // Rubric-weighted composite (0–1). error_rate penalty is applied at
      // aggregation time (in the controller), not per-record.
      const composite = weightedComposite(scores, cfg.dimensions);
      canaryBroker.publish({
        type: 'judge_score',
        request_id: params.requestId,
        scores,
        composite,
        pass: composite * 10 >= cfg.failThreshold,
        ts: new Date().toISOString(),
      });
      await emitCanaryScore({
        canary_name: params.canaryName,
        version_label: params.versionLabel,
        prompt_arn: params.versionArn,
        request_id: params.requestId,
        composite_score: composite,
        latency_ms: params.latencyMs,
        error: 0,
        ...scores,
      });
    } catch (err) {
      console.warn('[canary-judge] failed', err);
      await emitCanaryScore({
        canary_name: params.canaryName,
        version_label: params.versionLabel,
        prompt_arn: params.versionArn,
        request_id: params.requestId,
        composite_score: 0,
        latency_ms: params.latencyMs,
        error: 1,
        helpfulness: 0,
        factuality: 0,
        tone: 0,
        conciseness: 0,
      });
    } finally {
      inflight--;
    }
  });
}
