import { WebhookConfig, WebhookRoutingRule } from '../../shared/types';

/**
 * Check if a single routing rule matches the given alarm namespace and tags.
 */
function matchesRule(
  rule: WebhookRoutingRule,
  alarmNamespace: string,
  alarmTags: Record<string, string>
): boolean {
  if (rule.field === 'namespace') {
    return matchPattern(alarmNamespace, rule.pattern, rule.match);
  }

  if (rule.field === 'tag') {
    // Pattern format for tags: "key=value"
    const separatorIndex = rule.pattern.indexOf('=');
    if (separatorIndex === -1) {
      return false;
    }
    const tagKey = rule.pattern.substring(0, separatorIndex);
    const tagPattern = rule.pattern.substring(separatorIndex + 1);
    const tagValue = alarmTags[tagKey];
    if (tagValue === undefined) {
      return false;
    }
    return matchPattern(tagValue, tagPattern, rule.match);
  }

  return false;
}

/**
 * Match a value against a pattern using the specified match type.
 */
function matchPattern(value: string, pattern: string, matchType: 'equals' | 'contains' | 'regex'): boolean {
  switch (matchType) {
    case 'equals':
      return value === pattern;
    case 'contains':
      return value.includes(pattern);
    case 'regex':
      try {
        const regex = new RegExp(pattern);
        return regex.test(value);
      } catch {
        // Invalid regex pattern → treat as non-matching
        return false;
      }
  }
}

/**
 * Determine if a webhook config matches the given alarm based on its routing rules.
 * A webhook with empty routing rules always matches (acts as catch-all).
 * A webhook matches if ANY of its routing rules match the alarm.
 */
function webhookMatches(
  config: WebhookConfig,
  alarmNamespace: string,
  alarmTags: Record<string, string>
): boolean {
  // Empty routing rules → always matches (catch-all)
  if (config.routingRules.length === 0) {
    return true;
  }

  // Match if ANY rule matches
  return config.routingRules.some((rule) => matchesRule(rule, alarmNamespace, alarmTags));
}

/**
 * Route webhooks based on alarm namespace and tags.
 *
 * Returns an array of webhook URLs that should receive the notification.
 * - If no webhooks match any routing rules, broadcast to ALL configured webhooks.
 * - If at least one webhook matches, return only the matching webhook URLs.
 * - Empty webhookConfigs → return empty array.
 * - Webhook with empty routingRules → always matches (catch-all).
 *
 * @param alarmNamespace - The namespace of the alarm (e.g., "AWS/EC2")
 * @param alarmTags - Tags associated with the alarm
 * @param webhookConfigs - Array of webhook configurations with routing rules
 * @returns Array of webhook URLs to send notifications to
 */
export function routeWebhooks(
  alarmNamespace: string,
  alarmTags: Record<string, string>,
  webhookConfigs: WebhookConfig[]
): string[] {
  if (webhookConfigs.length === 0) {
    return [];
  }

  const matchedUrls: string[] = [];

  for (const config of webhookConfigs) {
    if (webhookMatches(config, alarmNamespace, alarmTags)) {
      matchedUrls.push(config.url);
    }
  }

  // If no webhooks matched, broadcast to all
  if (matchedUrls.length === 0) {
    return webhookConfigs.map((config) => config.url);
  }

  return matchedUrls;
}
