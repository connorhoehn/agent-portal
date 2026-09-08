/**
 * OrgIQ-Agents — IAM roles and the Bedrock managed prompts.
 *
 * Read this together with agentcore-runtime-stack.test.ts. The roles here are
 * NOT the principal a deployed runtime assumes: the container assumes
 * `orgiq-<agent>-execution-role`, created by OrgIQ-AgentCoreRuntime. This
 * distinction has already cost a debugging session — a bedrock:GetPrompt grant
 * added here had no run-time effect whatsoever, and the symptom was a silent
 * fallback to the prompt baked into the image.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { agentsStack } from './helpers/stacks';
import { actionsOf, statementsForRole } from './helpers/cfn';

const template = Template.fromStack(agentsStack());

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

describe('one role and one managed prompt per agent', () => {
  test('every agent has a role', () => {
    const roleNames = Object.values<any>(template.findResources('AWS::IAM::Role'))
      .map((r) => r.Properties?.RoleName)
      .filter(Boolean)
      .sort();
    assert.deepEqual(roleNames, ALL_AGENTS.map((a) => `orgiq-${a}-role`).sort());
  });

  test('every agent has a managed prompt named exactly what its runtime asks for', () => {
    // agentcore-runtime-stack sets SYSTEM_PROMPT_NAME=orgiq-<agent>-system-prompt
    // and agents/_shared/prompt_source.py resolves it at run time. A rename
    // here is invisible until you notice Prompt Studio edits stop landing.
    const promptNames = Object.values<any>(template.findResources('AWS::Bedrock::Prompt'))
      .map((p) => p.Properties?.Name)
      .sort();
    assert.deepEqual(promptNames, ALL_AGENTS.map((a) => `orgiq-${a}-system-prompt`).sort());
  });

  test('each prompt has a default variant, or GetPrompt returns nothing usable', () => {
    for (const prompt of Object.values<any>(template.findResources('AWS::Bedrock::Prompt'))) {
      assert.equal(prompt.Properties.DefaultVariant, 'default');
      assert.ok((prompt.Properties.Variants ?? []).some((v: any) => v.Name === 'default'));
    }
  });
});

describe('least privilege that is easy to lose', () => {
  test('iam:PassRole is scoped to execution roles AND conditioned on bedrock-agentcore', () => {
    for (const agent of ALL_AGENTS) {
      const passRole = statementsForRole(template, `orgiq-${agent}-role`).find((s) =>
        actionsOf(s).includes('iam:PassRole'),
      );
      assert.ok(passRole, `${agent}: no PassRole statement`);
      assert.match(JSON.stringify(passRole.Resource), /-\*-execution-role/);
      assert.equal(
        passRole.Condition?.StringEquals?.['iam:PassedToService'],
        'bedrock-agentcore.amazonaws.com',
        `${agent}: unconditional PassRole hands any matching role to any service`,
      );
    }
  });

  test('the assessment agents get no Aurora, no S3 and no knowledge base', () => {
    // They are read-only text agents in a different tenant. Any data-plane
    // grant here is a tenancy leak, not a convenience.
    for (const agent of ['assessment-scorer', 'assessment-drafter']) {
      const granted = new Set(
        statementsForRole(template, `orgiq-${agent}-role`).flatMap(actionsOf),
      );
      for (const forbidden of [
        'rds-data:ExecuteStatement',
        's3:GetObject',
        'bedrock:Retrieve',
        'secretsmanager:GetSecretValue',
      ]) {
        assert.ok(!granted.has(forbidden), `${agent} must not hold ${forbidden}`);
      }
    }
  });

  test('only graph-builder gets Aurora write verbs', () => {
    // Everything else that touches Aurora here is read-only
    // (rds-data:ExecuteStatement alone). scoring writes score columns through
    // ExecuteStatement, not through transactions.
    for (const agent of ALL_AGENTS) {
      const granted = new Set(
        statementsForRole(template, `orgiq-${agent}-role`).flatMap(actionsOf),
      );
      const hasWrites = granted.has('rds-data:BeginTransaction');
      assert.equal(
        hasWrites,
        agent === 'graph-builder',
        `${agent}: transactional Aurora access should belong to graph-builder alone`,
      );
    }
  });

  test('ingestion may write artifacts but only reads documents', () => {
    const granted = new Set(
      statementsForRole(template, 'orgiq-ingestion-role').flatMap(actionsOf),
    );
    assert.ok(granted.has('s3:GetObject'));
    assert.ok(granted.has('s3:PutObject'));
    assert.ok(!granted.has('s3:DeleteObject'), 'ingestion must not be able to delete source docs');
  });
});

describe('exports', () => {
  test('every agent role ARN is exported under a stable name', () => {
    for (const agent of ALL_AGENTS) {
      template.hasOutput('*', { Export: { Name: `orgiq-${agent}-role-arn` } });
    }
  });
});
