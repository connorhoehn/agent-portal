/**
 * OrgIQ-AgentCoreRuntime.
 *
 * This stack owns the two hazards that have cost the most time on this project:
 * the ECR chicken-and-egg (the stack creates the repos AND the runtimes that
 * pin images from them), and the prompt-read grant landing on the wrong
 * principal (a Prompt Studio edit silently does nothing, because every agent
 * quietly falls back to its baked literal).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { runtimeStack } from './helpers/stacks';
import { actionsOf, flatten, runtimeNamed, runtimeNames, statementsForRole } from './helpers/cfn';
import { resolveContainerUri } from '../lib/agentcore-runtime-stack';

// `require`, not `import * as`: a namespace import is an __importStar copy with
// getter-only properties, so stubbing it would neither work nor be seen by the
// module under test.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('node:child_process') as any;

const ALL_AGENTS = [
  'supervisor',
  'search',
  'scoring',
  'advisor',
  'ingestion',
  'graph-builder',
  'assessment-scorer',
  'assessment-drafter',
];

const phaseOne = Template.fromStack(runtimeStack().runtime);
const phaseTwoBuild = runtimeStack({ deployRuntimes: 'true' });
const phaseTwo = Template.fromStack(phaseTwoBuild.runtime);

function envOf(template: Template, agent: string): Record<string, string> {
  const safe = `orgiq_${agent.replace(/-/g, '_')}`;
  return runtimeNamed(template, safe).Properties.EnvironmentVariables ?? {};
}

describe('phase 1 / phase 2: the repos must exist before any runtime pins an image from them', () => {
  test('without --context deployRuntimes=true the stack creates NO runtimes', () => {
    // Deploying both at once fails every CfnRuntime with an invalid-image
    // error against the empty repo the same stack just created. cdk.json used
    // to set deployRuntimes=true, which made that the guaranteed outcome of
    // the first deploy after any teardown.
    phaseOne.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
    phaseOne.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', 0);
  });

  test('phase 1 still creates every ECR repo and execution role, so the images have somewhere to go', () => {
    const repoNames = Object.values<any>(phaseOne.findResources('AWS::ECR::Repository'))
      .map((r) => r.Properties?.RepositoryName)
      .sort();
    assert.deepEqual(
      repoNames,
      ['orgiq-agent-base', ...ALL_AGENTS.map((a) => `orgiq-${a}`)].sort(),
      'phase 1 must create the shared base repo plus one repo per agent',
    );
    for (const agent of ALL_AGENTS) {
      statementsForRole(phaseOne, `orgiq-${agent}-execution-role`);
    }
  });

  test('phase 2 creates a runtime + endpoint for every agent', () => {
    assert.deepEqual(
      runtimeNames(phaseTwo),
      ALL_AGENTS.map((a) => `orgiq_${a.replace(/-/g, '_')}`).sort(),
    );
    phaseTwo.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', ALL_AGENTS.length);
  });

  test('--context onlyAgents restricts phase 2 to images that actually exist', () => {
    const t = Template.fromStack(
      runtimeStack({ deployRuntimes: 'true', onlyAgents: 'supervisor,search' }).runtime,
    );
    assert.deepEqual(runtimeNames(t), ['orgiq_search', 'orgiq_supervisor']);
    // The repos are still all there — only the runtimes are subsetted.
    assert.equal(
      Object.keys(t.findResources('AWS::ECR::Repository')).length,
      ALL_AGENTS.length + 1,
    );
  });

  test('runtime names satisfy the service regex [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens', () => {
    for (const name of runtimeNames(phaseTwo)) {
      assert.match(name, /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/, `${name} would be rejected by the API`);
    }
    for (const ep of Object.values<any>(
      phaseTwo.findResources('AWS::BedrockAgentCore::RuntimeEndpoint'),
    )) {
      assert.match(ep.Properties.Name, /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    }
  });

  test('each endpoint DependsOn its runtime', () => {
    for (const [id, ep] of Object.entries(
      phaseTwo.findResources('AWS::BedrockAgentCore::RuntimeEndpoint'),
    )) {
      const deps = ep.DependsOn ?? [];
      assert.ok(
        (Array.isArray(deps) ? deps : [deps]).some((d: string) => d.includes('Runtime')),
        `${id}: endpoint must depend on its runtime`,
      );
    }
  });
});

describe('container images are digest-pinned at synth time', () => {
  // Digest pinning is why every image push rolls the runtime — and why
  // /mnt/workspace session storage is wiped on every build-all.sh + deploy.
  // If this ever silently degrades to a floating tag, CFN stops seeing a diff
  // and a pushed image never reaches the fleet.
  test('resolveContainerUri pins the digest when ECR answers', () => {
    const saved = childProcess.execFileSync;
    (childProcess as any).execFileSync = () => 'sha256:abc123\n';
    try {
      assert.equal(
        resolveContainerUri('123.dkr.ecr.us-east-1.amazonaws.com/orgiq-search', 'orgiq-search', 'us-east-1'),
        '123.dkr.ecr.us-east-1.amazonaws.com/orgiq-search@sha256:abc123',
      );
    } finally {
      (childProcess as any).execFileSync = saved;
    }
  });

  test('resolveContainerUri falls back to :latest on the first deploy, when no image exists yet', () => {
    const saved = childProcess.execFileSync;
    (childProcess as any).execFileSync = () => {
      throw new Error('ImageNotFoundException');
    };
    try {
      assert.equal(
        resolveContainerUri('123.dkr.ecr.us-east-1.amazonaws.com/orgiq-search', 'orgiq-search', 'us-east-1'),
        '123.dkr.ecr.us-east-1.amazonaws.com/orgiq-search:latest',
      );
    } finally {
      (childProcess as any).execFileSync = saved;
    }
  });

  test('a non-digest answer is not pasted into the template verbatim', () => {
    // `aws ecr describe-images` prints "None" (not an error) when the query
    // finds nothing — pinning that would synthesise a garbage image URI.
    const saved = childProcess.execFileSync;
    (childProcess as any).execFileSync = () => 'None\n';
    try {
      assert.equal(
        resolveContainerUri('repo', 'orgiq-search', 'us-east-1'),
        'repo:latest',
      );
    } finally {
      (childProcess as any).execFileSync = saved;
    }
  });
});

describe('the prompt-read grant must be on the RUNTIME EXECUTION role', () => {
  // Agents resolve their system prompt from Bedrock Prompt Management every
  // PROMPT_REFRESH_S. The container assumes orgiq-<agent>-execution-role. The
  // OrgIQ-Agents role orgiq-<agent>-role is a DIFFERENT principal — granting
  // bedrock:GetPrompt there has no run-time effect at all, and the failure is
  // silent: the agent falls back to its baked literal and Prompt Studio
  // becomes a no-op nobody notices.
  for (const agent of ALL_AGENTS) {
    test(`orgiq-${agent}-execution-role can GetPrompt + ListPrompts`, () => {
      const granted = new Set(
        statementsForRole(phaseOne, `orgiq-${agent}-execution-role`).flatMap(actionsOf),
      );
      assert.ok(granted.has('bedrock:GetPrompt'), 'missing bedrock:GetPrompt on the execution role');
      assert.ok(
        granted.has('bedrock:ListPrompts'),
        'missing bedrock:ListPrompts on the execution role (and it must be paginated caller-side)',
      );
    });
  }

  test('the execution role is assumed by bedrock-agentcore, not bedrock', () => {
    const roles = Object.values<any>(phaseOne.findResources('AWS::IAM::Role')).filter((r) =>
      String(r.Properties?.RoleName ?? '').endsWith('-execution-role'),
    );
    assert.ok(roles.length >= ALL_AGENTS.length);
    for (const role of roles) {
      const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
      assert.ok(
        trust.includes('bedrock-agentcore.amazonaws.com'),
        'the runtime container assumes this role via bedrock-agentcore',
      );
    }
  });
});

describe('the ADOT trace pipeline', () => {
  // OTEL_TRACES_EXPORTER=console was a debugging setting that starved the whole
  // pipeline: aws/spans stayed empty, which starved the span projector,
  // /recent-invocations and online evaluation with no error anywhere.
  for (const agent of ALL_AGENTS) {
    test(`orgiq-${agent} exports spans via otlp with observability enabled`, () => {
      const env = envOf(phaseTwo, agent);
      assert.equal(env.OTEL_TRACES_EXPORTER, 'otlp', 'console starves aws/spans silently');
      assert.equal(env.AGENT_OBSERVABILITY_ENABLED, 'true');
      assert.equal(env.OTEL_SERVICE_NAME, `orgiq-${agent}`);
    });
  }
});

describe('live system prompts reach the deployed fleet through promoted pointers (DE-4)', () => {
  for (const agent of ALL_AGENTS) {
    test(`orgiq-${agent} points at the prompt name OrgIQ-Agents actually creates, and at its own pointer`, () => {
      const env = envOf(phaseTwo, agent);
      // Must match CfnPrompt name `${prefix}-${agentName}-system-prompt` in
      // agents-stack.ts — see cross-stack.test.ts, which checks both ends.
      assert.equal(env.SYSTEM_PROMPT_NAME, `orgiq-${agent}-system-prompt`);
      assert.equal(env.SYSTEM_PROMPT_POINTER, `/orgiq/prompts/${agent}`);
      assert.equal(env.PROMPT_REFRESH_S, '60');
    });

    test(`orgiq-${agent} never deploys on DRAFT: a studio edit must be published and promoted first`, () => {
      const env = envOf(phaseTwo, agent);
      assert.equal(env.SYSTEM_PROMPT_VERSION, undefined, 'no fleet-wide version by default; the pointer decides');
      assert.equal(env.APP_ENV, 'production', 'prompt_source.py refuses DRAFT under APP_ENV=production');
    });

    test(`orgiq-${agent} may read only its own pointer path, and cannot move one`, () => {
      const statements = statementsForRole(phaseTwo, `orgiq-${agent}-execution-role`);
      const read = statements.find((s: any) => s.Sid === 'PromptPointerRead');
      assert.ok(read, 'PromptPointerRead missing on the execution role');
      assert.deepEqual(actionsOf(read!).sort(), ['ssm:GetParameter', 'ssm:GetParameters']);
      const resource = flatten(read!.Resource);
      assert.match(resource, new RegExp(`parameter/orgiq/prompts/${agent}/\\*`));
      for (const other of ALL_AGENTS.filter((a) => a !== agent)) {
        assert.doesNotMatch(resource, new RegExp(`prompts/${other}/`));
      }
      for (const s of statements) {
        assert.ok(!actionsOf(s).some((a) => /^ssm:(Put|Delete)Parameter/.test(a)), `${agent} must not write SSM: ${actionsOf(s)}`);
      }
    });
  }

  test('--context systemPromptVersion=<n> is a fleet-wide hard pin; DRAFT is refused at synth', () => {
    const pinned = Template.fromStack(runtimeStack({ deployRuntimes: 'true', systemPromptVersion: '7' }).runtime);
    for (const agent of ALL_AGENTS) assert.equal(envOf(pinned, agent).SYSTEM_PROMPT_VERSION, '7');
    assert.throws(() => runtimeStack({ deployRuntimes: 'true', systemPromptVersion: 'DRAFT' }), /DRAFT is not deployable/);
    assert.throws(() => runtimeStack({ deployRuntimes: 'true', systemPromptVersion: '0' }), /numbered/);
  });
});

describe('the read-only graph role is mandatory and an EXCLUSIVE credential swap', () => {
  test('search/advisor always receive readonly credentials and production mode', () => {
    for (const agent of ['search', 'advisor']) {
      assert.match(envOf(phaseTwo, agent).AURORA_READONLY_SECRET_ARN ?? '', /readonly/);
      assert.equal(envOf(phaseTwo, agent).APP_ENV, 'production');
    }
  });

  test('admin fallback cannot be enabled through the old deployment context', () => {
    assert.throws(() => runtimeStack({ deployRuntimes: 'true', readOnlyGraphRole: 'false' }), /cannot be disabled/);
  });

  test('on: search/advisor lose GetSecretValue on the admin secret entirely', () => {
    // A boundary the agent can step around by fetching the other secret is a
    // suggestion, not a boundary. This is why the swap is exclusive.
    const build = runtimeStack({ deployRuntimes: 'true', readOnlyGraphRole: 'true' });
    const t = Template.fromStack(build.runtime);
    for (const agent of ['search', 'advisor']) {
      const secretStatements = statementsForRole(t, `orgiq-${agent}-execution-role`).filter((s) =>
        actionsOf(s).includes('secretsmanager:GetSecretValue'),
      );
      const resources = JSON.stringify(secretStatements.map((s) => s.Resource));
      assert.ok(resources.includes('orgiq-aurora-readonly'), `${agent} must read the readonly secret`);
      assert.ok(
        !resources.includes('secret:orgiq-aurora-abc123'),
        `${agent} must LOSE the admin credential, not merely gain a second one`,
      );
      assert.match(envOf(t, agent).AURORA_READONLY_SECRET_ARN ?? '', /readonly/);
    }
  });

  test('on: the writers keep the admin credential', () => {
    const t = Template.fromStack(
      runtimeStack({ deployRuntimes: 'true', readOnlyGraphRole: 'true' }).runtime,
    );
    for (const agent of ['ingestion', 'graph-builder', 'scoring']) {
      const resources = JSON.stringify(
        statementsForRole(t, `orgiq-${agent}-execution-role`)
          .filter((s) => actionsOf(s).includes('secretsmanager:GetSecretValue'))
          .map((s) => s.Resource),
      );
      assert.ok(resources.includes('orgiq-aurora-abc123'), `${agent} writes and needs the admin login`);
      assert.equal(t && envOf(t, agent).AURORA_READONLY_SECRET_ARN, undefined);
    }
  });
});

describe('guardrail enforcement lives on the supervisor edge only', () => {
  test('supervisor gets all three role-keyed guardrail IDs', () => {
    const env = envOf(phaseTwo, 'supervisor');
    assert.equal(env.GUARDRAIL_ID_MEMBER, 'gr-member');
    assert.equal(env.GUARDRAIL_ID_ORG_LEADER, 'gr-orgleader');
    assert.equal(env.GUARDRAIL_ID_HR_ADMIN, 'gr-hradmin');
  });

  test('sub-agents get none of them — they trust the supervisor edge', () => {
    for (const agent of ALL_AGENTS.filter((a) => a !== 'supervisor')) {
      const env = envOf(phaseTwo, agent);
      assert.equal(env.GUARDRAIL_ID_MEMBER, undefined, `${agent} must not carry a guardrail id`);
      assert.equal(env.GUARDRAIL_ID_ORG_LEADER, undefined);
      assert.equal(env.GUARDRAIL_ID_HR_ADMIN, undefined);
    }
  });

  test('only the supervisor may invoke other runtimes (A2A)', () => {
    const supervisor = new Set(
      statementsForRole(phaseOne, 'orgiq-supervisor-execution-role').flatMap(actionsOf),
    );
    assert.ok(supervisor.has('bedrock-agentcore:InvokeAgentRuntime'));
    for (const agent of ALL_AGENTS.filter((a) => a !== 'supervisor')) {
      const granted = new Set(
        statementsForRole(phaseOne, `orgiq-${agent}-execution-role`).flatMap(actionsOf),
      );
      assert.ok(
        !granted.has('bedrock-agentcore:InvokeAgentRuntime'),
        `${agent} must not be able to invoke sibling runtimes`,
      );
    }
  });
});

describe('container start-up permissions', () => {
  test('every execution role can pull from BOTH its own repo and the shared base repo', () => {
    // Agents extend orgiq-agent-base. Without the base repo in the ECR grant
    // the runtime fails on layer resolution at container start.
    for (const agent of ALL_AGENTS) {
      const ecr = statementsForRole(phaseOne, `orgiq-${agent}-execution-role`).find(
        (s) => s.Sid === 'EcrAccess',
      );
      assert.ok(ecr, `${agent}: no EcrAccess statement`);
      const resources = JSON.stringify(ecr.Resource);
      assert.ok(resources.includes('AgentBaseRepo'), `${agent}: missing the shared base repo`);
    }
  });
});

describe('session lifecycle', () => {
  test('the supervisor holds a warm microVM between AG-UI turns; sub-agents release sooner', () => {
    assert.deepEqual(runtimeNamed(phaseTwo, 'orgiq_supervisor').Properties.LifecycleConfiguration, {
      IdleRuntimeSessionTimeout: 1800,
      MaxLifetime: 28800,
    });
    assert.deepEqual(runtimeNamed(phaseTwo, 'orgiq_search').Properties.LifecycleConfiguration, {
      IdleRuntimeSessionTimeout: 600,
      MaxLifetime: 28800,
    });
  });

  test('no OrgIQ agent runtime mounts session storage — only the devbox does', () => {
    // Session storage is wiped on every runtime version update (i.e. every
    // image push). These runtimes must never be given somewhere to lose data.
    for (const runtime of Object.values<any>(
      phaseTwo.findResources('AWS::BedrockAgentCore::Runtime'),
    )) {
      assert.equal(
        runtime.Properties.FilesystemConfigurations,
        undefined,
        'an OrgIQ agent runtime with session storage would silently lose it on every deploy',
      );
    }
  });
});

describe('machine-callback secrets', () => {
  test('unset secrets are OMITTED, never sent as the string "undefined"', () => {
    const env = envOf(phaseTwo, 'supervisor');
    assert.equal(env.APPROVALS_REQUEST_SECRET, undefined);
    assert.equal(env.HARNESS_TRACE_SECRET, undefined);
    assert.equal(env.ASSESSMENT_RUN_COMPLETE_SECRET, undefined);
    assert.ok(
      !JSON.stringify(env).includes('undefined'),
      'a literal "undefined" here would be a valid-looking wrong shared secret',
    );
  });

  test('when the operator supplies them they land on every runtime', () => {
    const t = Template.fromStack(
      runtimeStack(
        { deployRuntimes: 'true' },
        {
          approvalsRequestSecret: 'approvals-xyz',
          harnessTraceSecret: 'harness-xyz',
          assessmentRunCompleteSecret: 'runcomplete-xyz',
        },
      ).runtime,
    );
    for (const agent of ALL_AGENTS) {
      const env = envOf(t, agent);
      assert.equal(env.APPROVALS_REQUEST_SECRET, 'approvals-xyz');
      assert.equal(env.HARNESS_TRACE_SECRET, 'harness-xyz');
      assert.equal(env.ASSESSMENT_RUN_COMPLETE_SECRET, 'runcomplete-xyz');
    }
  });
});

describe('model policy', () => {
  test('the default model is AWS-native Nova — no Anthropic model in the OrgIQ fleet', () => {
    for (const agent of ALL_AGENTS) {
      const modelId = envOf(phaseTwo, agent).MODEL_ID;
      assert.equal(modelId, 'amazon.nova-pro-v1:0');
      assert.ok(!/anthropic/i.test(modelId), 'the devbox is the only Claude exception');
    }
  });
});

describe('onlyAgents cannot delete live runtimes (DE-1)', () => {
  const LIVE = 'SupervisorRuntime,SearchRuntime,AdvisorRuntime';

  test('refuses an onlyAgents that leaves out a live runtime, naming it', () => {
    assert.throws(
      () => runtimeStack({ deployRuntimes: 'true', onlyAgents: 'search', liveRuntimeIds: LIVE }),
      /would delete live runtime\(s\): supervisor, advisor/,
    );
  });

  test('allows it when every live agent is named, on a first partial deploy, or on purpose', () => {
    runtimeStack({ deployRuntimes: 'true', onlyAgents: 'supervisor,search,advisor', liveRuntimeIds: LIVE });
    runtimeStack({ deployRuntimes: 'true', onlyAgents: 'search' });
    runtimeStack({ deployRuntimes: 'true', onlyAgents: 'search', liveRuntimeIds: LIVE, allowRuntimeDelete: 'true' });
  });
});
