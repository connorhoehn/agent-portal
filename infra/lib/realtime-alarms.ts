import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/**
 * Load alarms for the realtime stack (docs/realtime-capacity-100-calls-2026-10-01.md
 * §6, ranked change #9), off unless `--context realtimeAlarms=true`.
 *
 * One SNS topic, `<prefix>-realtime-alarms`, minted by OrgIQ-MiddlewareService
 * (which every realtime stack deploys after) and addressed BY NAME everywhere
 * else — an ARN built from the name, so no export is created and none freezes.
 * `--context alertEmail=…` (the same key OrgIQ-Observability reads) subscribes
 * an address; confirm the subscription email or nothing is delivered.
 *
 * Each stack alarms on the resources it owns; nothing here reaches across.
 */
export function realtimeAlarmsEnabled(scope: Construct): boolean {
  const v = scope.node.tryGetContext('realtimeAlarms');
  return v === true || v === 'true';
}

export function realtimeAlarmTopicName(prefix: string): string {
  return `${prefix}-realtime-alarms`;
}

/** The topic, imported by name (no export). */
export function realtimeAlarmTopic(scope: Construct, prefix: string): sns.ITopic {
  const stack = cdk.Stack.of(scope);
  return sns.Topic.fromTopicArn(scope, 'RealtimeAlarmTopicRef', stack.formatArn({
    service: 'sns', resource: realtimeAlarmTopicName(prefix), arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
  }));
}

export interface AlarmSpec {
  readonly id: string;
  readonly metric: cloudwatch.IMetric;
  readonly threshold: number;
  readonly description: string;
  readonly comparison?: cloudwatch.ComparisonOperator;
  readonly evaluationPeriods?: number;
  readonly datapointsToAlarm?: number;
  readonly treatMissingData?: cloudwatch.TreatMissingData;
}

/** An alarm named `<prefix>-<id>` that notifies the topic on ALARM and OK. */
export function realtimeAlarm(scope: Construct, prefix: string, topic: sns.ITopic, spec: AlarmSpec): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, `${spec.id}Alarm`, {
    alarmName: `${prefix}-${spec.id}`,
    alarmDescription: spec.description,
    metric: spec.metric,
    threshold: spec.threshold,
    comparisonOperator: spec.comparison ?? cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: spec.evaluationPeriods ?? 3,
    datapointsToAlarm: spec.datapointsToAlarm ?? spec.evaluationPeriods ?? 3,
    treatMissingData: spec.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cwActions.SnsAction(topic));
  alarm.addOkAction(new cwActions.SnsAction(topic));
  return alarm;
}
