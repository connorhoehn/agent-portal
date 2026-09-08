// Role registry derived from the Cedar seed files, so the capabilities shown
// in the Identity UI are the ones actually enforced — no second hand-written
// source of truth to drift. Labels/summaries are presentation-only and live in
// the small static map below.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RoleDefinition {
  id: string;
  tenant: string | null; // null = cross-tenant (admin)
  label: string;
  summary: string;
  capabilities: string[];
}

const PRESENTATION: Record<string, { label: string; summary: string }> = {
  member: { label: 'Member', summary: 'Rank-and-file IC. Search the org, see basic profile pages.' },
  sme: { label: 'SME', summary: 'Subject-matter expert on initiatives. Dispatches agent work against a granted budget envelope.' },
  'program-owner': { label: 'Program Owner', summary: 'Solution/program owner. Runs the delivery cadence — sprints, bots, the whole board — and allocates the monthly budget and sprint envelopes on the initiatives they own. No leaderboard access, no identity admin, and never transaction approval.' },
  'org-leader': { label: 'Org Leader', summary: 'VPs / Directors. Full org visibility, leaderboards, and transaction approval over $10k.' },
  'hr-admin': { label: 'HR Admin', summary: 'People Ops. Sees salary + performance, edits guardrails/policies, manages users and ingest.' },
  assessor: { label: 'Assessor', summary: 'Scores dimensions and manages submission intake. No exception approval or report publishing.' },
  'lead-assessor': { label: 'Lead Assessor', summary: 'Approves N/A exceptions, publishes reports, curates the assessment knowledge base.' },
  'program-lead': { label: 'Program Lead', summary: 'Owns the assessment program — rubric target level, configuration, and user management.' },
  admin: { label: 'Admin', summary: 'Cross-tenant platform operator. Full access; the only role that can masquerade.' },
};

function seedsDir(): string {
  for (const candidate of [
    join(__dirname, '..', '..', 'seeds'),
    join(__dirname, '..', 'seeds'),
    '/app/seeds',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Cannot locate middleware/seeds/ directory');
}

/** Extract the action ids from every `permit` block in a Cedar role file. */
function permittedActions(cedar: string): string[] {
  const noComments = cedar.replace(/\/\/[^\n]*/g, '');
  const actions = new Set<string>();
  for (const permitBlock of noComments.split(/\bpermit\b/).slice(1)) {
    // Ignore forbid blocks that follow; capture only up to the closing `;`.
    const stmt = permitBlock.split(';')[0] ?? '';
    // Unconstrained action (the admin blanket permit) → wildcard.
    if (/,\s*action\s*,/.test(stmt)) return ['*'];
    for (const m of stmt.matchAll(/OrgIQ::Action::"([^"]+)"/g)) actions.add(m[1]!);
  }
  return [...actions];
}

let _cache: RoleDefinition[] | null = null;

export function roleRegistry(): RoleDefinition[] {
  if (_cache) return _cache;
  const rolesDir = join(seedsDir(), 'roles');
  const out: RoleDefinition[] = [];
  for (const entry of readdirSync(rolesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cedar')) {
      const id = entry.name.replace(/\.cedar$/, '');
      out.push({
        id,
        tenant: null,
        capabilities: permittedActions(readFileSync(join(rolesDir, entry.name), 'utf8')),
        ...(PRESENTATION[id] ?? { label: id, summary: '' }),
      });
    } else if (entry.isDirectory()) {
      for (const f of readdirSync(join(rolesDir, entry.name))) {
        if (!f.endsWith('.cedar')) continue;
        const id = f.replace(/\.cedar$/, '');
        out.push({
          id,
          tenant: entry.name,
          capabilities: permittedActions(readFileSync(join(rolesDir, entry.name, f), 'utf8')),
          ...(PRESENTATION[id] ?? { label: id, summary: '' }),
        });
      }
    }
  }
  _cache = out.sort((a, b) => (a.tenant ?? '').localeCompare(b.tenant ?? '') || a.id.localeCompare(b.id));
  return _cache;
}
