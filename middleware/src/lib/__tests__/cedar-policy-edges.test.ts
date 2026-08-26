// Regression lock on the Cedar-policy EDGE CASES that the role -> capability
// matrix (authz-matrix.test.ts) does not pin. The matrix test asserts each
// role's *granted action set*; it does not look inside individual policy
// statements at the conditions that make those grants safe:
//
//   1. the threshold that scopes org-leader's ApproveTransaction permit,
//   2. the explicit forbid statements (effect + target + when-clause shape)
//      that survive a future broad permit and a masquerading admin,
//   3. the per-statement `principal.tenant` conditioning that is the
//      cross-pollination guard at the policy layer,
//   4. admin's structural uniqueness (sole wildcard / sole Masquerade holder),
//   5. schema<->policy agreement at the attribute/type level.
//
// These are the invariants a stray `.cedar` edit could break WITHOUT changing
// any role's coarse granted-action set — so the matrix test would stay green
// while the security property silently regressed (e.g. `>` widened to `>=`, a
// forbid's `when` gaining a tenant guard that lets a masquerader slip past, a
// tenant condition dropped so an orgiq permit fires inside newsroom).
//
// Like authz-matrix.test.ts this is pure filesystem reads + string parsing
// (reusing the same seed-parsing approach and lib/cedar-parse.ts's
// `splitStatements` for per-statement granularity): deterministic, offline, no
// supertest / AVP / network.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitStatements } from '../cedar-parse.js';

// ---------------------------------------------------------------------------
// Seed location — same fallback shape role-registry.ts / authz-matrix.test.ts
// use so the test survives a dist-test transform.
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

interface Role {
  id: string;
  tenant: string | null; // null = cross-tenant (admin, a top-level *.cedar)
  cedar: string;
  statements: string[]; // one permit/forbid each, comments stripped
}

