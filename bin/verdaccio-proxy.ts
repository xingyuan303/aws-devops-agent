#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VerdaccioProxyStack } from '../lib/verdaccio-proxy-stack';

const app = new cdk.App();

new VerdaccioProxyStack(app, 'VerdaccioProxyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },

  // ============ 修改以下配置 ============

  // 你的 CodeArtifact 配置
  codeArtifactDomain: 'your-domain',          // CodeArtifact domain 名称
  codeArtifactDomainOwner: '111122223333',     // 你的 AWS 账号 ID
  codeArtifactRepo: 'your-repo',              // Repository 名称

  // 设计同学公司的公网出口 IP（找他们运维要）
  allowedCidrs: [
    '203.0.113.0/24',   // 设计公司出口 IP 段
    // '198.51.100.0/24', // 如有多个，继续添加
  ],

  // 你们组件库的 npm scope（不带 @）
  npmScope: 'your-company',
});
