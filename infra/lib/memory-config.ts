import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANTS } from './tenants.generated';

/**
 * DE-8: AgentCore Memory as per-tenant config (`infra/memory-config.json`).
 * Event expiry belongs to the memory resource, not a namespace, so each tenant
 * entry becomes its own `CfnMemory`. Unknown tenants, strategies or keys, and
 * an expiry outside the service's 7..365 days, throw at synth.
 */
/** Every tenant in tenants/manifest.json (DE-29) may carry a memory entry. */
export const MEMORY_TENANTS = TENANTS;
export const MEMORY_STRATEGIES = ['semantic', 'summary', 'user_preference'] as const;
export type MemoryStrategy = (typeof MEMORY_STRATEGIES)[number];

export interface TenantMemoryConfig {
  readonly tenant: string;
  readonly eventExpiryDays: number;
  readonly strategies: readonly MemoryStrategy[];
}

export const DEFAULT_MEMORY_CONFIG_PATH = join(__dirname, '..', 'memory-config.json');

function fail(where: string, msg: string): never {
  throw new Error(`memory-config: ${where}: ${msg}`);
}

function section(raw: unknown, where: string, base: { eventExpiryDays?: number; strategies?: MemoryStrategy[] }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(where, 'must be an object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'eventExpiryDays' && k !== 'strategies') fail(where, `unknown key "${k}"`);
  let days = base.eventExpiryDays;
  if (o.eventExpiryDays !== undefined) {
    const d = o.eventExpiryDays;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 7 || d > 365) fail(where, 'eventExpiryDays must be an integer in 7..365');
    days = d;
  }
  let strategies = base.strategies;
  if (o.strategies !== undefined) {
    if (!Array.isArray(o.strategies)) fail(where, 'strategies must be an array');
    for (const s of o.strategies) {
      if (!(MEMORY_STRATEGIES as readonly unknown[]).includes(s)) fail(where, `unknown strategy "${String(s)}"`);
    }
    strategies = [...new Set(o.strategies as MemoryStrategy[])];
  }
  return { eventExpiryDays: days, strategies };
}

export function parseMemoryConfig(raw: unknown): TenantMemoryConfig[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('root', 'must be an object');
  const root = raw as Record<string, unknown>;
  for (const k of Object.keys(root)) if (k !== 'default' && k !== 'tenants') fail('root', `unknown key "${k}"`);
  const def = section(root.default ?? {}, 'default', {});
  if (def.eventExpiryDays === undefined) fail('default', 'eventExpiryDays is required');
  const tenants = root.tenants;
  if (!tenants || typeof tenants !== 'object' || Array.isArray(tenants)) fail('tenants', 'must be an object');
  return Object.entries(tenants as Record<string, unknown>).map(([tenant, entry]) => {
    if (!(MEMORY_TENANTS as readonly string[]).includes(tenant)) fail('tenants', `unknown tenant "${tenant}"`);
    const t = section(entry, `tenants.${tenant}`, { eventExpiryDays: def.eventExpiryDays, strategies: def.strategies ?? [] });
    return { tenant, eventExpiryDays: t.eventExpiryDays!, strategies: t.strategies ?? [] };
  });
}

export function loadMemoryConfig(path = DEFAULT_MEMORY_CONFIG_PATH): TenantMemoryConfig[] {
  return parseMemoryConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/** SSM parameter holding a tenant's memory id (replaces the frozen CFN export). */
export const memoryIdParameterName = (prefix: string, tenant: string): string => `/${prefix}/memory/${tenant}/id`;
