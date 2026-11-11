// lintRunbook: the ten rules, each with a failing fixture taken from the ten
// procedural facts the design quotes verbatim (fixtures/bad.ts) and a passing
// one (the good fixtures and every seed runbook), against the real tree's
// routes and scripts (repo-context.ts).
import { lintRunbook, LINT_RULES } from '../index.js';
import type { LintRuleId, RunbookDoc } from '../types.js';
import { repoLintContext } from '../repo-context.js';
import { BAD_EXAMPLES, DERIVED_COMMAND_REAL, DERIVED_SECRETS } from './fixtures/bad.js';
import { GOOD_DOCS, flakyRerunDiff, ssoNewOrigin, tenantCutoverV1, tenantCutoverV2 } from './fixtures/good.js';
import { seedDocs } from './fixtures/seeds.js';
import { BUNDLE_RULES } from './fixtures/bundles.js';

const ctx = repoLintContext();
const rulesOf = (doc: RunbookDoc) => [...new Set(lintRunbook(doc, ctx).map((f) => f.rule))].sort();

it('lint: every seed runbook is clean — zero findings against the real routes and scripts', () => {
  expect(ctx.routes?.length ?? 0).toBeGreaterThan(100);
  for (const [label, doc] of seedDocs()) expect([label, lintRunbook(doc, ctx)]).toEqual([label, []]);
});

describe('the ten bad examples (design §1.4, verbatim)', () => {
  for (const ex of BAD_EXAMPLES) {
    it(`lint: bad example ${ex.n} fails (${ex.source}, ${ex.fact}) with ${ex.expect.join(', ')}`, () => {
      const got = rulesOf(ex.doc);
      for (const rule of ex.expect) expect([ex.n, got]).toEqual([ex.n, expect.arrayContaining([rule])]);
    });
  }
});

// Which fixture proves each rule fires, and which proves it can pass.
// R0's ten rules; the R8 bundle and skill rules have their own table (model-bundle.test.ts).
const FAILING: Partial<Record<LintRuleId, RunbookDoc>> = {
  'R-imperative': BAD_EXAMPLES[0]!.doc,
  'R-joined': BAD_EXAMPLES[5]!.doc,
  'R-generated': BAD_EXAMPLES[9]!.doc,
  'R-commandless': BAD_EXAMPLES[2]!.doc,
  'R-verify': BAD_EXAMPLES[8]!.doc,
  'R-rollback': BAD_EXAMPLES[8]!.doc,
  'R-single-subject': BAD_EXAMPLES[3]!.doc,
  'R-command-real': DERIVED_COMMAND_REAL,
  'R-length': BAD_EXAMPLES[0]!.doc,
  'R-secrets': DERIVED_SECRETS,
};
const PASSING: Partial<Record<LintRuleId, RunbookDoc>> = {
  'R-imperative': tenantCutoverV1,
  'R-joined': tenantCutoverV2,
  'R-generated': ssoNewOrigin,
  'R-commandless': tenantCutoverV2,
  'R-verify': tenantCutoverV1,
  // Read-only steps need no roll back: the flaky-test runbook changes nothing.
  'R-rollback': flakyRerunDiff,
  'R-single-subject': tenantCutoverV2,
  'R-command-real': tenantCutoverV2,
  'R-length': ssoNewOrigin,
  'R-secrets': tenantCutoverV2,
};

// Lane C's rules (a run-authored draft) have their failing and passing cases in
// routes/__tests__/runbook-debrief.test.ts, where a kept folder is filed.
const LANE_C_RULES: readonly LintRuleId[] = ['R-frontmatter', 'R-allowed-tools', 'R-injection'];

describe('each rule has a failing and a passing fixture', () => {
  it('covers exactly the design table (with the R8 rules in model-bundle.test.ts)', () => {
    expect(LINT_RULES.map((r) => r.id).filter((id) => !BUNDLE_RULES.includes(id) && !LANE_C_RULES.includes(id)).sort()).toEqual(Object.keys(FAILING).sort());
  });
  for (const id of Object.keys(FAILING) as LintRuleId[]) {
    it(`lint rule ${id}: fails its bad fixture`, () => expect(rulesOf(FAILING[id]!)).toContain(id));
    it(`lint rule ${id}: passes its good fixture`, () => expect(rulesOf(PASSING[id]!)).not.toContain(id));
  }
});

describe('rule details', () => {
  it('R-command-real names the invented route and the missing script', () => {
    const msgs = lintRunbook(DERIVED_COMMAND_REAL, ctx).filter((f) => f.rule === 'R-command-real').map((f) => f.message);
    expect(msgs).toEqual([
      'calls /api/canary/online-eval/enable, which no mounted route serves',
      'runs scripts/enable-online-eval.sh, which is not in the repository',
    ]);
  });

  it('R-command-real accepts parameterised routes and shell variables in a path segment', () => {
    const doc: RunbookDoc = { ...tenantCutoverV1, steps: [{ ...tenantCutoverV1.steps[0]!, command: { lang: 'bash', text: 'curl -s "$BFF/api/__mock/identity/clone/$CLONE_ID"\n./scripts/validate-mock-floor.sh --quick' } }] };
    expect(lintRunbook(doc, ctx).filter((f) => f.rule === 'R-command-real')).toEqual([]);
  });

  it('without a context R-command-real checks nothing (the linter itself stays pure)', () => {
    expect(lintRunbook(DERIVED_COMMAND_REAL).some((f) => f.rule === 'R-command-real')).toBe(false);
  });

  it('a step that names an identifier passes once it carries the command', () => {
    const doc: RunbookDoc = {
      ...tenantCutoverV1,
      steps: [{ do: 'Deploy with both enableEval and enableOnlineEvalConfig context flags.', command: { lang: 'bash', text: 'cd infra && ./scripts/deploy.sh OrgIQ-AgentCoreGateway --context enableEval=true --context enableOnlineEvalConfig=true' }, expect: 'UPDATE_COMPLETE.' }],
    };
    expect(rulesOf(doc)).not.toContain('R-commandless');
  });

  it('R-single-subject is the only warning; every other rule blocks an accept', () => {
    const warnings = LINT_RULES.filter((r) => r.severity === 'warning').map((r) => r.id);
    expect(warnings).toEqual(['R-single-subject']);
  });

  it('is deterministic: same doc, same findings in the same order', () => {
    for (const doc of Object.values(GOOD_DOCS).concat(BAD_EXAMPLES.map((e) => e.doc))) {
      expect(lintRunbook(doc, ctx)).toEqual(lintRunbook(doc, ctx));
    }
  });
});
