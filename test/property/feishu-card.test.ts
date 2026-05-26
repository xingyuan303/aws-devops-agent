// Feature: cloudwatch-alarm-auto-rca, Property 10: Feishu card formatting completeness
// Validates: Requirements 4.1, 4.2

import * as fc from 'fast-check';
import { formatFeishuCard, NotificationType } from '../../src/lambdas/feishu-notifier/card-formatter';
import { RCAReport } from '../../src/shared/types';

// --- Arbitrary generators ---

const arbAlarmName = fc.string({ minLength: 1, maxLength: 30 }).map(
  (s) => s.replace(/[^a-zA-Z0-9-_]/g, 'a') || 'alarm'
);

const arbNamespace = fc.constantFrom('AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ECS');

const arbMetricName = fc.constantFrom(
  'CPUUtilization', 'FreeableMemory', 'Duration', 'Errors'
);

const arbResourceArn = fc.constantFrom(
  'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
  'arn:aws:rds:us-east-1:123456789012:db:prod-db',
  'arn:aws:lambda:us-east-1:123456789012:function:my-func'
);

const arbTimestamp = fc.integer({ min: 1700000000000, max: 1710000000000 }).map(
  (ts) => new Date(ts).toISOString()
);

const arbCategory = fc.constantFrom(
  'system_change', 'input_anomaly', 'resource_limit',
  'component_failure', 'dependency_issue', 'unknown'
) as fc.Arbitrary<RCAReport['rootCause']['category']>;

const arbConfidence = fc.constantFrom('high', 'medium', 'low') as fc.Arbitrary<RCAReport['rootCause']['confidence']>;

const arbReportStatus = fc.constantFrom('completed', 'partial', 'timeout') as fc.Arbitrary<RCAReport['status']>;

const arbNotificationType = fc.constantFrom('rca_complete', 'rca_timeout', 'rca_partial') as fc.Arbitrary<NotificationType>;

const arbAlarmSummaryEntry = fc.record({
  alarmName: arbAlarmName,
  namespace: arbNamespace,
  metricName: arbMetricName,
  currentValue: fc.double({ min: 0, max: 2000, noNaN: true }),
  threshold: fc.double({ min: 0, max: 1000, noNaN: true }),
  resource: arbResourceArn,
});

const arbRCAReport: fc.Arbitrary<RCAReport> = fc.record({
  reportId: fc.string({ minLength: 5, maxLength: 36 }).map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'x') || 'rpt-id'),
  groupId: fc.string({ minLength: 5, maxLength: 36 }).map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'x') || 'grp-id'),
  generatedAt: arbTimestamp,
  status: arbReportStatus,
  alarmSummary: fc.record({
    alarmCount: fc.integer({ min: 1, max: 5 }),
    alarms: fc.array(arbAlarmSummaryEntry, { minLength: 1, maxLength: 5 }),
    firstAlarmTime: arbTimestamp,
    lastAlarmTime: arbTimestamp,
  }),
  investigation: fc.record({
    timeline: fc.array(
      fc.record({
        timestamp: arbTimestamp,
        action: fc.string({ minLength: 1, maxLength: 50 }),
        finding: fc.string({ minLength: 1, maxLength: 100 }),
      }),
      { minLength: 1, maxLength: 3 }
    ),
    dataSourcesConsulted: fc.array(fc.constantFrom('CloudWatch', 'CloudTrail', 'X-Ray'), { minLength: 0, maxLength: 3 }),
    hypothesesExplored: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }),
  }),
  rootCause: fc.record({
    summary: fc.string({ minLength: 1, maxLength: 100 }),
    category: arbCategory,
    details: fc.string({ minLength: 1, maxLength: 200 }),
    confidence: arbConfidence,
    affectedResources: fc.array(arbResourceArn, { minLength: 1, maxLength: 3 }),
  }),
  remediation: fc.record({
    immediateMitigation: fc.string({ minLength: 1, maxLength: 100 }),
    longTermFix: fc.string({ minLength: 0, maxLength: 100 }),
    steps: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
  }),
});

describe('Property 10: Feishu card formatting completeness', () => {
  it('card always has a valid header with severity-appropriate color', () => {
    fc.assert(
      fc.property(arbRCAReport, arbNotificationType, (report, notificationType) => {
        const card = formatFeishuCard(report, notificationType);

        expect(card.card.header).toBeDefined();
        expect(card.card.header.template).toBeDefined();
        expect(['red', 'orange', 'green']).toContain(card.card.header.template);
        expect(card.card.header.title.tag).toBe('plain_text');
        expect(card.card.header.title.content.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('card always contains alarm name(s)', () => {
    fc.assert(
      fc.property(arbRCAReport, arbNotificationType, (report, notificationType) => {
        const card = formatFeishuCard(report, notificationType);
        const textContent = card.card.elements
          .filter((e) => e.text)
          .map((e) => e.text!.content)
          .join('\n');

        // At least one alarm name from the report should appear in the card
        const alarmNames = report.alarmSummary.alarms.map((a) => a.alarmName);
        const hasAlarmName = alarmNames.some((name) => textContent.includes(name));
        expect(hasAlarmName).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('card always contains affected resource identifier', () => {
    fc.assert(
      fc.property(arbRCAReport, arbNotificationType, (report, notificationType) => {
        const card = formatFeishuCard(report, notificationType);
        const textContent = card.card.elements
          .filter((e) => e.text)
          .map((e) => e.text!.content)
          .join('\n');

        // Should contain resource info or "未知" placeholder
        const hasResource = report.rootCause.affectedResources.some((r) => textContent.includes(r))
          || textContent.includes('未知');
        expect(hasResource).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('card always contains root cause summary text', () => {
    fc.assert(
      fc.property(arbRCAReport, arbNotificationType, (report, notificationType) => {
        const card = formatFeishuCard(report, notificationType);
        const textContent = card.card.elements
          .filter((e) => e.text)
          .map((e) => e.text!.content)
          .join('\n');

        expect(textContent).toContain(report.rootCause.summary);
      }),
      { numRuns: 100 }
    );
  });

  it('card always contains at least one remediation suggestion', () => {
    fc.assert(
      fc.property(arbRCAReport, arbNotificationType, (report, notificationType) => {
        const card = formatFeishuCard(report, notificationType);
        const textContent = card.card.elements
          .filter((e) => e.text)
          .map((e) => e.text!.content)
          .join('\n');

        // Should contain either a step or the immediateMitigation
        const hasRemediation = report.remediation.steps.some((s) => textContent.includes(s))
          || textContent.includes(report.remediation.immediateMitigation);
        expect(hasRemediation).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('card always contains a link URL', () => {
    fc.assert(
      fc.property(arbRCAReport, arbNotificationType, (report, notificationType) => {
        const card = formatFeishuCard(report, notificationType);

        // Find the action element with a button containing a URL
        const actionElement = card.card.elements.find((e) => e.tag === 'action');
        expect(actionElement).toBeDefined();
        expect(actionElement!.actions).toBeDefined();
        expect(actionElement!.actions!.length).toBeGreaterThan(0);
        expect(actionElement!.actions![0].url).toBeDefined();
        expect(actionElement!.actions![0].url!.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });

  it('card msg_type is always "interactive"', () => {
    fc.assert(
      fc.property(arbRCAReport, arbNotificationType, (report, notificationType) => {
        const card = formatFeishuCard(report, notificationType);
        expect(card.msg_type).toBe('interactive');
      }),
      { numRuns: 100 }
    );
  });
});
