// Feature: cloudwatch-alarm-auto-rca, Property 1: Alarm event field extraction
// **Validates: Requirements 1.2**

import * as fc from 'fast-check';
import { parseAlarmEvent } from '../../src/lambdas/alarm-router/parser';
import { AlarmRouterInput } from '../../src/shared/types';

/**
 * Shared arbitrary generators for CloudWatch alarm events.
 */
const arbNamespace = fc.constantFrom(
  'AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ECS', 'AWS/SQS', 'AWS/DynamoDB', 'AWS/S3'
);

const arbMetricName = fc.constantFrom(
  'CPUUtilization', 'ReadIOPS', 'Errors', 'Duration', 'Invocations',
  'ApproximateNumberOfMessagesVisible', 'ConsumedReadCapacityUnits'
);

const arbDimensions = fc.oneof(
  fc.constant({ InstanceId: 'i-1234567890abcdef0' }),
  fc.constant({ DBInstanceIdentifier: 'my-db' }),
  fc.constant({ FunctionName: 'my-function' }),
  fc.constant({ QueueName: 'my-queue' }),
  fc.constant({ TableName: 'my-table' }),
  fc.constant({ BucketName: 'my-bucket' }),
);

const arbAlarmName = fc.string({ minLength: 1, maxLength: 50 })
  .filter(s => s.trim().length > 0);

const arbAccountId: fc.Arbitrary<string> = fc.integer({ min: 100000000000, max: 999999999999 }).map(n => String(n));

const arbRegion = fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1');

const arbTimestamp: fc.Arbitrary<string> = fc.integer({ min: 1577836800000, max: 1893456000000 }).map(ms => new Date(ms).toISOString());

const arbThreshold = fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true });
const arbCurrentValue = fc.double({ min: 0, max: 10000, noNaN: true, noDefaultInfinity: true });

/**
 * Generator: Single metric alarm event.
 * A standard alarm with one metricStat entry.
 */
const arbSingleMetricAlarmEvent: fc.Arbitrary<AlarmRouterInput> = fc.tuple(
  arbAlarmName,
  arbNamespace,
  arbMetricName,
  arbDimensions,
  arbAccountId,
  arbRegion,
  arbTimestamp,
  arbTimestamp,
  arbThreshold,
  arbCurrentValue
).map(([alarmName, namespace, metricName, dimensions, accountId, region, timestamp, previousTimestamp, threshold, currentValue]) => {
  const alarmArn = `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}`;
  const recentDatapoints = [currentValue];

  return {
    version: '0',
    id: `event-${Date.now()}`,
    'detail-type': 'CloudWatch Alarm State Change' as const,
    source: 'aws.cloudwatch' as const,
    account: accountId,
    time: timestamp,
    region,
    resources: [alarmArn],
    detail: {
      alarmName,
      state: {
        value: 'ALARM',
        reason: 'Threshold Crossed',
        reasonData: JSON.stringify({ threshold, recentDatapoints }),
        timestamp,
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold OK',
        timestamp: previousTimestamp,
      },
      configuration: {
        metrics: [
          {
            id: 'm1',
            metricStat: {
              metric: {
                namespace,
                name: metricName,
                dimensions,
              },
              period: 300,
              stat: 'Average',
            },
            returnData: true,
          },
        ],
      },
    },
  };
});

/**
 * Generator: Metric math alarm event.
 * Contains an expression metric plus a metricStat metric used in the expression.
 */
const arbMetricMathAlarmEvent: fc.Arbitrary<AlarmRouterInput> = fc.tuple(
  arbAlarmName,
  arbNamespace,
  arbMetricName,
  arbDimensions,
  arbAccountId,
  arbRegion,
  arbTimestamp,
  arbTimestamp,
  arbThreshold,
  arbCurrentValue
).map(([alarmName, namespace, metricName, dimensions, accountId, region, timestamp, previousTimestamp, threshold, currentValue]) => {
  const alarmArn = `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}`;

  return {
    version: '0',
    id: `event-${Date.now()}`,
    'detail-type': 'CloudWatch Alarm State Change' as const,
    source: 'aws.cloudwatch' as const,
    account: accountId,
    time: timestamp,
    region,
    resources: [alarmArn],
    detail: {
      alarmName,
      state: {
        value: 'ALARM',
        reason: 'Threshold Crossed: ANOMALY_DETECTION_BAND',
        reasonData: JSON.stringify({ threshold, recentDatapoints: [currentValue] }),
        timestamp,
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold OK',
        timestamp: previousTimestamp,
      },
      configuration: {
        metrics: [
          {
            id: 'e1',
            expression: 'METRICS("m1") / 100',
            returnData: true,
          },
          {
            id: 'm1',
            metricStat: {
              metric: {
                namespace,
                name: metricName,
                dimensions,
              },
              period: 300,
              stat: 'Average',
            },
            returnData: false,
          },
        ],
      },
    },
  };
});

