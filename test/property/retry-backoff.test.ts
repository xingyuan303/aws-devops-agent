// Feature: cloudwatch-alarm-auto-rca, Property 9: Retry backoff calculation
// Validates: Requirements 3.4

import * as fc from 'fast-check';
import { calculateBackoffDelay } from '../../src/lambdas/rca-analyzer/agent-client';

describe('Property 9: Retry backoff calculation', () => {
  it('delay equals initialDelay × backoffMultiplier^(attempt-1) for any valid inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),           // attempt number (1-3)
        fc.integer({ min: 100, max: 60000 }),     // initialDelayMs (100ms to 60s)
        fc.double({ min: 1, max: 5, noNaN: true }), // backoffMultiplier (1x to 5x)
        (attempt, initialDelayMs, multiplier) => {
          const result = calculateBackoffDelay(attempt, initialDelayMs, multiplier);
          const expected = initialDelayMs * Math.pow(multiplier, attempt - 1);

          expect(result).toBeCloseTo(expected, 5);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('first attempt always returns exactly the initial delay', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 60000 }),
        fc.double({ min: 1, max: 5, noNaN: true }),
        (initialDelayMs, multiplier) => {
          const result = calculateBackoffDelay(1, initialDelayMs, multiplier);
          expect(result).toBe(initialDelayMs);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('delay is monotonically non-decreasing with attempt number when multiplier >= 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 60000 }),
        fc.double({ min: 1, max: 5, noNaN: true }),
        (initialDelayMs, multiplier) => {
          const delay1 = calculateBackoffDelay(1, initialDelayMs, multiplier);
          const delay2 = calculateBackoffDelay(2, initialDelayMs, multiplier);
          const delay3 = calculateBackoffDelay(3, initialDelayMs, multiplier);

          expect(delay2).toBeGreaterThanOrEqual(delay1);
          expect(delay3).toBeGreaterThanOrEqual(delay2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('default config (5000ms, multiplier 2) produces 5000, 10000, 20000 for attempts 1, 2, 3', () => {
    expect(calculateBackoffDelay(1, 5000, 2)).toBe(5000);
    expect(calculateBackoffDelay(2, 5000, 2)).toBe(10000);
    expect(calculateBackoffDelay(3, 5000, 2)).toBe(20000);
  });

  it('delay is always positive for valid inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 60000 }),
        fc.double({ min: 1, max: 5, noNaN: true }),
        (attempt, initialDelayMs, multiplier) => {
          const result = calculateBackoffDelay(attempt, initialDelayMs, multiplier);
          expect(result).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('multiplier of 1 produces constant delay regardless of attempt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 100, max: 60000 }),
        (attempt, initialDelayMs) => {
          const result = calculateBackoffDelay(attempt, initialDelayMs, 1);
          expect(result).toBe(initialDelayMs);
        }
      ),
      { numRuns: 100 }
    );
  });
});
