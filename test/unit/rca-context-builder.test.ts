import { buildRCAContext, DevOpsAgentRequest } from '../../src/lambdas/rca-analyzer/context-builder';
import { AlarmRouterOutput } from '../../src/shared/types';

function makeAlarm(overrides: Partial<AlarmRouterOutput> = {}): AlarmRouterOutput {
  return {
    alarmId: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:TestAlarm',
    alarmName: 'TestAlarm',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-1234567890abcdef0' },
    threshold: 80,
    currentValue: 95,
    stateChangeTimestamp: '2024-01-15T10:30:00.000Z',
    previousState: 'OK',
    accountId: '123456789012',
    region: 'us-east-1',
    resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0',
    filtered: false,
    ...overrides,
  };
}

describe('buildRCAContext', () => {
  it('should return investigationType as alarm_response', () => {
    const result = buildRCAContext([makeAlarm()]);
    expect(result.investigationType).toBe('alarm_response');
  });

  it('should collect all unique alarm ARNs', () => {
    const alarms = [
      makeAlarm({ alarmId: 'arn:alarm:1' }),
      makeAlarm({ alarmId: 'arn:alarm:2' }),
      makeAlarm({ alarmId: 'arn:alarm:1' }), // duplicate
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.alarmArns).toEqual(['arn:alarm:1', 'arn:alarm:2']);
  });

  it('should collect all unique resource ARNs and filter out empty strings', () => {
    const alarms = [
      makeAlarm({ resourceArn: 'arn:resource:1' }),
      makeAlarm({ resourceArn: '' }),
      makeAlarm({ resourceArn: 'arn:resource:2' }),
      makeAlarm({ resourceArn: 'arn:resource:1' }), // duplicate
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.resourceArns).toEqual(['arn:resource:1', 'arn:resource:2']);
  });

  it('should set timeRange.start to 1 hour before the earliest alarm', () => {
    const alarms = [
      makeAlarm({ stateChangeTimestamp: '2024-01-15T12:00:00.000Z' }),
      makeAlarm({ stateChangeTimestamp: '2024-01-15T10:00:00.000Z' }), // earliest
      makeAlarm({ stateChangeTimestamp: '2024-01-15T11:00:00.000Z' }),
    ];
    const result = buildRCAContext(alarms);
    // Earliest is 10:00, so start should be 09:00
    expect(result.context.timeRange.start).toBe('2024-01-15T09:00:00.000Z');
  });

  it('should set timeRange.end to the latest alarm timestamp', () => {
    const alarms = [
      makeAlarm({ stateChangeTimestamp: '2024-01-15T12:00:00.000Z' }), // latest
      makeAlarm({ stateChangeTimestamp: '2024-01-15T10:00:00.000Z' }),
      makeAlarm({ stateChangeTimestamp: '2024-01-15T11:00:00.000Z' }),
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.timeRange.end).toBe('2024-01-15T12:00:00.000Z');
  });

  it('should use current time when no valid timestamps exist', () => {
    const before = Date.now();
    const alarms = [makeAlarm({ stateChangeTimestamp: '' })];
    const result = buildRCAContext(alarms);
    const after = Date.now();

    const endTime = new Date(result.context.timeRange.end).getTime();
    expect(endTime).toBeGreaterThanOrEqual(before);
    expect(endTime).toBeLessThanOrEqual(after);

    const startTime = new Date(result.context.timeRange.start).getTime();
    const oneHourMs = 60 * 60 * 1000;
    expect(startTime).toBeGreaterThanOrEqual(before - oneHourMs);
    expect(startTime).toBeLessThanOrEqual(after - oneHourMs);
  });

  it('should build a non-empty additionalContext string', () => {
    const alarms = [makeAlarm()];
    const result = buildRCAContext(alarms);
    expect(result.context.additionalContext).not.toBe('');
    expect(result.context.additionalContext).toContain('TestAlarm');
    expect(result.context.additionalContext).toContain('AWS/EC2');
    expect(result.context.additionalContext).toContain('CPUUtilization');
    expect(result.context.additionalContext).toContain('95');
    expect(result.context.additionalContext).toContain('80');
  });

  it('should include all alarms in the additionalContext', () => {
    const alarms = [
      makeAlarm({ alarmName: 'Alarm-A', namespace: 'AWS/RDS' }),
      makeAlarm({ alarmName: 'Alarm-B', namespace: 'AWS/Lambda' }),
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.additionalContext).toContain('Alarm-A');
    expect(result.context.additionalContext).toContain('Alarm-B');
    expect(result.context.additionalContext).toContain('AWS/RDS');
    expect(result.context.additionalContext).toContain('AWS/Lambda');
  });

  it('should handle a single alarm correctly', () => {
    const alarm = makeAlarm({
      alarmId: 'arn:aws:cloudwatch:us-east-1:123:alarm:Single',
      alarmName: 'SingleAlarm',
      stateChangeTimestamp: '2024-06-01T08:00:00.000Z',
      resourceArn: 'arn:aws:ec2:us-east-1:123:instance/i-abc',
    });
    const result = buildRCAContext([alarm]);

    expect(result.context.alarmArns).toEqual(['arn:aws:cloudwatch:us-east-1:123:alarm:Single']);
    expect(result.context.resourceArns).toEqual(['arn:aws:ec2:us-east-1:123:instance/i-abc']);
    expect(result.context.timeRange.start).toBe('2024-06-01T07:00:00.000Z');
    expect(result.context.timeRange.end).toBe('2024-06-01T08:00:00.000Z');
  });

  it('should handle alarms with no resource ARNs', () => {
    const alarms = [
      makeAlarm({ resourceArn: '' }),
      makeAlarm({ resourceArn: '' }),
    ];
    const result = buildRCAContext(alarms);
    expect(result.context.resourceArns).toEqual([]);
  });

  it('should handle empty alarms array gracefully', () => {
    const result = buildRCAContext([]);
    expect(result.investigationType).toBe('alarm_response');
    expect(result.context.alarmArns).toEqual([]);
    expect(result.context.resourceArns).toEqual([]);
    expect(result.context.additionalContext).toBe('No alarm details available');
  });
});
