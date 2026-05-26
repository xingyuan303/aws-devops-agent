import { formatFeishuCard, isMitigationOnlyReport } from '../../src/lambdas/feishu-notifier/card-formatter';
import { RCAReport } from '../../src/shared/types';

function createMockReport(overrides?: Partial<RCAReport>): RCAReport {
  return {
    reportId: 'rpt-001',
    groupId: 'grp-001',
    generatedAt: '2024-01-15T10:30:00Z',
    status: 'completed',
    alarmSummary: {
      alarmCount: 2,
      alarms: [
        {
          alarmName: 'HighCPUAlarm',
          namespace: 'AWS/EC2',
          metricName: 'CPUUtilization',
          currentValue: 95,
          threshold: 80,
          resource: 'i-1234567890abcdef0',
        },
        {
          alarmName: 'HighMemoryAlarm',
          namespace: 'AWS/EC2',
          metricName: 'MemoryUtilization',
          currentValue: 92,
          threshold: 85,
          resource: 'i-1234567890abcdef0',
        },
      ],
      firstAlarmTime: '2024-01-15T10:25:00Z',
      lastAlarmTime: '2024-01-15T10:26:00Z',
    },
    investigation: {
      timeline: [
        { timestamp: '2024-01-15T10:25:00Z', action: 'Check metrics', finding: 'CPU spike' },
      ],
      dataSourcesConsulted: ['CloudWatch', 'CloudTrail'],
      hypothesesExplored: ['Deployment change', 'Traffic spike'],
    },
    rootCause: {
      summary: 'A recent deployment increased memory consumption causing CPU contention.',
      category: 'system_change',
      details: 'Deployment at 10:20 introduced a memory leak in the application.',
      confidence: 'high',
      affectedResources: ['arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0'],
    },
    remediation: {
      immediateMitigation: 'Rollback the latest deployment.',
      longTermFix: 'Fix the memory leak in the application code.',
      steps: ['Rollback deployment v2.3.1', 'Monitor CPU and memory', 'Apply hotfix v2.3.2'],
    },
    ...overrides,
  };
}

describe('formatFeishuCard', () => {
  describe('rca_complete notification', () => {
    it('should use red template for high confidence', () => {
      const report = createMockReport({ rootCause: { ...createMockReport().rootCause, confidence: 'high' } });
      const card = formatFeishuCard(report, 'rca_complete');

      expect(card.msg_type).toBe('interactive');
      expect(card.card.header.template).toBe('red');
      expect(card.card.header.title.tag).toBe('plain_text');
      expect(card.card.header.title.content).toContain('根因分析完成');
    });

    it('should use orange template for medium confidence', () => {
      const report = createMockReport({
        rootCause: { ...createMockReport().rootCause, confidence: 'medium' },
      });
      const card = formatFeishuCard(report, 'rca_complete');

      expect(card.card.header.template).toBe('orange');
    });

    it('should use green template for low confidence', () => {
      const report = createMockReport({
        rootCause: { ...createMockReport().rootCause, confidence: 'low' },
      });
      const card = formatFeishuCard(report, 'rca_complete');

      expect(card.card.header.template).toBe('green');
    });

    it('should include all required elements: alarm names, resources, root cause, remediation, link', () => {
      const report = createMockReport();
      const card = formatFeishuCard(report, 'rca_complete');
      const elements = card.card.elements;
      const textContent = elements
        .filter((e) => e.text)
        .map((e) => e.text!.content)
        .join('\n');

      // Alarm names
      expect(textContent).toContain('HighCPUAlarm');
      expect(textContent).toContain('HighMemoryAlarm');

      // Affected resources
      expect(textContent).toContain('arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0');

      // Root cause summary
      expect(textContent).toContain('A recent deployment increased memory consumption');

      // Remediation steps
      expect(textContent).toContain('Rollback deployment v2.3.1');

      // Link button
      const actionElement = elements.find((e) => e.tag === 'action');
      expect(actionElement).toBeDefined();
      expect(actionElement!.actions![0].url).toContain('console.aws.amazon.com/cloudwatch');
    });
  });

  describe('rca_timeout notification', () => {
    it('should use orange template', () => {
      const report = createMockReport({ status: 'timeout' });
      const card = formatFeishuCard(report, 'rca_timeout');

      expect(card.card.header.template).toBe('orange');
      expect(card.card.header.title.content).toContain('超时');
    });

    it('should include timeout status message', () => {
      const report = createMockReport({ status: 'timeout' });
      const card = formatFeishuCard(report, 'rca_timeout');
      const textContent = card.card.elements
        .filter((e) => e.text)
        .map((e) => e.text!.content)
        .join('\n');

      expect(textContent).toContain('超时');
    });

    it('should still include alarm names, resources, and link', () => {
      const report = createMockReport({ status: 'timeout' });
      const card = formatFeishuCard(report, 'rca_timeout');
      const elements = card.card.elements;
      const textContent = elements.filter((e) => e.text).map((e) => e.text!.content).join('\n');

      expect(textContent).toContain('HighCPUAlarm');
      expect(textContent).toContain('arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0');

      const actionElement = elements.find((e) => e.tag === 'action');
      expect(actionElement).toBeDefined();
    });
  });

  describe('rca_partial notification', () => {
    it('should use orange template', () => {
      const report = createMockReport({ status: 'partial' });
      const card = formatFeishuCard(report, 'rca_partial');

      expect(card.card.header.template).toBe('orange');
      expect(card.card.header.title.content).toContain('部分完成');
    });

    it('should include partial status message', () => {
      const report = createMockReport({ status: 'partial' });
      const card = formatFeishuCard(report, 'rca_partial');
      const textContent = card.card.elements
        .filter((e) => e.text)
        .map((e) => e.text!.content)
        .join('\n');

      expect(textContent).toContain('部分完成');
    });

    it('should include alarm names, resources, root cause, remediation, and link', () => {
      const report = createMockReport({ status: 'partial' });
      const card = formatFeishuCard(report, 'rca_partial');
      const elements = card.card.elements;
      const textContent = elements.filter((e) => e.text).map((e) => e.text!.content).join('\n');

      expect(textContent).toContain('HighCPUAlarm');
      expect(textContent).toContain('arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0');
      expect(textContent).toContain('A recent deployment increased memory consumption');
      expect(textContent).toContain('Rollback deployment v2.3.1');

      const actionElement = elements.find((e) => e.tag === 'action');
      expect(actionElement).toBeDefined();
      expect(actionElement!.actions![0].url).toContain('console.aws.amazon.com/cloudwatch');
    });
  });
});

