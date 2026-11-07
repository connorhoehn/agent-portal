import * as cdk from 'aws-cdk-lib';
import { NAG_SUPPRESSIONS } from '../nag-suppressions';

/**
 * cdk-nag AwsSolutions checks over the whole app (work item 19).
 *
 * `--context nag=true`  require cdk-nag; fail the synth if it is not installed.
 * `--context nag=false` skip it.
 * unset                 run it when cdk-nag is installed, warn when it is not.
 *
 * Findings become error annotations, which `cdk synth` / `cdk deploy` refuse;
 * test/nag.test.ts fails on any that infra/nag-suppressions.ts does not list.
 *
 * cdk-nag is loaded with require() rather than imported so this checkout still
 * synthesises before `npm install -D cdk-nag` has been run.
 */
export function applyNag(app: cdk.App, stacks: cdk.Stack[]): 'applied' | 'skipped' | 'missing' {
  const want = app.node.tryGetContext('nag');
  if (want === false || want === 'false') return 'skipped';
  let nag: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nag = require('cdk-nag');
  } catch {
    if (want === true || want === 'true') {
      throw new Error('--context nag=true but cdk-nag is not installed: run `npm install -D cdk-nag@^2` in infra/');
    }
    // On the first stack: the CLI does not print annotations on the App root.
    if (stacks[0]) cdk.Annotations.of(stacks[0]).addWarningV2('orgiq:nag-missing',
      'cdk-nag is not installed, so the AwsSolutions checks did not run (npm install -D cdk-nag@^2)');
    return 'missing';
  }
  cdk.Aspects.of(app).add(new nag.AwsSolutionsChecks({ verbose: true }));
  for (const stack of stacks) {
    const entries = NAG_SUPPRESSIONS.filter(e => !e.stacks || e.stacks.some(suffix => stack.stackName.endsWith(`-${suffix}`)));
    if (entries.length) {
      nag.NagSuppressions.addStackSuppressions(stack, entries.map(e => ({ id: e.id, reason: e.reason })), true);
    }
  }
  return 'applied';
}
