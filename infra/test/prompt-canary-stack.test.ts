/**
 * DE-4: the canary's second, per-agent input. The promotion controller moves
 * only `/orgiq/prompts/<agent>/{live,candidate}`, records the lifecycle, and
 * is DISABLED by default (gate-only promotion until online eval lands).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PromptCanaryStack } from '../lib/prompt-canary-stack';
import { POINTER_AGENTS } from '../lib/prompt-pointers';
import { actionsOf, flatten, statementsForRole } from './helpers/cfn';

function canary(enabled?: boolean): Template {
  const app = new cdk.App();
  return Template.fromStack(new PromptCanaryStack(app, 'OrgIQ-PromptCanary', {
    env: {}, prefix: 'orgiq', ...(enabled !== undefined && { promptPromotion: { enabled } }),
  }));
}

const machinesOf = (t: Template) => Object.values<any>(t.findResources('AWS::StepFunctions::StateMachine'));
/** The ASL as text: a plain string, or the Fn::Join of strings and tokens (tokens become `<ref>`). */
function definitionText(value: any): string {
  if (typeof value === 'string') return value;
  const join = value?.['Fn::Join'];
  if (Array.isArray(join)) return join[1].map((part: any) => (typeof part === 'string' ? part : '<ref>')).join(join[0]);
  return JSON.stringify(value);
}
const promotionDefinition = (t: Template) => definitionText(machinesOf(t).find((m) => m.Properties.StateMachineName === 'orgiq-prompt-promotion')!.Properties.DefinitionString);
const schedulesOf = (t: Template) => Object.values<any>(t.findResources('AWS::Scheduler::Schedule'));

describe('the promotion controller exists beside the demo canary', () => {
  const t = canary();
  test('two Express machines: the A/B weight controller and the per-agent pointer controller', () => {
    assert.deepEqual(machinesOf(t).map((m) => m.Properties.StateMachineName).sort(), ['orgiq-canary-controller', 'orgiq-prompt-promotion']);
  });
  test('its schedule is DISABLED by default and ENABLED only when asked; it names every pointer agent', () => {
    const sched = schedulesOf(t).find((s) => s.Properties.Name === 'orgiq-prompt-promotion-schedule')!;
    assert.equal(sched.Properties.State, 'DISABLED');
    assert.deepEqual(JSON.parse(sched.Properties.Target.Input).agents, [...POINTER_AGENTS]);
    const on = schedulesOf(canary(true)).find((s) => s.Properties.Name === 'orgiq-prompt-promotion-schedule')!;
    assert.equal(on.Properties.State, 'ENABLED');
    // The demo canary's own schedule is unchanged.
    assert.equal(schedulesOf(t).find((s) => s.Properties.Name === 'orgiq-canary-controller-schedule')!.Properties.State, 'ENABLED');
  });
});

describe('what the controller does', () => {
  const def = promotionDefinition(canary());
  test('scores are grouped by the pointer arm, per agent', () => {
    assert.match(def, /prompt_arm as version_label/);
    assert.match(def, /filter agent = /);
    assert.match(def, /"mode":"pointer"/);
  });
  test('PROMOTE copies candidate → live (no weight) and deletes the candidate; ROLLBACK deletes the candidate only', () => {
    assert.match(def, /ssm:putParameter/);
    assert.match(def, /prompts\/\{\}\/live/);
    assert.match(def, /promptId.{1,4}:.{1,4}\{\}.{1,6}version.{1,4}:.{1,4}\{\}/, 'live is written as {promptId, version} with the weight dropped');
    assert.match(def, /ssm:deleteParameter/);
    assert.doesNotMatch(def, /canary\/weight_b/, 'the pointer controller never moves the demo weight');
  });
  test('the lifecycle rows are the schema statuses: promoted, superseded, rolled_back', () => {
    for (const status of ['promoted', 'superseded', 'rolled_back']) {
      assert.ok(def.includes(`"StringValue":"${status}"`), status);
    }
    assert.match(def, /observability\.prompt_version_meta/);
    assert.doesNotMatch(def, /"StringValue":"deployed"/, 'deployed is the candidate step (the CLI / route), not the controller');
  });
  test('a missing candidate is a no-op, never a failure', () => {
    assert.match(def, /NoCandidate/);
    assert.match(def, /NO_CANDIDATE/);
  });
});

