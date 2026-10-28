/**
 * DE-3: the central model registry.
 *
 * One reviewed file (`infra/config/model-registry.json`) becomes one SSM
 * parameter (`/orgiq/models/registry`) every runtime reads at run time; each
 * runtime's `MODEL_ID` is only the cold fallback, taken from its role's
 * `primary`. A non-AWS-native id must fail the synth, not reach a runtime.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { runtimeStack } from './helpers/stacks';
import { runtimeNamed, statementsForRole } from './helpers/cfn';
import {
  DEFAULT_MODEL_REGISTRY_FILE,
  isAllowedModelId,
  loadModelRegistry,
  validateModelRegistry,
} from '../lib/model-registry';

const registry = loadModelRegistry();
const build = runtimeStack({ deployRuntimes: 'true' });
const template = Template.fromStack(build.runtime);

function envOf(agent: string): Record<string, string> {
  return runtimeNamed(template, `orgiq_${agent.replace(/-/g, '_')}`).Properties.EnvironmentVariables ?? {};
}

function writeRegistry(doc: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-registry-'));
  const file = path.join(dir, 'model-registry.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe('the checked-in registry', () => {
  test('is valid and names every runtime plus the eval judge', () => {
    for (const role of ['supervisor', 'search', 'scoring', 'advisor', 'ingestion', 'graph-builder',
      'assessment-scorer', 'assessment-drafter', 'eval-judge']) {
      assert.ok(registry.roles[role], `registry is missing role ${role}`);
    }
  });

  test('the supervisor is registered on Nova Pro (what the cloud has served), Lite as a fallback', () => {
    assert.equal(registry.roles.supervisor.primary, 'amazon.nova-pro-v1:0');
    assert.ok(registry.roles.supervisor.fallbacks?.includes('amazon.nova-lite-v1:0'));
  });
});

describe('synth emits the registry parameter', () => {
  test('/orgiq/models/registry holds the file, standard tier', () => {
    const params = Object.values<any>(template.findResources('AWS::SSM::Parameter'))
      .filter((r) => r.Properties.Name === '/orgiq/models/registry');
    assert.equal(params.length, 1);
    assert.equal(params[0].Properties.Tier, 'Standard');
    assert.deepEqual(JSON.parse(params[0].Properties.Value), registry);
  });

  test('every runtime gets MODEL_REGISTRY_PARAM and its role primary as the cold MODEL_ID', () => {
    for (const agent of ['supervisor', 'search', 'ingestion', 'assessment-drafter']) {
      const env = envOf(agent);
      assert.equal(env.MODEL_REGISTRY_PARAM, '/orgiq/models/registry', agent);
      assert.equal(env.MODEL_ID, registry.roles[agent].primary, agent);
      assert.equal(env.MODEL_REGISTRY_VERSION, undefined, 'no version pin unless asked');
    }
  });

  test('a version pin from context reaches every runtime', () => {
    const pinned = Template.fromStack(runtimeStack({ deployRuntimes: 'true', modelRegistryVersion: '4' }).runtime);
    const env = runtimeNamed(pinned, 'orgiq_search').Properties.EnvironmentVariables;
    assert.equal(env.MODEL_REGISTRY_VERSION, '4');
  });

  test('each execution role may read the parameter', () => {
    const statements = statementsForRole(template, 'orgiq-search-execution-role');
    const read = statements.find((s: any) => s.Sid === 'ModelRegistryRead');
    assert.ok(read, 'ModelRegistryRead statement missing');
    assert.deepEqual([read.Action].flat(), ['ssm:GetParameter']);
  });
});

describe('the AWS-native rule is mechanical', () => {
  const good = JSON.parse(fs.readFileSync(DEFAULT_MODEL_REGISTRY_FILE, 'utf8'));

  test('synth fails on a registry holding a non-AWS-native id', () => {
    const bad = structuredClone(good);
    bad.roles.search.primary = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
    const file = writeRegistry(bad);
    assert.throws(
      () => runtimeStack({ deployRuntimes: 'true', modelRegistryFile: file }),
      /role search: model id "anthropic\.claude-3-5-sonnet-20240620-v1:0" is not AWS-native/,
    );
  });

  test('a non-AWS fallback or a widened allow list is refused', () => {
    const fb = structuredClone(good);
    fb.roles.supervisor.fallbacks = ['us.anthropic.claude-3-haiku-20240307-v1:0'];
    assert.throws(() => validateModelRegistry(fb), /not AWS-native/);
    const widened = structuredClone(good);
    widened.allow = [...good.allow, 'anthropic.'];
    assert.throws(() => validateModelRegistry(widened), /widens the AWS-native rule/);
  });

  test('cross-region Nova profiles are allowed, other vendors are not', () => {
    assert.ok(isAllowedModelId('us.amazon.nova-pro-v1:0'));
    assert.ok(isAllowedModelId('amazon.nova-lite-v1:0'));
    assert.ok(!isAllowedModelId('us.anthropic.claude-sonnet-4'));
    assert.ok(!isAllowedModelId('meta.llama3-70b-instruct-v1:0'));
  });
});
