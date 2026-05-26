/**
 * Integration test: EventBridge rule matching logic.
 *
 * Validates that the EventBridge rule defined in the CDK stack correctly
 * matches CloudWatch Alarm State Change events that are entering the ALARM
 * state, and ignores all other events.
 *
 * Approach:
 * 1. Synthesize the CDK stack to extract the actual EventPattern.
 * 2. Implement a minimal AWS EventBridge pattern matcher (the relevant
 *    subset: array-of-allowed-values matching at every leaf).
 * 3. Run a battery of representative events through the matcher.
 *
 * Validates: Requirements 1.1
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CloudwatchAlarmAutoRcaStack } from '../../lib/cloudwatch-alarm-auto-rca-stack';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface ExtractedRule {
  eventPattern: any;
  hasStateMachineTarget: boolean;
}

function extractAlarmRule(): ExtractedRule {
  const app = new cdk.App();
  const stack = new CloudwatchAlarmAutoRcaStack(app, 'EventBridgeTestStack');
  const template = Template.fromStack(stack);

  const rules = template.findResources('AWS::Events::Rule');
  // Find the rule that matches CloudWatch alarm events (filter out any other rules).
  const matched = Object.values(rules).find((r: any) => {
    const detailType = r.Properties?.EventPattern?.['detail-type'];
    return Array.isArray(detailType) && detailType.includes('CloudWatch Alarm State Change');
  }) as any;

  if (!matched) {
    throw new Error('CloudWatch alarm EventBridge rule not found in synthesized template');
  }

  const targets = matched.Properties.Targets ?? [];
  // Step Functions state machine targets carry an Arn that resolves via Ref/Fn::GetAtt.
  // We just confirm at least one target exists; downstream wiring is covered by cdk-stack.test.ts.
  return {
    eventPattern: matched.Properties.EventPattern,
    hasStateMachineTarget: targets.length > 0,
  };
}

/**
 * Minimal EventBridge pattern matcher.
 *
 * Implements only the matching semantics actually used by the alarm rule:
 *   - At every level the pattern is a plain object whose keys must be present
 *     in the event.
 *   - Leaf values in the pattern are arrays. The corresponding event value
 *     must equal one of the array elements.
 *
 * If the pattern grows to use anything-but / numeric / prefix matchers we will
 * need to extend this. For now the alarm rule only uses array-equality.
 */
function matchesEventPattern(event: any, pattern: any): boolean {
  if (Array.isArray(pattern)) {
    // Leaf: event value must equal one of the allowed values.
    return pattern.includes(event);
  }
  if (pattern === null || typeof pattern !== 'object') {
    // Non-array leaves are not part of the alarm rule grammar.
    throw new Error(`Unsupported pattern leaf: ${JSON.stringify(pattern)}`);
  }
  if (event === null || typeof event !== 'object') {
    return false;
  }
  for (const key of Object.keys(pattern)) {
    if (!(key in event)) return false;
    if (!matchesEventPattern((event as any)[key], (pattern as any)[key])) {
      return false;
    }
  }
  return true;
}

function buildAlarmEvent(opts: {
  source?: string;
  detailType?: string;
  stateValue?: string;
}): any {
  return {
    version: '0',
    id: 'test-event-id',
    source: opts.source ?? 'aws.cloudwatch',
    'detail-type': opts.detailType ?? 'CloudWatch Alarm State Change',
    account: '123456789012',
    time: '2024-01-15T10:00:00Z',
    region: 'us-east-1',
    resources: ['arn:aws:cloudwatch:us-east-1:123456789012:alarm:Test'],
    detail: {
      alarmName: 'Test',
      state: {
        value: opts.stateValue ?? 'ALARM',
        reason: 'Threshold Crossed',
        timestamp: '2024-01-15T10:00:00Z',
      },
      previousState: {
        value: 'OK',
        reason: 'Below threshold',
        timestamp: '2024-01-15T09:55:00Z',
      },
      configuration: {},
    },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Integration: EventBridge rule matching (Requirements 1.1)', () => {
  let rule: ExtractedRule;

  beforeAll(() => {
    rule = extractAlarmRule();
  });

  describe('Synthesized rule shape', () => {
    it('should match aws.cloudwatch as source', () => {
      expect(rule.eventPattern.source).toEqual(['aws.cloudwatch']);
    });

    it('should match CloudWatch Alarm State Change as detail-type', () => {
      expect(rule.eventPattern['detail-type']).toEqual(['CloudWatch Alarm State Change']);
    });

    it('should constrain detail.state.value to ALARM only', () => {
      expect(rule.eventPattern.detail).toBeDefined();
      expect(rule.eventPattern.detail.state).toBeDefined();
      expect(rule.eventPattern.detail.state.value).toEqual(['ALARM']);
    });

    it('should have a Step Functions state machine as target', () => {
      expect(rule.hasStateMachineTarget).toBe(true);
    });
  });

  describe('Pattern matcher correctness on synthesized rule', () => {
    it('should accept a typical ALARM state change event', () => {
      const event = buildAlarmEvent({});
      expect(matchesEventPattern(event, rule.eventPattern)).toBe(true);
    });

    it('should reject events transitioning to OK', () => {
      const event = buildAlarmEvent({ stateValue: 'OK' });
      expect(matchesEventPattern(event, rule.eventPattern)).toBe(false);
    });

    it('should reject events transitioning to INSUFFICIENT_DATA', () => {
      const event = buildAlarmEvent({ stateValue: 'INSUFFICIENT_DATA' });
      expect(matchesEventPattern(event, rule.eventPattern)).toBe(false);
    });

    it('should reject events from non-CloudWatch sources', () => {
      const event = buildAlarmEvent({ source: 'aws.ec2' });
      expect(matchesEventPattern(event, rule.eventPattern)).toBe(false);
    });

    it('should reject events with a different detail-type', () => {
      const event = buildAlarmEvent({ detailType: 'EC2 Instance State-change Notification' });
      expect(matchesEventPattern(event, rule.eventPattern)).toBe(false);
    });

    it('should reject events with missing detail.state', () => {
      const event = buildAlarmEvent({});
      delete event.detail.state;
      expect(matchesEventPattern(event, rule.eventPattern)).toBe(false);
    });

    it('should reject events with missing detail entirely', () => {
      const event = buildAlarmEvent({});
      delete event.detail;
      expect(matchesEventPattern(event, rule.eventPattern)).toBe(false);
    });

    it('should accept events for any region/account when state.value is ALARM', () => {
      const eventA = { ...buildAlarmEvent({}), region: 'eu-west-1', account: '999999999999' };
      const eventB = { ...buildAlarmEvent({}), region: 'us-west-2', account: '111111111111' };
      expect(matchesEventPattern(eventA, rule.eventPattern)).toBe(true);
      expect(matchesEventPattern(eventB, rule.eventPattern)).toBe(true);
    });
  });
});
