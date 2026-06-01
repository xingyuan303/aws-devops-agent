import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';

/**
 * Fetch a resource's AWS tags via the unified Resource Groups Tagging API.
 * Works across all services whose ARN alarm-router can build (EC2, RDS,
 * Lambda, ELB, SQS, DynamoDB, S3, ECS, SNS). Region is parsed from the ARN.
 * Any failure (empty ARN, untaggable resource, throttling) degrades to {} so
 * callers fall back to non-tag behaviour instead of breaking.
 *
 * Call this ONLY when a tag-based rule actually exists, so deployments that
 * don't use tag filtering/routing incur no extra Tagging API calls.
 */
export async function fetchResourceTags(resourceArn: string): Promise<Record<string, string>> {
  if (!resourceArn) return {};
  const region = resourceArn.split(':')[3] || process.env.AWS_REGION;
  try {
    const client = new ResourceGroupsTaggingAPIClient(region ? { region } : {});
    const res = await client.send(new GetResourcesCommand({ ResourceARNList: [resourceArn] }));
    const tags = res.ResourceTagMappingList?.[0]?.Tags ?? [];
    return Object.fromEntries(tags.map((t) => [t.Key ?? '', t.Value ?? '']));
  } catch (err) {
    console.error(
      JSON.stringify({
        message: 'Failed to fetch resource tags',
        resourceArn,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return {};
  }
}
