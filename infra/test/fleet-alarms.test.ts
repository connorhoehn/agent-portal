/**
 * DE-50: the devbox fleet's metric filters and alarms, synth only.
 * `--context fleetAlarms=true` on OrgIQ-MiddlewareService.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { middlewareServiceStack } from './helpers/stacks';
import { FLEET_ALARM_IDS, FLEET_NAMESPACE } from '../lib/fleet-alarms';

const off = Template.fromStack(middlewareServiceStack());
const on = Template.fromStack(middlewareServiceStack({ fleetAlarms: true }));

describe('fleet alarms (DE-50)', () => {
  test('off by default: no OrgIQ/DevboxFleet filter and no devbox alarm', () => {
    const filters = Object.values<any>(off.findResources('AWS::Logs::MetricFilter'));
    assert.equal(filters.filter((f) => JSON.stringify(f).includes(FLEET_NAMESPACE)).length, 0);
    const alarms = Object.values<any>(off.findResources('AWS::CloudWatch::Alarm'));
    assert.equal(alarms.filter((a) => String(a.Properties.AlarmName ?? '').includes('devbox-')).length, 0);
  });

  test('every metric the spec names is a filter in OrgIQ/DevboxFleet on the middleware log group', () => {
    const filters = Object.values<any>(on.findResources('AWS::Logs::MetricFilter'))
      .filter((f) => f.Properties.MetricTransformations?.[0]?.MetricNamespace === FLEET_NAMESPACE);
    const names = filters.map((f) => f.Properties.MetricTransformations[0].MetricName).sort();
    for (const m of ['SpendUsd', 'SpendUsdByInitiative', 'ReaperKills', 'ReaperStopFailures', 'RunningBoxes', 'LiveBoxes',
      'StuckRuns', 'BudgetThresholdCrossed', 'FleetPaused', 'RunCutoffs']) {
      assert.ok(names.includes(m), `missing metric filter ${m}`);
    }
    // The spend line carries the InitiativeId and ActorId dimensions.
    on.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: Match.stringLikeRegexp('devbox-spend'),
      MetricTransformations: [Match.objectLike({
        MetricName: 'SpendUsdByInitiative',
        Dimensions: Match.arrayWith([
          Match.objectLike({ Key: 'InitiativeId', Value: '$.InitiativeId' }),
          Match.objectLike({ Key: 'ActorId', Value: '$.ActorId' }),
        ]),
      })],
    });
    on.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: Match.stringLikeRegexp('devbox-reaped'),
      MetricTransformations: [Match.objectLike({ MetricName: 'ReaperKills', Dimensions: [Match.objectLike({ Key: 'Reason', Value: '$.reason' })] })],
    });
  });

  test('each alarm exists and notifies the <prefix>-alerts topic', () => {
    const alarms = Object.values<any>(on.findResources('AWS::CloudWatch::Alarm'));
    for (const id of FLEET_ALARM_IDS) {
      const a = alarms.find((x) => String(x.Properties.AlarmName).endsWith(`-${id}`));
      assert.ok(a, `missing alarm ${id}`);
      const actions = JSON.stringify(a.Properties.AlarmActions);
      assert.match(actions, /-alerts/, `${id} does not notify the alerts topic`);
    }
  });

  test('the spend-rate threshold is $10 per 15 minutes by default and follows fleetSpendRateUsd', () => {
    on.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('devbox-spend-rate$'), Threshold: 10, Period: 900, Statistic: 'Sum',
    });
    const tuned = Template.fromStack(middlewareServiceStack({ fleetAlarms: 'true', fleetSpendRateUsd: 25 }));
    tuned.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: Match.stringLikeRegexp('devbox-spend-rate$'), Threshold: 25 });
  });

  test('the reaper-silent alarm breaches on missing data', () => {
    on.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('devbox-reaper-silent$'), TreatMissingData: 'breaching', ComparisonOperator: 'LessThanThreshold',
    });
  });
});
