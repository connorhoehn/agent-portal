import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';

export interface SpanProjectorStackProps extends cdk.StackProps {
  /** Resource-naming prefix; defaults to 'orgiq' so the deployed names do not move. */
  prefix?: string;
  /** ARN of the Aurora Serverless v2 cluster (accepts cross-stack ref or Fn.importValue) */
  auroraClusterArn: string;
  /** ARN of the Aurora credentials secret in Secrets Manager */
  auroraSecretArn: string;
  /** Aurora database name. Defaults to 'orgiq'. */
  auroraDatabase?: string;
  /**
   * Optional: additional CloudWatch log group that Phase 2's OTel collector
   * writes to (e.g. /orgiq/otel/spans). Forwarded to the Lambda as an env var.
   */
  otelLogGroup?: string;
}

/**
 * OrgIQ-SpanProjector — OI Phase 3
 *
 * Deploys a Lambda that polls CloudWatch Logs Insights every minute for
 * OI-attributed OTel spans, reconstructs trace trees, and projects each
 * trace into observability.invocation_traces + observability.tool_calls
 * via the Aurora RDS Data API.
 */
export class SpanProjectorStack extends cdk.Stack {
  public readonly projectorFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: SpanProjectorStackProps) {
    super(scope, id, props);
    const prefix = props.prefix ?? 'orgiq';

    // -----------------------------------------------------------------------
    // SSM cursor parameter — tracks last-processed timestamp
    // -----------------------------------------------------------------------
    const cursorParam = new ssm.StringParameter(this, 'CursorParam', {
      parameterName: `/${prefix}/span-projector/cursor`,
      description: 'High-water mark (epoch-ms) for the Span Projector Lambda poll window',
      stringValue: '0', // Lambda overwrites this with real epoch-ms values on each run
    });

    // -----------------------------------------------------------------------
    // Lambda
    // -----------------------------------------------------------------------
    const environment: Record<string, string> = {
      AURORA_CLUSTER_ARN: props.auroraClusterArn,
      AURORA_SECRET_ARN: props.auroraSecretArn,
      AURORA_DATABASE: props.auroraDatabase ?? 'orgiq',
      CURSOR_PARAM_NAME: cursorParam.parameterName,
    };

    if (props.otelLogGroup) {
      environment['OTEL_LOG_GROUP'] = props.otelLogGroup;
    }

    const fn = new lambda.Function(this, 'Projector', {
      functionName: `${prefix}-span-projector`,
      description: 'OI Phase 3: project OTel OI spans from CloudWatch into Aurora observability tables',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'span-projector')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment,
    });

    this.projectorFunction = fn;

    // -----------------------------------------------------------------------
    // IAM
    // -----------------------------------------------------------------------

    // CloudWatch Logs — discover log groups and filter events
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CwLogs',
      actions: [
        'logs:DescribeLogGroups',
        'logs:FilterLogEvents',
      ],
      resources: ['*'],
    }));

    // RDS Data API — execute SQL against Aurora
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RdsDataApi',
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
      ],
      resources: [props.auroraClusterArn],
    }));

    // Secrets Manager — authenticate RDS Data API calls
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AuroraSecret',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.auroraSecretArn],
    }));

    // AgentCore — list runtimes to discover log group names (best-effort)
    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCoreListRuntimes',
      actions: ['bedrock-agentcore:ListAgentRuntimes'],
      resources: ['*'],
    }));

    // SSM — read + write the cursor parameter
    cursorParam.grantRead(fn);
    cursorParam.grantWrite(fn);

    // -----------------------------------------------------------------------
    // EventBridge schedule — every 1 minute
    // (EventBridge minimum resolution is 1 minute; 30s would require a cron
    // workaround and two rules. 1-minute is sufficient for near-real-time.)
    // -----------------------------------------------------------------------
    const rule = new events.Rule(this, 'PollSchedule', {
      ruleName: `${prefix}-span-projector-poll`,
      description: 'Trigger the Span Projector Lambda every minute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    });
    rule.addTarget(new targets.LambdaFunction(fn, {
      retryAttempts: 1,
    }));

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ProjectorFunctionArn', {
      value: fn.functionArn,
      exportName: `${prefix}-span-projector-fn-arn`,
      description: 'ARN of the Span Projector Lambda',
    });

    new cdk.CfnOutput(this, 'CursorParamName', {
      value: cursorParam.parameterName,
      description: 'SSM parameter that tracks the Span Projector poll cursor',
    });
  }
}
