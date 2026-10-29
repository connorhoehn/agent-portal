import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as path from 'path';
import { POINTER_AGENTS } from './prompt-pointers';

export interface PromptPromotionProps {
  /**
   * DE-4: run the per-agent promotion controller on a schedule. Off by
   * default (the schedule is created DISABLED): until online eval scores
   * arrive per arm (DE-5) the controller would promote on noise, so the
   * default path is gate-only — `scripts/prompt-pointers.ts candidate` then
   * `promote`, a straight pointer flip after the offline gate.
   */
  readonly enabled: boolean;
  /** The agents whose pointers the controller may move. */
  readonly agents?: readonly string[];
}

export interface PromptCanaryStackProps extends cdk.StackProps {
  /** AWS environment (account + region). */
  env: cdk.Environment;
  /** Resource-naming prefix (e.g. "orgiq"). */
  prefix: string;
  promptPromotion?: PromptPromotionProps;
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

    this.addPromptPromotionController({
      prefix,
      promotion: props.promptPromotion ?? { enabled: false },
      parseMetricsFn,
      scoresLogGroup,
      configParam,
      controlParam,
      auroraClusterArn,
      auroraSecretArn,
    });
  }

  /**
   * DE-4: the second, per-agent input to the canary. For each agent with a
   * `/<prefix>/prompts/<agent>/candidate` pointer it reads the last five
   * minutes of score events for that agent grouped by `prompt_arm`
   * (`live` / `candidate`, the attribute prompt_source.py stamps on every
   * span), hands them to the same ParseMetrics decision engine with the
   * candidate's weight, and then:
   *   PROMOTE  → live ← candidate, candidate deleted; prompt_version_meta
   *              new → promoted, old live → superseded
   *   ROLLBACK → candidate deleted; → rolled_back
   *   anything else → nothing moves.
   * Thresholds and the halt/cooldown flags are the existing
   * `/<prefix>/canary/config` and `/control`. The controller's role may
   * write SSM only under `/<prefix>/prompts/*`: it cannot touch weight_b.
   */
  private addPromptPromotionController(input: {
    prefix: string;
    promotion: PromptPromotionProps;
    parseMetricsFn: lambda.IFunction;
    scoresLogGroup: logs.ILogGroup;
    configParam: ssm.IStringParameter;
    controlParam: ssm.IStringParameter;
    auroraClusterArn: string;
    auroraSecretArn: string;
  }): void {
    const { prefix, promotion } = input;
    const agents = [...(promotion.agents ?? POINTER_AGENTS)];
    for (const a of agents) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(a)) throw new Error(`promptPromotion.agents: "${a}" is not an agent name`);
    }
    const stack = cdk.Stack.of(this);
    const pointerArn = stack.formatArn({
      service: 'ssm', resource: 'parameter', resourceName: `${prefix}/prompts/*`, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    const role = new iam.Role(this, 'PromotionControllerRole', {
      roleName: `${prefix}-prompt-promotion-role`,
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'Execution role for the DE-4 per-agent prompt promotion controller.',
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'PromptPointers',
      actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [pointerArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CanaryThresholdsRead',
      actions: ['ssm:GetParameter'],
      resources: [input.configParam.parameterArn, input.controlParam.parameterArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'LogsInsightsQuery',
      actions: ['logs:StartQuery', 'logs:GetQueryResults', 'logs:StopQuery'],
      resources: ['*'],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeParseMetrics',
      actions: ['lambda:InvokeFunction'],
      resources: [input.parseMetricsFn.functionArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraDataApi', actions: ['rds-data:ExecuteStatement'], resources: [input.auroraClusterArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraSecret', actions: ['secretsmanager:GetSecretValue'], resources: [input.auroraSecretArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'SfnLogDelivery',
      actions: [
        'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
        'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }));

    const lifecycleUpsert = (status: string, promptIdPath: string, versionPath: string, resultPath: string, next: string) => ({
      Type: 'Task',
      Resource: 'arn:aws:states:::aws-sdk:rdsdata:executeStatement',
      Parameters: {
        ResourceArn: input.auroraClusterArn,
        SecretArn: input.auroraSecretArn,
        Database: 'orgiq',
        Sql: 'INSERT INTO observability.prompt_version_meta (prompt_id, version, lifecycle_status) VALUES (:prompt_id, :version, :status) '
          + 'ON CONFLICT (prompt_id, version) DO UPDATE SET lifecycle_status = EXCLUDED.lifecycle_status'
          + (status === 'superseded' ? ', superseded_at = now()' : ''),
        Parameters: [
          { Name: 'prompt_id', Value: { 'StringValue.$': promptIdPath } },
          { Name: 'version', Value: { 'StringValue.$': versionPath } },
          { Name: 'status', Value: { StringValue: status } },
        ],
      },
      ResultPath: resultPath,
      Next: next,
    });

    const perAgent = {
      StartAt: 'GetCandidate',
      States: {
        GetCandidate: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:getParameter',
          Parameters: { 'Name.$': `States.Format('/${prefix}/prompts/{}/candidate', $.agent)` },
          ResultSelector: { 'raw.$': '$.Parameter.Value', 'pointer.$': 'States.StringToJson($.Parameter.Value)' },
          ResultPath: '$.candidate',
          // States.ALL must stand alone and last (Step Functions rejects the
          // machine otherwise: the 2026-10-29 deploy rolled back on it).
          Catch: [
            { ErrorEquals: ['Ssm.ParameterNotFoundException'], ResultPath: '$.error', Next: 'NoCandidate' },
            { ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'NoCandidate' },
          ],
          Next: 'GetLive',
        },
        NoCandidate: { Type: 'Pass', Result: { action: 'NO_CANDIDATE' }, ResultPath: '$.decision', End: true },
        GetLive: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:getParameter',
          Parameters: { 'Name.$': `States.Format('/${prefix}/prompts/{}/live', $.agent)` },
          ResultSelector: { 'pointer.$': 'States.StringToJson($.Parameter.Value)', present: true },
          ResultPath: '$.live',
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.live', Next: 'GetConfig' }],
          Next: 'GetConfig',
        },
        GetConfig: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:getParameter',
          Parameters: { Name: input.configParam.parameterName },
          ResultPath: '$.config',
          Next: 'GetControl',
        },
        GetControl: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:getParameter',
          Parameters: { Name: input.controlParam.parameterName },
          ResultPath: '$.control',
          Next: 'StartInsights',
        },
        StartInsights: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:cloudwatchlogs:startQuery',
          Parameters: {
            LogGroupName: input.scoresLogGroup.logGroupName,
            // Scores for THIS agent, bucketed by the arm that served the run
            // (`orgiq.prompt_arm` on the span → `prompt_arm` on the score
            // event). The lambda maps live→A, candidate→B.
            'QueryString.$': "States.Format('fields @timestamp, prompt_arm as version_label | filter agent = \"{}\" and ispresent(prompt_arm) | stats avg(composite_score) as composite, sum(error)/count(*) as error_rate, pct(latency_ms, 95) as p95, count(*) as n by version_label', $.agent)",
            'StartTime.$': 'States.MathAdd($$.State.EnteredTime.UnixTime, -300)',
            'EndTime.$': '$$.State.EnteredTime.UnixTime',
          },
          ResultPath: '$.query',
          Next: 'WaitForResults',
        },
        WaitForResults: { Type: 'Wait', Seconds: 3, Next: 'GetResults' },
        GetResults: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:cloudwatchlogs:getQueryResults',
          Parameters: { 'QueryId.$': '$.query.QueryId' },
          ResultPath: '$.results',
          Next: 'IsComplete',
        },
        IsComplete: {
          Type: 'Choice',
          Choices: [{ Variable: '$.results.Status', StringEquals: 'Complete', Next: 'ParseMetrics' }],
          Default: 'WaitForResults',
        },
        ParseMetrics: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke',
          Parameters: {
            FunctionName: input.parseMetricsFn.functionArn,
            Payload: {
              mode: 'pointer',
              'agent.$': '$.agent',
              'results.$': '$.results.Results',
              'weight.$': "States.Format('{}', $.candidate.pointer.weight)",
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
            { Variable: '$.decision.Payload.action', StringEquals: 'PROMOTE', Next: 'PromoteLive' },
            { Variable: '$.decision.Payload.action', StringEquals: 'ROLLBACK', Next: 'RollbackDeleteCandidate' },
          ],
          Default: 'Hold',
        },
        Hold: { Type: 'Pass', End: true },
        // PROMOTE: live ← {promptId, version} of the candidate (weight dropped), then the candidate goes.
        PromoteLive: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:putParameter',
          Parameters: {
            'Name.$': `States.Format('/${prefix}/prompts/{}/live', $.agent)`,
            'Value.$': "States.Format('{\"promptId\":\"{}\",\"version\":\"{}\"}', $.candidate.pointer.promptId, $.candidate.pointer.version)",
            Type: 'String',
            Overwrite: true,
          },
          ResultPath: '$.liveWrite',
          Next: 'PromoteDeleteCandidate',
        },
        PromoteDeleteCandidate: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:deleteParameter',
          Parameters: { 'Name.$': `States.Format('/${prefix}/prompts/{}/candidate', $.agent)` },
          ResultPath: '$.candidateDelete',
          Next: 'MarkPromoted',
        },
        MarkPromoted: lifecycleUpsert('promoted', '$.candidate.pointer.promptId', '$.candidate.pointer.version', '$.audit1', 'HadLive'),
        HadLive: {
          Type: 'Choice',
          Choices: [{ Variable: '$.live.present', IsPresent: true, Next: 'MarkSuperseded' }],
          Default: 'Hold',
        },
        MarkSuperseded: { ...lifecycleUpsert('superseded', '$.live.pointer.promptId', '$.live.pointer.version', '$.audit2', 'Hold') },
        // ROLLBACK: only the candidate goes; live is untouched.
        RollbackDeleteCandidate: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ssm:deleteParameter',
          Parameters: { 'Name.$': `States.Format('/${prefix}/prompts/{}/candidate', $.agent)` },
          ResultPath: '$.candidateDelete',
          Next: 'MarkRolledBack',
        },
        MarkRolledBack: lifecycleUpsert('rolled_back', '$.candidate.pointer.promptId', '$.candidate.pointer.version', '$.audit1', 'Hold'),
      },
    };

    const definition = {
      Comment: 'OrgIQ prompt promotion controller (DE-4) — per agent: promote the candidate pointer to live, or roll it back.',
      StartAt: 'EachAgent',
      States: {
        EachAgent: {
          Type: 'Map',
          ItemsPath: '$.agents',
          MaxConcurrency: 1,
          Parameters: { 'agent.$': '$$.Map.Item.Value' },
          Iterator: perAgent,
          End: true,
        },
      },
    };

    const logGroup = new logs.LogGroup(this, 'PromotionControllerLogGroup', {
      logGroupName: `/aws/vendedlogs/states/${prefix}-prompt-promotion`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const machine = new sfn.StateMachine(this, 'PromotionStateMachine', {
      stateMachineName: `${prefix}-prompt-promotion`,
      stateMachineType: sfn.StateMachineType.EXPRESS,
      role,
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(definition)),
      logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: true },
    });

    const schedulerRole = new iam.Role(this, 'PromotionSchedulerRole', {
      roleName: `${prefix}-prompt-promotion-scheduler-role`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    schedulerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'StartPromotionController', actions: ['states:StartExecution'], resources: [machine.stateMachineArn],
    }));
    new scheduler.CfnSchedule(this, 'PromotionSchedule', {
      name: `${prefix}-prompt-promotion-schedule`,
      description: promotion.enabled
        ? 'Fires the DE-4 prompt promotion controller every five minutes.'
        : 'DISABLED by default (gate-only promotion); --context promptPromotionCanary=true enables it.',
      scheduleExpression: 'rate(5 minutes)',
      flexibleTimeWindow: { mode: 'OFF' },
      state: promotion.enabled ? 'ENABLED' : 'DISABLED',
      target: {
        arn: machine.stateMachineArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ agents }),
      },
    });

    new cdk.CfnOutput(this, 'PromptPromotionStateMachineArn', {
      value: machine.stateMachineArn,
      description: `DE-4 per-agent promotion controller (schedule ${promotion.enabled ? 'ENABLED' : 'DISABLED'}).`,
    });
  }
}
