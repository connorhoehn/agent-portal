/**
 * Central, versioned model registry (DE-3).
 *
 * `infra/config/model-registry.json` is the reviewed source; CDK writes it to
 * SSM `/<prefix>/models/registry` (standard tier), so SSM's own parameter
 * history numbers every change. Agents read it at run time through
 * `agents/_shared/model_registry.py` (60 s cache, `MODEL_ID` as the cold
 * fallback), so a registry edit rolls no runtime.
 *
 * The validator here is the synth half of the AWS-native-only rule: every id
 * must start with an allowed prefix, and a registry's own `allow` list may
 * narrow the built-in prefixes but never widen them. The same rule runs in the
 * Python resolver. The devbox's Claude inference profile is outside the
 * registry by design (`devbox-stack.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ALLOWED_MODEL_PREFIXES = ['amazon.', 'us.amazon.', 'eu.amazon.', 'apac.amazon.'] as const;

export const DEFAULT_MODEL_REGISTRY_FILE = path.join(__dirname, '..', 'config', 'model-registry.json');

export interface ModelRoleEntry {
  readonly primary: string;
  readonly fallbacks?: readonly string[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ModelRegistry {
  readonly schema: 1;
  readonly roles: Record<string, ModelRoleEntry>;
  readonly allow?: readonly string[];
}

export function isAllowedModelId(id: unknown, allow: readonly string[] = ALLOWED_MODEL_PREFIXES): boolean {
  if (typeof id !== 'string' || !id.trim()) return false;
  const narrowed = allow.filter((p) => (ALLOWED_MODEL_PREFIXES as readonly string[]).includes(p));
  const effective = narrowed.length ? narrowed : ALLOWED_MODEL_PREFIXES;
  return effective.some((p) => id.startsWith(p));
}

/** Throws with every problem listed; returns the typed registry when clean. */
export function validateModelRegistry(doc: unknown, source = 'model registry'): ModelRegistry {
  const problems: string[] = [];
  const d = doc as Partial<ModelRegistry> | null;
  if (!d || typeof d !== 'object') throw new Error(`${source}: must be a JSON object`);
  if (d.schema !== 1) problems.push(`unsupported schema ${JSON.stringify(d.schema)}`);
  const allow = d.allow ?? ALLOWED_MODEL_PREFIXES;
  if (!Array.isArray(allow) || !allow.every((p) => typeof p === 'string')) {
    problems.push('allow must be a list of prefixes');
  } else {
    const widened = allow.filter((p) => !(ALLOWED_MODEL_PREFIXES as readonly string[]).includes(p));
    if (widened.length) problems.push(`allow widens the AWS-native rule: ${widened.join(', ')}`);
  }
  const roles = d.roles;
  if (!roles || typeof roles !== 'object' || !Object.keys(roles).length) {
    problems.push('roles must be a non-empty object');
  } else {
    for (const [role, entry] of Object.entries(roles)) {
      if (!entry || typeof entry !== 'object') {
        problems.push(`role ${role}: entry must be an object`);
        continue;
      }
      for (const id of [entry.primary, ...(entry.fallbacks ?? [])]) {
        if (!isAllowedModelId(id, Array.isArray(allow) ? allow : ALLOWED_MODEL_PREFIXES)) {
          problems.push(`role ${role}: model id ${JSON.stringify(id)} is not AWS-native`);
        }
      }
    }
  }
  if (problems.length) throw new Error(`${source}: ${problems.join('; ')}`);
  return d as ModelRegistry;
}

export function loadModelRegistry(file: string = DEFAULT_MODEL_REGISTRY_FILE): ModelRegistry {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateModelRegistry(raw, file);
}

/** The registry's primary for `role`, or `fallback` when the role is absent. */
export function primaryModelFor(registry: ModelRegistry, role: string, fallback: string): string {
  return registry.roles[role]?.primary ?? fallback;
}
