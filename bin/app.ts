#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudwatchAlarmAutoRcaStack } from '../lib/cloudwatch-alarm-auto-rca-stack';

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
