import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * tenants/kb-prefixes.json: each tenant's declared prefixes of the documents
 * bucket. The knowledge-base stack creates one data source per prefix; the
 * middleware (lib/kb-prefixes.ts) and the agents (_shared/kb_resolver.py) carry
 * literal copies that their tests compare to this file.
 */
export const KB_PREFIXES_FILE = join(__dirname, '..', '..', 'tenants', 'kb-prefixes.json');

/** A Bedrock knowledge base takes at most this many data sources. */
export const MAX_DATA_SOURCES_PER_KB = 5;

const PREFIX_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\/$/;

export interface DeclaredKbPrefix { readonly tenant: string; readonly prefix: string }

export function parseKbPrefixes(raw: unknown): DeclaredKbPrefix[] {
  const o = raw as { homeTenant?: unknown; tenants?: unknown };
  if (!o || typeof o !== 'object' || typeof o.homeTenant !== 'string') {
    throw new Error('kb-prefixes.json: needs a "homeTenant" string');
  }
  if (!o.tenants || typeof o.tenants !== 'object' || Array.isArray(o.tenants)) {
    throw new Error('kb-prefixes.json: "tenants" must map tenant ids to prefix lists');
  }
  const out: DeclaredKbPrefix[] = [];
  for (const [tenant, prefixes] of Object.entries(o.tenants as Record<string, unknown>)) {
    if (!Array.isArray(prefixes) || prefixes.length === 0) throw new Error(`kb-prefixes.json: ${tenant} needs a non-empty prefix list`);
    for (const p of prefixes) {
      if (typeof p !== 'string' || !PREFIX_RE.test(p)) throw new Error(`kb-prefixes.json: ${tenant} prefix ${JSON.stringify(p)} must be a relative folder ending in "/"`);
      out.push({ tenant, prefix: p });
    }
  }
  if (!out.some((d) => d.tenant === o.homeTenant)) throw new Error('kb-prefixes.json: the home tenant declares no prefix');
  for (const a of out) {
    for (const b of out) {
      if (a !== b && (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix))) {
        throw new Error(`kb-prefixes.json: ${a.prefix} and ${b.prefix} overlap; one data source per disjoint prefix`);
      }
    }
  }
  if (out.length > MAX_DATA_SOURCES_PER_KB) {
    throw new Error(`kb-prefixes.json: ${out.length} prefixes, but a knowledge base takes at most ${MAX_DATA_SOURCES_PER_KB} data sources`);
  }
  return out;
}

export function declaredKbPrefixes(file: string = KB_PREFIXES_FILE): DeclaredKbPrefix[] {
  return parseKbPrefixes(JSON.parse(readFileSync(file, 'utf8')));
}
