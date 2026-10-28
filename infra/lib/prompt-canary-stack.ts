import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as path from 'path';

export interface PromptCanaryStackProps extends cdk.StackProps {
  /** AWS environment (account + region). */
  env: cdk.Environment;
  /** Resource-naming prefix (e.g. "orgiq"). */
  prefix: string;
}

/**
 * OrgIQ-PromptCanary — Prompt A/B canary controller.
 *
 * Deploys two Managed Prompt variants (Subject A vs B) plus an LLM-as-judge
 * prompt, an EventBridge Scheduler that fires every minute into an Express
 * Step Functions state machine, and the SSM parameters / log groups the
 * controller reads & writes. The state machine pulls the last 5 minutes of
 * EMF score events from `/orgiq/canary/scores`, hands them to a stateless
 * ParseMetrics Lambda, then promotes / rolls back / holds the B-traffic
 * weight in SSM and audits each decision into Aurora.
 */
export class PromptCanaryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PromptCanaryStackProps) {
    super(scope, id, props);

    const prefix = props.prefix;
    const stack = cdk.Stack.of(this);

    // -----------------------------------------------------------------------
    // 1. Managed Prompts — Subject A, Subject B, Judge
    // -----------------------------------------------------------------------

    const subjectPromptA = new cdk.aws_bedrock.CfnPrompt(this, 'SubjectPromptA', {
      name: `${prefix}-canary-subject-a`,
      description: 'Terse expert-explainer (Version A)',
      variants: [
        {
          name: 'default',
          templateType: 'TEXT',
          modelId: 'amazon.nova-pro-v1:0',
          templateConfiguration: {
            text: {
              text: '{{person_name}} is a strong fit for {{topic}}. Their experience includes {{summary}}.',
              inputVariables: [
                { name: 'person_name' },
                { name: 'topic' },
                { name: 'summary' },
              ],
            },
          },
        },
      ],
      defaultVariant: 'default',
    });

    const subjectBTemplate = [
      '**{{person_name}} — why they fit "{{topic}}"**',
      '',
      '- **Role:** (infer from summary)',
      '- **Relevant projects:** (extract from summary)',
      '- **Key skills:** (extract from summary)',
      '- **Recent activity:** (most recent items from summary)',
      '',
      'Summary context: {{summary}}',
    ].join('\n');

    const subjectPromptB = new cdk.aws_bedrock.CfnPrompt(this, 'SubjectPromptB', {
      name: `${prefix}-canary-subject-b`,
      description: 'Structured expert-explainer (Version B)',
      variants: [
        {
          name: 'default',
          templateType: 'TEXT',
          modelId: 'amazon.nova-pro-v1:0',
          templateConfiguration: {
            text: {
              text: subjectBTemplate,
              inputVariables: [
                { name: 'person_name' },
                { name: 'topic' },
                { name: 'summary' },
              ],
            },
          },
        },
      ],
      defaultVariant: 'default',
    });

    const judgeTemplate = [
      'You are evaluating a response to an "expert finder" question.',
      '',
      'QUESTION: Why is {{person_name}} a fit for {{topic}}?',
      'RESPONSE: {{response}}',
      '',
      'Score the RESPONSE on four dimensions, each 0.0 to 1.0:',
      '- helpfulness: does it answer the question?',
      '- factuality: does it stay grounded in the implicit context?',
      '- tone: is it professional and clear?',
      '- conciseness: appropriate length, no filler?',
      '',
      'Return ONLY a JSON object: {"helpfulness": <float>, "factuality": <float>, "tone": <float>, "conciseness": <float>}',
    ].join('\n');

    const judgePrompt = new cdk.aws_bedrock.CfnPrompt(this, 'JudgePrompt', {
      name: `${prefix}-canary-judge`,
      description: 'LLM-as-judge rubric scorer',
      variants: [
        {
          name: 'default',
          templateType: 'TEXT',
          modelId: 'amazon.nova-pro-v1:0',
          templateConfiguration: {
            text: {
              text: judgeTemplate,
              inputVariables: [
                { name: 'person_name' },
                { name: 'topic' },
                { name: 'response' },
              ],
            },
          },
        },
      ],
      defaultVariant: 'default',
    });

    // -----------------------------------------------------------------------
    // 2. Prompt versions (immutable snapshots middleware pins against)
    // -----------------------------------------------------------------------

    const subjectPromptVersionA = new cdk.aws_bedrock.CfnPromptVersion(this, 'SubjectPromptVersionA', {
      promptArn: subjectPromptA.attrArn,
      description: 'v1',
    });

