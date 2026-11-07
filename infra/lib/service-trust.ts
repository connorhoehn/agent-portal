import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * Service principals that take the confused-deputy conditions, and the
 * `aws:SourceArn` each is pinned to by default (this account and region).
 *
 * Deliberately absent:
 *   - lambda.amazonaws.com: Lambda assumes an execution role without
 *     setting aws:SourceArn / aws:SourceAccount, so the conditions would stop
 *     every function from starting.
 *   - ec2.amazonaws.com: same for instance-profile roles.
 * The trust-policy test (test/service-trust.test.ts) holds every other
 * service principal in the app to both conditions.
 */
const SOURCE_ARN: Record<string, (region: string, account: string) => string> = {
  'bedrock-agentcore.amazonaws.com': (r, a) => `arn:aws:bedrock-agentcore:${r}:${a}:*`,
  'bedrock.amazonaws.com': (r, a) => `arn:aws:bedrock:${r}:${a}:*`,
  'ecs-tasks.amazonaws.com': (r, a) => `arn:aws:ecs:${r}:${a}:*`,
  'states.amazonaws.com': (r, a) => `arn:aws:states:${r}:${a}:stateMachine:*`,
  'scheduler.amazonaws.com': (r, a) => `arn:aws:scheduler:${r}:${a}:schedule-group/*`,
};

export const SERVICES_WITHOUT_SOURCE_CONDITIONS = ['lambda.amazonaws.com', 'ec2.amazonaws.com'] as const;

/**
 * A service principal that only this account's resources of that service can
 * act through: `aws:SourceAccount` = this account and `aws:SourceArn` like
 * `sourceArn` (default: any resource of that service in this account/region).
 */
export function trustedService(scope: Construct, service: string, sourceArn?: string): iam.ServicePrincipal {
  const stack = cdk.Stack.of(scope);
  const def = SOURCE_ARN[service];
  if (!def && !sourceArn) {
    throw new Error(`trustedService: no default aws:SourceArn for ${service}; pass one`);
  }
  return new iam.ServicePrincipal(service, {
    conditions: {
      StringEquals: { 'aws:SourceAccount': stack.account },
      ArnLike: { 'aws:SourceArn': sourceArn ?? def!(stack.region, stack.account) },
    },
  });
}
