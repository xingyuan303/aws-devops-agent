/**
 * Unit tests for markdownToLarkMd (the small markdown→lark_md adapter the
 * Feishu bot uses to render Agent-produced summaries inside interactive cards).
 *
 * lark_md doesn't support ATX heading syntax (`#`, `##`, ...), so we rewrite
 * each heading line as a bolded text line with a depth-indicating prefix
 * emoji. Every other markdown construct is preserved verbatim because lark_md
 * already renders it correctly.
 */
import { markdownToLarkMd } from '../../src/lambdas/feishu-bot/index';

describe('markdownToLarkMd', () => {
  it('returns empty string for empty / null / undefined input', () => {
    expect(markdownToLarkMd('')).toBe('');
    // @ts-expect-error — exercise runtime null guard
    expect(markdownToLarkMd(null)).toBe('');
    // @ts-expect-error — exercise runtime undefined guard
    expect(markdownToLarkMd(undefined)).toBe('');
  });

  it('rewrites # / ## / ### / #### to bold lines with emoji prefix', () => {
    const input = `# Mitigation Summary
## Action
### Step 1
#### 1.1 sub-step`;
    const out = markdownToLarkMd(input);
    expect(out).toContain('**📌 Mitigation Summary**');
    expect(out).toContain('**🔹 Action**');
    expect(out).toContain('**▸ Step 1**');
    expect(out).toContain('**· 1.1 sub-step**');
    // No raw # left
    expect(out).not.toMatch(/^#/m);
  });

  it('preserves bold, code, lists, links, fenced code blocks verbatim', () => {
    const input = [
      '**bold text** and `inline code`',
      '- list item 1',
      '- list item 2',
      '[link](https://example.com)',
      '```bash',
      'aws cloudwatch describe-alarms',
      '```',
    ].join('\n');
    expect(markdownToLarkMd(input)).toBe(input);
  });

  it('does not touch a line that contains # mid-line (e.g. a comment in code)', () => {
    const input = 'echo "hello # world"';
    expect(markdownToLarkMd(input)).toBe(input);
  });

  it('handles realistic mitigation summary similar to user screenshot', () => {
    const input = `# Mitigation Summary

## Action
调整 CloudWatch 告警 EC2-HighCPU-Test 的配置参数以减少误报

## Reasoning
调查发现 EC2 实例 i-xxx 的 CloudWatch 告警 EC2-HighCPU-Test 配置过于敏感。

## Execution Plan

### Step 1: Prepare

#### 1.1 aws cloudwatch describe-alarms

**Type:** command
\`\`\`
aws cloudwatch describe-alarms --alarm-names EC2-HighCPU-Test --region us-east-1
\`\`\`
**Purpose:** 记录当前告警配置`;

    const out = markdownToLarkMd(input);
    expect(out).toContain('**📌 Mitigation Summary**');
    expect(out).toContain('**🔹 Action**');
    expect(out).toContain('**🔹 Reasoning**');
    expect(out).toContain('**🔹 Execution Plan**');
    expect(out).toContain('**▸ Step 1: Prepare**');
    expect(out).toContain('**· 1.1 aws cloudwatch describe-alarms**');
    // Bold and code preserved
    expect(out).toContain('**Type:** command');
    expect(out).toContain('aws cloudwatch describe-alarms --alarm-names');
  });
});
