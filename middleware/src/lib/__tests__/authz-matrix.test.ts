// Regression lock on the role -> capability matrix defined by the SEED Cedar
// policies. This session materially reworked the authorization model (added
// ManageSprints, ManageIngest gating, grant-scoped DispatchAgentRun, an
// org-leader ApproveTransaction threshold, etc.), and there was no test that
// pinned the resulting matrix — a stray edit to a `.cedar` seed could silently
// widen or narrow a role's authority.
//
// SOURCE OF TRUTH — why we parse the `.cedar` seeds directly here:
//   - middleware/src/lib/role-registry.ts is the *production* derivation of
//     this matrix, but it reads `import.meta.url` at module scope (and stats
//     the seeds dir on load). Under ts-jest's CommonJS transform that is not
//     importable — every existing test that touches it MOCKS it out
//     (see routes/__tests__/identity.test.ts). Importing it here would test a
//     mock, not the policies.
//   - So this test reads the SAME seed files role-registry.ts reads and
//     replicates its exact enforcement-derivation logic (`permittedActions`),
//     keeping the derivation dependency-free (the design intent behind
//     lib/cedar-parse.ts). If role-registry.ts's parser and this one ever
//     disagree, that is itself a signal worth catching.
//
// This test performs NO network / AVP / supertest work: it is pure filesystem
// reads + string parsing, so it is fully deterministic offline.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Locate middleware/seeds/ from this test's directory, with the same fallback
// shape role-registry.ts uses so the test survives a dist-test transform.
// ---------------------------------------------------------------------------
function seedsDir(): string {
  for (const candidate of [
    join(__dirname, '..', '..', '..', 'seeds'), // src/lib/__tests__ -> middleware/seeds
    join(__dirname, '..', '..', 'seeds'),
    join(process.cwd(), 'seeds'),
    '/app/seeds',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Cannot locate middleware/seeds/ directory from the test');
}

// ---------------------------------------------------------------------------
// Parsing — mirrors role-registry.ts `permittedActions` exactly.
//   * strips `//` comments
//   * splits on the `permit` keyword; a `forbid` block is never a grant
//   * an unconstrained `action,` (the admin blanket permit) is a wildcard
//   * otherwise collects every OrgIQ::Action::"X" inside the permit statement
// ---------------------------------------------------------------------------
function permittedActions(cedar: string): string[] {
  const noComments = cedar.replace(/\/\/[^\n]*/g, '');
  const actions = new Set<string>();
  for (const permitBlock of noComments.split(/\bpermit\b/).slice(1)) {
    const stmt = permitBlock.split(';')[0] ?? '';
    if (/,\s*action\s*,/.test(stmt)) return ['*']; // admin blanket permit
    for (const m of stmt.matchAll(/OrgIQ::Action::"([^"]+)"/g)) actions.add(m[1]!);
  }
  return [...actions];
}

/** Action ids that appear inside `forbid` statements (explicit denials). */
function forbiddenActions(cedar: string): string[] {
  const noComments = cedar.replace(/\/\/[^\n]*/g, '');
  const actions = new Set<string>();
  for (const forbidBlock of noComments.split(/\bforbid\b/).slice(1)) {
    const stmt = forbidBlock.split(';')[0] ?? '';
    for (const m of stmt.matchAll(/OrgIQ::Action::"([^"]+)"/g)) actions.add(m[1]!);
  }
  return [...actions];
}

/** Every action id referenced ANYWHERE in a policy (permit + forbid). */
function referencedActions(cedar: string): string[] {
  const noComments = cedar.replace(/\/\/[^\n]*/g, '');
  const actions = new Set<string>();
  for (const m of noComments.matchAll(/OrgIQ::Action::"([^"]+)"/g)) actions.add(m[1]!);
  return [...actions];
}

interface Role {
  id: string;
  tenant: string | null; // null = cross-tenant (admin)
  source: string;
  cedar: string;
  granted: string[];
  forbidden: string[];
}

// Load every role once, keyed by "<tenant|*>/<id>".
function loadRoles(): Map<string, Role> {
  const rolesDir = join(seedsDir(), 'roles');
  const roles = new Map<string, Role>();
  const add = (id: string, tenant: string | null, path: string) => {
    const cedar = readFileSync(path, 'utf8');
    roles.set(`${tenant ?? '*'}/${id}`, {
      id,
      tenant,
      source: path,
      cedar,
      granted: permittedActions(cedar),
      forbidden: forbiddenActions(cedar),
    });
  };
  for (const entry of readdirSync(rolesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cedar')) {
      add(entry.name.replace(/\.cedar$/, ''), null, join(rolesDir, entry.name));
    } else if (entry.isDirectory()) {
      for (const f of readdirSync(join(rolesDir, entry.name))) {
        if (f.endsWith('.cedar')) {
          add(f.replace(/\.cedar$/, ''), entry.name, join(rolesDir, entry.name, f));
        }
      }
    }
  }
  return roles;
}

const roles = loadRoles();
const sorted = (xs: string[]) => [...xs].sort();

function role(key: string): Role {
  const r = roles.get(key);
  if (!r) throw new Error(`Seed role not found: ${key} (have: ${[...roles.keys()].join(', ')})`);
  return r;
}

// ===========================================================================
// The matrix. Each role's granted set is asserted EXACTLY (set equality is the
// real lock: it fails on any widening AND any narrowing). Explicit has/hasn't
// spot-checks below re-state the security-critical grants for intent.
// ===========================================================================

const MATRIX: Record<string, { tenant: string | null; granted: string[] }> = {
  'orgiq/member': {
    tenant: 'orgiq',
    granted: ['Search', 'ViewOrgChart', 'ViewObservability', 'LabelFeedback'],
  },
  'orgiq/sme': {
    tenant: 'orgiq',
    granted: [
      'Search', 'ViewOrgChart', 'ViewObservability', 'LabelFeedback',
      'DispatchAgentRun', 'ManageSprints',
    ],
  },
  'orgiq/org-leader': {
    tenant: 'orgiq',
    granted: [
      'Search', 'ViewOrgChart', 'ViewLeaderboard', 'ViewObservability', 'LabelFeedback',
      'ManageCanary', 'DispatchAgentRun', 'ManageBudgets', 'ManageSprints', 'ApproveTransaction',
    ],
  },
  'orgiq/hr-admin': {
    tenant: 'orgiq',
    granted: [
      'Search', 'ViewOrgChart', 'ViewLeaderboard', 'ViewSalary', 'ViewPerformance',
      'EditGuardrail', 'EditPolicy', 'EditSchema', 'ViewIdentityAdmin', 'ViewObservability',
      'LabelFeedback', 'ManageIngest', 'ManageCanary', 'ManageKB', 'ManageDevbox',
      'ManageUsers', 'DispatchAgentRun', 'ManageBudgets',
    ],
  },
  'newsroom/reporter': {
    tenant: 'newsroom',
    granted: ['Search', 'WriteArticle', 'ManagePitches', 'LabelFeedback'],
  },
  'newsroom/editor': {
    tenant: 'newsroom',
    granted: [
      'Search', 'WriteArticle', 'ManagePitches', 'PublishArticle',
      'ManageKB', 'ViewObservability', 'LabelFeedback',
    ],
  },
  '*/admin': {
    tenant: null,
    granted: ['*'], // cross-tenant blanket permit
  },
};

describe('seed Cedar role -> capability matrix', () => {
  test('exactly the seven seed roles exist', () => {
    expect(sorted([...roles.keys()])).toEqual(sorted(Object.keys(MATRIX)));
  });

  describe.each(Object.entries(MATRIX))('%s', (key, expected) => {
    test('is scoped to the expected tenant', () => {
      expect(role(key).tenant).toBe(expected.tenant);
    });

    test('grants exactly its expected capability set', () => {
      expect(sorted(role(key).granted)).toEqual(sorted(expected.granted));
    });
  });
});

// ---------------------------------------------------------------------------
// Security-critical positive/negative spot checks (redundant with set equality
// above, but they document intent and pinpoint the exact regression).
// ---------------------------------------------------------------------------
describe('capability boundaries that must not regress', () => {
  const has = (key: string, cap: string) => role(key).granted.includes(cap);

  test('member is a read-only IC — no dispatch, budgets, sprints, ingest, approval, masquerade', () => {
    const m = role('orgiq/member').granted;
    for (const cap of [
      'DispatchAgentRun', 'ManageBudgets', 'ManageSprints', 'ManageIngest',
      'ApproveTransaction', 'Masquerade', 'ManageUsers', 'ViewLeaderboard',
    ]) {
      expect(m).not.toContain(cap);
    }
  });

  test('sme adds dispatch + sprints only; never budgets, ingest, approval, masquerade', () => {
    expect(has('orgiq/sme', 'DispatchAgentRun')).toBe(true);
    expect(has('orgiq/sme', 'ManageSprints')).toBe(true);
    for (const cap of ['ManageBudgets', 'ManageIngest', 'ApproveTransaction', 'Masquerade', 'ManageUsers']) {
      expect(has('orgiq/sme', cap)).toBe(false);
    }
  });

  test('org-leader holds budgets/sprints/dispatch/approval; not ingest, users, masquerade', () => {
    for (const cap of ['ManageBudgets', 'ManageSprints', 'DispatchAgentRun', 'ApproveTransaction']) {
      expect(has('orgiq/org-leader', cap)).toBe(true);
    }
    for (const cap of ['ManageIngest', 'ManageUsers', 'Masquerade', 'EditPolicy']) {
      expect(has('orgiq/org-leader', cap)).toBe(false);
    }
  });

  test('hr-admin owns the admin surface (ingest/users/policy/devbox) + budgets, but not approval or masquerade', () => {
    for (const cap of [
      'ManageIngest', 'ManageUsers', 'EditPolicy', 'EditGuardrail', 'EditSchema',
      'ManageDevbox', 'ManageKB', 'ViewIdentityAdmin', 'ManageBudgets', 'DispatchAgentRun',
    ]) {
      expect(has('orgiq/hr-admin', cap)).toBe(true);
    }
    // hr-admin DOES hold ManageBudgets (grants agent spend); it does NOT approve
    // transactions (separation of duties) and cannot masquerade.
    for (const cap of ['ApproveTransaction', 'Masquerade']) {
      expect(has('orgiq/hr-admin', cap)).toBe(false);
    }
  });

  test('reporter can pitch but never publish', () => {
    expect(has('newsroom/reporter', 'ManagePitches')).toBe(true);
    expect(has('newsroom/reporter', 'Search')).toBe(true);
    expect(has('newsroom/reporter', 'PublishArticle')).toBe(false);
  });

  test('editor is reporter + publish', () => {
    expect(has('newsroom/editor', 'ManagePitches')).toBe(true);
    expect(has('newsroom/editor', 'PublishArticle')).toBe(true);
  });

  test('admin is the ONLY role with a blanket grant — and thus the only masquerader', () => {
    // The blanket permit is the sole source of Masquerade authority. Assert no
    // OTHER role names Masquerade in its permit list, and admin is a wildcard.
    expect(role('*/admin').granted).toEqual(['*']);
    for (const [key, r] of roles) {
      if (key === '*/admin') continue;
      expect(r.granted).not.toContain('Masquerade');
      expect(r.granted).not.toEqual(['*']);
    }
  });
});

// ---------------------------------------------------------------------------
// Explicit forbids — Cedar forbids override any permit, including admin's
// blanket grant while masquerading. Lock the three ApproveTransaction denials.
// ---------------------------------------------------------------------------
describe('explicit ApproveTransaction forbids (separation of duties)', () => {
  test.each(['orgiq/member', 'orgiq/sme', 'orgiq/hr-admin'])(
    '%s explicitly forbids ApproveTransaction and does not permit it',
    (key) => {
      expect(role(key).forbidden).toContain('ApproveTransaction');
      expect(role(key).granted).not.toContain('ApproveTransaction');
    },
  );

  test('org-leader is the sole ApproveTransaction grantee, gated on amount > 10000', () => {
    expect(role('orgiq/org-leader').granted).toContain('ApproveTransaction');
    expect(role('orgiq/org-leader').forbidden).not.toContain('ApproveTransaction');
    // The approval permit is threshold-scoped, not blanket.
    expect(role('orgiq/org-leader').cedar).toMatch(/resource\.amount\s*>\s*10000/);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation: the enforcement mechanism is the `principal.tenant`
// condition on every tenant-scoped permit. An orgiq role's grants can never
// apply inside newsroom (and vice-versa) because the permit only matches when
// principal.tenant equals the role's tenant. Admin is deliberately NOT
// tenant-conditioned (break-glass), so its blanket permit applies in whatever
// tenant the session is parked in.
// ---------------------------------------------------------------------------
describe('cross-tenant isolation', () => {
  test.each([
    ['orgiq/member', 'orgiq'],
    ['orgiq/sme', 'orgiq'],
    ['orgiq/org-leader', 'orgiq'],
    ['orgiq/hr-admin', 'orgiq'],
    ['newsroom/reporter', 'newsroom'],
    ['newsroom/editor', 'newsroom'],
  ])('%s guards its permit with principal.tenant == "%s"', (key, tenant) => {
    const r = role(key);
    // The permit only fires in-tenant.
    expect(r.cedar).toMatch(new RegExp(`principal\\.tenant\\s*==\\s*"${tenant}"`));
    // ...and never claims the other tenant.
    const other = tenant === 'orgiq' ? 'newsroom' : 'orgiq';
    expect(r.cedar).not.toMatch(new RegExp(`principal\\.tenant\\s*==\\s*"${other}"`));
  });

  test('admin is cross-tenant: no principal.tenant condition', () => {
    expect(role('*/admin').cedar).not.toMatch(/principal\.tenant\s*==/);
  });

  test('newsroom roles carry no orgiq-only management capability', () => {
    // Newsroom grants must not leak orgiq program/admin authority.
    const orgiqOnly = ['ManageBudgets', 'ManageSprints', 'DispatchAgentRun', 'ManageIngest', 'ManageUsers', 'ApproveTransaction'];
    for (const key of ['newsroom/reporter', 'newsroom/editor']) {
      for (const cap of orgiqOnly) {
        expect(role(key).granted).not.toContain(cap);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Schema completeness: AVP's CreatePolicy rejects any policy referencing an
// action the schema doesn't declare. Guard against a role granting/forbidding
// an action that seeds/schema.json doesn't know about.
// ---------------------------------------------------------------------------
describe('schema completeness (AVP rejects undeclared actions)', () => {
  const schema = JSON.parse(readFileSync(join(seedsDir(), 'schema.json'), 'utf8'));
  const declared: Set<string> = new Set(Object.keys(schema.OrgIQ.actions));

  test('every action referenced by any role is declared in schema.json', () => {
    const undeclared: string[] = [];
    for (const r of roles.values()) {
      for (const action of referencedActions(r.cedar)) {
        if (!declared.has(action)) undeclared.push(`${r.tenant ?? '*'}/${r.id}:${action}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  test('Masquerade is a declared action even though only the admin blanket permit confers it', () => {
    expect(declared.has('Masquerade')).toBe(true);
  });

  test('schema principal/resource shape matches what the policies condition on', () => {
    // Policies read principal.role, principal.tenant and resource.amount.
    const user = schema.OrgIQ.entityTypes.User.shape.attributes;
    expect(user.role).toEqual({ type: 'String', required: true });
    expect(user.tenant.type).toBe('String');
    expect(schema.OrgIQ.entityTypes.Application.shape.attributes.amount.type).toBe('Long');
  });
});
