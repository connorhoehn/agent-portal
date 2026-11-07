/**
 * OrgIQ-Agents — the Bedrock managed prompts. The per-agent IAM roles it used
 * to hold were never assumed by anything and were removed (work item 19); the
 * runtime principal is `orgiq-<agent>-execution-role` from
 * OrgIQ-AgentCoreRuntime (see agentcore-runtime-stack.test.ts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { agentsStack } from './helpers/stacks';

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

describe('one managed prompt per agent, and no IAM roles', () => {
  test('OrgIQ-Agents creates no IAM role at all', () => {
    // It used to create orgiq-<agent>-role for every agent, trusted by bedrock
    // and ecs-tasks with no source conditions and holding the Aurora master
    // secret. Nothing assumed them: the runtime container runs as
    // orgiq-<agent>-execution-role from OrgIQ-AgentCoreRuntime.
    template.resourceCountIs('AWS::IAM::Role', 0);
    template.resourceCountIs('AWS::IAM::Policy', 0);
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
