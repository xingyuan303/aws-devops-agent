import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { Construct } from 'constructs';

export interface VerdaccioProxyStackProps extends cdk.StackProps {
  /**
   * CodeArtifact domain name
   */
  codeArtifactDomain: string;

  /**
   * CodeArtifact domain owner (AWS account ID)
   */
  codeArtifactDomainOwner: string;

  /**
   * CodeArtifact repository name
   */
  codeArtifactRepo: string;

  /**
   * Allowed CIDR blocks (design team's company public IPs)
   * Example: ['203.0.113.0/24', '198.51.100.0/24']
   */
  allowedCidrs: string[];

  /**
   * npm scope for your packages (without @), e.g. 'your-company'
   */
  npmScope: string;

  /**
   * VPC to deploy into (optional, will create new one if not provided)
   */
  vpc?: ec2.IVpc;
}

export class VerdaccioProxyStack extends cdk.Stack {
  public readonly serviceUrl: string;

  constructor(scope: Construct, id: string, props: VerdaccioProxyStackProps) {
    super(scope, id, props);

    // VPC
    const vpc = props.vpc ?? new ec2.Vpc(this, 'VerdaccioVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // EFS for Verdaccio storage (packages cache persists across restarts)
    const fileSystem = new efs.FileSystem(this, 'VerdaccioStorage', {
      vpc,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    });

    const accessPoint = fileSystem.addAccessPoint('VerdaccioAccessPoint', {
      path: '/verdaccio',
      posixUser: { uid: '10001', gid: '65533' },
      createAcl: { ownerUid: '10001', ownerGid: '65533', permissions: '755' },
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'VerdaccioCluster', { vpc });

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'VerdaccioTask', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Grant CodeArtifact access to the task role
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'codeartifact:GetAuthorizationToken',
        'codeartifact:GetRepositoryEndpoint',
        'codeartifact:ReadFromRepository',
      ],
      resources: ['*'],
    }));
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:GetServiceBearerToken'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'sts:AWSServiceName': 'codeartifact.amazonaws.com' },
      },
    }));

    // EFS volume
    taskDef.addVolume({
      name: 'verdaccio-storage',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
      },
    });

    // CodeArtifact endpoint URL
    const region = cdk.Stack.of(this).region;
    const codeArtifactUrl = `https://${props.codeArtifactDomain}-${props.codeArtifactDomainOwner}.d.codeartifact.${region}.amazonaws.com/npm/${props.codeArtifactRepo}/`;

    // Container
    const container = taskDef.addContainer('verdaccio', {
      image: ecs.ContainerImage.fromRegistry('verdaccio/verdaccio:5'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'verdaccio',
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        VERDACCIO_PORT: '4873',
        CODEARTIFACT_DOMAIN: props.codeArtifactDomain,
        CODEARTIFACT_DOMAIN_OWNER: props.codeArtifactDomainOwner,
        CODEARTIFACT_REPO: props.codeArtifactRepo,
        CODEARTIFACT_URL: codeArtifactUrl,
        NPM_SCOPE: props.npmScope,
      },
      portMappings: [{ containerPort: 4873 }],
      // Entrypoint script that fetches token then starts Verdaccio
      command: [
        'sh', '-c',
        [
          // Get CodeArtifact token using task role credentials
          'export CODEARTIFACT_AUTH_TOKEN=$(wget -qO- http://169.254.170.2$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI | python3 -c "import sys,json; print(json.load(sys.stdin))" 2>/dev/null || echo "")',
          // Write Verdaccio config with token
          'cat > /verdaccio/conf/config.yaml << EOF',
          'storage: /verdaccio/storage/data',
          'uplinks:',
          '  codeartifact:',
          `    url: ${codeArtifactUrl}`,
          '    auth:',
          '      type: bearer',
          '      token_env: CODEARTIFACT_AUTH_TOKEN',
          '  npmjs:',
          '    url: https://registry.npmjs.org/',
          'packages:',
          `  "@${props.npmScope}/*":`,
          '    access: $all',
          '    proxy: codeartifact',
          '  "**":',
          '    access: $all',
          '    proxy: npmjs',
          'auth:',
          '  htpasswd:',
          '    file: /dev/null',
          '    max_users: -1',
          'middlewares:',
          '  audit:',
          '    enabled: true',
          'listen: 0.0.0.0:4873',
          'EOF',
          // Start Verdaccio
          'verdaccio --config /verdaccio/conf/config.yaml',
        ].join('\n'),
      ],
    });

    container.addMountPoints({
      sourceVolume: 'verdaccio-storage',
      containerPath: '/verdaccio/storage',
      readOnly: false,
    });

    // Grant EFS access
    fileSystem.grant(taskDef.taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');

    // ALB + Fargate Service
    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'VerdaccioService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      publicLoadBalancer: true, // Needs to be reachable from design team's network
      listenerPort: 80,
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:4873/-/ping || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    // Allow EFS from Fargate
    fileSystem.connections.allowDefaultPortFrom(service.service.connections);

    // IP Whitelist - only allow design team's company IPs
    const albSg = service.loadBalancer.connections.securityGroups[0];

    // Remove default 0.0.0.0/0 rule and add specific CIDRs
    for (const cidr of props.allowedCidrs) {
      albSg.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(80),
        `Allow design team from ${cidr}`
      );
    }

    // Token Refresher Lambda - runs every 10 hours to restart the service
    // (Verdaccio reads token from env, so restarting picks up new token via task role)
    const refresherFn = new lambda.Function(this, 'TokenRefresher', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { ECSClient, UpdateServiceCommand } = require('@aws-sdk/client-ecs');
exports.handler = async () => {
  const client = new ECSClient();
  await client.send(new UpdateServiceCommand({
    cluster: process.env.CLUSTER_ARN,
    service: process.env.SERVICE_ARN,
    forceNewDeployment: true,
  }));
  return { statusCode: 200, body: 'Service restarted for token refresh' };
};
      `),
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        SERVICE_ARN: service.service.serviceArn,
      },
      timeout: cdk.Duration.seconds(30),
    });

    service.service.grantTaskDefinitionAccess(refresherFn);
    refresherFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService'],
      resources: [service.service.serviceArn],
    }));

    // Schedule: every 10 hours
    new events.Rule(this, 'TokenRefreshSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(10)),
      targets: [new targets.LambdaFunction(refresherFn)],
    });

    // Outputs
    this.serviceUrl = `http://${service.loadBalancer.loadBalancerDnsName}`;

    new cdk.CfnOutput(this, 'VerdaccioUrl', {
      value: this.serviceUrl,
      description: 'Verdaccio registry URL for design team',
    });

    new cdk.CfnOutput(this, 'NpmConfigCommand', {
      value: `npm config set @${props.npmScope}:registry ${this.serviceUrl}`,
      description: 'Command for design team to configure npm',
    });
  }
}
