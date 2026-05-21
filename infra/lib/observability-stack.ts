import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly prefix?: string;
  readonly monthlyBudgetUsd?: number;
  readonly alertEmail?: string;
  /** Aurora cluster identifier for metrics */
  readonly auroraClusterIdentifier: string;
  /** Knowledge Base ID for metrics (singular, kept for backwards compatibility) */
  readonly knowledgeBaseId?: string;
  /** Per-KB metrics: slug → Bedrock KB ID (e.g. { default: 'EJYAXQAMHQ', newsroom: 'XYZ123' }) */
  readonly knowledgeBaseIds?: Record<string, string>;
}

/**
 * OrgIQ-Observability: CloudWatch dashboard + budget alarm.
 * Monitors Aurora Serverless v2 ACU billing, Bedrock, DynamoDB, and KB metrics.
 */
export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const budgetUsd = props.monthlyBudgetUsd ?? 200;
    const alertEmail = props.alertEmail ?? '';

    // -------------------------------------------------------------------
    // SNS Topic for alerts
    // -------------------------------------------------------------------

    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${prefix}-alerts`,
      displayName: 'OrgIQ Infrastructure Alerts',
    });

    if (alertEmail) {
      alertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
    }

    // -------------------------------------------------------------------
    // CloudWatch Dashboard
    // -------------------------------------------------------------------

    const dashboard = new cloudwatch.Dashboard(this, 'OrgIQDashboard', {
      dashboardName: `${prefix}-dashboard`,
      defaultInterval: cdk.Duration.hours(6),
    });

    // --- Aurora Serverless v2 Metrics ---
    const auroraAcuWidget = new cloudwatch.GraphWidget({
      title: 'Aurora Serverless v2 — ACU Utilization',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/RDS',
          metricName: 'ServerlessDatabaseCapacity',
          dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
          label: 'ACU (current)',
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/RDS',
          metricName: 'CPUUtilization',
          dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
          label: 'CPU %',
        }),
      ],
      width: 12,
      height: 6,
    });

    const auroraConnectionsWidget = new cloudwatch.GraphWidget({
      title: 'Aurora — Connections & Latency',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/RDS',
          metricName: 'DatabaseConnections',
          dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
          label: 'Connections',
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/RDS',
          metricName: 'CommitLatency',
          dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
          statistic: 'p99',
          period: cdk.Duration.minutes(5),
          label: 'Commit latency p99 (ms)',
        }),
      ],
      width: 12,
      height: 6,
    });

    // --- Bedrock Metrics ---
    const bedrockInvocationsWidget = new cloudwatch.GraphWidget({
      title: 'Bedrock — Model Invocations (Nova)',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'Invocations',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationLatency',
          statistic: 'p99',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    const bedrockThrottlesWidget = new cloudwatch.GraphWidget({
      title: 'Bedrock — Throttles & Errors',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationThrottles',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationClientErrors',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationServerErrors',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    // --- DynamoDB Metrics ---
    const dynamoWidget = new cloudwatch.GraphWidget({
      title: 'DynamoDB — Read/Write Capacity',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'ConsumedReadCapacityUnits',
          dimensionsMap: { TableName: `${prefix}-scores` },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'ConsumedReadCapacityUnits',
          dimensionsMap: { TableName: `${prefix}-sessions` },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'ConsumedWriteCapacityUnits',
          dimensionsMap: { TableName: `${prefix}-scores` },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    // --- Knowledge Base Metrics ---
    // Build a map from all available KB IDs, preferring the new plural prop
    // and falling back to the legacy singular prop when knowledgeBaseIds is absent.
    const kbIds: Record<string, string> =
      props.knowledgeBaseIds ??
      (props.knowledgeBaseId ? { default: props.knowledgeBaseId } : {});

    const kbWidgets: cloudwatch.GraphWidget[] = Object.entries(kbIds).map(
      ([slug, kbId]) =>
        new cloudwatch.GraphWidget({
          title: `Bedrock KB — Retrieve Operations (${slug})`,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/Bedrock',
              metricName: 'KnowledgeBaseRetrieveLatency',
              dimensionsMap: { KnowledgeBaseId: kbId },
              statistic: 'p99',
              label: `${slug} Retrieve p99`,
              period: cdk.Duration.minutes(5),
            }),
          ],
          right: [
            new cloudwatch.Metric({
              namespace: 'AWS/Bedrock',
              metricName: 'KnowledgeBaseRetrieveDocumentCount',
              dimensionsMap: { KnowledgeBaseId: kbId },
              statistic: 'Sum',
              label: `${slug} Retrieve Count`,
              period: cdk.Duration.minutes(5),
            }),
          ],
          width: 12,
          height: 6,
        }),
    );

    // Assemble dashboard rows
    dashboard.addWidgets(auroraAcuWidget, auroraConnectionsWidget);
    dashboard.addWidgets(bedrockInvocationsWidget, bedrockThrottlesWidget);
    dashboard.addWidgets(dynamoWidget);
    // Knowledge Bases row — one widget per KB (pairs of two fill a row naturally)
    if (kbWidgets.length > 0) {
      dashboard.addWidgets(...kbWidgets);
    }

    // -------------------------------------------------------------------
    // CloudWatch Alarms
    // -------------------------------------------------------------------

    // Aurora high ACU alarm (approaching max capacity)
    new cloudwatch.Alarm(this, 'AuroraHighAcuAlarm', {
      alarmName: `${prefix}-aurora-high-acu`,
      alarmDescription: 'Aurora Serverless v2 ACU nearing max (4 ACU)',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'ServerlessDatabaseCapacity',
        dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3.5,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alertTopic));

    // Bedrock throttle alarm
    new cloudwatch.Alarm(this, 'BedrockThrottleAlarm', {
      alarmName: `${prefix}-bedrock-throttles`,
      alarmDescription: 'Bedrock model invocations being throttled',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'InvocationThrottles',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alertTopic));

    // -------------------------------------------------------------------
    // Budget Alarm
    // -------------------------------------------------------------------

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${prefix}-monthly-budget`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: alertEmail ? [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 120,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        },
      ] : [],
    });

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home#dashboards:name=${prefix}-dashboard`,
    });
  }
}
