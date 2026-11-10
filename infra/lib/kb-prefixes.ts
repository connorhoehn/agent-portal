import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/**
 * tenants/kb-prefixes.json: each tenant's declared prefixes of the documents
 * bucket. The knowledge-base stack creates one data source per prefix; the
 * middleware (lib/kb-prefixes.ts) and the agents (_shared/kb_resolver.py) carry
 * literal copies that their tests compare to this file, and synth compares
 * them too (declaredKbPrefixes).
 */
export const KB_PREFIXES_FILE = join(ROOT, 'tenants', 'kb-prefixes.json');
/** The tenant registry; every tenant named in kb-prefixes.json must be one of its ids. */
export const TENANT_MANIFEST_FILE = join(ROOT, 'tenants', 'manifest.json');
/** The literal copies the middleware and the agents carry (their images do not ship the file). */
export const MIDDLEWARE_COPY_FILE = join(ROOT, 'middleware', 'src', 'lib', 'kb-prefixes.ts');
export const AGENTS_COPY_FILE = join(ROOT, 'agents', '_shared', 'kb_resolver.py');

/** A Bedrock knowledge base takes at most this many data sources. */
export const MAX_DATA_SOURCES_PER_KB = 5;

const PREFIX_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\/$/;

export interface DeclaredKbPrefix { readonly tenant: string; readonly prefix: string }

export function parseKbPrefixes(raw: unknown, knownTenants?: readonly string[]): DeclaredKbPrefix[] {
  const o = raw as { homeTenant?: unknown; tenants?: unknown };
  if (!o || typeof o !== 'object' || typeof o.homeTenant !== 'string') {
    throw new Error('kb-prefixes.json: needs a "homeTenant" string');
  }
  if (!o.tenants || typeof o.tenants !== 'object' || Array.isArray(o.tenants)) {
    throw new Error('kb-prefixes.json: "tenants" must map tenant ids to prefix lists');
  }
  const out: DeclaredKbPrefix[] = [];
  for (const [tenant, prefixes] of Object.entries(o.tenants as Record<string, unknown>)) {
    if (knownTenants && !knownTenants.includes(tenant)) {
      throw new Error(`kb-prefixes.json: ${JSON.stringify(tenant)} is not a tenant in tenants/manifest.json`);
    }
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

function readRequired(file: string, what: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    const why = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new Error(`${what} is missing or unreadable at ${file} (${why}); synth refuses to build the knowledge base without it`);
  }
}

/** The tenant ids in tenants/manifest.json. */
export function manifestTenantIds(file: string = TENANT_MANIFEST_FILE): string[] {
  const m = JSON.parse(readRequired(file, 'tenants/manifest.json')) as { tenants?: Array<{ id?: unknown }> };
  const ids = (m.tenants ?? []).map((t) => t.id).filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) throw new Error('tenants/manifest.json lists no tenants');
  return ids;
}

export type PrefixMap = Record<string, string[]>;

/** `{ tenant: [prefix, ...] }` from a literal copy's block (TypeScript single quotes, Python double quotes). */
export function parseCopyBlock(block: string, quote: "'" | '"'): PrefixMap {
  const key = quote === "'" ? '(\\w+)' : '"(\\w+)"';
  return Object.fromEntries(
    [...block.matchAll(new RegExp(`${key}: [\\[(]([^\\])]*)[\\])]`, 'g'))]
      .map((m) => [m[1]!, [...m[2]!.matchAll(new RegExp(`${quote}([^${quote}]+)${quote}`, 'g'))].map((x) => x[1]!)]),
  );
}

/** The middleware's and the agents' literal maps. Throws when either cannot be read. */
export function literalCopies(tsFile = MIDDLEWARE_COPY_FILE, pyFile = AGENTS_COPY_FILE): { middleware: PrefixMap; agents: PrefixMap } {
  const tsBlock = /DECLARED_KB_PREFIXES[^=]*= \{([\s\S]*?)\n\};/.exec(readRequired(tsFile, 'the middleware copy of the prefix map'))?.[1];
  const pyBlock = /DECLARED_PREFIXES = \{([\s\S]*?)\n\}/.exec(readRequired(pyFile, "the agents' copy of the prefix map"))?.[1];
  if (!tsBlock || !pyBlock) throw new Error('kb-prefixes: the middleware or agent copy of the prefix map could not be found in its file');
  return { middleware: parseCopyBlock(tsBlock, "'"), agents: parseCopyBlock(pyBlock, '"') };
}

/** Differences between the file's map and a copy: a tenant on one side only, or different prefixes. */
export function copyDrift(file: Readonly<Record<string, readonly string[]>>, copy: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const t of new Set([...Object.keys(file), ...Object.keys(copy)])) {
    if (!(t in file)) { out.push(`${t} is missing from the file`); continue; }
    if (!(t in copy)) { out.push(`${t} is missing from the copy`); continue; }
    const a = [...file[t]!].sort().join(',');
    const b = [...copy[t]!].sort().join(',');
    if (a !== b) out.push(`${t}: file [${a}] vs copy [${b}]`);
  }
  return out;
}

/**
 * The declared prefixes. Synth fails loudly, naming the cause, when the file
 * is absent, unreadable or not JSON, when it names a tenant the manifest does
 * not know, or when it disagrees with the middleware's or the agents' copy:
 * a tenant missing on one side would leave documents claimed by an owner that
 * no data source indexes, or indexed for a tenant the readers do not know.
 */
export function declaredKbPrefixes(
  file: string = KB_PREFIXES_FILE,
  opts: { manifest?: string; copies?: { middleware: PrefixMap; agents: PrefixMap } | null } = {},
): DeclaredKbPrefix[] {
  const raw = readRequired(file, 'tenants/kb-prefixes.json');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`kb-prefixes.json is not valid JSON: ${(err as Error).message}`); }
  const out = parseKbPrefixes(parsed, manifestTenantIds(opts.manifest));
  const copies = opts.copies === undefined ? literalCopies() : opts.copies;
  if (copies) {
    const map = (parsed as { tenants: PrefixMap }).tenants;
    const drift = [
      ...copyDrift(map, copies.middleware).map((d) => `middleware/src/lib/kb-prefixes.ts: ${d}`),
      ...copyDrift(map, copies.agents).map((d) => `agents/_shared/kb_resolver.py: ${d}`),
    ];
    if (drift.length) throw new Error(`kb-prefixes.json disagrees with a copy:\n  ${drift.join('\n  ')}`);
  }
  return out;
}
