/**
 * Deploy/teardown configuration — SOURCE-LEVEL assertions.
 *
 * The first suite is a genuine config check with a template consequence: what
 * cdk.json puts in `context` is what every plain `cdk deploy` sees.
 *
 * The rest are greps over shell scripts, and this file does not pretend they
 * are anything better. They are here because each pins a specific regression
 * that was expensive to diagnose, in code no type system or template assertion
 * can reach. A grep will not catch a rewrite that keeps the string and loses
 * the behaviour — but it does catch the specific undo, which is the failure
 * mode these have actually had.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const INFRA = path.join(__dirname, '..');
const cdkJson = JSON.parse(fs.readFileSync(path.join(INFRA, 'cdk.json'), 'utf8'));
const destroySh = fs.readFileSync(path.join(INFRA, 'scripts', 'destroy.sh'), 'utf8');
const deploySh = fs.readFileSync(path.join(INFRA, 'scripts', 'deploy.sh'), 'utf8');

/** Script text with comment lines stripped, so a comment cannot satisfy a grep. */
function code(script: string): string {
  return script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('cdk.json must not pre-enable a second-phase gate', () => {
  test('deployRuntimes is NOT set in cdk.json context', () => {
    // This is the regression, verbatim: cdk.json used to carry
    // "deployRuntimes": "true", so the first deploy after any teardown created
    // the ECR repos and the CfnRuntimes that pin images from them in one pass,
    // and every runtime failed with an invalid-image error against the empty
    // repo the same stack had just created. The documented order is: deploy
    // (repos + roles) → agents/base/build.sh → agents/build-all.sh → redeploy
    // with --context deployRuntimes=true.
    assert.equal(
      cdkJson.context?.deployRuntimes,
      undefined,
      'deployRuntimes in cdk.json makes the chicken-and-egg failure the default',
    );
  });

  test('the other artifact-dependent gates are not pre-enabled either', () => {
    for (const gate of ['deployDevbox', 'deployMiddlewareService']) {
      assert.equal(
        cdkJson.context?.[gate],
        undefined,
        `${gate} requires a pushed image; enabling it by default guarantees a failed first deploy`,
      );
    }
  });
});

describe('destroy.sh: the wedges it exists to avoid', () => {
  test('it does NOT CFN-pre-delete OrgIQ-Aurora', () => {
    // Aurora's exports are still imported by KnowledgeBase / Agents /
    // AgentCoreRuntime / AgentCoreGateway at that point, so CloudFormation
    // cancels the delete ("Cannot delete export ... as it is in use by ...")
    // and `wait stack-delete-complete` polls to its ~60-minute ceiling.
    // `cdk destroy --all` deletes in dependency order and does it correctly.
    assert.ok(
      !/delete-stack[^\n]*OrgIQ-Aurora/.test(code(destroySh)),
      'pre-deleting the Aurora stack cancels on an in-use export and hangs for an hour',
    );
  });

  test('it pre-drains AgentCore runtimes before cdk destroy', () => {
    // AWS::BedrockAgentCore::Runtime regularly exceeds the resource handler's
    // delete timeout and fails with NotStabilized, dropping the stack into
    // DELETE_FAILED and aborting `cdk destroy --all` partway through the fleet
    // — even though the runtime finishes deleting server-side anyway.
    const script = code(destroySh);
    const drainAt = script.indexOf('delete-agent-runtime');
    const destroyAt = script.indexOf('cdk destroy --all');
    assert.ok(drainAt > -1, 'no runtime pre-drain found');
    assert.ok(destroyAt > -1, 'no cdk destroy --all found');
    assert.ok(drainAt < destroyAt, 'the pre-drain must run BEFORE cdk destroy');
  });

  test('endpoints are deleted before their runtime', () => {
    // The API rejects a runtime delete with ConflictException while any
    // endpoint remains, and DEFAULT cannot be deleted on its own.
    const script = code(destroySh);
    const endpointAt = script.indexOf('delete-agent-runtime-endpoint');
    const runtimeAt = script.indexOf('delete-agent-runtime --agent-runtime-id');
    assert.ok(endpointAt > -1, 'no endpoint drain found');
    assert.ok(
      runtimeAt === -1 || endpointAt < runtimeAt,
      'a runtime delete with a live endpoint returns ConflictException',
    );
    assert.match(destroySh, /DEFAULT/, 'the DEFAULT endpoint must be skipped explicitly');
  });
});

describe('deploy.sh: a half-built fleet must not exit 0', () => {
  test('it reconciles real CloudFormation status after cdk deploy', () => {
    // `cdk deploy --all` does not reliably exit non-zero when a stack mid-fleet
    // fails; six stacks were silently skipped and the script still exited 0.
    const script = code(deploySh);
    assert.match(script, /describe-stacks/, 'no post-deploy status reconciliation found');
    assert.match(script, /FAILURES/, 'no failure accumulator found');
  });

  test('the KB Data-API race auto-recovery is bounded to one attempt', () => {
    // An unbounded retry turns a genuinely-broken deploy into an infinite loop
    // that keeps recreating a knowledge base.
    assert.match(code(deploySh), /KB_RETRIED/);
  });
});

describe('deploy.sh: a later deploy keeps the second-phase gates that are live', () => {
  // Forgetting one of these on a later deploy scaled the BFF to 0, removed the
  // CloudFront lock, deleted every CfnRuntime, or left the runtimes' callback
  // guards open — each while every stack read healthy.
  const script = code(deploySh);
  for (const key of [
    'deployRuntimes', 'deployMiddlewareService', 'albAllowCidr', 'deployPortal', 'portalPublicUrl', 'portalPublicUrls',
    'approvalsRequestSecret', 'harnessTraceSecret', 'assessmentRunCompleteSecret',
    'realtimeGateway', 'deploySocialImages', 'deploySocialMedia', 'sfuImageDigest', 'sfuAllowCidr',
    'socialPortalOrigin', 'deploySocial', 'deploySocialService', 'platformApiImageDigest',
    'deployDocumentWorkspace', 'documentWorkspace', 'sfuAmiId', 'turnAmiId',
  ]) {
    test(`${key} is inferred from the live account`, () => {
      assert.match(script, new RegExp(`infer ${key} |${key}:`), `${key} is not inferred`);
    });
  }

  test('a named stack brings its dependencies and its readers-by-name into the diff, deploy and reconciliation', () => {
    // ./deploy.sh OrgIQ-SocialMedia redeployed OrgIQ-MiddlewareService under
    // --no-rollback (UPDATE_FAILED) and still reported "all 1 expected stack(s)
    // healthy"; the SFU it replaced left OrgIQ-Social calling a dead host.
    assert.match(script, /--show-dependencies --json/);
    assert.match(script, /EXPECTED_STACKS=\("\$\{SELECTED_STACKS\[@\]\}"\)/);
    assert.match(script, /READS_BY_NAME=\("\$\{STACK_PREFIX\}SocialMedia:\$\{STACK_PREFIX\}Social"\)/);
    assert.match(script, /deploy "\$\{NAMED_STACKS\[@\]\}"/);
  });

  test('a value the caller passed wins over an inferred one', () => {
    assert.match(script, /infer\(\) \{[^}]*ctx_given "\$1" && return 0/);
  });

  test('inferred context reaches cdk ls and both cdk deploy forms', () => {
    assert.match(script, /ls "\$\{ENV_CONTEXT\[@\]\}" \$\{INFERRED\[@\]\+"\$\{INFERRED\[@\]\}"\}/);
    assert.match(script, /deploy --all "\$\{ENV_CONTEXT\[@\]\}" \$\{INFERRED\[@\]\+"\$\{INFERRED\[@\]\}"\}/);
    assert.match(script, /deploy "\$\{CDK_ARGS\[@\]\}" "\$\{ENV_CONTEXT\[@\]\}" \$\{INFERRED\[@\]\+"\$\{INFERRED\[@\]\}"\}/);
  });

  test('secret values are never echoed', () => {
    assert.match(script, /<from Secrets Manager>/);
  });
});

describe('teardown and rebuild know the opt-in stacks (deploy plan §8/§10)', () => {
  test('cdk destroy synthesizes the opt-in stacks, or it cannot see them to delete', () => {
    // Without the flags OrgIQ-Portal / OrgIQ-Social* are not in the app, so
    // `cdk destroy --all` skips them and then fails on the middleware, whose
    // exports they still import.
    const script = code(destroySh);
    for (const flag of ['deploySocial=true', 'deploySocialMedia=true', 'deploySocialImages=true', 'deployPortal=true']) {
      assert.match(script, new RegExp(`--context ${flag}`), `destroy does not pass ${flag}`);
    }
    assert.match(script, /destroy --all --force "\$\{ENV_CONTEXT\[@\]\}" "\$\{DESTROY_CONTEXT\[@\]\}"/);
  });

  test('the billing sweep reports ElastiCache, the SFU host and EIP, CloudFront, social tables and retained repos', () => {
    const script = code(destroySh);
    assert.match(script, /describe-replication-groups/);
    assert.match(script, /describe-addresses/);
    assert.match(script, /list-distributions/);
    assert.match(script, /-social-'\)\]/);
    for (const repo of ['middleware', 'social-gateway', 'platform-api', 'lvs-sfu']) {
      assert.match(script, new RegExp(`"\\$\\{PREFIX\\}-${repo}"`), `${repo} not in RETAINED_REPOS`);
    }
  });

  test('a social table is never deleted with deletion protection still on', () => {
    // delete-table is refused while protection is on; both scripts must turn
    // it off first, in that order.
    for (const script of [code(deploySh), code(destroySh)]) {
      const off = script.indexOf('--no-deletion-protection-enabled');
      const del = script.indexOf('delete-table', off);
      assert.ok(off > -1 && del > off, 'update-table --no-deletion-protection-enabled must precede delete-table');
    }
  });

  test('destroy.sh deletes retained data only when asked (PURGE_RETAINED)', () => {
    const script = code(destroySh);
    const gate = script.indexOf('PURGE_RETAINED');
    assert.ok(gate > -1 && gate < script.indexOf('--no-deletion-protection-enabled'));
  });

  test('deploy.sh deletes only EMPTY orphaned social tables, and knows the portal bucket and pending secrets', () => {
    const script = code(deploySh);
    assert.match(script, /scan --table-name "\$1" --limit 1 --select COUNT/);
    assert.match(script, /"\$\{PREFIX\}-portal-\$\{ACCOUNT\}-\$\{REGION\}"/);
    assert.match(script, /--force-delete-without-recovery/);
  });
});

describe('deploy.sh: a replacement deploys with rollback from the start', () => {
  const script = deploySh;
  test('the diff decides --no-rollback, so a refused attempt cannot strand RETAINed resources', () => {
    assert.match(script, /diff .*INFERRED/);
    assert.match(script, /requires replacement/);
    assert.match(script, /\$NO_ROLLBACK && CDK_FLAGS\+=\(--no-rollback\)/);
  });
});

describe('deploy.sh: an orphaned Cloud Map namespace is swept before deploy', () => {
  test('only unowned namespaces with no services are deleted', () => {
    assert.match(deploySh, /servicediscovery list-namespaces/);
    assert.match(deploySh, /describe-stack-resources --physical-resource-id "\$ns"/);
    assert.match(deploySh, /services" == "0"/);
  });
});

describe('deploy.sh: schema migrations run before cdk deploy (DE-20)', () => {
  const script = code(deploySh);

  test('the migrate step applies the schema before the first cdk deploy', () => {
    // The new BFF must start on the new schema; a step after cdk deploy would
    // let the middleware boot against tables it does not have yet.
    const migrate = script.indexOf('run_migrate apply --schema-only');
    const firstDeploy = script.indexOf('run_cdk_deploy || DEPLOY_RC=$?');
    assert.ok(migrate > 0, 'no `migrate apply --schema-only` step in deploy.sh');
    assert.ok(firstDeploy > 0, 'run_cdk_deploy call not found');
    assert.ok(migrate < firstDeploy, 'the migrate step must come before cdk deploy');
    assert.match(script, /-m schema\.migrate/);
  });

  test('an unapplied before-middleware data entry stops a middleware deploy', () => {
    const gate = script.indexOf('run_migrate gate --before middleware');
    assert.ok(gate > 0 && gate < script.indexOf('run_cdk_deploy || DEPLOY_RC=$?'));
    assert.match(script, /\$\{STACK_PREFIX\}MiddlewareService"[^\n]*\n\s*if ! run_migrate gate --before middleware/);
  });

  test('it is skippable, waits for Aurora, and baselines a fresh cluster after deploy', () => {
    assert.match(script, /DEPLOY_MIGRATE:-true/);
    assert.match(script, /stack_status \$\{STACK_PREFIX\}Aurora/);
    const after = script.lastIndexOf('run_migrate apply --schema-only');
    assert.ok(after > script.lastIndexOf('run_cdk_deploy || DEPLOY_RC=$?'), 'no fresh-cluster migrate after cdk deploy');
  });
});