/**
 * Generator: Anomaly detection alarm event.
 * Contains an ANOMALY_DETECTION_BAND expression and underlying metric.
 */
const arbAnomalyDetectionAlarmEvent: fc.Arbitrary<AlarmRouterInput> = fc.tuple(
  arbAlarmName,
  arbNamespace,
  arbMetricName,
  arbDimensions,
  arbAccountId,
  arbRegion,
  arbTimestamp,
  arbTimestamp,
  arbThreshold,
  arbCurrentValue
).map(([alarmName, namespace, metricName, dimensions, accountId, region, timestamp, previousTimestamp, threshold, currentValue]) => {
  const alarmArn = `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}`;

  return {
    version: '0',
    id: `event-${Date.now()}`,
    'detail-type': 'CloudWatch Alarm State Change' as const,
    source: 'aws.cloudwatch' as const,
    account: accountId,
    time: timestamp,
    region,
    resources: [alarmArn],
    detail: {
      alarmName,
      state: {
        value: 'ALARM',
        reason: 'Thresholds Crossed: 1 datapoint was outside the band',
        reasonData: JSON.stringify({
          threshold,
          evaluatedDatapoints: [{ value: currentValue, threshold: [threshold * 0.8, threshold * 1.2] }],
        }),
        timestamp,
      },
      previousState: {
        value: 'OK',
        reason: 'Threshold OK',
        timestamp: previousTimestamp,
      },
      configuration: {
        metrics: [
          {
            id: 'ad1',
            expression: 'ANOMALY_DETECTION_BAND(m1, 2)',
            returnData: true,
          },
          {
            id: 'm1',
            metricStat: {
              metric: {
                namespace,
                name: metricName,
                dimensions,
              },
              period: 300,
              stat: 'Average',
            },
            returnData: false,
          },
        ],
      },
    },
  };
});

/**
 * Generator: Composite alarm event.
 * Composite alarms have no metrics array — they reference other alarms via rules.
 */
const arbCompositeAlarmEvent: fc.Arbitrary<AlarmRouterInput> = fc.tuple(
  arbAlarmName,
  arbAccountId,
  arbRegion,
  arbTimestamp,
  arbTimestamp
).map(([alarmName, accountId, region, timestamp, previousTimestamp]) => {
  const alarmArn = `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}`;

  return {
    version: '0',
    id: `event-${Date.now()}`,
    'detail-type': 'CloudWatch Alarm State Change' as const,
    source: 'aws.cloudwatch' as const,
    account: accountId,
    time: timestamp,
    region,
    resources: [alarmArn],
    detail: {
      alarmName,
      state: {
        value: 'ALARM',
        reason: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:child-alarm transitioned to ALARM',
        timestamp,
      },
      previousState: {
        value: 'OK',
        reason: 'All child alarms OK',
        timestamp: previousTimestamp,
      },
      configuration: {
        // Composite alarms have no metrics
      },
    },
  };
});

/**
 * Combined generator covering all alarm types.
 */
const arbAnyValidAlarmEvent: fc.Arbitrary<AlarmRouterInput> = fc.oneof(
  arbSingleMetricAlarmEvent,
  arbMetricMathAlarmEvent,
  arbAnomalyDetectionAlarmEvent,
  arbCompositeAlarmEvent
);

