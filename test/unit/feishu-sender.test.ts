import { FeishuCardMessage } from '../../src/shared/types';
import {
  sendFeishuMessage,
  sendToMultipleWebhooks,
  writeToDeadLetter,
  setDynamoDBClient,
  SendResult,
  FailedNotification,
} from '../../src/lambdas/feishu-notifier/sender';

// Mock http/https modules
jest.mock('http', () => ({
  request: jest.fn(),
}));
jest.mock('https', () => ({
  request: jest.fn(),
}));

// Mock crypto.randomUUID
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'test-uuid-1234'),
}));

// Helper to create a mock Feishu card message
function createMockMessage(): FeishuCardMessage {
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: 'Test Alert' },
        template: 'red',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**Test content**' },
        },
      ],
    },
  };
}

// Helper to set up http mock for successful response
function mockHttpSuccess(responseBody: string = '{"code":0,"msg":"success"}') {
  const https = require('https');
  https.request.mockImplementation((_options: any, callback: any) => {
    const res = {
      statusCode: 200,
      on: jest.fn((event: string, handler: any) => {
        if (event === 'data') {
          handler(responseBody);
        }
        if (event === 'end') {
          handler();
        }
      }),
    };
    callback(res);
    return {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
  });
}

// Helper to set up http mock for failure response
function mockHttpFailure(statusCode: number = 500, body: string = 'Internal Server Error') {
  const https = require('https');
  https.request.mockImplementation((_options: any, callback: any) => {
    const res = {
      statusCode,
      on: jest.fn((event: string, handler: any) => {
        if (event === 'data') {
          handler(body);
        }
        if (event === 'end') {
          handler();
        }
      }),
    };
    callback(res);
    return {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
  });
}

// Helper to set up http mock for network error
function mockHttpNetworkError(errorMessage: string = 'ECONNREFUSED') {
  const https = require('https');
  https.request.mockImplementation((_options: any, _callback: any) => {
    const req = {
      on: jest.fn((event: string, handler: any) => {
        if (event === 'error') {
          // Store the error handler and call it asynchronously
          setTimeout(() => handler(new Error(errorMessage)), 0);
        }
      }),
      write: jest.fn(),
      end: jest.fn(),
    };
    return req;
  });
}

// Helper to mock http with sequence of responses (success/failure)
function mockHttpSequence(responses: Array<{ success: boolean; statusCode?: number; body?: string }>) {
  const https = require('https');
  let callIndex = 0;
  https.request.mockImplementation((_options: any, callback: any) => {
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;

    if (response.success) {
      const res = {
        statusCode: response.statusCode || 200,
        on: jest.fn((event: string, handler: any) => {
          if (event === 'data') {
            handler(response.body || '{"code":0,"msg":"success"}');
          }
          if (event === 'end') {
            handler();
          }
        }),
      };
      callback(res);
    } else {
      const res = {
        statusCode: response.statusCode || 500,
        on: jest.fn((event: string, handler: any) => {
          if (event === 'data') {
            handler(response.body || 'Server Error');
          }
          if (event === 'end') {
            handler();
          }
        }),
      };
      callback(res);
    }

    return {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
  });
}

describe('Feishu Sender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('sendFeishuMessage', () => {
    it('should successfully send a message on first attempt', async () => {
      mockHttpSuccess();
      const message = createMockMessage();

      const resultPromise = sendFeishuMessage('https://open.feishu.cn/open-apis/bot/v2/hook/test-token', message, {
        maxRetries: 3,
        retryIntervalMs: 100,
      });

      jest.runAllTimers();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.webhookUrl).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/test-token');
      expect(result.retryCount).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it('should retry on failure then succeed', async () => {
      // First call fails, second succeeds
      mockHttpSequence([
        { success: false, statusCode: 500, body: 'Server Error' },
        { success: true, body: '{"code":0,"msg":"success"}' },
      ]);

      const message = createMockMessage();

      const resultPromise = sendFeishuMessage('https://open.feishu.cn/open-apis/bot/v2/hook/test-token', message, {
        maxRetries: 3,
        retryIntervalMs: 100,
      });

      // Advance timers to allow retry interval to pass
      await jest.advanceTimersByTimeAsync(200);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should return failure when all retries are exhausted', async () => {
      mockHttpFailure(503, 'Service Unavailable');

      const message = createMockMessage();

      const resultPromise = sendFeishuMessage('https://open.feishu.cn/open-apis/bot/v2/hook/test-token', message, {
        maxRetries: 3,
        retryIntervalMs: 100,
      });

      // Advance timers to allow all retries
      await jest.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.retryCount).toBe(2);
      expect(result.error).toContain('All 3 attempts failed');
      expect(result.error).toContain('HTTP 503');
    });

    it('should use default options when none provided', async () => {
      mockHttpSuccess();
      const message = createMockMessage();

      const resultPromise = sendFeishuMessage('https://open.feishu.cn/open-apis/bot/v2/hook/test-token', message);

      jest.runAllTimers();
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(0);
    });

    it('should handle Feishu API error codes in response body', async () => {
      const https = require('https');
      https.request.mockImplementation((_options: any, callback: any) => {
        const res = {
          statusCode: 200,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'data') {
              handler('{"code":9499,"msg":"invalid webhook"}');
            }
            if (event === 'end') {
              handler();
            }
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const message = createMockMessage();

      const resultPromise = sendFeishuMessage('https://open.feishu.cn/open-apis/bot/v2/hook/test-token', message, {
        maxRetries: 2,
        retryIntervalMs: 100,
      });

      await jest.advanceTimersByTimeAsync(300);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Feishu API error');
    });
  });

  describe('sendToMultipleWebhooks', () => {
    it('should send to all webhooks and track results', async () => {
      // First webhook succeeds, second fails
      const https = require('https');
      let callCount = 0;
      https.request.mockImplementation((_options: any, callback: any) => {
        callCount++;
        const isFirst = callCount <= 1; // First call for first webhook

        const res = {
          statusCode: isFirst ? 200 : 500,
          on: jest.fn((event: string, handler: any) => {
            if (event === 'data') {
              handler(isFirst ? '{"code":0,"msg":"success"}' : 'Server Error');
            }
            if (event === 'end') {
              handler();
            }
          }),
        };
        callback(res);
        return {
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(),
        };
      });

      const message = createMockMessage();
      const webhookUrls = [
        'https://open.feishu.cn/open-apis/bot/v2/hook/token-1',
        'https://open.feishu.cn/open-apis/bot/v2/hook/token-2',
      ];

      const resultPromise = sendToMultipleWebhooks(webhookUrls, message, {
        maxRetries: 1,
        retryIntervalMs: 100,
      });

      await jest.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.sentTo).toContain('https://open.feishu.cn/open-apis/bot/v2/hook/token-1');
      expect(result.failedTo).toContain('https://open.feishu.cn/open-apis/bot/v2/hook/token-2');
    });

    it('should return all sent when all succeed', async () => {
      mockHttpSuccess();

      const message = createMockMessage();
      const webhookUrls = [
        'https://open.feishu.cn/open-apis/bot/v2/hook/token-1',
        'https://open.feishu.cn/open-apis/bot/v2/hook/token-2',
      ];

      const resultPromise = sendToMultipleWebhooks(webhookUrls, message, {
        maxRetries: 3,
        retryIntervalMs: 100,
      });

      jest.runAllTimers();
      const result = await resultPromise;

      expect(result.sentTo).toHaveLength(2);
      expect(result.failedTo).toHaveLength(0);
      expect(result.totalRetryCount).toBe(0);
    });

    it('should handle empty webhook list', async () => {
      const message = createMockMessage();

      const resultPromise = sendToMultipleWebhooks([], message);

      jest.runAllTimers();
      const result = await resultPromise;

      expect(result.sentTo).toHaveLength(0);
      expect(result.failedTo).toHaveLength(0);
      expect(result.totalRetryCount).toBe(0);
    });
  });

  describe('writeToDeadLetter', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv, DEAD_LETTER_TABLE_NAME: 'test-dead-letter-table' };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should write failed notification to DynamoDB', async () => {
      const mockSend = jest.fn().mockResolvedValue({});
      const mockClient = { send: mockSend } as any;
      setDynamoDBClient(mockClient);

      const failedNotification: FailedNotification = {
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
        message: createMockMessage(),
        error: 'All 3 attempts failed',
      };

      await writeToDeadLetter(failedNotification);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const putCommand = mockSend.mock.calls[0][0];
      expect(putCommand.input.TableName).toBe('test-dead-letter-table');
      expect(putCommand.input.Item.notificationId).toBe('test-uuid-1234');
      expect(putCommand.input.Item.webhookUrl).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/test-token');
      expect(putCommand.input.Item.message).toEqual(failedNotification.message);
      expect(putCommand.input.Item.error).toBe('All 3 attempts failed');
      expect(putCommand.input.Item.failedAt).toBeDefined();
    });

    it('should throw when DEAD_LETTER_TABLE_NAME is not configured', async () => {
      delete process.env.DEAD_LETTER_TABLE_NAME;

      const failedNotification: FailedNotification = {
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
        message: createMockMessage(),
        error: 'Send failed',
      };

      await expect(writeToDeadLetter(failedNotification)).rejects.toThrow(
        'DEAD_LETTER_TABLE_NAME environment variable is not configured'
      );
    });

    it('should propagate DynamoDB errors', async () => {
      const mockSend = jest.fn().mockRejectedValue(new Error('DynamoDB write failed'));
      const mockClient = { send: mockSend } as any;
      setDynamoDBClient(mockClient);

      const failedNotification: FailedNotification = {
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token',
        message: createMockMessage(),
        error: 'Send failed',
      };

      await expect(writeToDeadLetter(failedNotification)).rejects.toThrow('DynamoDB write failed');
    });
  });
});
