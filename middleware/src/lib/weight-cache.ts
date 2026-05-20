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
