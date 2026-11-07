/**
 * OrgIQ-Devbox — the tenth runtime, and the only place Claude models are
 * allowed in this project.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { devboxStack, SECRET_ARN, READONLY_SECRET_ARN } from './helpers/stacks';
import { actionsOf, statementsForRole } from './helpers/cfn';
import { DEFAULT_DEVBOX_MODELS, DEVBOX_TASK_TIMEOUT_S } from '../lib/devbox-stack';

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

  test('org access reads Aurora as orgiq_graph_reader, never with the master secret (DE-40)', () => {
    const t = Template.fromStack(devboxStack({ devboxOrgAccess: 'true' }));
    const secretResources = statementsForRole(t, 'orgiq-devbox-execution-role')
      .filter((st: any) => actionsOf(st).includes('secretsmanager:GetSecretValue'))
      .flatMap((st: any) => [].concat(st.Resource));
    assert.deepEqual(secretResources, [READONLY_SECRET_ARN]);
    assert.ok(!JSON.stringify(t.toJSON()).includes(SECRET_ARN), 'the master secret must not appear in the devbox stack');
  });
});

describe('the model allowlist is backed by IAM (DE-40)', () => {
  const invokeResources = (t: Template): string[] => {
    const st = statementsForRole(t, 'orgiq-devbox-execution-role').find((x: any) => x.Sid === 'BedrockInvokeClaude');
    assert.ok(st);
    return [].concat(st.Resource).map((r: unknown) => JSON.stringify(r));
  };

  test('the Bedrock statement lists exactly the configured models, never a wildcard over anthropic', () => {
    const t = Template.fromStack(devboxStack({
      devboxModels: 'us.anthropic.claude-haiku-4-5-20251001-v1:0,us.anthropic.claude-sonnet-5',
    }));
    const resources = invokeResources(t).join(' ');
    assert.ok(!resources.includes('*anthropic*') && !resources.includes('anthropic.*'), resources);
    for (const m of ['claude-haiku-4-5-20251001-v1:0', 'claude-sonnet-5']) {
      assert.ok(resources.includes(`inference-profile/us.anthropic.${m}`), `missing profile ${m}`);
      assert.ok(resources.includes(`foundation-model/anthropic.${m}`), `missing foundation model ${m}`);
    }
    assert.ok(!resources.includes('opus'), 'a model no profile names must not be invocable');
    // Two ARNs per model (profile + foundation model), two models.
    assert.equal(invokeResources(t).length, 4);
  });

  test('the runtime env allowlist is the same union IAM grants', () => {
    const t = Template.fromStack(devboxStack({ deployDevbox: 'true', devboxModels: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }));
    const rt = Object.values<any>(t.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    assert.deepEqual(rt.Properties.EnvironmentVariables.DEVBOX_ALLOWED_MODELS.split(','), ['us.anthropic.claude-haiku-4-5-20251001-v1:0']);
  });

  test('a non-inference-profile model in the context refuses to synth', () => {
    assert.throws(() => devboxStack({ devboxModels: 'anthropic.claude-sonnet-5' }), /inference-profile/);
  });

  test('the default is exactly the pre-profile allowlist', () => {
    const rt = runtime();
    assert.deepEqual(rt.Properties.EnvironmentVariables.DEVBOX_ALLOWED_MODELS.split(','), [...DEFAULT_DEVBOX_MODELS]);
  });
});

describe('one lifetime model (DE-48)', () => {
  test('the container task default is set explicitly and matches the middleware default', () => {
    assert.equal(runtime().Properties.EnvironmentVariables.DEVBOX_TASK_TIMEOUT_S, String(DEVBOX_TASK_TIMEOUT_S));
    assert.equal(DEVBOX_TASK_TIMEOUT_S, 840);
  });

  test('the platform clocks stay outside the reaper\'s (idle 1 h, max 8 h)', () => {
    assert.deepEqual(runtime().Properties.LifecycleConfiguration, { IdleRuntimeSessionTimeout: 3600, MaxLifetime: 28800 });
  });
});

// ─── The lab loop ────────────────────────────────────────────────────────────
//
// `agents/devbox/lab` calls back into the middleware, and until this wiring
// existed nothing set LAB_API_BASE — so every deployed session printed
// "LAB_API_BASE is not set — the lab loop is not wired in this environment"
// and the loop did nothing at all. Observed on the deployed runtime 2026-09-09.

describe('lab loop wiring', () => {
  const envOf = (t: Template) =>
    Object.values<any>(t.findResources('AWS::BedrockAgentCore::Runtime'))[0]
      .Properties.EnvironmentVariables as Record<string, string>;

  test('neither var is present when the operator has not supplied them', () => {
    // Absent, not empty. The `lab` script branches on `-n "${VAR:-}"`, so an
    // empty string behaves identically for it — but in the runtime's env map an
    // empty value reads as a configured-but-broken loop rather than one nobody
    // turned on.
    const env = envOf(phaseTwo);
    assert.equal('LAB_API_BASE' in env, false);
    assert.equal('LAB_CALLBACK_SECRET' in env, false);
  });

  test('with an origin, the runtime gets the lab secret by NAME and may read only it', () => {
    const t = Template.fromStack(devboxStack({ deployDevbox: 'true' }, { labApiBase: 'https://orgiq.example.com' }));
    const env = envOf(t);
    assert.equal(env['LAB_API_BASE'], 'https://orgiq.example.com');
    assert.equal(env['LAB_CALLBACK_SECRET_ID'], 'orgiq-lab-callback-secret');
    assert.equal('LAB_CALLBACK_SECRET' in env, false, 'the value never enters the template');
    const st = statementsForRole(t, 'orgiq-devbox-execution-role').find((x: any) => x.Sid === 'LabCallbackSecret');
    assert.match(JSON.stringify(st!.Resource), /secret:orgiq-lab-callback-secret-\?{6}/);
  });

  test('a plaintext labCallbackSecret is refused unless plaintextCallbackSecrets=true (one release)', () => {
    const props = { labApiBase: 'https://orgiq.example.com', labCallbackSecret: 'lab-secret-value' };
    assert.throws(() => devboxStack({ deployDevbox: 'true' }, props), /passes a secret VALUE/);
    const env = envOf(Template.fromStack(devboxStack({ deployDevbox: 'true', plaintextCallbackSecrets: 'true' }, props)));
    assert.equal(env['LAB_CALLBACK_SECRET'], 'lab-secret-value');
  });

  test('without an origin there is no secret id and no grant', () => {
    assert.equal('LAB_CALLBACK_SECRET_ID' in envOf(phaseTwo), false);
    assert.ok(!statementsForRole(phaseTwo, 'orgiq-devbox-execution-role').some((x: any) => x.Sid === 'LabCallbackSecret'));
  });
});
