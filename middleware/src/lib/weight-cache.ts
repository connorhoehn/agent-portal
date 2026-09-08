// Read-through cache over SSM Parameter Store for canary weight + control.
//
// Two parameters live in SSM:
//   /orgiq/canary/weight_b — String "0".."100"
//   /orgiq/canary/control  — JSON { manual_override_until, cooldown_until, halted }
//
// The hot path (router pick on every invocation) reads weight_b through a 20s
// TTL cache. If SSM is briefly unavailable, we serve stale rather than fail.
// Setters write through and immediately update the cache so the next hot-path
// read sees the new value.

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import type { CanaryControlState } from './canary-types.js';
import {
  mockGetControl,
  mockGetWeightB,
  mockSetControl,
  mockSetWeightB,
} from '../mock/canary-weight.js';
import { config } from '../config.js';

const TTL_MS = 20_000;
const WEIGHT_PARAM = '/orgiq/canary/weight_b';
const CONTROL_PARAM = '/orgiq/canary/control';

const client = new SSMClient({});

interface CacheEntry {
  value: number;
  fetchedAt: number;
}

let entry: CacheEntry | null = null;

export async function getWeightB(): Promise<number> {
  // `ParameterNotFound` below covers "the PromptCanary stack was never
  // deployed". It does NOT cover "there is no credential to call SSM with":
  // offline the SDK throws CredentialsProviderError before it ever reaches
  // Parameter Store, the `catch` re-threw it, and GET /canary/weight 500'd.
  if (config.mock.agentcore) return mockGetWeightB();
  const now = Date.now();
  if (entry && now - entry.fetchedAt < TTL_MS) return entry.value;

  try {
    const res = await client.send(
      new GetParameterCommand({ Name: WEIGHT_PARAM }),
    );
    const n = Number.parseInt(res.Parameter?.Value ?? '0', 10);
    entry = { value: Number.isFinite(n) ? n : 0, fetchedAt: now };
    return entry.value;
  } catch (err) {
    const e = err as { name?: string };
    if (entry) {
      console.warn('[weight-cache] SSM error, serving stale', e?.name);
      return entry.value;
    }
    // The weight parameter is created by the OrgIQ-PromptCanary stack, which
    // is gated behind --context deployCanary=true. When it isn't deployed the
    // canary is simply off — treat that as weight 0, not a 500.
    if (e?.name === 'ParameterNotFound') {
      console.warn('[weight-cache] weight param missing (PromptCanary stack not deployed) — defaulting to 0');
      entry = { value: 0, fetchedAt: now };
      return 0;
    }
    throw err;
  }
}

export async function setWeightB(
  weightB: number,
  source: 'controller' | 'manual' | 'halt',
): Promise<void> {
  // `source` is part of the signature so callers self-document the reason for
  // the mutation; the downstream broker event captures it. SSM itself is
  // history-agnostic, so we don't pass it to the API.
  void source;
  if (config.mock.agentcore) {
    // Move the same row the GET reads, so the slider's optimistic update is
    // confirmed by the next poll rather than snapping back.
    mockSetWeightB(weightB);
    return;
  }
  await client.send(
    new PutParameterCommand({
      Name: WEIGHT_PARAM,
      Value: String(weightB),
      Type: 'String',
      Overwrite: true,
    }),
  );
  entry = { value: weightB, fetchedAt: Date.now() };
}

const DEFAULT_CONTROL: CanaryControlState = {
  manual_override_until: '',
  cooldown_until: '',
  halted: false,
};

function parseControl(raw: string | undefined | null): CanaryControlState {
  if (!raw || typeof raw !== 'string') return { ...DEFAULT_CONTROL };
  try {
    const parsed = JSON.parse(raw) as Partial<CanaryControlState>;
    return {
      manual_override_until:
        typeof parsed.manual_override_until === 'string'
          ? parsed.manual_override_until
          : '',
      cooldown_until:
        typeof parsed.cooldown_until === 'string' ? parsed.cooldown_until : '',
      halted: parsed.halted === true,
    };
  } catch {
    return { ...DEFAULT_CONTROL };
  }
}

export async function getControl(): Promise<CanaryControlState> {
  if (config.mock.agentcore) return mockGetControl();
  try {
    const res = await client.send(
      new GetParameterCommand({ Name: CONTROL_PARAM }),
    );
    return parseControl(res.Parameter?.Value);
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'ParameterNotFound') {
      return { ...DEFAULT_CONTROL };
    }
    console.warn('[weight-cache] getControl failed', e?.name);
    return { ...DEFAULT_CONTROL };
  }
}

export async function setControl(
  control: Partial<CanaryControlState>,
): Promise<void> {
  // Merge with existing so partial updates don't clobber unrelated fields.
  if (config.mock.agentcore) {
    mockSetControl(control);
    return;
  }
  const existing = await getControl();
  const merged: CanaryControlState = {
    manual_override_until:
      control.manual_override_until ?? existing.manual_override_until,
    cooldown_until: control.cooldown_until ?? existing.cooldown_until,
    halted: control.halted ?? existing.halted,
  };

  await client.send(
    new PutParameterCommand({
      Name: CONTROL_PARAM,
      Value: JSON.stringify(merged),
      Type: 'String',
      Overwrite: true,
    }),
  );
}

export function invalidate(): void {
  entry = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject ARN helpers — SSM-backed, in-memory cache (no TTL needed).
// Falls back to env-var config on ParameterNotFound so existing deployments
// that haven't run /start yet still work.
// ─────────────────────────────────────────────────────────────────────────────

const SUBJECT_A_PARAM = '/orgiq/canary/subject_a_arn';
const SUBJECT_B_PARAM = '/orgiq/canary/subject_b_arn';

let cachedSubjectA = '';
let cachedSubjectB = '';

export async function getSubjectAArn(): Promise<string> {
  if (cachedSubjectA) return cachedSubjectA;
  try {
    const res = await client.send(new GetParameterCommand({ Name: SUBJECT_A_PARAM }));
    cachedSubjectA = res.Parameter?.Value ?? '';
    return cachedSubjectA || config.canary.subjectAArn;
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'ParameterNotFound') return config.canary.subjectAArn;
    console.warn('[weight-cache] getSubjectAArn failed', e?.name);
    return config.canary.subjectAArn;
  }
}

export async function getSubjectBArn(): Promise<string> {
  if (cachedSubjectB) return cachedSubjectB;
  try {
    const res = await client.send(new GetParameterCommand({ Name: SUBJECT_B_PARAM }));
    cachedSubjectB = res.Parameter?.Value ?? '';
    return cachedSubjectB || config.canary.subjectBArn;
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'ParameterNotFound') return config.canary.subjectBArn;
    console.warn('[weight-cache] getSubjectBArn failed', e?.name);
    return config.canary.subjectBArn;
  }
}

export async function setSubjectArns(aArn: string, bArn: string): Promise<void> {
  await Promise.all([
    client.send(new PutParameterCommand({
      Name: SUBJECT_A_PARAM,
      Value: aArn,
      Type: 'String',
      Overwrite: true,
    })),
    client.send(new PutParameterCommand({
      Name: SUBJECT_B_PARAM,
      Value: bArn,
      Type: 'String',
      Overwrite: true,
    })),
  ]);
  cachedSubjectA = aArn;
  cachedSubjectB = bArn;
}
