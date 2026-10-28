import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DE-7: the gateway's tools come from `infra/gateway-tools.json`. This module
 * is the synth-time schema check: unknown keys, an unknown access value (there
 * is no `aurora: "admin"`), a duplicate name or an unknown agent all throw.
 */
export type AuroraAccess = 'none' | 'reader';

export interface GatewayToolAccess {
  readonly kb: boolean;
  readonly aurora: AuroraAccess;
  readonly bedrockInvoke: boolean;
}

export interface GatewayToolSpec {
  readonly name: string;
  readonly target: string;
  /** Construct-id stem; keeps already-deployed logical ids stable. Defaults to PascalCase(target). */
  readonly logicalId: string;
  readonly handler: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly access: GatewayToolAccess;
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  readonly agents: readonly string[];
}

export interface GatewayToolManifest { readonly tools: readonly GatewayToolSpec[] }

export const DEFAULT_MANIFEST_PATH = join(__dirname, '..', 'gateway-tools.json');

const TOOL_KEYS = new Set(['name', 'target', 'logicalId', 'handler', 'description', 'inputSchema',
  'access', 'timeoutSeconds', 'memoryMb', 'agents']);
const ACCESS_KEYS = new Set(['kb', 'aurora', 'bedrockInvoke']);
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const HANDLER_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

function fail(where: string, msg: string): never {
  throw new Error(`gateway-tools manifest: ${where}: ${msg}`);
}

function pascal(s: string): string {
  return s.split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

export function parseGatewayToolManifest(raw: unknown, knownAgents: readonly string[]): GatewayToolManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('root', 'must be an object');
  const root = raw as Record<string, unknown>;
  for (const k of Object.keys(root)) if (k !== 'tools') fail('root', `unknown key "${k}"`);
  if (!Array.isArray(root.tools) || root.tools.length === 0) fail('tools', 'must be a non-empty array');

  const names = new Set<string>();
  const targets = new Set<string>();
  const ids = new Set<string>();
  const tools: GatewayToolSpec[] = (root.tools as unknown[]).map((entry, i) => {
    const where = `tools[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(where, 'must be an object');
    const t = entry as Record<string, unknown>;
    for (const k of Object.keys(t)) if (!TOOL_KEYS.has(k)) fail(where, `unknown key "${k}"`);
    const str = (k: string): string => {
      if (typeof t[k] !== 'string' || !(t[k] as string).trim()) fail(where, `"${k}" must be a non-empty string`);
      return t[k] as string;
    };
    const name = str('name');
    const target = str('target');
    if (!NAME_RE.test(name)) fail(where, `name "${name}" must match ${NAME_RE}`);
    if (!NAME_RE.test(target)) fail(where, `target "${target}" must match ${NAME_RE}`);
    const handler = str('handler');
    if (!HANDLER_RE.test(handler)) fail(where, `handler "${handler}" must look like module.function`);
    const logicalId = t.logicalId === undefined ? pascal(target) : str('logicalId');
    if (!/^[A-Z][A-Za-z0-9]*$/.test(logicalId)) fail(where, `logicalId "${logicalId}" must be PascalCase alphanumeric`);
    for (const [set, v, label] of [[names, name, 'name'], [targets, target, 'target'], [ids, logicalId, 'logicalId']] as const) {
      if (set.has(v)) fail(where, `duplicate ${label} "${v}"`);
      set.add(v);
    }
    const schema = t.inputSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || (schema as any).type !== 'object') {
      fail(where, 'inputSchema must be a JSON-schema object with type "object"');
    }
    const a = (t.access ?? {}) as Record<string, unknown>;
    if (typeof a !== 'object' || Array.isArray(a)) fail(where, 'access must be an object');
    for (const k of Object.keys(a)) if (!ACCESS_KEYS.has(k)) fail(where, `access has unknown key "${k}"`);
    const aurora = (a.aurora ?? 'none') as string;
    if (aurora !== 'none' && aurora !== 'reader') fail(where, `access.aurora must be "none" or "reader", got "${aurora}"`);
    for (const k of ['kb', 'bedrockInvoke']) {
      if (a[k] !== undefined && typeof a[k] !== 'boolean') fail(where, `access.${k} must be a boolean`);
    }
    const num = (k: string, min: number, max: number): number => {
      const v = t[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(where, `"${k}" must be an integer in ${min}..${max}`);
      return v as number;
    };
    const agents = t.agents;
    if (!Array.isArray(agents) || agents.length === 0) fail(where, '"agents" must be a non-empty array');
    for (const ag of agents as unknown[]) {
      if (typeof ag !== 'string' || !knownAgents.includes(ag)) fail(where, `unknown agent "${String(ag)}"`);
    }
    return {
      name, target, logicalId, handler, description: str('description'),
      inputSchema: schema as Record<string, unknown>,
      access: { kb: a.kb === true, aurora: aurora as AuroraAccess, bedrockInvoke: a.bedrockInvoke === true },
      timeoutSeconds: num('timeoutSeconds', 1, 900),
      memoryMb: num('memoryMb', 128, 10240),
      agents: [...new Set(agents as string[])],
    };
  });
  return { tools };
}

export function loadGatewayToolManifest(knownAgents: readonly string[], path = DEFAULT_MANIFEST_PATH): GatewayToolManifest {
  return parseGatewayToolManifest(JSON.parse(readFileSync(path, 'utf8')), knownAgents);
}
