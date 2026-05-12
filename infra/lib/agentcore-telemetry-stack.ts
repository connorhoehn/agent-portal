import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as xray from 'aws-cdk-lib/aws-xray';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

const AGENT_NAMES = ['supervisor', 'search', 'scoring', 'advisor', 'ingestion', 'graph-builder'] as const;

export interface AgentCoreTelemetryStackProps extends cdk.StackProps {
  readonly prefix?: string;
  readonly modelId?: string;
  /** Only create online evaluation configs when runtimes are deployed */
  readonly enableOnlineEvaluation?: boolean;
}

/**
 * AgentCore Telemetry: custom evaluators, online evaluation configs, X-Ray,
 * and a CloudWatch dashboard for AgentCore runtime metrics.
 *
 * Enable online evaluation after deploying runtimes:
 *   cdk deploy OrgIQ-AgentCoreTelemetry --context deployRuntimes=true --context enableEval=true
 */
export class AgentCoreTelemetryStack extends cdk.Stack {
  public readonly evaluationRoleArn: string;

  constructor(scope: Construct, id: string, props: AgentCoreTelemetryStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const safeName = prefix.replace(/-/g, '_');
    const modelId = props.modelId ?? 'us.amazon.nova-pro-v1:0';
    const enableOnlineEval = props.enableOnlineEvaluation
      ?? this.node.tryGetContext('enableEval') === 'true';

    // -------------------------------------------------------------------
    // IAM Role for evaluation execution
    // -------------------------------------------------------------------

    const evalRole = new iam.Role(this, 'EvaluationExecutionRole', {
      roleName: `${prefix}-eval-execution-role`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for OrgIQ online evaluation configs',
      inlinePolicies: {
        EvalAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'BedrockInvoke',
              actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'CloudWatchLogsDescribe',
              // DescribeLogGroups + Insights query management are list/control ops — need * resource.
              actions: [
                'logs:DescribeLogGroups',
                'logs:StartQuery',
                'logs:StopQuery',
                'logs:GetQueryResults',
              ],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'CloudWatchLogsRead',
              actions: [
                'logs:GetLogEvents',
                'logs:FilterLogEvents',
                'logs:DescribeLogStreams',
              ],
              resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*:*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:aws/spans:*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'XRayRead',
              actions: ['xray:GetTraceSummaries', 'xray:BatchGetTraces', 'xray:GetServiceGraph'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'MetricsWrite',
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: { StringEquals: { 'cloudwatch:namespace': `${prefix}/evaluations` } },
            }),
          ],
        }),
      },
    });
    this.evaluationRoleArn = evalRole.roleArn;

    // -------------------------------------------------------------------
    // X-Ray transaction search — resource-based policy
    // -------------------------------------------------------------------

    new xray.CfnResourcePolicy(this, 'XRayResourcePolicy', {
      policyName: `${prefix}-bedrock-agentcore-xray`,
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'AllowBedrockAgentCoreXRay',
          Effect: 'Allow',
          Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
          Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
          Resource: '*',
          Condition: {
            StringEquals: { 'aws:SourceAccount': this.account },
          },
        }],
      }),
    });

    // -------------------------------------------------------------------
    // CloudWatch Log Group retention — pre-create groups so OnlineEvalConfig
    // can reference them without a race condition.
    // -------------------------------------------------------------------

    const logRetentions: logs.LogRetention[] = [];
    for (const agentName of AGENT_NAMES) {
      const safeAgent = agentName.replace(/-/g, '_');
      logRetentions.push(new logs.LogRetention(this, `${this.pascal(agentName)}LogRetention`, {
        logGroupName: `/aws/bedrock-agentcore/runtimes/${prefix}_${safeAgent}`,
        retention: logs.RetentionDays.ONE_MONTH,
      }));
    }

    // -------------------------------------------------------------------
    // Custom Evaluator: OrgIQ Response Quality (LLM-as-a-judge, TRACE level)
    // -------------------------------------------------------------------

    const qualityEvaluator = new bedrockagentcore.CfnEvaluator(this, 'QualityEvaluator', {
      evaluatorName: `${safeName}_response_quality`,
      description: 'Evaluates OrgIQ agent response quality: correctness, relevance, and org-specificity',
      level: 'TRACE',
      evaluatorConfig: {
        llmAsAJudge: {
          instructions: `You are evaluating an OrgIQ organizational intelligence agent response.
The agent answers questions about people, expertise, projects, and knowledge in an organization.

Agent response to evaluate:
{assistant_turn}

Conversation context:
{context}

Evaluate the response on OVERALL QUALITY considering:
1. Does it correctly identify relevant people, documents, or expertise?
2. Is the response grounded in organizational data (not hallucinated)?
3. Is it concise and actionable for the user?

Rate on the numerical scale below.`,
          modelConfig: {
            bedrockEvaluatorModelConfig: {
              modelId: modelId,
            },
          },
          ratingScale: {
            numerical: [
              { label: 'Poor', value: 1, definition: 'Wrong or irrelevant response, no useful organizational information.' },
              { label: 'Below Average', value: 2, definition: 'Partially relevant but missing key organizational details.' },
              { label: 'Average', value: 3, definition: 'Correct but could be more specific or complete.' },
              { label: 'Good', value: 4, definition: 'Accurate, relevant, and reasonably complete organizational response.' },
              { label: 'Excellent', value: 5, definition: 'Precise, well-sourced from org data, actionable, and complete.' },
            ],
          },
        },
      },
    });

    // Custom Evaluator: Tool Selection Accuracy (TOOL_CALL level)
    const toolSelectionEvaluator = new bedrockagentcore.CfnEvaluator(this, 'ToolSelectionEvaluator', {
      evaluatorName: `${safeName}_tool_selection`,
      description: 'Evaluates whether the OrgIQ agent selected the right tool for the query',
      level: 'TOOL_CALL',
      evaluatorConfig: {
        llmAsAJudge: {
          instructions: `You are evaluating tool selection by an OrgIQ organizational intelligence agent.

Available tools:
{available_tools}

Tool call and result:
{tool_turn}

Conversation context:
{context}

Evaluate whether the SELECTED TOOL was the most appropriate choice for the user's query.
Consider: was a faster/simpler tool available? Was the tool capable of answering the query type?`,
          modelConfig: {
            bedrockEvaluatorModelConfig: {
              modelId: modelId,
            },
          },
          ratingScale: {
            categorical: [
              { label: 'Correct', definition: 'The selected tool is the best choice for this query type.' },
              { label: 'Acceptable', definition: 'The tool works but a more efficient tool was available.' },
              { label: 'Incorrect', definition: 'Wrong tool selected — another tool would have been more appropriate.' },
            ],
          },
        },
      },
    });

    // -------------------------------------------------------------------
    // Online Evaluation Config (only when enableOnlineEval = true)
    // Reads from all 6 runtime log groups with 10% sampling
    // -------------------------------------------------------------------

    if (enableOnlineEval) {
      // CfnOnlineEvaluationConfig limits: logGroupNames ≤ 5, serviceNames ≤ 1.
      // Monitor the 5 user-facing agents; graph-builder is internal so excluded.
      const monitoredAgents = AGENT_NAMES.filter(n => n !== 'graph-builder');
      const logGroupNames = monitoredAgents.map(name =>
        `/aws/bedrock-agentcore/runtimes/${prefix}_${name.replace(/-/g, '_')}`
      );

      const onlineEvalConfig = new bedrockagentcore.CfnOnlineEvaluationConfig(this, 'OnlineEvalConfig', {
        onlineEvaluationConfigName: `${safeName}_online_eval`,
        description: 'Continuous quality monitoring for 5 user-facing OrgIQ agents',
        evaluationExecutionRoleArn: evalRole.roleArn,
        dataSourceConfig: {
          cloudWatchLogs: {
            logGroupNames,
            // serviceNames triggers X-Ray aws/spans validation; omit until
            // X-Ray → CloudWatch Logs integration is enabled in the account.
          },
        },
        evaluators: [
          { evaluatorId: qualityEvaluator.attrEvaluatorId },
          { evaluatorId: toolSelectionEvaluator.attrEvaluatorId },
        ],
        rule: {
          samplingConfig: { samplingPercentage: 10 },
        },
      });
      // Ensure log groups exist before OnlineEvalConfig tries to access them.
      for (const lr of logRetentions) onlineEvalConfig.node.addDependency(lr);
    }

    // -------------------------------------------------------------------
    // CloudWatch Dashboard — AgentCore Runtime Metrics
    // -------------------------------------------------------------------

    const dashboard = new cloudwatch.Dashboard(this, 'AgentCoreDashboard', {
      dashboardName: `${prefix}-agentcore-telemetry`,
      defaultInterval: cdk.Duration.hours(3),
    });

    // Row 1: Invocation counts per agent
    const invocationsWidget = new cloudwatch.GraphWidget({
      title: 'AgentCore — Invocations per Agent',
      left: AGENT_NAMES.map(name => new cloudwatch.Metric({
        namespace: 'bedrock-agentcore',
        metricName: 'Invocations',
        dimensionsMap: { AgentRuntimeName: `${prefix}_${name.replace(/-/g, '_')}` },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
        label: name,
      })),
      width: 12, height: 6,
    });

    // Row 1: Latency p99 per agent
    const latencyWidget = new cloudwatch.GraphWidget({
      title: 'AgentCore — p99 Latency per Agent (ms)',
      left: AGENT_NAMES.map(name => new cloudwatch.Metric({
        namespace: 'bedrock-agentcore',
        metricName: 'InvocationLatency',
        dimensionsMap: { AgentRuntimeName: `${prefix}_${name.replace(/-/g, '_')}` },
        statistic: 'p99',
        period: cdk.Duration.minutes(5),
        label: name,
      })),
      width: 12, height: 6,
    });

    // Row 2: Errors and throttles
    const errorsWidget = new cloudwatch.GraphWidget({
      title: 'AgentCore — Errors per Agent',
      left: AGENT_NAMES.map(name => new cloudwatch.Metric({
        namespace: 'bedrock-agentcore',
        metricName: 'Errors',
        dimensionsMap: { AgentRuntimeName: `${prefix}_${name.replace(/-/g, '_')}` },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
        label: name,
      })),
      width: 12, height: 6,
    });

    // Row 2: Bedrock model usage (tokens)
    const tokensWidget = new cloudwatch.GraphWidget({
      title: 'Bedrock — Token Usage (Input + Output)',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InputTokenCount',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          label: 'Input tokens',
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'OutputTokenCount',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          label: 'Output tokens',
        }),
      ],
      width: 12, height: 6,
    });

    // Row 3: MCP Gateway metrics
    const gatewayWidget = new cloudwatch.GraphWidget({
      title: 'MCP Gateway — Tool Invocations',
      left: [
        new cloudwatch.Metric({
          namespace: 'bedrock-agentcore',
          metricName: 'GatewayToolInvocations',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          label: 'Tool invocations',
        }),
        new cloudwatch.Metric({
          namespace: 'bedrock-agentcore',
          metricName: 'GatewayToolErrors',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          label: 'Tool errors',
        }),
      ],
      width: 12, height: 6,
    });

    // Row 3: Memory operations
    const memoryWidget = new cloudwatch.GraphWidget({
      title: 'AgentCore Memory — Store/Retrieve Operations',
      left: [
        new cloudwatch.Metric({
          namespace: 'bedrock-agentcore',
          metricName: 'MemoryStoreOperations',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          label: 'Store ops',
        }),
        new cloudwatch.Metric({
          namespace: 'bedrock-agentcore',
          metricName: 'MemoryRetrieveOperations',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
          label: 'Retrieve ops',
        }),
      ],
      width: 12, height: 6,
    });

    dashboard.addWidgets(invocationsWidget, latencyWidget);
    dashboard.addWidgets(errorsWidget, tokensWidget);
    dashboard.addWidgets(gatewayWidget, memoryWidget);

    // -------------------------------------------------------------------
    // Alarms
    // -------------------------------------------------------------------

    const supervisorErrorAlarm = new cloudwatch.Alarm(this, 'SupervisorErrorAlarm', {
      alarmName: `${prefix}-supervisor-errors`,
      alarmDescription: 'Supervisor agent has elevated error rate',
      metric: new cloudwatch.Metric({
        namespace: 'bedrock-agentcore',
        metricName: 'Errors',
        dimensionsMap: { AgentRuntimeName: `${prefix}_supervisor` },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'EvaluationRoleArn', {
      value: evalRole.roleArn,
      exportName: `${prefix}-eval-execution-role-arn`,
    });

    new cdk.CfnOutput(this, 'QualityEvaluatorId', {
      value: qualityEvaluator.attrEvaluatorId,
      exportName: `${prefix}-quality-evaluator-id`,
    });

    new cdk.CfnOutput(this, 'ToolSelectionEvaluatorId', {
      value: toolSelectionEvaluator.attrEvaluatorId,
      exportName: `${prefix}-tool-selection-evaluator-id`,
    });

    new cdk.CfnOutput(this, 'TelemetryDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home#dashboards:name=${prefix}-agentcore-telemetry`,
    });
  }

  private pascal(name: string): string {
    return name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}
