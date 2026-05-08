import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** Monthly budget limit in USD */
  readonly monthlyBudgetUsd?: number;
  /** Email address for budget alerts */
  readonly alertEmail?: string;
  /** Neptune Analytics graph ID for metrics */
  readonly neptuneGraphId: string;
  /** Knowledge Base ID for metrics */
  readonly knowledgeBaseId: string;
}

/**
 * OrgIQ-Observability: CloudWatch dashboard + budget alarm.
 * Monitors Neptune per-NCU-hour billing and OpenSearch 2 OCU minimum.
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

    // --- Neptune Analytics Metrics ---
    const neptuneMemoryWidget = new cloudwatch.GraphWidget({
      title: 'Neptune Analytics — Memory Utilization',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/NeptuneGraph',
          metricName: 'UsedMemory',
          dimensionsMap: { GraphId: props.neptuneGraphId },
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    const neptuneQueryWidget = new cloudwatch.GraphWidget({
      title: 'Neptune Analytics — Query Performance',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/NeptuneGraph',
          metricName: 'QueryLatency',
          dimensionsMap: { GraphId: props.neptuneGraphId },
          statistic: 'p99',
          period: cdk.Duration.minutes(5),
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/NeptuneGraph',
          metricName: 'QueryCount',
          dimensionsMap: { GraphId: props.neptuneGraphId },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    // --- OpenSearch Serverless Metrics ---
    const ossComputeWidget = new cloudwatch.GraphWidget({
      title: 'OpenSearch Serverless — OCU Usage',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/AOSS',
          metricName: 'SearchOCU',
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/AOSS',
          metricName: 'IndexingOCU',
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    // --- Bedrock Metrics ---
    const bedrockInvocationsWidget = new cloudwatch.GraphWidget({
      title: 'Bedrock — Model Invocations',
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
    const kbWidget = new cloudwatch.GraphWidget({
      title: 'Bedrock Knowledge Base — Retrieve Operations',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'RetrieveLatency',
          dimensionsMap: { KnowledgeBaseId: props.knowledgeBaseId },
          statistic: 'p99',
          period: cdk.Duration.minutes(5),
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'RetrieveCount',
          dimensionsMap: { KnowledgeBaseId: props.knowledgeBaseId },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    // Assemble dashboard rows
    dashboard.addWidgets(neptuneMemoryWidget, neptuneQueryWidget);
    dashboard.addWidgets(ossComputeWidget, bedrockInvocationsWidget);
    dashboard.addWidgets(bedrockThrottlesWidget, dynamoWidget);
    dashboard.addWidgets(kbWidget);

    // -------------------------------------------------------------------
    // CloudWatch Alarms
    // -------------------------------------------------------------------

    // Neptune high memory utilization
    new cloudwatch.Alarm(this, 'NeptuneHighMemoryAlarm', {
      alarmName: `${prefix}-neptune-high-memory`,
      alarmDescription: 'Neptune Analytics memory utilization exceeds 80%',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/NeptuneGraph',
        metricName: 'UsedMemoryPercent',
        dimensionsMap: { GraphId: props.neptuneGraphId },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
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
    // Budget Alarm (critical for OpenSearch 2 OCU minimum + Neptune NCU)
    // -------------------------------------------------------------------

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${prefix}-monthly-budget`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: budgetUsd,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: alertEmail ? [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: alertEmail,
            },
          ],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: alertEmail,
            },
          ],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 120,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: alertEmail,
            },
          ],
        },
      ] : [],
    });

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${prefix}-dashboard`,
      exportName: `${prefix}-dashboard-url`,
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      exportName: `${prefix}-alert-topic-arn`,
    });
  }
}
