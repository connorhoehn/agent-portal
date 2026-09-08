/**
 * OrgIQ-Devbox — the tenth runtime, and the only place Claude models are
 * allowed in this project.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { devboxStack } from './helpers/stacks';
import { actionsOf, statementsForRole } from './helpers/cfn';

const phaseOne = Template.fromStack(devboxStack());
const phaseTwo = Template.fromStack(devboxStack({ deployDevbox: 'true' }));

const runtime = () =>
  Object.values<any>(phaseTwo.findResources('AWS::BedrockAgentCore::Runtime'))[0];

describe('two-phase deploy, same shape as the agent fleet', () => {
  test('phase 1 creates the repo and role but no runtime', () => {
    phaseOne.resourceCountIs('AWS::ECR::Repository', 1);
    phaseOne.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
    statementsForRole(phaseOne, 'orgiq-devbox-execution-role');
  });

  test('phase 2 creates exactly one runtime with a legal name', () => {
    phaseTwo.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    assert.match(runtime().Properties.AgentRuntimeName, /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
  });
});

describe('session storage', () => {
  test('the workspace is mounted at /mnt/workspace', () => {
    // ⚠️ Preview feature: this is wiped on EVERY runtime version update, and
    // container URIs are digest-pinned, so every image push + deploy resets
    // every session workspace. Treat it as a cache; never a durable store.
    assert.deepEqual(runtime().Properties.FilesystemConfigurations, [
      { SessionStorage: { MountPath: '/mnt/workspace' } },
    ]);
  });
});

describe('the Claude exception is AWS-hosted and narrow', () => {
  test('the default model is a Bedrock inference profile, not an Anthropic API model', () => {
    // Bare foundation-model IDs do not support on-demand invocation for these
    // models; the `us.` inference-profile form is required.
    const model = runtime().Properties.EnvironmentVariables.ANTHROPIC_MODEL;
    assert.match(model, /^us\.anthropic\.claude-/);
    assert.equal(runtime().Properties.EnvironmentVariables.CLAUDE_CODE_USE_BEDROCK, '1');
  });

  test('the default is Haiku — a devbox task is usually small and Sonnet was charging ~$0.12 for "are you there"', () => {
    assert.match(runtime().Properties.EnvironmentVariables.ANTHROPIC_MODEL, /haiku/);
  });

  test('per-task model overrides are constrained by an allow-list', () => {
    const allowed = runtime().Properties.EnvironmentVariables.DEVBOX_ALLOWED_MODELS.split(',');
    assert.ok(allowed.length > 0);
    for (const model of allowed) {
      assert.match(model, /^us\.anthropic\./, 'a stray client must not be able to bill any model');
    }
  });

  test('Bedrock invoke is scoped to anthropic resources, not *', () => {
    const invoke = statementsForRole(phaseOne, 'orgiq-devbox-execution-role').find(
      (s) => s.Sid === 'BedrockInvokeClaude',
    );
    assert.ok(invoke);
    const resources = JSON.stringify(invoke.Resource);
    assert.ok(!resources.includes('"*"'), 'devbox must not hold bedrock:InvokeModel on *');
    assert.ok(resources.includes('anthropic'));
  });

  test('no OrgIQ API key of any kind is baked into the runtime environment', () => {
    const env = JSON.stringify(runtime().Properties.EnvironmentVariables);
    assert.ok(!/ANTHROPIC_API_KEY/.test(env), 'the whole point is no Anthropic API key anywhere');
  });
});

describe('org data access is opt-in', () => {
  test('by default the devbox holds no Aurora or knowledge-base permissions', () => {
    const granted = new Set(
      statementsForRole(phaseOne, 'orgiq-devbox-execution-role').flatMap(actionsOf),
    );
    assert.ok(!granted.has('rds-data:ExecuteStatement'), 'devboxOrgAccess must default off');
    assert.ok(!granted.has('bedrock:Retrieve'));
    assert.ok(!granted.has('secretsmanager:GetSecretValue'));
  });

  test('--context devboxOrgAccess=true adds READ-only access, with no transactions or batch writes', () => {
    const t = Template.fromStack(devboxStack({ devboxOrgAccess: 'true' }));
    const statements = statementsForRole(t, 'orgiq-devbox-execution-role');
    const granted = new Set(statements.flatMap(actionsOf));
    assert.ok(granted.has('rds-data:ExecuteStatement'));
    assert.ok(granted.has('bedrock:Retrieve'));
    for (const write of [
      'rds-data:BatchExecuteStatement',
      'rds-data:BeginTransaction',
      'rds-data:CommitTransaction',
      'bedrock:RetrieveAndGenerate',
    ]) {
      assert.ok(!granted.has(write), `org access must stay read-only; found ${write}`);
    }
  });
});
