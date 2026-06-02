import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AlarmEventForwarderStack } from '../../lib/alarm-event-forwarder-stack';

describe('AlarmEventForwarderStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new AlarmEventForwarderStack(app, 'ForwarderTest', {
      env: { account: '123456789012', region: 'us-west-2' },
      centralRegion: 'us-east-1',
    });
    template = Template.fromStack(stack);
  });

  it('creates a rule matching CloudWatch ALARM state-change events', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.cloudwatch'],
        'detail-type': ['CloudWatch Alarm State Change'],
        detail: { state: { value: ['ALARM'] } },
      },
    });
  });

  it('targets the central region default event bus', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: 'arn:aws:events:us-east-1:123456789012:event-bus/default',
        }),
      ]),
    });
  });
});