describe('Property 1: Alarm event field extraction', () => {
  describe('Single metric alarms', () => {
    it('should correctly extract all fields from single metric alarm events', () => {
      fc.assert(
        fc.property(arbSingleMetricAlarmEvent, (event: AlarmRouterInput) => {
          const result = parseAlarmEvent(event);
          expect(result.filtered).toBe(false);
          expect(result.alarmName).toBe(event.detail.alarmName);
          expect(result.namespace).toBe(event.detail.configuration.metrics![0].metricStat!.metric.namespace);
          expect(result.metricName).toBe(event.detail.configuration.metrics![0].metricStat!.metric.name);
          expect(result.dimensions).toEqual(event.detail.configuration.metrics![0].metricStat!.metric.dimensions);
          expect(result.stateChangeTimestamp).toBe(event.detail.state.timestamp);
          expect(result.accountId).toBe(event.account);
          expect(result.region).toBe(event.region);

          const reasonData = JSON.parse(event.detail.state.reasonData!);
          expect(result.threshold).toBe(reasonData.threshold);
          expect(result.currentValue).toBe(reasonData.recentDatapoints[reasonData.recentDatapoints.length - 1]);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Metric math alarms', () => {
    it('should extract metric info from the metricStat entry in a metric math alarm', () => {
      fc.assert(
        fc.property(arbMetricMathAlarmEvent, (event: AlarmRouterInput) => {
          const result = parseAlarmEvent(event);
          expect(result.filtered).toBe(false);
          expect(result.alarmName).toBe(event.detail.alarmName);

          // The parser finds the first metric with a metricStat
          const metricStatEntry = event.detail.configuration.metrics!.find(m => m.metricStat != null)!;
          expect(result.namespace).toBe(metricStatEntry.metricStat!.metric.namespace);
          expect(result.metricName).toBe(metricStatEntry.metricStat!.metric.name);
          expect(result.dimensions).toEqual(metricStatEntry.metricStat!.metric.dimensions);
          expect(result.stateChangeTimestamp).toBe(event.detail.state.timestamp);
          expect(result.accountId).toBe(event.account);
          expect(result.region).toBe(event.region);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Anomaly detection alarms', () => {
    it('should extract metric info and currentValue from anomaly detection alarms', () => {
      fc.assert(
        fc.property(arbAnomalyDetectionAlarmEvent, (event: AlarmRouterInput) => {
          const result = parseAlarmEvent(event);
          expect(result.filtered).toBe(false);
          expect(result.alarmName).toBe(event.detail.alarmName);

          // The parser finds the metricStat entry
          const metricStatEntry = event.detail.configuration.metrics!.find(m => m.metricStat != null)!;
          expect(result.namespace).toBe(metricStatEntry.metricStat!.metric.namespace);
          expect(result.metricName).toBe(metricStatEntry.metricStat!.metric.name);
          expect(result.dimensions).toEqual(metricStatEntry.metricStat!.metric.dimensions);
          expect(result.stateChangeTimestamp).toBe(event.detail.state.timestamp);
          expect(result.accountId).toBe(event.account);
          expect(result.region).toBe(event.region);

          // Anomaly detection uses evaluatedDatapoints for currentValue
          const reasonData = JSON.parse(event.detail.state.reasonData!);
          expect(result.threshold).toBe(reasonData.threshold);
          expect(result.currentValue).toBe(reasonData.evaluatedDatapoints[0].value);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Composite alarms', () => {
    it('should extract alarmName and timestamps with empty metric fields for composite alarms', () => {
      fc.assert(
        fc.property(arbCompositeAlarmEvent, (event: AlarmRouterInput) => {
          const result = parseAlarmEvent(event);
          expect(result.filtered).toBe(false);
          expect(result.alarmName).toBe(event.detail.alarmName);
          expect(result.stateChangeTimestamp).toBe(event.detail.state.timestamp);
          expect(result.accountId).toBe(event.account);
          expect(result.region).toBe(event.region);

          // Composite alarms have no metric info
          expect(result.namespace).toBe('');
          expect(result.metricName).toBe('');
          expect(result.dimensions).toEqual({});
          expect(result.threshold).toBe(0);
          expect(result.currentValue).toBe(0);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('All alarm types combined', () => {
    it('should always extract alarmName and stateChangeTimestamp correctly for any valid alarm type', () => {
      fc.assert(
        fc.property(arbAnyValidAlarmEvent, (event: AlarmRouterInput) => {
          const result = parseAlarmEvent(event);
          expect(result.filtered).toBe(false);
          expect(result.alarmName).toBe(event.detail.alarmName);
          expect(result.stateChangeTimestamp).toBe(event.detail.state.timestamp);
          expect(result.accountId).toBe(event.account);
          expect(result.region).toBe(event.region);
        }),
        { numRuns: 100 }
      );
    });
  });
});