    const subjectPromptVersionB = new cdk.aws_bedrock.CfnPromptVersion(this, 'SubjectPromptVersionB', {
      promptArn: subjectPromptB.attrArn,
      description: 'v1',
    });

    const judgePromptVersion = new cdk.aws_bedrock.CfnPromptVersion(this, 'JudgePromptVersion', {
      promptArn: judgePrompt.attrArn,
      description: 'v1',
    });

    // -----------------------------------------------------------------------
    // 3. SSM Parameters — weight, control flags, controller config
    // -----------------------------------------------------------------------

    const weightBParam = new ssm.StringParameter(this, 'WeightBParam', {
      parameterName: `/${prefix}/canary/weight_b`,
      description: 'Current B-variant traffic weight (integer 0-100, percentage).',
      stringValue: '10',
      tier: ssm.ParameterTier.STANDARD,
    });

    const controlParam = new ssm.StringParameter(this, 'ControlParam', {
      parameterName: `/${prefix}/canary/control`,
      description: 'Manual override / cooldown / halt flags for the canary controller.',
      stringValue: '{"manual_override_until":"0","cooldown_until":"0","halted":false}',
      tier: ssm.ParameterTier.STANDARD,
    });

    const configParam = new ssm.StringParameter(this, 'ConfigParam', {
      parameterName: `/${prefix}/canary/config`,
      description: 'Controller thresholds: sample size, promotion delta, rollback floor, ceilings, step size.',
      stringValue: '{"min_samples":30,"promotion_delta":0.05,"rollback_floor":0.55,"error_ceiling":0.05,"latency_p95_ceiling_ms":8000,"step_pp":10,"cooldown_seconds":90}',
      tier: ssm.ParameterTier.STANDARD,
    });

    // -----------------------------------------------------------------------
    // 4. CloudWatch log groups
    // -----------------------------------------------------------------------

