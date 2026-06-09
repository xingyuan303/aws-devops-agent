import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { FrequencyCapConfig } from '../../shared/types';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/** Env var holding the frequency-cap counter table name. */
const TABLE_NAME = process.env.FREQUENCY_CAP_TABLE_NAME;

/**
 * Computes the calendar-day bucket (YYYY-MM-DD) for `now`, shifted by the
 * configured UTC offset so the day resets at local midnight (e.g. +8 = Beijing).
 */
export function computeDayBucket(now: Date, utcOffsetHours: number): string {
  const shifted = new Date(now.getTime() + utcOffsetHours * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Atomically records one occurrence of `alarmName` for the current calendar day
 * and reports whether this occurrence exceeds the per-day cap.
 *
 * Semantics: the first `maxPerDay` occurrences pass (`capped === false`); the
 * (maxPerDay + 1)-th and beyond are capped (`capped === true`).
 *
 * Fails open: any missing-table / DynamoDB error returns `{ capped: false }` so
 * the cap never drops alarms because of an infrastructure issue.
 */
export async function checkFrequencyCap(
  alarmName: string,
  config: FrequencyCapConfig,
  now: Date = new Date()
): Promise<{ capped: boolean; count: number }> {
  if (!TABLE_NAME) {
    console.warn('[FrequencyCap] FREQUENCY_CAP_TABLE_NAME not set, skipping cap');
    return { capped: false, count: 0 };
  }

  const dayBucket = computeDayBucket(now, config.utcOffsetHours);
  // TTL: 2 days out — comfortably outlives any single calendar day so the
  // per-day counter auto-expires after the day rolls over.
  const ttl = Math.floor(now.getTime() / 1000) + 2 * 86400;

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { alarmName, dayBucket },
        UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
        ReturnValues: 'UPDATED_NEW',
      })
    );

    const count = Number(result.Attributes?.count ?? 0);
    return { capped: count > config.maxPerDay, count };
  } catch (error) {
    console.warn('[FrequencyCap] DynamoDB update failed, failing open', error);
    return { capped: false, count: 0 };
  }
}