describe('phase-2 mitigation card (reportPhase = "mitigation")', () => {
  function createMitigationReport(overrides?: Partial<RCAReport>): RCAReport {
    return {
      ...createMockReport(),
      reportPhase: 'mitigation',
      // Phase 2 reports don't carry these (would belong to phase 1)
      rootCauses: undefined,
      keyFindings: undefined,
      hypothesesDetailed: undefined,
      ...overrides,
    };
  }

  describe('isMitigationOnlyReport', () => {
    it('returns true when reportPhase is explicitly "mitigation"', () => {
      expect(isMitigationOnlyReport(createMitigationReport())).toBe(true);
    });

    it('returns false when reportPhase is explicitly "investigation" — even if mitigationPlan happens to be set', () => {
      const r = createMockReport({
        reportPhase: 'investigation',
        mitigationPlan: [{ step: '...' }],
        rootCauses: undefined,
        keyFindings: undefined,
      });
      expect(isMitigationOnlyReport(r)).toBe(false);
    });

    it('legacy fallback: when reportPhase is unset, infers from mitigationPlan + absence of rootCauses/keyFindings', () => {
      const r = createMockReport({
        reportPhase: undefined,
        mitigationPlan: [{ step: 'Restart' }],
        rootCauses: undefined,
        keyFindings: undefined,
      });
      expect(isMitigationOnlyReport(r)).toBe(true);
    });
  });

  describe('formatFeishuCard for mitigation phase', () => {
    it('renders the mitigation-specific title and a green template on success', () => {
      const card = formatFeishuCard(
        createMitigationReport({ mitigationPlan: [{ step: 'Rollback deployment' }] }),
        'rca_complete'
      );
      expect(card.card.header.title.content).toContain('缓解计划');
      expect(card.card.header.template).toBe('green');
    });

    it('does NOT render Investigation timeline / Root cause sections (those belong to phase 1)', () => {
      const card = formatFeishuCard(
        createMitigationReport({ mitigationPlan: [{ step: 'Rollback' }] }),
        'rca_complete'
      );
      const text = card.card.elements
        .filter((e) => e.text)
        .map((e) => e.text!.content)
        .join('\n');
      expect(text).not.toContain('Investigation timeline');
      expect(text).not.toContain('Root cause');
      expect(text).toContain('Mitigation plan');
    });

    it('falls back to agentRawText when no structured mitigationPlan was parsed', () => {
      const card = formatFeishuCard(
        createMitigationReport({
          mitigationPlan: undefined,
          remediation: {
            immediateMitigation: '',
            longTermFix: '',
            steps: [],
          },
          agentRawText:
            '# Mitigation Summary\n\n## Action\n无需采取缓解措施。\n\n## Reasoning\n这是一次预期的测试行为。',
        }),
        'rca_complete'
      );
      const text = card.card.elements
        .filter((e) => e.text)
        .map((e) => e.text!.content)
        .join('\n');
      // ATX headings should be normalized into bold, and the body content present.
      expect(text).toContain('Action');
      expect(text).toContain('无需采取缓解措施');
      expect(text).toContain('这是一次预期的测试行为');
      // No literal '##' should leak through into the rendered card.
      expect(text).not.toMatch(/^## /m);
    });
  });
});