    const scoresLogGroup = new logs.LogGroup(this, 'ScoresLogGroup', {
      logGroupName: `/${prefix}/canary/scores`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sfnLogGroup = new logs.LogGroup(this, 'ControllerLogGroup', {
      logGroupName: `/aws/vendedlogs/states/${prefix}-canary-controller`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------------
    // 5. ParseMetrics Lambda — stateless decision engine
    // -----------------------------------------------------------------------

    const parseMetricsFn = new lambda.Function(this, 'ParseMetrics', {
      functionName: `${prefix}-canary-parse-metrics`,
      description: 'Canary controller: parses CW Logs Insights results into a PROMOTE/ROLLBACK/HOLD decision.',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'canary-parse-metrics')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
    });

    // -----------------------------------------------------------------------
    // 6. Aurora cluster + secret ARNs (cross-stack imports from Aurora stack)
    // -----------------------------------------------------------------------

    const auroraClusterArn = cdk.Fn.importValue(`${prefix}-aurora-cluster-arn`);
    const auroraSecretArn = cdk.Fn.importValue(`${prefix}-aurora-secret-arn`);

    // -----------------------------------------------------------------------
    // 7. IAM role for the Express state machine
    // -----------------------------------------------------------------------

    const canaryParamArns = [
      stack.formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: `${prefix}/canary/weight_b`,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }),
      stack.formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: `${prefix}/canary/control`,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }),
      stack.formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: `${prefix}/canary/config`,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }),
    ];

    const sfnRole = new iam.Role(this, 'ControllerRole', {
      roleName: `${prefix}-canary-controller-role`,
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'Execution role for the OrgIQ Prompt Canary Express state machine.',
    });

    sfnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'LogsInsightsQuery',
      effect: iam.Effect.ALLOW,
      actions: ['logs:StartQuery', 'logs:GetQueryResults', 'logs:StopQuery'],
      resources: ['*'],
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmCanaryParams',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: canaryParamArns,
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeParseMetrics',
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [parseMetricsFn.functionArn],
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraDataApi',
      effect: iam.Effect.ALLOW,
      actions: ['rds-data:ExecuteStatement'],
      resources: [auroraClusterArn],
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraSecret',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [auroraSecretArn],
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SfnLogDelivery',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        // Express logging requires these on the delivery side too.
        'logs:CreateLogDelivery',
        'logs:GetLogDelivery',
        'logs:UpdateLogDelivery',
        'logs:DeleteLogDelivery',
        'logs:ListLogDeliveries',
        'logs:PutResourcePolicy',
        'logs:DescribeResourcePolicies',
        'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }));

    // -----------------------------------------------------------------------
    // 8. Express state machine ASL
    // -----------------------------------------------------------------------

    const aslDefinition = {
      Comment: 'OrgIQ Prompt Canary controller — promote/rollback/hold the B-variant traffic weight.',
      StartAt: 'GetWeight',
      States: {
        GetWeight: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:getParameter',
          Parameters: { Name: weightBParam.parameterName },
          ResultPath: '$.weight',
          Next: 'GetControl',
        },
        GetControl: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:getParameter',
          Parameters: { Name: controlParam.parameterName },
          ResultPath: '$.control',
          Next: 'GetConfig',
        },
        GetConfig: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:getParameter',
          Parameters: { Name: configParam.parameterName },
          ResultPath: '$.config',
          Next: 'StartInsights',
        },
        StartInsights: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:cloudwatchlogs:startQuery',
          Parameters: {
            'LogGroupName': scoresLogGroup.logGroupName,
            'QueryString': 'fields @timestamp | filter ispresent(version_label) | stats avg(composite_score) as composite, sum(error)/count(*) as error_rate, pct(latency_ms, 95) as p95, count(*) as n by version_label',
            'StartTime.$': 'States.MathAdd($$.State.EnteredTime.UnixTime, -300)',
            'EndTime.$': '$$.State.EnteredTime.UnixTime',
          },
          ResultPath: '$.query',
          Next: 'WaitForResults',
        },
        WaitForResults: {
          Type: 'Wait',
          Seconds: 3,
          Next: 'GetResults',
        },
        GetResults: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:cloudwatchlogs:getQueryResults',
          Parameters: { 'QueryId.$': '$.query.QueryId' },
          ResultPath: '$.results',
          Next: 'IsComplete',
        },
        IsComplete: {
          Type: 'Choice',
          Choices: [
            {
              Variable: '$.results.Status',
              StringEquals: 'Complete',
              Next: 'ParseMetrics',
            },
          ],
          Default: 'WaitForResults',
        },
        ParseMetrics: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Parameters: {
            FunctionName: parseMetricsFn.functionArn,
            Payload: {
              'results.$': '$.results.Results',
              'weight.$': '$.weight.Parameter.Value',
              'control.$': '$.control.Parameter.Value',
              'config.$': '$.config.Parameter.Value',
            },
          },
          ResultPath: '$.decision',
          Next: 'DecideAction',
        },
        DecideAction: {
          Type: 'Choice',
          Choices: [
            {
              Variable: '$.decision.Payload.action',
              StringEquals: 'PROMOTE',
              Next: 'PromoteWeight',
            },
            {
              Variable: '$.decision.Payload.action',
              StringEquals: 'ROLLBACK',
              Next: 'RollbackWeight',
            },
          ],
          Default: 'HoldSteady',
        },
        PromoteWeight: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter',
          Parameters: {
            Name: weightBParam.parameterName,
            'Value.$': 'States.Format(\'{}\', $.decision.Payload.weight_b_after)',
            Type: 'String',
            Overwrite: true,
          },
          ResultPath: '$.weightUpdate',
          Next: 'SetCooldown',
        },
        RollbackWeight: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter',
          Parameters: {
            Name: weightBParam.parameterName,
            Value: '0',
            Type: 'String',
            Overwrite: true,
          },
          ResultPath: '$.weightUpdate',
          Next: 'SetCooldown',
        },
        HoldSteady: {
          Type: 'Pass',
          ResultPath: '$.weightUpdate',
          Next: 'WriteDecisionAudit',
        },
        SetCooldown: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter',
          Parameters: {
            Name: controlParam.parameterName,
            'Value.$': '$.decision.Payload.new_control',
            Type: 'String',
            Overwrite: true,
          },
          ResultPath: '$.controlUpdate',
          Next: 'WriteDecisionAudit',
        },
        WriteDecisionAudit: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:rdsdata:executeStatement',
          Parameters: {
            ResourceArn: auroraClusterArn,
            SecretArn: auroraSecretArn,
            Database: 'orgiq',
            Sql: [
              'INSERT INTO observability.canary_decisions (',
              '  prompt_version_a_arn, prompt_version_b_arn,',
              '  action,',
              '  weight_b_before, weight_b_after,',
              '  composite_a, composite_b,',
              '  error_rate_a, error_rate_b,',
              '  latency_p95_a_ms, latency_p95_b_ms,',
              '  sample_count_a, sample_count_b,',
              '  reason, execution_arn',
              ') VALUES (',
              '  :prompt_version_a_arn, :prompt_version_b_arn,',
              '  :action,',
              '  :weight_b_before, :weight_b_after,',
              '  :composite_a, :composite_b,',
              '  :error_rate_a, :error_rate_b,',
              '  :latency_p95_a_ms, :latency_p95_b_ms,',
              '  :sample_count_a, :sample_count_b,',
              '  :reason, :execution_arn',
              ')',
            ].join(' '),
            Parameters: [
              { Name: 'prompt_version_a_arn', Value: { StringValue: subjectPromptVersionA.attrArn } },
              { Name: 'prompt_version_b_arn', Value: { StringValue: subjectPromptVersionB.attrArn } },
              { Name: 'action', Value: { 'StringValue.$': '$.decision.Payload.action' } },
              { Name: 'weight_b_before', Value: { 'LongValue.$': '$.decision.Payload.weight_b_before' } },
              { Name: 'weight_b_after', Value: { 'LongValue.$': '$.decision.Payload.weight_b_after' } },
              { Name: 'composite_a', Value: { 'DoubleValue.$': '$.decision.Payload.composite_a' } },
              { Name: 'composite_b', Value: { 'DoubleValue.$': '$.decision.Payload.composite_b' } },
              { Name: 'error_rate_a', Value: { 'DoubleValue.$': '$.decision.Payload.error_rate_a' } },
              { Name: 'error_rate_b', Value: { 'DoubleValue.$': '$.decision.Payload.error_rate_b' } },
              { Name: 'latency_p95_a_ms', Value: { 'LongValue.$': '$.decision.Payload.latency_p95_a_ms' } },
              { Name: 'latency_p95_b_ms', Value: { 'LongValue.$': '$.decision.Payload.latency_p95_b_ms' } },
              { Name: 'sample_count_a', Value: { 'LongValue.$': '$.decision.Payload.sample_count_a' } },
              { Name: 'sample_count_b', Value: { 'LongValue.$': '$.decision.Payload.sample_count_b' } },
              { Name: 'reason', Value: { 'StringValue.$': '$.decision.Payload.reason' } },
              { Name: 'execution_arn', Value: { 'StringValue.$': '$$.Execution.Id' } },
            ],
          },
          ResultPath: '$.audit',
          Next: 'Done',
        },
        Done: {
          Type: 'Succeed',
        },
      },
    };

    const stateMachine = new sfn.StateMachine(this, 'ControllerStateMachine', {
      stateMachineName: `${prefix}-canary-controller`,
      stateMachineType: sfn.StateMachineType.EXPRESS,
      role: sfnRole,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(aslDefinition)),
      logs: {
        destination: sfnLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    // -----------------------------------------------------------------------
    // 9. EventBridge Scheduler — fire the controller every minute
    // -----------------------------------------------------------------------

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `${prefix}-canary-scheduler-role`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role assumed by EventBridge Scheduler to start canary controller executions.',
    });

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'StartCanaryController',
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [stateMachine.stateMachineArn],
    }));

    new scheduler.CfnSchedule(this, 'ControllerSchedule', {
      name: `${prefix}-canary-controller-schedule`,
      description: 'Fires the OrgIQ Prompt Canary controller state machine every minute.',
      scheduleExpression: 'rate(1 minute)',
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: stateMachine.stateMachineArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    // -----------------------------------------------------------------------
    // 10. Outputs — version ARNs middleware pins against, plus param/log names
    // -----------------------------------------------------------------------

    new cdk.CfnOutput(this, 'SubjectPromptAArn', {
      value: subjectPromptVersionA.attrArn,
      description: 'ARN of Subject Prompt A (version v1) — pin middleware against this.',
    });

    new cdk.CfnOutput(this, 'SubjectPromptBArn', {
      value: subjectPromptVersionB.attrArn,
      description: 'ARN of Subject Prompt B (version v1) — pin middleware against this.',
    });

    new cdk.CfnOutput(this, 'JudgePromptArn', {
      value: judgePromptVersion.attrArn,
      description: 'ARN of the LLM-as-judge prompt (version v1).',
    });

    new cdk.CfnOutput(this, 'WeightBParamName', {
      value: weightBParam.parameterName,
      description: 'SSM parameter name for the B-variant traffic weight.',
    });

    new cdk.CfnOutput(this, 'ControlParamName', {
      value: controlParam.parameterName,
      description: 'SSM parameter name for canary control flags (override/cooldown/halt).',
    });

    new cdk.CfnOutput(this, 'ConfigParamName', {
      value: configParam.parameterName,
      description: 'SSM parameter name for controller thresholds (sample size, deltas, ceilings).',
    });

    new cdk.CfnOutput(this, 'ScoresLogGroupName', {
      value: scoresLogGroup.logGroupName,
      description: 'CloudWatch log group that middleware EMFs canary score events into.',
    });

    new cdk.CfnOutput(this, 'ControllerStateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'ARN of the canary controller Express state machine.',
    });
  }
}
