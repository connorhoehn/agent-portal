/**
 * App-level invariants — the ones no single stack can check.
 *
 * These synthesise the real bin/app.ts (see helpers/app-assembly.ts for why
 * that works with no credentials), so they cover the wiring as deployed rather
 * than a fixture's idea of it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exportedNames, importedExportNames, synthApp } from './helpers/app-assembly';

const app = synthApp();

const EXPECTED_STACKS = [
  'OrgIQ-AgentCoreCapabilities',
  'OrgIQ-AgentCoreGateway',
  'OrgIQ-AgentCoreMemory',
  'OrgIQ-AgentCorePolicy',
  'OrgIQ-AgentCoreRuntime',
  'OrgIQ-AgentCoreTelemetry',
  'OrgIQ-Agents',
  'OrgIQ-Aurora',
  'OrgIQ-Authentication',
  'OrgIQ-Authorization',
  'OrgIQ-Devbox',
  'OrgIQ-Foundation',
  'OrgIQ-Guardrails',
  'OrgIQ-KnowledgeBase',
  'OrgIQ-MiddlewareService',
  'OrgIQ-Observability',
  'OrgIQ-SpanProjector',
];

describe('the app synthesises offline', () => {
  test('every default stack is produced with no AWS credentials', () => {
    for (const name of EXPECTED_STACKS) {
      assert.ok(app.has(name), `missing ${name}; got ${app.stackNames.join(', ')}`);
    }
  });

  test('PromptCanary is opt-in and appears only with --context deployCanary=true', () => {
    assert.ok(!app.has('OrgIQ-PromptCanary'), 'the canary must not deploy by default');
    assert.ok(synthApp({ deployCanary: 'true' }).has('OrgIQ-PromptCanary'));
  });
});

describe('cross-stack imports resolve to a real export', () => {
  // The failure this prevents: "No export named orgiq-aurora-secret-arn found"
  // — a whole-stack deploy failure that only shows up in CloudFormation, after
  // everything before it in the fleet has already deployed. PromptCanary hit
  // exactly this because it imported Aurora through raw Fn.importValue.
  test('every Fn::ImportValue in the app is satisfied by some stack Output', () => {
    const allExports = new Set<string>();
    for (const template of Object.values(app.templates)) {
      for (const name of exportedNames(template)) allExports.add(name);
    }

    const missing: string[] = [];
    for (const [stackName, template] of Object.entries(app.templates)) {
      for (const imported of importedExportNames(template)) {
        if (!allExports.has(imported)) missing.push(`${stackName} imports ${imported}`);
      }
    }
    assert.deepEqual(missing, [], 'unsatisfied cross-stack imports');
  });

  test('export names are unique across the fleet', () => {
    // Two stacks exporting the same name is a deploy-time collision.
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [stackName, template] of Object.entries(app.templates)) {
      for (const name of exportedNames(template)) {
        const prior = seen.get(name);
        if (prior) clashes.push(`${name}: ${prior} and ${stackName}`);
        else seen.set(name, stackName);
      }
    }
    assert.deepEqual(clashes, []);
  });

  test('OrgIQ-KnowledgeBase exports are locked by several consumers — that is why a KB deleted out-of-band cannot be replaced', () => {
    // CloudFormation refuses to delete or change an export while anything
    // imports it. That is the whole reason a knowledge base destroyed
    // out-of-band (e.g. by destroy.sh's KB pre-drain) cannot be re-created
    // through CFN without a multi-stack teardown, and why the recovery path is
    // `--context kbId=<new-id>` plus a `knowledge_bases` registry repoint.
    // The count matters, so this test states it rather than the mechanism.
    const on = synthApp({ deployRuntimes: 'true' });
    const kbExports = exportedNames(on.templates['OrgIQ-KnowledgeBase']);
    const consumers = Object.entries(on.templates)
      .filter(([name]) => name !== 'OrgIQ-KnowledgeBase')
      .filter(([, t]) => [...importedExportNames(t)].some((i) => kbExports.has(i)))
      .map(([name]) => name)
      .sort();
    assert.ok(
      consumers.length >= 3,
      `expected the KB exports to be pinned by several stacks, got: ${consumers.join(', ') || '(none)'}`,
    );
  });
});

describe('deploy gates are OFF by default', () => {
  // Each of these is a second phase that requires an artifact to exist first.
  // A default-on gate turns the first deploy after any teardown into a
  // guaranteed failure — which is exactly what cdk.json's old
  // "deployRuntimes": "true" did.
  test('no agent runtime is created without --context deployRuntimes=true', () => {
    app.template('OrgIQ-AgentCoreRuntime').resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
  });

  test('no devbox runtime is created without --context deployDevbox=true', () => {
    app.template('OrgIQ-Devbox').resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
  });

  test('the middleware service starts at DesiredCount 0 without --context deployMiddlewareService=true', () => {
    app.template('OrgIQ-MiddlewareService').hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 0,
    });
  });

  test('no online evaluation config without BOTH enableEval and enableOnlineEvalConfig', () => {
    // The config resource requires ServiceNames + ExecutionStatus ENABLED and
    // an exec role that can create its results log group; created before the
    // agents run, aws/spans does not exist yet and it 400s.
    app
      .template('OrgIQ-AgentCoreTelemetry')
      .resourceCountIs('AWS::BedrockAgentCore::OnlineEvaluationConfig', 0);
    const evalOnly = synthApp({ enableEval: 'true' });
    evalOnly
      .template('OrgIQ-AgentCoreTelemetry')
      .resourceCountIs('AWS::BedrockAgentCore::OnlineEvaluationConfig', 0);
  });

  test('the gates do turn on when asked', () => {
    const on = synthApp({
      deployRuntimes: 'true',
      deployDevbox: 'true',
      deployMiddlewareService: 'true',
    });
    const runtimes = on.template('OrgIQ-AgentCoreRuntime').findResources(
      'AWS::BedrockAgentCore::Runtime',
    );
    assert.equal(Object.keys(runtimes).length, 8, 'expected the eight OrgIQ agent runtimes');
    on.template('OrgIQ-Devbox').resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
    on.template('OrgIQ-MiddlewareService').hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
    });
  });
});

describe('every agent runtime points at a prompt OrgIQ-Agents actually creates', () => {
  test('SYSTEM_PROMPT_NAME matches a CfnPrompt name, for every agent', () => {
    // A mismatch is silent: prompt_source.py cannot find the prompt, falls
    // back to the literal baked into the image, and Prompt Studio edits stop
    // reaching the fleet with nothing logged anywhere obvious.
    const on = synthApp({ deployRuntimes: 'true' });
    const promptNames = new Set(
      Object.values<any>(on.template('OrgIQ-Agents').findResources('AWS::Bedrock::Prompt')).map(
        (p) => p.Properties?.Name,
      ),
    );
    const runtimes = Object.values<any>(
      on.template('OrgIQ-AgentCoreRuntime').findResources('AWS::BedrockAgentCore::Runtime'),
    );
    assert.ok(runtimes.length > 0);
    for (const runtime of runtimes) {
      const wanted = runtime.Properties.EnvironmentVariables?.SYSTEM_PROMPT_NAME;
      assert.ok(
        promptNames.has(wanted),
        `${runtime.Properties.AgentRuntimeName} wants prompt "${wanted}", which OrgIQ-Agents does not create (it makes: ${[...promptNames].join(', ')})`,
      );
    }
  });

  test('every agent with an IAM role in OrgIQ-Agents also gets a runtime', () => {
    // AgentCoreRuntimeStack skips any agent missing from props.agentRoles, so
    // the two AGENT_NAMES lists drifting apart silently drops an agent from
    // the deployed fleet.
    const on = synthApp({ deployRuntimes: 'true' });
    const roleAgents = Object.values<any>(
      on.template('OrgIQ-Agents').findResources('AWS::IAM::Role'),
    )
      .map((r) => /^orgiq-(.+)-role$/.exec(r.Properties?.RoleName ?? '')?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
    const runtimeAgents = Object.values<any>(
      on.template('OrgIQ-AgentCoreRuntime').findResources('AWS::BedrockAgentCore::Runtime'),
    )
      .map((r) => String(r.Properties.AgentRuntimeName).replace(/^orgiq_/, '').replace(/_/g, '-'))
      .sort();
    assert.deepEqual(runtimeAgents, roleAgents);
  });
});
