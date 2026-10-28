/**
 * DE-28 class 1: partial secret ARNs.
 *
 * `Secret.fromSecretNameV2` renders `arn:...:secret:<name>` with no random
 * suffix. Secrets Manager reads a final `-xxxxxx` (six characters) as that
 * suffix, so `orgiq-realtime-jwt-secret` resolved to a secret named
 * `orgiq-realtime-jwt` and the task failed AccessDenied. Two views:
 * `partialSecretArns` reads a synthesised template, `nameLookupFindings` reads
 * the source for the call itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Fn::Join ARNs naming a secret by name only (no suffix, no wildcard). */
export function partialSecretArns(template: any): string[] {
  const found: string[] = [];
  const visit = (node: any, where: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    const join = node['Fn::Join'];
    if (Array.isArray(join) && Array.isArray(join[1])) {
      const parts: any[] = join[1];
      const last = parts[parts.length - 1];
      // `...:secret:<name>` as the final literal: no suffix, no wildcard (`*` or the IAM `??????`).
      const m = typeof last === 'string' ? /:secret:([^:]+)$/.exec(last) : null;
      if (m && !/[*?]/.test(m[1]!) && parts.some((p) => typeof p === 'string' && p.includes('secretsmanager'))) {
        found.push(`${where}: :secret:${m[1]}`);
      }
    }
    for (const [k, v] of Object.entries(node)) visit(v, `${where}.${k}`);
  };
  visit(template, '$');
  return found;
}

export interface NameLookupFinding { file: string; line: number; name: string | null; problem: string }

/** Source calls of `fromSecretNameV2` whose name is dynamic or ends in a six-character hyphen segment. */
export function nameLookupFindings(source: string, file: string): NameLookupFinding[] {
  const out: NameLookupFinding[] = [];
  const re = /fromSecretNameV2\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const line = source.slice(0, m.index).split('\n').length;
    // Skip comments mentioning the call.
    const lineText = source.split('\n')[line - 1]!.trimStart();
    if (lineText.startsWith('*') || lineText.startsWith('//')) continue;
    const args = splitArgs(source.slice(m.index + m[0].length));
    const raw = (args[2] ?? '').trim();
    const lit = /^(['"`])([\s\S]*)\1$/.exec(raw);
    if (!lit) { out.push({ file, line, name: null, problem: `name is not a literal (${raw.slice(0, 40)})` }); continue; }
    const name = lit[2]!.replace(/\$\{[^}]*\}/g, 'p');
    const last = name.split('-').pop()!;
    if (name.includes('-') && last.length === 6) out.push({ file, line, name, problem: `final segment "-${last}" reads as a random suffix` });
  }
  return out;
}

function splitArgs(rest: string): string[] {
  const args: string[] = [];
  let depth = 0, cur = '', quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (quote) { cur += c; if (c === quote && rest[i - 1] !== '\\') quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) { args.push(cur); return args; } depth--; }
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  args.push(cur);
  return args;
}

export function libSources(root: string): { file: string; source: string }[] {
  const dir = path.join(root, 'lib');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: `lib/${f}`, source: fs.readFileSync(path.join(dir, f), 'utf8') }));
}
