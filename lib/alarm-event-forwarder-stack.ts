import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface AlarmEventForwarderStackProps extends cdk.StackProps {
  /**
   * The region where the main CloudwatchAlarmAutoRcaStack runs and receives
   * the forwarded events (typically the DevOps Agent region, e.g. us-east-1).
   */
  centralRegion: string;
}

/**
 * Deployed to each SOURCE region. Forwards CloudWatch "Alarm State Change"
 * events (ALARM only) from that region's default event bus to the central
 * region's default event bus, so a single central RCA stack can process
 * alarms originating in multiple regions.
 *
 * The central rule already matches `source=aws.cloudwatch` /
 * `detail-type=CloudWatch Alarm State Change`; forwarded events keep their
 * original source/detail-type/detail (including the originating region and
 * account), so alarm-router builds the correct resource ARN per region.
 */
export class AlarmEventForwarderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AlarmEventForwarderStackProps) {
    super(scope, id, props);

    const centralBus = events.EventBus.fromEventBusArn(
      this,
      'CentralBus',
      `arn:aws:events:${props.centralRegion}:${this.account}:event-bus/default`
    );

    new events.Rule(this, 'ForwardAlarmsToCentral', {
      description: `Forward CloudWatch ALARM events to ${props.centralRegion} for central RCA`,
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: { state: { value: ['ALARM'] } },
      },
      // CDK provisions the IAM role granting events:PutEvents to the target bus.
      targets: [new targets.EventBus(centralBus)],
    });
  }
}