describe('the controller role', () => {
  const t = canary();
  const statements = statementsForRole(t, 'orgiq-prompt-promotion-role');
  test('may read/write/delete SSM only under /orgiq/prompts/*, and read the thresholds', () => {
    const pointers = statements.find((s: any) => s.Sid === 'PromptPointers')!;
    assert.deepEqual(actionsOf(pointers).sort(), ['ssm:DeleteParameter', 'ssm:GetParameter', 'ssm:PutParameter']);
    assert.match(flatten(pointers.Resource), /parameter\/orgiq\/prompts\/\*/);
    for (const s of statements) {
      if (actionsOf(s).some((a) => /ssm:(Put|Delete)/.test(a))) assert.equal(s.Sid, 'PromptPointers', `write grant outside the pointers: ${s.Sid}`);
    }
    const thresholds = statements.find((s: any) => s.Sid === 'CanaryThresholdsRead')!;
    assert.deepEqual(actionsOf(thresholds), ['ssm:GetParameter']);
  });
  test('the demo canary role did not gain pointer access', () => {
    for (const s of statementsForRole(t, 'orgiq-canary-controller-role')) {
      assert.doesNotMatch(flatten(s.Resource), /prompts/);
    }
  });
});

describe('the ParseMetrics lambda understands the arm labels', () => {
  const index = join(__dirname, '..', 'lambda', 'canary-parse-metrics', 'index.py');
  const venv = join(__dirname, '..', '..', '.venv-synth', 'bin', 'python');
  const python = existsSync(venv) ? venv : 'python3';
  function decide(rows: Array<Record<string, string>>, weight = '10') {
    const results = rows.map((r) => Object.entries(r).map(([field, value]) => ({ field, value })));
    const event = { mode: 'pointer', results, weight, control: '{"manual_override_until":"0","cooldown_until":"0","halted":false}',
      config: '{"min_samples":30,"promotion_delta":0.05,"rollback_floor":0.55,"error_ceiling":0.05,"latency_p95_ceiling_ms":8000,"step_pp":10}' };
    const r = spawnSync(python, ['-I', '-c', `import json,sys; sys.path.insert(0, ${JSON.stringify(join(index, '..'))}); import index; print(json.dumps(index.lambda_handler(json.loads(sys.argv[1]), None)))`, JSON.stringify(event)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  }
  test('live→A, candidate→B: a better candidate PROMOTEs, a worse one ROLLs BACK, too few samples do nothing', () => {
    const live = { version_label: 'live', composite: '0.70', error_rate: '0.01', p95: '1200', n: '60' };
    assert.equal(decide([live, { version_label: 'candidate', composite: '0.80', error_rate: '0.01', p95: '1300', n: '60' }]).action, 'PROMOTE');
    assert.equal(decide([live, { version_label: 'candidate', composite: '0.50', error_rate: '0.01', p95: '1300', n: '60' }]).action, 'ROLLBACK');
    assert.equal(decide([live, { version_label: 'candidate', composite: '0.80', error_rate: '0.01', p95: '1300', n: '5' }]).action, 'SKIPPED_NO_SAMPLES');
  });
  test('the demo canary A/B labels still work', () => {
    const out = decide([{ version_label: 'A', composite: '0.70', error_rate: '0.01', p95: '1200', n: '60' },
      { version_label: 'B', composite: '0.80', error_rate: '0.01', p95: '1300', n: '60' }]);
    assert.equal(out.action, 'PROMOTE');
    assert.equal(out.weight_b_after, 20);
  });
});
