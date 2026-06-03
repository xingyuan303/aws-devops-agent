import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CloudwatchAlarmAutoRcaStack } from '../../lib/cloudwatch-alarm-auto-rca-stack';

describe('CDK Stack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new CloudwatchAlarmAutoRcaStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  describe('DynamoDB tables', () => {
    it('should create WorkflowExecution table with correct keys and TTL', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: 'executionId', KeyType: 'HASH' }),
          Match.objectLike({ AttributeName: 'createdAt', KeyType: 'RANGE' }),
        ]),
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('should create AlarmGroup table with correct keys and TTL', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: 'resourceArn', KeyType: 'HASH' }),
          Match.objectLike({ AttributeName: 'groupId', KeyType: 'RANGE' }),
        ]),
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('should create DeadLetterNotification table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: 'notificationId', KeyType: 'HASH' }),
        ]),
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('should create ChatInvestigationMapping table', () => {
      // 飞书 chat-initiated investigation 的 taskId↔chatId 映射表
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: 'taskId', KeyType: 'HASH' }),
        ]),
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: Match.objectLike({
          AttributeName: 'ttl',
          Enabled: true,
        }),
      });
    });

    it('should have exactly 5 DynamoDB tables', () => {
      template.resourceCountIs('AWS::DynamoDB::Table', 5);
    });
  });

  describe('Lambda functions', () => {
    it('should create AlarmRouter Lambda with correct config', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        MemorySize: 256,
        Timeout: 30,
        Description: Match.stringLikeRegexp('.*alarm.*'),
      });
    });

    it('should create RCAAnalyzer Lambda with 512MB memory and 60s timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        MemorySize: 512,
        Timeout: 60,
        Description: Match.stringLikeRegexp('.*webhook.*'),
      });
    });

    it('should create FeishuNotifier Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        MemorySize: 256,
        Timeout: 60,
        Description: Match.stringLikeRegexp('.*Feishu.*'),
      });
    });

    it('should create InvestigationEventHandler Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        MemorySize: 512,
        Timeout: 120,
        Description: Match.stringLikeRegexp('.*aws\\.aidevops.*'),
      });
    });

    it('should have 7 Lambda functions (5 core + config seeder + CR provider)', () => {
      template.resourceCountIs('AWS::Lambda::Function', 7);
    });

    it('should configure environment variables for Lambda functions', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            SSM_CONFIG_PATH: '/cloudwatch-alarm-auto-rca/config',
          }),
        },
      });
    });
  });

  describe('EventBridge rule', () => {
    it('should create EventBridge rule for CloudWatch Alarm State Change', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.cloudwatch'],
          'detail-type': ['CloudWatch Alarm State Change'],
          detail: {
            state: {
              value: ['ALARM'],
            },
          },
        },
      });
    });

    it('should create EventBridge rule for aws.aidevops investigation events', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.aidevops'],
          'detail-type': Match.arrayWith(['Investigation Completed']),
        },
      });
    });

    it('should have Step Functions state machine as target', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.anyValue(),
          }),
        ]),
      });
    });
  });

  describe('Step Functions state machine', () => {
    it('should create a Standard state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'STANDARD',
      });
    });

    it('should have exactly 1 state machine', () => {
      template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    });
  });

  describe('SSM config seeding', () => {
    it('does not manage the config parameter as a CFN resource', () => {
      // Decoupled: no AWS::SSM::Parameter so deploys never overwrite runtime config.
      template.resourceCountIs('AWS::SSM::Parameter', 0);
    });

    it('wires the seeder to the correct parameter path', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            PARAM_NAME: '/cloudwatch-alarm-auto-rca/config',
          }),
        },
      });
    });
  });

  describe('CloudWatch Alarms', () => {
    it('should create workflow failure alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'CloudWatchAlarmAutoRCA',
        MetricName: 'RCAAnalysesFailed',
      });
    });

    it('should create notification failure alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'CloudWatchAlarmAutoRCA',
        MetricName: 'NotificationsFailed',
      });
    });
  });
});
