import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { realtimeAlarm } from './realtime-alarms';

/**
 * Devbox-fleet metrics and alarms (docs/deployment-enhancements/DE-50-kill-switches-and-alerts.md),
 * off unless `--context fleetAlarms=true`, on OrgIQ-MiddlewareService.
 *
 * The middleware writes one JSON line per event to stdout
 * (middleware/src/lib/fleet-metrics.ts), `{ "type": "<line>", ... }`; metric
 * filters on the service's log group turn them into `OrgIQ/DevboxFleet`
 * metrics — the realtime gateway's stats-line pattern. Alarms go to the
 * `<prefix>-alerts` topic OrgIQ-Observability owns, imported by name (no
 * export, nothing freezes).
 *
 * Per-initiative thresholds are data, so they cannot be static alarms: the
 * middleware's budget sweep emits one `budget-threshold` line per crossing and
 * the alarms count crossings.
 */
export const FLEET_NAMESPACE = 'OrgIQ/DevboxFleet';

export function fleetAlarmsEnabled(scope: Construct): boolean {
  const v = scope.node.tryGetContext('fleetAlarms');
  return v === true || v === 'true';
}

export function fleetAlertsTopicName(prefix: string): string {
  return `${prefix}-alerts`;
}

/** The names, for tests and the runbook. */
export const FLEET_ALARM_IDS = [
  'devbox-spend-rate', 'devbox-budget-100', 'devbox-budget-80', 'devbox-budget-50',
  'devbox-stuck-runs', 'devbox-reap-failures', 'devbox-reaper-silent', 'devbox-paused',
] as const;

export function attachFleetAlarms(scope: Construct, prefix: string, logGroup: logs.ILogGroup): void {
  const stack = cdk.Stack.of(scope);
  const topic = sns.Topic.fromTopicArn(scope, 'FleetAlertsTopicRef', stack.formatArn({
    service: 'sns', resource: fleetAlertsTopicName(prefix), arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
  }));
  const ctxNum = (key: string, fallback: number): number => {
    const v = Number(scope.node.tryGetContext(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };

  const filter = (id: string, line: string, metricName: string, value: string, dimensions?: Record<string, string>) =>
    new logs.MetricFilter(scope, `Fleet${id}`, {
      logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.type', '=', line),
      metricNamespace: FLEET_NAMESPACE,
      metricName,
      metricValue: value,
      ...(dimensions ? { dimensions } : {}),
    });

  const spend = filter('SpendUsd', 'devbox-spend', 'SpendUsd', '$.usd');
  filter('SpendUsdByInitiative', 'devbox-spend', 'SpendUsdByInitiative', '$.usd', { InitiativeId: '$.InitiativeId', ActorId: '$.ActorId' });
  filter('ReaperKills', 'devbox-reaped', 'ReaperKills', '1', { Reason: '$.reason' });
  const reapFailed = filter('ReaperStopFailures', 'devbox-reap-failed', 'ReaperStopFailures', '1');
  filter('RunCutoffs', 'devbox-run-cutoff', 'RunCutoffs', '1');
  const running = filter('RunningBoxes', 'devbox-fleet-stats', 'RunningBoxes', '$.runningBoxes');
  filter('LiveBoxes', 'devbox-fleet-stats', 'LiveBoxes', '$.liveBoxes');
  const stuck = filter('StuckRuns', 'devbox-fleet-stats', 'StuckRuns', '$.stuckRuns');
  const paused = filter('FleetPaused', 'devbox-fleet-stats', 'FleetPaused', '$.fleetPaused');
  filter('BudgetThresholdCrossed', 'budget-threshold', 'BudgetThresholdCrossed', '1', { Threshold: '$.threshold' });

  const one = cdk.Duration.minutes(1);
  const five = cdk.Duration.minutes(5);
  const crossed = (threshold: number) => new cloudwatch.Metric({
    namespace: FLEET_NAMESPACE, metricName: 'BudgetThresholdCrossed', dimensionsMap: { Threshold: String(threshold) },
    period: five, statistic: 'Sum',
  });
  const alarm = (spec: Parameters<typeof realtimeAlarm>[3]) => realtimeAlarm(scope, prefix, topic, spec);

  alarm({ id: 'devbox-spend-rate', threshold: ctxNum('fleetSpendRateUsd', 10), evaluationPeriods: 1,
    metric: spend.metric({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
    description: 'Agent fleet spend above the per-15-minute threshold (fleetSpendRateUsd, default $10). Consider PUT /api/ops/switches/fleet.' });
  alarm({ id: 'devbox-budget-100', threshold: 0, evaluationPeriods: 1, metric: crossed(100),
    description: 'An initiative crossed 100% of its allocation this period (the Activity bell names it).' });
  alarm({ id: 'devbox-budget-80', threshold: 0, evaluationPeriods: 1, metric: crossed(80),
    description: 'An initiative crossed 80% of its allocation this period (notify only).' });
  alarm({ id: 'devbox-budget-50', threshold: 0, evaluationPeriods: 1, metric: crossed(50),
    description: 'An initiative crossed 50% of its allocation this period (notify only).' });
  alarm({ id: 'devbox-stuck-runs', threshold: 0, evaluationPeriods: 3,
    metric: stuck.metric({ period: one, statistic: 'Maximum' }),
    description: 'Boxes running past their task ceiling plus grace, or jobs claimed past JOB_STALE_MINUTES, for 3 minutes.' });
  alarm({ id: 'devbox-reap-failures', threshold: 0, evaluationPeriods: 1,
    metric: reapFailed.metric({ period: five, statistic: 'Sum' }),
    description: 'The reaper could not stop a box — that box is still billing.' });
  alarm({ id: 'devbox-reaper-silent', threshold: 1, comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    evaluationPeriods: 10, treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    metric: running.metric({ period: one, statistic: 'SampleCount' }),
    description: 'No devbox-fleet-stats line for 10 minutes — the reaper leader is down or the middleware is not running.' });
  alarm({ id: 'devbox-paused', threshold: 1, comparison: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1, metric: paused.metric({ period: one, statistic: 'Maximum' }),
    description: 'The agent fleet is paused (the OK notification announces the resume).' });
}
