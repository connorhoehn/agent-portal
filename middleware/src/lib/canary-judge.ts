// Async canary judge dispatcher. Fire-and-forget — the agent invocation path
// returns to the user immediately and the judge call runs in the background.
//
// Bounded concurrency via a simple in-process semaphore. If the inflight count
// hits MAX_INFLIGHT we drop the new judge request (and log the request_id so
// it's traceable). This is intentional: better to skip a score than to queue
// unbounded judge calls during a traffic spike.
//
// The judge prompt is configured as a Bedrock prompt management ARN supplied
// via CANARY_JUDGE_PROMPT_ARN env var. It must accept {person_name, topic,
// response} variables and return JSON with helpfulness/factuality/tone/
// conciseness scores in [0, 1].

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { emitCanaryScore } from './emf-emitter.js';
import { canaryBroker } from './canary-broker.js';
import type { CanaryVersionLabel } from './canary-types.js';

const MAX_INFLIGHT = 8;
let inflight = 0;

const client = new BedrockRuntimeClient({});

const JUDGE_PROMPT_ARN = process.env['CANARY_JUDGE_PROMPT_ARN'] ?? '';

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
      const res = await client.send(
        new ConverseCommand({
          modelId: JUDGE_PROMPT_ARN,
          promptVariables: {
            person_name: { text: params.personName },
            topic: { text: params.topic },
            response: { text: params.response },
          },
        }),
      );
      const text = res.output?.message?.content?.[0]?.text ?? '{}';
      const json = JSON.parse(text.replace(/```json\n?|\n?```/g, '')) as Record<
        string,
        unknown
      >;
      const scores = {
        helpfulness: clamp01(json['helpfulness']),
        factuality: clamp01(json['factuality']),
        tone: clamp01(json['tone']),
        conciseness: clamp01(json['conciseness']),
      };
      const mean =
        (scores.helpfulness +
          scores.factuality +
          scores.tone +
          scores.conciseness) /
        4;
      // error_rate penalty is applied at aggregation time (in the controller),
      // not per-record — keep this simple.
      const composite = mean;
      canaryBroker.publish({
        type: 'judge_score',
        request_id: params.requestId,
        scores,
        composite,
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
