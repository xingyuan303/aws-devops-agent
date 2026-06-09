// Frequency-cap unit tests

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockImplementation(() => ({
      send: (...args: any[]) => mockSend(...args),
    })),
  },
  UpdateCommand: jest.fn().mockImplementation((params) => ({ ...params, _type: 'Update' })),
}));

// Table name must be set before importing the module under test.
process.env.FREQUENCY_CAP_TABLE_NAME = 'test-frequency-table';

import { computeDayBucket, checkFrequencyCap } from '../../src/lambdas/alarm-router/frequency-cap';
import { FrequencyCapConfig } from '../../src/shared/types';

const CONFIG: FrequencyCapConfig = { enabled: true, maxPerDay: 3, utcOffsetHours: 8 };

describe('computeDayBucket', () => {
  it('uses the same calendar day before the UTC+8 midnight boundary', () => {
    // 2026-06-10T15:30Z + 8h = 2026-06-10T23:30 (UTC+8) -> still 06-10
    expect(computeDayBucket(new Date('2026-06-10T15:30:00Z'), 8)).toBe('2026-06-10');
  });

  it('rolls to the next day after the UTC+8 midnight boundary', () => {
    // 2026-06-10T16:30Z + 8h = 2026-06-11T00:30 (UTC+8) -> 06-11
    expect(computeDayBucket(new Date('2026-06-10T16:30:00Z'), 8)).toBe('2026-06-11');
  });

  it('respects a different offset', () => {
    // UTC (offset 0): 2026-06-10T16:30Z stays 06-10
    expect(computeDayBucket(new Date('2026-06-10T16:30:00Z'), 0)).toBe('2026-06-10');
  });
});

describe('checkFrequencyCap', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('passes the first maxPerDay occurrences (count <= max)', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { count: 3 } });
    const result = await checkFrequencyCap('alarm-x', CONFIG, new Date('2026-06-10T01:00:00Z'));
    expect(result.capped).toBe(false);
    expect(result.count).toBe(3);
  });

  it('caps occurrences beyond maxPerDay (count > max)', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { count: 4 } });
    const result = await checkFrequencyCap('alarm-x', CONFIG, new Date('2026-06-10T01:00:00Z'));
    expect(result.capped).toBe(true);
    expect(result.count).toBe(4);
  });

  it('atomically increments with ADD and an if_not_exists TTL', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { count: 1 } });
    await checkFrequencyCap('alarm-x', CONFIG, new Date('2026-06-10T01:00:00Z'));
    const sent = mockSend.mock.calls[0][0];
    expect(sent.TableName).toBe('test-frequency-table');
    expect(sent.Key).toEqual({ alarmName: 'alarm-x', dayBucket: '2026-06-10' });
    expect(sent.UpdateExpression).toContain('ADD #count :one');
    expect(sent.UpdateExpression).toContain('if_not_exists(#ttl');
  });

  it('fails open when DynamoDB throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('ddb down'));
    const result = await checkFrequencyCap('alarm-x', CONFIG);
    expect(result.capped).toBe(false);
  });
});
