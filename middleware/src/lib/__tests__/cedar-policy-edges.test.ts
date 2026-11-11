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
// tenant condition dropped so an orgiq permit fires inside assessment).
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

  // These roles carry other forbids now (EnterEnvironment), so select the
  // ApproveTransaction one by target rather than assuming it is the only one —
  // the assertion that matters is its SHAPE, not its position in the file.
  const approvalForbid = (key: string): string => {
    const fs = forbids(role(key)).filter((s) => /ApproveTransaction/.test(s));
    expect(fs).toHaveLength(1);
    return fs[0]!;
  };

  test.each(DENIERS)('%s has exactly one forbid targeting ApproveTransaction, by equality', (key) => {
    const f = approvalForbid(key);
    expect(f).toMatch(/action\s*==\s*OrgIQ::Action::"ApproveTransaction"/);
    // Not a list target — a single, unambiguous action equality.
    expect(f).not.toMatch(/action\s+in\s*\[/);
  });

  test.each(DENIERS)('%s forbid keys only on principal.role, so it survives masquerade and tenant switch', (key) => {
    const cond = whenBody(approvalForbid(key));
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
//    orgiq grant can never fire inside another tenant and vice-versa).
//    org-leader has TWO permits; both must be guarded — a per-statement check
//    the file-level regex in the matrix test does not make.
// ===========================================================================
describe('per-statement tenant conditioning (cross-pollination guard)', () => {
  test.each(NON_ADMIN_TENANTS)('%s: EVERY permit conditions on principal.tenant == "%s"', (key, tenant) => {
    const ps = permits(role(key));
    expect(ps.length).toBeGreaterThan(0);
    const other = tenant === 'orgiq' ? 'assessment' : 'orgiq';
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

// ===========================================================================
// 6. DE-42 / DE-43: the agent-code actions split out of ManageDevbox.
//    The sme's grants are conditioned on the initiative booleans the route
//    computes; the author forbid refuses self-approval in production. The
//    local matrix ignores both, so the routes repeat them — this pins the
//    production copy.
// ===========================================================================
describe('DE-42 initiative conditions and the DE-43 author forbid', () => {
  const schema = JSON.parse(readFileSync(join(seedsDir(), 'schema.json'), 'utf8'));
  const app = schema.OrgIQ.entityTypes.Application.shape.attributes;
  const ACTIONS = ['OpenDevboxShell', 'RunDevboxTask', 'DecideAgentChange', 'DeliverAgentChange'];

  test('schema.json declares onInitiative, ownsBox and isAuthor as optional Booleans on Application', () => {
    for (const attr of ['onInitiative', 'ownsBox', 'isAuthor']) {
      expect(app[attr]).toEqual({ type: 'Boolean', required: false });
    }
  });

  test.each(ACTIONS)('every sme permit naming %s carries the onInitiative clause and the orgiq tenant guard', (action) => {
    const stmts = permits(role('orgiq/sme')).filter((s) => s.includes(`OrgIQ::Action::"${action}"`));
    expect(stmts.length).toBe(1);
    const cond = whenBody(stmts[0]!);
    expect(cond).toContain('resource has onInitiative && resource.onInitiative');
    expect(cond).toMatch(/principal has tenant && principal\.tenant == "orgiq"/);
  });

  test('only the shell and task permit also accept ownsBox', () => {
    for (const s of permits(role('orgiq/sme')).filter((x) => ACTIONS.some((a) => x.includes(`"${a}"`)))) {
      const shellOrTask = /OpenDevboxShell|RunDevboxTask/.test(s);
      expect(/resource has ownsBox && resource\.ownsBox/.test(whenBody(s))).toBe(shellOrTask);
    }
  });

  test('the sme general grant (the first permit) does not name any of the new actions', () => {
    const general = permits(role('orgiq/sme'))[0]!;
    for (const a of [...ACTIONS, 'ManageSdlcPolicies']) expect(general).not.toContain(`"${a}"`);
  });

  test.each(['orgiq/sme', 'orgiq/hr-admin'])('%s forbids DecideAgentChange when the caller is the author, except admin', (key) => {
    const f = forbids(role(key)).filter((s) => /DecideAgentChange/.test(s));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/action\s*==\s*OrgIQ::Action::"DecideAgentChange"/);
    expect(whenBody(f[0]!)).toBe('resource has isAuthor && resource.isAuthor && principal.role != "admin"');
  });

  test('the new statements were appended: each role file still opens with its original general grant', () => {
    // policy-seeds.ts keys AVP policies by statement position; appending keeps
    // every existing statement's description (and so its policy id).
    expect(permits(role('orgiq/sme'))[0]).toMatch(/"ManageDevbox"/);
    expect(permits(role('orgiq/hr-admin'))[0]).toMatch(/"ManageDevbox"/);
    const smeStatements = role('orgiq/sme').statements;
    expect(smeStatements.slice(-3).map((s) => s.split(/\s/)[0])).toEqual(['permit', 'permit', 'forbid']);
  });
});

// ===========================================================================
// 7. docs/next-steps.md §9 item 8. The program-owner budget scope is a forbid
//    keyed on `ownsInitiative`, which the budget and grant routes send
//    (lib/budget-scope.ts); a bare capability probe sends none, so the forbid
//    must not fire on a missing attribute. ManageSdlcPolicies and
//    EditGuardrail are unconditioned grants on org-leader's general permit,
//    under its orgiq tenant guard.
// ===========================================================================
describe('§9 item 8: the program-owner budget forbid and the new org-leader grants', () => {
  const schema = JSON.parse(readFileSync(join(seedsDir(), 'schema.json'), 'utf8'));

  test('schema.json declares ownsInitiative as an optional Boolean, and ManageSdlcPolicies / ViewWorkItems as actions', () => {
    expect(schema.OrgIQ.entityTypes.Application.shape.attributes.ownsInitiative).toEqual({ type: 'Boolean', required: false });
    expect(Object.keys(schema.OrgIQ.actions)).toEqual(expect.arrayContaining(['ManageSdlcPolicies', 'ViewWorkItems']));
    expect(Object.keys(schema.OrgIQ.actions)).not.toContain('EditSdlcPolicy');
  });

  test('program-owner forbids ManageBudgets only when ownsInitiative is present and false', () => {
    const f = forbids(role('orgiq/program-owner')).filter((s) => /ManageBudgets/.test(s));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/action\s*==\s*OrgIQ::Action::"ManageBudgets"/);
    expect(whenBody(f[0]!)).toBe('principal.role == "program-owner" && resource has ownsInitiative && !resource.ownsInitiative');
  });

  test('the forbid was appended: program-owner still opens with its general grant, then the ApproveTransaction forbid', () => {
    const kinds = role('orgiq/program-owner').statements.map((s) => s.split(/\s/)[0]);
    expect(kinds).toEqual(['permit', 'forbid', 'forbid']);
    expect(role('orgiq/program-owner').statements[1]).toMatch(/ApproveTransaction/);
  });

  test('org-leader grants ManageSdlcPolicies and EditGuardrail on its general permit, tenant-guarded, unconditioned otherwise', () => {
    const general = permits(role('orgiq/org-leader'))[0]!;
    for (const a of ['ManageSdlcPolicies', 'EditGuardrail']) expect(general).toContain(`OrgIQ::Action::"${a}"`);
    expect(whenBody(general)).toBe('principal.role == "org-leader" && principal has tenant && principal.tenant == "orgiq"');
    expect(forbids(role('orgiq/org-leader')).some((s) => /ManageSdlcPolicies|EditGuardrail/.test(s))).toBe(false);
  });

  test('the lab drive (11 Nov 2026): org-leader grants OperateDevbox and RunDevboxTask on the same general permit, and still not ManageDevbox or the shell', () => {
    const general = permits(role('orgiq/org-leader'))[0]!;
    for (const a of ['OperateDevbox', 'RunDevboxTask']) expect(general).toContain(`OrgIQ::Action::"${a}"`);
    for (const a of ['ManageDevbox', 'OpenDevboxShell']) expect(general).not.toContain(`OrgIQ::Action::"${a}"`);
    expect(Object.keys(schema.OrgIQ.actions)).toContain('OperateDevbox');
  });

  test('the lab drive: sme and hr-admin carry OperateDevbox on their general permit, unconditioned, beside ManageDevbox', () => {
    for (const key of ['orgiq/sme', 'orgiq/hr-admin']) {
      const general = permits(role(key))[0]!;
      expect(general).toContain('OrgIQ::Action::"ManageDevbox"');
      expect(general).toContain('OrgIQ::Action::"OperateDevbox"');
      expect(whenBody(general)).not.toMatch(/onInitiative|ownsBox/);
    }
  });
});

// ===========================================================================
// DecideDecision scope (G54): the production copy of the route's decidesThis rule.
// ===========================================================================
describe('DecideDecision: the decidesThis forbid against the real orgiq policy set', () => {
  /** The roles the forbid names, read from the shipped member.cedar. */
  const forbid = forbids(role('orgiq/member')).find((s) => /DecideDecision/.test(s))!;
  const named = [...(forbid.match(/\[([^\]]*)\]\.contains\(principal\.role\)/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  /** Cedar's answer for a role asking DecideDecision: permitted by its seed, and not hit by the forbid. */
  const allowed = (roleId: string, decidesThis: boolean | undefined): boolean => {
    const permitted = permits(role(`orgiq/${roleId}`)).some((s) => /OrgIQ::Action::"DecideDecision"/.test(s));
    const forbidden = decidesThis === false && named.includes(roleId);
    return permitted && !forbidden;
  };

  test('the forbid only fires when decidesThis is present and false', () => {
    expect(whenBody(forbid)).toMatch(/^resource has decidesThis && !resource\.decidesThis &&/);
  });

  test('an org-leader deciding a decision they neither own nor are assigned is allowed (the route sends decidesThis: true for the override)', () => {
    expect(named).not.toContain('org-leader');
    expect(allowed('org-leader', true)).toBe(true);
    // Even a stray false would not refuse them: the role is not in the forbid's list.
    expect(allowed('org-leader', false)).toBe(true);
  });

  test('a member deciding a decision they neither own nor are assigned is forbidden; the decider or owner is allowed', () => {
    expect(named).toContain('member');
    expect(allowed('member', false)).toBe(false);
    expect(allowed('member', true)).toBe(true);
    expect(allowed('member', undefined)).toBe(true); // a bare capability probe sends no attribute
  });
});
