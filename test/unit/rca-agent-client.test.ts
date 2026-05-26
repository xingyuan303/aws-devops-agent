/**
 * Tests for the webhook-mode agent-client.
 *
 * The agent-client used to wrap CreateChat + SendMessage. It has been replaced
 * by a webhook trigger:
 *   - GET /secret from Secrets Manager (cached)
 *   - POST payload + HMAC-SHA256 signature to webhook URL
 *   - Treat 2xx as a successful trigger; do NOT wait for investigation completion
 *
 * Investigation results arrive asynchronously via EventBridge events, handled
 * by the InvestigationEventHandler Lambda — that flow is covered separately.
 */

import { DevOpsAgentRequest } from '../../src/lambdas/rca-analyzer/context-builder';
import { URL } from 'url';

// Mock Secrets Manager client BEFORE importing agent-client
const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: mockSecretsSend,
  })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({
    __type: 'GetSecretValueCommand',
    input,
  })),
}));

process.env.DEVOPS_AGENT_WEBHOOK_SECRET_ID =
  'cloudwatch-alarm-auto-rca/devops-agent-webhook';

import {
  triggerDevOpsAgentInvestigation,
  calculateBackoffDelay,
  computeHmacSignature,
  buildWebhookPayload,
  setHttpTransport,
  resetHttpTransport,
  resetCredentialCache,
  AgentClientOptions,
  HttpTransport,
} from '../../src/lambdas/rca-analyzer/agent-client';

const TEST_URL = 'https://event-ai.us-east-1.api.aws/webhook/generic/test-id';
const TEST_SECRET = 'test-secret-base64';

const mockRequest: DevOpsAgentRequest = {
  investigationType: 'alarm_response',
  context: {
    alarmArns: ['arn:aws:cloudwatch:us-east-1:123456789012:alarm:TestAlarm'],
    resourceArns: ['arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890'],
    timeRange: {
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-01-01T01:00:00.000Z',
    },
    additionalContext: 'Test alarm context',
  },
};

function mockSecretValue(value: { url: string; secret: string }) {
  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify(value),
  });
}

// ---------------------------------------------------------------------------
// calculateBackoffDelay (pure helper, kept for backwards compatibility)
// ---------------------------------------------------------------------------

