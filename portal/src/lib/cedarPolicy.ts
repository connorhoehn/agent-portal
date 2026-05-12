// Cedar policy parser/generator for the Builder mode of the policies editor.
//
// Recognizes the seed-policy template:
//   permit | forbid (
//     principal,
//     action == OrgIQ::Action::"X"   |   action in [OrgIQ::Action::"X", ...],
//     resource
//   )
//   when { principal.role == "ROLE" };
//
// Returns null when the policy doesn't fit (raw editor only). The 3 baseline
// roles all match.

export type Effect = 'permit' | 'forbid';

export interface ParsedPolicy {
  effect: Effect;
  actions: string[];
  /** null = no role condition (matches everyone). */
  role: string | null;
}

const NS = 'OrgIQ';
const ACTION_REGEX = new RegExp(`${NS}::Action::"([^"]+)"`, 'g');

export function parsePolicy(cedar: string): ParsedPolicy | null {
  // Strip line comments — they'd otherwise confuse the regex matchers.
  const stripped = cedar
    .split('\n')
    .map(line => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n')
    .trim();

  // Effect
  const effectMatch = stripped.match(/^\s*(permit|forbid)\s*\(/);
  if (!effectMatch) return null;
  const effect = effectMatch[1] as Effect;

  // Header must look like: principal, action <op> ..., resource
  const headerMatch = stripped.match(/^\s*(?:permit|forbid)\s*\(\s*principal\s*,\s*action(.*?),\s*resource\s*\)([\s\S]*)$/);
  if (!headerMatch) return null;
  const actionClause = headerMatch[1].trim();
  const rest = headerMatch[2].trim();

  // Actions
  const actions: string[] = [];
  for (const m of actionClause.matchAll(ACTION_REGEX)) actions.push(m[1]);
  if (actions.length === 0) return null;

  // Role: optional `when { principal.role == "ROLE" };`
  let role: string | null = null;
  if (rest.length > 0 && rest !== ';') {
    const whenMatch = rest.match(/^when\s*\{\s*principal\.role\s*==\s*"([^"]+)"\s*\}\s*;?\s*$/);
    if (!whenMatch) return null; // unsupported clause
    role = whenMatch[1];
  } else if (!rest.endsWith(';')) {
    // Header must be terminated, even when there's no `when`.
    return null;
  }

  return { effect, actions, role };
}

export function buildPolicy(p: ParsedPolicy): string {
  const actionList = p.actions.length === 1
    ? `action == ${NS}::Action::"${p.actions[0]}"`
    : `action in [\n    ${p.actions.map(a => `${NS}::Action::"${a}"`).join(',\n    ')}\n  ]`;
  const head = `${p.effect} (
  principal,
  ${actionList},
  resource
)`;
  if (p.role === null) return head + ';\n';
  return `${head}\nwhen { principal.role == "${p.role}" };\n`;
}