/** Statements that begin with `permit`. */
function permits(r: Role): string[] {
  return r.statements.filter((s) => /^permit\b/.test(s));
}
/** Statements that begin with `forbid`. */
function forbids(r: Role): string[] {
  return r.statements.filter((s) => /^forbid\b/.test(s));
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
      cedar,
      statements: splitStatements(cedar),
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
function role(key: string): Role {
  const r = roles.get(key);
  if (!r) throw new Error(`Seed role not found: ${key} (have: ${[...roles.keys()].join(', ')})`);
  return r;
}

// A `when { ... }` (or `unless { ... }`) condition body, flattened to a single
// line so multi-line conditions match with simple regexes.
function whenBody(statement: string): string {
  const m = statement.match(/\bwhen\s*\{([\s\S]*)\}/);
  return (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

const NON_ADMIN_TENANTS: Array<[string, string]> = [
  ['orgiq/member', 'orgiq'],
  ['orgiq/sme', 'orgiq'],
  ['orgiq/org-leader', 'orgiq'],
  ['orgiq/hr-admin', 'orgiq'],
  ['newsroom/reporter', 'newsroom'],
  ['newsroom/editor', 'newsroom'],
];

// ===========================================================================
// 1. Threshold-conditioned action — org-leader ApproveTransaction.
//    The approval permit must stay strictly threshold-scoped; the coarse
//    matrix ("org-leader grants ApproveTransaction") cannot see the operator
//    or the guard, so a `>` -> `>=` slip or a dropped `resource has amount`
//    would pass the matrix test but change who can approve what.
// ===========================================================================
describe('threshold: org-leader ApproveTransaction is gated on resource.amount > 10000', () => {
  const approvalPermit = () =>
    permits(role('orgiq/org-leader')).find((s) => /ApproveTransaction/.test(s));

  test('there is a dedicated permit statement targeting ApproveTransaction', () => {
    const p = approvalPermit();
    expect(p).toBeDefined();
    // It is a single-action permit (`action ==`), not folded into the `action in [...]` grant list.
    expect(p!).toMatch(/action\s*==\s*OrgIQ::Action::"ApproveTransaction"/);
    expect(p!).not.toMatch(/action\s+in\s*\[[\s\S]*ApproveTransaction/);
  });

  test('the guard is `resource has amount` then strictly `resource.amount > 10000`', () => {
    const cond = whenBody(approvalPermit()!);
    // Presence-check precedes the read (Cedar errors on a missing attr without it).
    expect(cond).toMatch(/resource\s+has\s+amount/);
    expect(cond).toMatch(/resource\.amount\s*>\s*10000\b/);
    // Strictly greater-than: NOT >=, <, <=, or ==. A relaxed operator would
    // widen approval authority below the intended floor.
    expect(cond).not.toMatch(/resource\.amount\s*>=/);
    expect(cond).not.toMatch(/resource\.amount\s*<=?/);
    expect(cond).not.toMatch(/resource\.amount\s*==/);
    // The threshold literal is exactly 10000 (no stray digits / different floor).
    const amounts = [...cond.matchAll(/resource\.amount\s*>\s*(\d+)/g)].map((m) => m[1]);
    expect(amounts).toEqual(['10000']);
  });

  test('the approval threshold lives ONLY on the approval permit, not the general grant', () => {
    const generalGrant = permits(role('orgiq/org-leader')).find((s) => /action\s+in\s*\[/.test(s));
    expect(generalGrant).toBeDefined();
    // The Search/ViewOrgChart/... bundle must not carry an amount condition.
    expect(generalGrant!).not.toMatch(/amount/);
  });

  test('schema backs the threshold: Application.amount is a numeric Long', () => {
    const schema = JSON.parse(readFileSync(join(seedsDir(), 'schema.json'), 'utf8'));
    const amount = schema.OrgIQ.entityTypes.Application.shape.attributes.amount;
    expect(amount.type).toBe('Long'); // `> 10000` is an integer comparison
    expect(amount.required).toBe(false); // hence the `resource has amount` guard above
  });
});

// ===========================================================================
// 2. Explicit forbid-wins — member / sme / hr-admin deny ApproveTransaction.
//    Cedar forbids override any permit (including admin's blanket grant while
//    masquerading). These assertions pin the forbid SHAPE, not just its
//    presence: single-action target, and a `when` that keys ONLY on
//    principal.role so the deny cannot be tenant-scoped away.
// ===========================================================================
describe('explicit forbid-wins on ApproveTransaction (separation of duties)', () => {
  const DENIERS = ['orgiq/member', 'orgiq/sme', 'orgiq/hr-admin'];

  test.each(DENIERS)('%s has exactly one forbid, targeting ApproveTransaction by equality', (key) => {
    const fs = forbids(role(key));
    expect(fs).toHaveLength(1);
    expect(fs[0]!).toMatch(/action\s*==\s*OrgIQ::Action::"ApproveTransaction"/);
    // Not a list target — a single, unambiguous action equality.
    expect(fs[0]!).not.toMatch(/action\s+in\s*\[/);
  });

  test.each(DENIERS)('%s forbid keys only on principal.role, so it survives masquerade and tenant switch', (key) => {
    const cond = whenBody(forbids(role(key))[0]!);
    const roleId = key.split('/')[1];
    expect(cond).toBe(`principal.role == "${roleId}"`);
    // A tenant condition on the forbid would let an admin masquerading in a
    // different tenant slip the deny — assert there is none.
    expect(cond).not.toMatch(/principal\.tenant/);
  });

  test('member forbids ApproveTransaction as belt-and-suspenders: it never permits it in the first place', () => {
    const member = role('orgiq/member');
    // No permit statement mentions ApproveTransaction...
    expect(permits(member).some((s) => /ApproveTransaction/.test(s))).toBe(false);
    // ...yet the forbid is present anyway, so a future broad permit still can't grant it.
    expect(forbids(member).some((s) => /ApproveTransaction/.test(s))).toBe(true);
  });

  test('only org-leader PERMITS ApproveTransaction; no other role does', () => {
    const permitters = [...roles.entries()]
      .filter(([, r]) => permits(r).some((s) => /ApproveTransaction/.test(s)))
      .map(([k]) => k);
    expect(permitters).toEqual(['orgiq/org-leader']);
  });
});

// ===========================================================================
// 3. Tenant conditioning — the cross-pollination guard, asserted per-statement.
//    Every permit of a non-admin role must condition on its own tenant (so an
//    orgiq grant can never fire inside newsroom and vice-versa). org-leader has
//    TWO permits; both must be guarded — a per-statement check the file-level
//    regex in the matrix test does not make.
// ===========================================================================
describe('per-statement tenant conditioning (cross-pollination guard)', () => {
  test.each(NON_ADMIN_TENANTS)('%s: EVERY permit conditions on principal.tenant == "%s"', (key, tenant) => {
    const ps = permits(role(key));
    expect(ps.length).toBeGreaterThan(0);
    const other = tenant === 'orgiq' ? 'newsroom' : 'orgiq';
    for (const p of ps) {
      const cond = whenBody(p);
      expect(cond).toMatch(new RegExp(`principal\\.tenant\\s*==\\s*"${tenant}"`));
      // Presence guard precedes the equality (Cedar-safe read of an optional attr).
      expect(cond).toMatch(/principal\s+has\s+tenant/);
      // ...and never claims the other tenant.
      expect(cond).not.toMatch(new RegExp(`"${other}"`));
    }
  });

  test('org-leader carries the tenant guard on BOTH its permits (general grant AND approval)', () => {
    const ps = permits(role('orgiq/org-leader'));
    expect(ps).toHaveLength(2);
    for (const p of ps) {
      expect(whenBody(p)).toMatch(/principal\.tenant\s*==\s*"orgiq"/);
    }
  });

  test('admin has NO tenant condition on any statement (cross-tenant break-glass)', () => {
    for (const s of role('*/admin').statements) {
      expect(whenBody(s)).not.toMatch(/principal\.tenant/);
    }
  });
});

// ===========================================================================
// 4. Admin uniqueness — sole wildcard permit, sole Masquerade holder.
// ===========================================================================
describe('admin structural uniqueness', () => {
  // An unconstrained `action,` in the scope is the wildcard permit.
  const isWildcard = (stmt: string) => /,\s*action\s*,/.test(stmt);

  test('admin is a single wildcard permit — no action list, no forbid', () => {
    const admin = role('*/admin');
    expect(admin.statements).toHaveLength(1);
    expect(permits(admin)).toHaveLength(1);
    expect(forbids(admin)).toHaveLength(0);
    expect(isWildcard(permits(admin)[0]!)).toBe(true);
    expect(whenBody(permits(admin)[0]!)).toBe('principal.role == "admin"');
  });

  test('admin is the ONLY role with a wildcard permit', () => {
    for (const [key, r] of roles) {
      const anyWildcard = permits(r).some(isWildcard);
      expect([key, anyWildcard]).toEqual([key, key === '*/admin']);
    }
  });

  test('no non-admin role names Masquerade anywhere; admin confers it only via the wildcard', () => {
    for (const [key, r] of roles) {
      if (key === '*/admin') continue;
      expect(r.cedar).not.toMatch(/OrgIQ::Action::"Masquerade"/);
    }
    // Admin never spells Masquerade out either — it flows solely from the wildcard action.
    expect(role('*/admin').cedar).not.toMatch(/OrgIQ::Action::"Masquerade"/);
  });
});

// ===========================================================================
// 5. Schema<->policy agreement at the attribute/type level.
//    AVP's CreatePolicy validates against schema.json; a policy that reads an
//    undeclared attribute or an action with the wrong principal/resource type
//    would be rejected at deploy. Assert the attributes and entity types the
//    policies actually reference are all declared with the expected shape.
// ===========================================================================
describe('schema/policy agreement', () => {
  const schema = JSON.parse(readFileSync(join(seedsDir(), 'schema.json'), 'utf8'));

  test('principal/resource attributes referenced by policies are declared with the right types', () => {
    const user = schema.OrgIQ.entityTypes.User.shape.attributes;
    const app = schema.OrgIQ.entityTypes.Application.shape.attributes;
    // role: required identity attribute the `when` clauses key on.
    expect(user.role).toEqual({ type: 'String', required: true });
    // tenant: optional (hence `principal has tenant` guards), String.
    expect(user.tenant).toEqual({ type: 'String', required: false });
    // amount: optional Long backing the approval threshold.
    expect(app.amount).toEqual({ type: 'Long', required: false });
  });

  test('every principal.<attr> / resource.<attr> a policy reads is declared on the matching entity type', () => {
    const userAttrs = new Set(Object.keys(schema.OrgIQ.entityTypes.User.shape.attributes));
    const appAttrs = new Set(Object.keys(schema.OrgIQ.entityTypes.Application.shape.attributes));
    const missing: string[] = [];
    for (const [key, r] of roles) {
      // `principal.role`, `principal.tenant`, `principal has tenant`, etc.
      for (const m of r.cedar.matchAll(/principal(?:\.|\s+has\s+)(\w+)/g)) {
        if (!userAttrs.has(m[1]!)) missing.push(`${key}: principal.${m[1]}`);
      }
      for (const m of r.cedar.matchAll(/resource(?:\.|\s+has\s+)(\w+)/g)) {
        if (!appAttrs.has(m[1]!)) missing.push(`${key}: resource.${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no policy references an action absent from schema.json.actions', () => {
    const declared = new Set(Object.keys(schema.OrgIQ.actions));
    const undeclared: string[] = [];
    for (const [key, r] of roles) {
      for (const m of r.cedar.matchAll(/OrgIQ::Action::"([^"]+)"/g)) {
        if (!declared.has(m[1]!)) undeclared.push(`${key}: ${m[1]}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  test('every declared action applies to principal User and resource Application (the types policies use)', () => {
    for (const [name, def] of Object.entries<any>(schema.OrgIQ.actions)) {
      expect(def.appliesTo.principalTypes).toContain('User');
      expect(def.appliesTo.resourceTypes).toContain('Application');
    }
  });
});
