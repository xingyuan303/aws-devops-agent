#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudwatchAlarmAutoRcaStack } from '../lib/cloudwatch-alarm-auto-rca-stack';
import { AlarmEventForwarderStack } from '../lib/alarm-event-forwarder-stack';

const app = new cdk.App();

new CloudwatchAlarmAutoRcaStack(app, 'CloudwatchAlarmAutoRcaStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },

  // 从 CDK context 或环境变量读取配置
  feishuWebhookUrl: app.node.tryGetContext('feishuWebhookUrl') || process.env.FEISHU_WEBHOOK_URL,
  feishuAppId: app.node.tryGetContext('feishuAppId') || process.env.FEISHU_APP_ID,
  feishuAppSecret: app.node.tryGetContext('feishuAppSecret') || process.env.FEISHU_APP_SECRET,
  feishuVerificationToken: app.node.tryGetContext('feishuVerificationToken') || process.env.FEISHU_VERIFICATION_TOKEN,
  agentSpaceId: app.node.tryGetContext('agentSpaceId') || process.env.AGENT_SPACE_ID,
  deployFeishuBot: app.node.tryGetContext('deployFeishuBot') !== 'false',
});

// 可选：多区域监控。把其它区域的 CloudWatch 告警事件转发到中心区域(主栈所在区，
// 即上面的 CDK_DEFAULT_REGION)统一处理。
//   用法: -c forwardFromRegions=us-west-2,eu-central-1
const centralRegion = process.env.CDK_DEFAULT_REGION;
const forwardFromRegions: string[] = (
  app.node.tryGetContext('forwardFromRegions') || process.env.FORWARD_FROM_REGIONS || ''
)
  .split(',')
  .map((r: string) => r.trim())
  .filter((r: string) => r.length > 0);

for (const sourceRegion of forwardFromRegions) {
  new AlarmEventForwarderStack(app, `AlarmEventForwarderStack-${sourceRegion}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: sourceRegion },
    centralRegion: centralRegion!,
  });
}