describe('calculateBackoffDelay', () => {
  it('returns initialDelay for attempt 1', () => {
    expect(calculateBackoffDelay(1, 5000, 2)).toBe(5000);
  });
  it('returns initialDelay * multiplier for attempt 2', () => {
    expect(calculateBackoffDelay(2, 5000, 2)).toBe(10000);
  });
  it('returns initialDelay * multiplier^2 for attempt 3', () => {
    expect(calculateBackoffDelay(3, 5000, 2)).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// computeHmacSignature (pure helper)
// ---------------------------------------------------------------------------

describe('computeHmacSignature', () => {
  it('produces a stable base64 SHA-256 HMAC over `${ts}:${payload}`', () => {
    const sig = computeHmacSignature('hello', '2024-01-01T00:00:00Z', 'secret');
    // Recompute with crypto directly to make sure the format matches the doc.
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', 'secret')
      .update('2024-01-01T00:00:00Z:hello', 'utf8')
      .digest('base64');
    expect(sig).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// buildWebhookPayload
// ---------------------------------------------------------------------------

describe('buildWebhookPayload', () => {
  it('includes a stable, unique-per-trigger incidentId', () => {
    const ts1 = '2024-01-01T00:00:00.000Z';
    const ts2 = '2024-01-01T00:00:01.000Z';
    const p1 = buildWebhookPayload(mockRequest, 'group-A', ts1);
    const p2 = buildWebhookPayload(mockRequest, 'group-A', ts2);
    expect(p1.incidentId).toMatch(/^cw-alarm-group-A-/);
    expect(p2.incidentId).toMatch(/^cw-alarm-group-A-/);
    expect(p1.incidentId).not.toBe(p2.incidentId);
  });

  it('serializes alarm ARNs / resource ARNs / time range into data.metadata', () => {
    const payload = buildWebhookPayload(mockRequest, 'g1', '2024-01-01T00:00:00.000Z');
    expect(payload.data.metadata.alarmArns).toEqual(mockRequest.context.alarmArns);
    expect(payload.data.metadata.resourceArns).toEqual(mockRequest.context.resourceArns);
    expect(payload.data.metadata.timeRange).toEqual(mockRequest.context.timeRange);
    expect(payload.data.metadata.groupId).toBe('g1');
  });

  it('uses HIGH priority and the eventType "incident" with action "created"', () => {
    const payload = buildWebhookPayload(mockRequest, 'g', '2024-01-01T00:00:00.000Z');
    expect(payload.eventType).toBe('incident');
    expect(payload.action).toBe('created');
    expect(payload.priority).toBe('HIGH');
  });
});

// ---------------------------------------------------------------------------
// triggerDevOpsAgentInvestigation
// ---------------------------------------------------------------------------

describe('triggerDevOpsAgentInvestigation', () => {
  let httpCalls: Array<{ url: URL; body: string; headers: Record<string, string> }>;

  beforeEach(() => {
    mockSecretsSend.mockReset();
    resetCredentialCache();
    httpCalls = [];
  });

  afterEach(() => {
    resetHttpTransport();
  });

  function installTransport(
    impl: (call: number) => Promise<{ statusCode: number; body: string }>
  ) {
    let n = 0;
    const transport: HttpTransport = async (url, body, headers) => {
      httpCalls.push({ url, body, headers });
      const result = await impl(n);
      n++;
      return result;
    };
    setHttpTransport(transport);
  }

  it('returns success when webhook responds 200', async () => {
    mockSecretValue({ url: TEST_URL, secret: TEST_SECRET });
    installTransport(async () => ({ statusCode: 200, body: 'webhook received' }));

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 1,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.incidentId).toMatch(/^cw-alarm-g1-/);
    expect(result.triggeredAt).toBeDefined();
    expect(httpCalls).toHaveLength(1);
  });

  it('signs the request with HMAC-SHA256 over `${timestamp}:${body}`', async () => {
    mockSecretValue({ url: TEST_URL, secret: TEST_SECRET });
    installTransport(async () => ({ statusCode: 200, body: 'ok' }));

    await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 1,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    const call = httpCalls[0];
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['x-amzn-event-timestamp']).toBeDefined();
    expect(call.headers['x-amzn-event-signature']).toBeDefined();

    const expected = computeHmacSignature(
      call.body,
      call.headers['x-amzn-event-timestamp'],
      TEST_SECRET
    );
    expect(call.headers['x-amzn-event-signature']).toBe(expected);
  });

  it('retries on 5xx and succeeds on a subsequent attempt', async () => {
    mockSecretValue({ url: TEST_URL, secret: TEST_SECRET });
    installTransport(async (n) => {
      if (n === 0) return { statusCode: 503, body: 'busy' };
      return { statusCode: 200, body: 'ok' };
    });

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 3,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(httpCalls).toHaveLength(2);
  });

  it('does NOT retry on 400-class errors (except 429)', async () => {
    mockSecretValue({ url: TEST_URL, secret: TEST_SECRET });
    installTransport(async () => ({ statusCode: 401, body: 'bad signature' }));

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 3,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(httpCalls).toHaveLength(1);
  });

  it('retries on 429 (rate limit)', async () => {
    mockSecretValue({ url: TEST_URL, secret: TEST_SECRET });
    installTransport(async (n) => {
      if (n === 0) return { statusCode: 429, body: 'slow down' };
      return { statusCode: 200, body: 'ok' };
    });

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 3,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(httpCalls.length).toBe(2);
  });

  it('returns failure after all retries are exhausted', async () => {
    mockSecretValue({ url: TEST_URL, secret: TEST_SECRET });
    installTransport(async () => ({ statusCode: 503, body: 'still busy' }));

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 3,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed after 3 attempts');
    expect(httpCalls).toHaveLength(3);
  });

  it('reports timedOut on transport TIMEOUT error', async () => {
    mockSecretValue({ url: TEST_URL, secret: TEST_SECRET });
    installTransport(async () => {
      throw new Error('TIMEOUT');
    });

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 1,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 50,
    });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('timed out');
  });

  it('returns failure when DEVOPS_AGENT_WEBHOOK_SECRET_ID is unset', async () => {
    const old = process.env.DEVOPS_AGENT_WEBHOOK_SECRET_ID;
    delete process.env.DEVOPS_AGENT_WEBHOOK_SECRET_ID;
    resetCredentialCache();
    try {
      const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
        maxRetries: 1,
        initialDelayMs: 1,
        backoffMultiplier: 2,
        timeoutMs: 5000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('DEVOPS_AGENT_WEBHOOK_SECRET_ID');
    } finally {
      process.env.DEVOPS_AGENT_WEBHOOK_SECRET_ID = old;
      resetCredentialCache();
    }
  });

  it('returns failure when secret is not valid JSON', async () => {
    mockSecretsSend.mockResolvedValue({ SecretString: 'not-json' });
    installTransport(async () => ({ statusCode: 200, body: 'ok' }));

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 1,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not valid JSON');
    expect(httpCalls).toHaveLength(0);
  });

  it('returns failure when secret JSON is missing url/secret keys', async () => {
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({ url: TEST_URL }),
    });
    installTransport(async () => ({ statusCode: 200, body: 'ok' }));

    const result = await triggerDevOpsAgentInvestigation(mockRequest, 'g1', {
      maxRetries: 1,
      initialDelayMs: 1,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('must contain');
  });
});
