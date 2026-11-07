import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { contextFlag } from './context-flags';

/**
 * Machine-callback secrets for AgentCore runtimes, by id instead of by value
 * (work item 19).
 *
 * A runtime's EnvironmentVariables is a plain string map that lands in the
 * CloudFormation template and in GetAgentRuntime, so a secret VALUE there is
 * readable by anyone who can read either. The runtime now gets the secret's
 * NAME in `<VAR>_ID` and GetSecretValue on that one secret, and fetches the
 * value at start (agents/_shared/callbacks.py, agents/devbox/lab — see
 * infra/SECURITY-NOTES.md for the change those need).
 *
 * The name, not the ARN: OrgIQ-MiddlewareService mints these secrets and
 * deploys after the runtimes, so the full ARN (with its random suffix) is not
 * known here, and a partial ARN is ambiguous for names that end in a hyphen
 * plus six characters — which every one of these (`…-secret`) does.
 *
 * `-c plaintextCallbackSecrets=true` keeps accepting the old
 * `--context <name>Secret=<value>` for one release, until the images that
 * fetch by id are deployed.
 */
export const plaintextCallbackSecrets = (scope: Construct): boolean =>
  contextFlag(scope, 'plaintextCallbackSecrets', false);

/** The secret's name (`<prefix>-<slug>-secret`) and an IAM resource for it. */
export function namedSecret(scope: Construct, prefix: string, slug: string): { name: string; arn: string } {
  const stack = cdk.Stack.of(scope);
  const name = `${prefix}-${slug}-secret`;
  return { name, arn: `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${name}-??????` };
}

/** GetSecretValue on exactly these named secrets. */
export function readNamedSecrets(sid: string, arns: string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({ sid, actions: ['secretsmanager:GetSecretValue'], resources: arns });
}

/** Refuse a plaintext secret in context unless the one-release fallback is on. */
export function refusePlaintext(scope: Construct, given: Record<string, string | undefined>): void {
  const set = Object.entries(given).filter(([, v]) => v).map(([k]) => k);
  if (set.length && !plaintextCallbackSecrets(scope)) {
    throw new Error(`--context ${set.join(', ')} passes a secret VALUE, which lands in the template and the runtime `
      + 'configuration. The runtime now reads it from Secrets Manager by name; drop the value, or pass '
      + '--context plaintextCallbackSecrets=true for one release until the agent images fetch by id (infra/SECURITY-NOTES.md).');
  }
}
