// Central, versioned model registry — the BFF's reader (DE-3).
//
// The registry is one JSON document in SSM, `/orgiq/models/registry`, written
// by CDK from the checked-in `infra/config/model-registry.json` (the agents read
// the same document through `agents/_shared/model_registry.py`). This reader
// gives BFF call sites one way to ask "which model does role X use", with the
// same fallbacks the agents have, so a registry outage never stops a caller:
//
//   MODEL_REGISTRY_PARAM set and not mocked → SSM (20 s cache, stale on error)
//   otherwise                                → the checked-in file, never SSM
//   role missing / registry unreadable        → the caller's literal fallback
//
// Every id is checked against the AWS-native prefixes; the registry's own
// `allow` list may narrow them, never widen them (same rule as the CDK synth
// check in infra/lib/model-registry.ts).
//
// Scope note: DE-3 moves the agents and the eval judge now. The BFF's other
// model ids (doc-linker, change-reviewer, site-survey, judge.ts) move onto
// this reader in a second pass, so wiring here changes no live behaviour yet.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { config } from '../config.js';

export const ALLOWED_MODEL_PREFIXES = ['amazon.', 'us.amazon.', 'eu.amazon.', 'apac.amazon.'] as const;

export interface ModelRoleEntry {
  primary: string;
  fallbacks?: string[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelRegistry {
  schema: 1;
  roles: Record<string, ModelRoleEntry>;
  allow?: string[];
}

export interface ResolvedRegistry {
  registry: ModelRegistry | null;
  /** SSM parameter version, '' offline. */
  version: string;
  source: 'ssm' | 'file' | 'none';
}

const TTL_MS = 20_000;

/**
 * Cross-region inference profiles (`us.` / `eu.` / `apac.`) bill as the
 * underlying foundation model, so a price lookup keyed by bare id must strip
 * the region prefix first — otherwise a `us.amazon.nova-pro-v1:0` run reads
 * as unpriced. DE-3 item 6; `pricing.ts` is the intended caller.
 */
export function stripInferenceProfilePrefix(modelId: string): string {
  return modelId.replace(/^(us|eu|apac)\./, '');
}

export function isAllowedModelId(id: unknown, allow: readonly string[] = ALLOWED_MODEL_PREFIXES): boolean {
  if (typeof id !== 'string' || !id.trim()) return false;
  const narrowed = allow.filter((p) => (ALLOWED_MODEL_PREFIXES as readonly string[]).includes(p));
  const effective = narrowed.length ? narrowed : ALLOWED_MODEL_PREFIXES;
  return effective.some((p) => id.startsWith(p));
}

/** The registry when every id is AWS-native, else throws naming each problem. */
export function validateModelRegistry(doc: unknown): ModelRegistry {
  const d = doc as Partial<ModelRegistry> | null;
  if (!d || typeof d !== 'object') throw new Error('model registry must be a JSON object');
  const problems: string[] = [];
  if (d.schema !== 1) problems.push(`unsupported schema ${JSON.stringify(d.schema)}`);
  const allow: readonly string[] = Array.isArray(d.allow) ? d.allow : ALLOWED_MODEL_PREFIXES;
  const widened = allow.filter((p) => !(ALLOWED_MODEL_PREFIXES as readonly string[]).includes(p));
  if (widened.length) problems.push(`allow widens the AWS-native rule: ${widened.join(', ')}`);
  if (!d.roles || typeof d.roles !== 'object' || !Object.keys(d.roles).length) {
    problems.push('roles must be a non-empty object');
  } else {
    for (const [role, entry] of Object.entries(d.roles)) {
      for (const id of [entry?.primary, ...(entry?.fallbacks ?? [])]) {
        if (!isAllowedModelId(id, allow)) problems.push(`role ${role}: model id ${JSON.stringify(id)} is not AWS-native`);
      }
    }
  }
  if (problems.length) throw new Error(`model registry: ${problems.join('; ')}`);
  return d as ModelRegistry;
}

function registryFile(): string | null {
  const explicit = process.env.MODEL_REGISTRY_FILE?.trim();
  if (explicit) return explicit;
  for (const candidate of [
    resolve(process.cwd(), '..', 'infra', 'config', 'model-registry.json'),
    resolve(process.cwd(), 'infra', 'config', 'model-registry.json'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let client: SSMClient | null = null;
let entry: { value: ResolvedRegistry; key: string; fetchedAt: number } | null = null;

export async function getModelRegistry(): Promise<ResolvedRegistry> {
  const param = process.env.MODEL_REGISTRY_PARAM?.trim();
  const pinned = process.env.MODEL_REGISTRY_VERSION?.trim();
  // OFFLINE: the checked-in file is the registry; SSM is never called (same
  // reason as judge-config.ts — a doomed GetParameter logs a misleading error).
  const online = Boolean(param) && !config.mock.agentcore;
  const key = online ? `ssm:${param}:${pinned ?? ''}` : `file:${registryFile() ?? ''}`;
  const now = Date.now();
  if (entry && entry.key === key && now - entry.fetchedAt < TTL_MS) return entry.value;

  let value: ResolvedRegistry;
  if (online) {
    try {
      client ??= new SSMClient({});
      const name = pinned ? `${param}:${pinned}` : param!;
      const res = await client.send(new GetParameterCommand({ Name: name }));
      value = {
        registry: validateModelRegistry(JSON.parse(res.Parameter?.Value ?? '{}')),
        version: String(res.Parameter?.Version ?? pinned ?? ''),
        source: 'ssm',
      };
    } catch (err) {
      if (entry && entry.key === key && entry.value.registry) return entry.value; // stale on error
      console.warn('[model-registry] SSM read failed, using fallbacks', (err as { name?: string })?.name ?? err);
      value = { registry: null, version: '', source: 'none' };
    }
  } else {
    const file = registryFile();
    try {
      value = file
        ? { registry: validateModelRegistry(JSON.parse(readFileSync(file, 'utf8'))), version: '', source: 'file' }
        : { registry: null, version: '', source: 'none' };
    } catch (err) {
      console.warn('[model-registry] registry file unreadable, using fallbacks', (err as Error)?.message);
      value = { registry: null, version: '', source: 'none' };
    }
  }
  entry = { value, key, fetchedAt: now };
  return value;
}

/** The ordered model chain for `role` (primary first), or `[fallback]`. */
export async function modelChainForRole(role: string, fallback: string): Promise<string[]> {
  const { registry } = await getModelRegistry();
  const e = registry?.roles[role];
  if (!e) return [fallback];
  return [...new Set([e.primary, ...(e.fallbacks ?? [])])];
}

export async function modelForRole(role: string, fallback: string): Promise<string> {
  return (await modelChainForRole(role, fallback))[0];
}

/** Test hook. */
export function resetModelRegistryCache(): void {
  entry = null;
  client = null;
}
