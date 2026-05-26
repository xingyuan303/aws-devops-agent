// Feature: cloudwatch-alarm-auto-rca, Property 14: TTL calculation correctness
// Validates: Requirements 6.4

import * as fc from 'fast-check';
import { calculateTTL } from '../../src/shared/dynamodb-client';

describe('Property 14: TTL calculation correctness', () => {
  it('TTL equals createdAt (Unix seconds) + retentionDays × 86400', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1600000000, max: 1800000000 }), // Unix seconds (reasonable range)
        fc.integer({ min: 1, max: 365 }),                  // retention days (1 to 365)
        (createdAtUnixSeconds, retentionDays) => {
          const result = calculateTTL(createdAtUnixSeconds, retentionDays);
          const expected = createdAtUnixSeconds + retentionDays * 86400;

          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('TTL is always greater than the creation timestamp', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1800000000 }),
        fc.integer({ min: 1, max: 365 }),
        (createdAtUnixSeconds, retentionDays) => {
          const result = calculateTTL(createdAtUnixSeconds, retentionDays);
          expect(result).toBeGreaterThan(createdAtUnixSeconds);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('doubling retention days doubles the added seconds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1600000000, max: 1800000000 }),
        fc.integer({ min: 1, max: 180 }),
        (createdAtUnixSeconds, retentionDays) => {
          const ttl1 = calculateTTL(createdAtUnixSeconds, retentionDays);
          const ttl2 = calculateTTL(createdAtUnixSeconds, retentionDays * 2);

          const added1 = ttl1 - createdAtUnixSeconds;
          const added2 = ttl2 - createdAtUnixSeconds;

          expect(added2).toBe(added1 * 2);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('default 90 days retention adds exactly 7776000 seconds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1600000000, max: 1800000000 }),
        (createdAtUnixSeconds) => {
          const result = calculateTTL(createdAtUnixSeconds, 90);
          expect(result - createdAtUnixSeconds).toBe(90 * 86400);
          expect(result - createdAtUnixSeconds).toBe(7776000);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('TTL increases monotonically with retention days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1600000000, max: 1800000000 }),
        fc.integer({ min: 1, max: 364 }),
        (createdAtUnixSeconds, retentionDays) => {
          const ttlSmaller = calculateTTL(createdAtUnixSeconds, retentionDays);
          const ttlLarger = calculateTTL(createdAtUnixSeconds, retentionDays + 1);

          expect(ttlLarger).toBeGreaterThan(ttlSmaller);
        }
      ),
      { numRuns: 100 }
    );
  });
});
