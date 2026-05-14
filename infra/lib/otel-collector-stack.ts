import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export interface OtelCollectorStackProps extends cdk.StackProps {
  /**
   * VPC to deploy the collector into. If omitted the stack imports the account's
   * default VPC (requires a successful cdk bootstrap with an `--env` that includes
   * account + region so the lookup can resolve at synth time).
   */
  readonly vpc?: ec2.IVpc;
  /**
   * Deployment stage. Controls CloudWatch log group removal policy:
   *   prod  → RETAIN (no accidental data loss on destroy)
   *   dev   → DESTROY (default — keeps the account clean during iteration)
   */
  readonly stage?: 'dev' | 'prod';
  /** Resource prefix. Defaults to 'orgiq'. */
  readonly prefix?: string;
}

/**
 * OrgIQ-OTelCollector: AWS Distro for OpenTelemetry (ADOT) Collector on ECS Fargate.
 *
 * Receives OTLP gRPC (port 4317) and HTTP (port 4318) from AgentCore Runtime agents
 * and exports spans to CloudWatch Logs (/orgiq/otel/spans) and X-Ray. The collector
 * config is stored in SSM Parameter Store at /orgiq/otel-collector/config and injected
 * into the container as AOT_CONFIG_CONTENT at task startup.
 *
 * Phase 3 (span projector Lambda) will consume the CloudWatch log group produced here.
 * Pass the exported OtelCollectorEndpoint / OtelCollectorLogGroup values downstream.
 */
export class OtelCollectorStack extends cdk.Stack {
  /** Internal ALB DNS name — use as the OTLP endpoint for agent runtimes. */
  public readonly endpoint: string;
  /** CloudWatch log group that receives exported OTLP spans. */
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: OtelCollectorStackProps = {}) {
    super(scope, id, props);

    const prefix = props.prefix ?? 'orgiq';
    const stage = props.stage ?? 'dev';

    // -----------------------------------------------------------------------
    // 1. VPC — accept from props (e.g. foundation.vpc) or fall back to default
    // -----------------------------------------------------------------------
    const vpc = props.vpc ?? ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // -----------------------------------------------------------------------
    // 2. CloudWatch Log Group — receives collector-exported spans
    // -----------------------------------------------------------------------
    this.logGroup = new logs.LogGroup(this, 'CollectorSpanLogs', {
      logGroupName: '/orgiq/otel/spans',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------------
    // 3. Collector config in SSM Parameter Store
    //
    // ${REGION} and ${ENVIRONMENT} are read by the ADOT collector process at
    // container startup from the task environment variables we pass below.
    // They MUST remain as literal `${...}` in the YAML — escape them in the JS
    // template literal so JS interpolation doesn't consume them.
    // -----------------------------------------------------------------------
    const collectorConfigYaml = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch:
    timeout: 5s
    send_batch_size: 100
  resource:
    attributes:
      - key: deployment.environment
        value: \${ENVIRONMENT}
        action: upsert
exporters:
  awscloudwatchlogs:
    region: \${REGION}
    log_group_name: /orgiq/otel/spans
    log_stream_name: collector
    raw_log: false
  awsxray:
    region: \${REGION}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [awscloudwatchlogs, awsxray]
`;

    const configParam = new ssm.StringParameter(this, 'CollectorConfig', {
      parameterName: '/orgiq/otel-collector/config',
      description: 'ADOT Collector YAML config — injected as AOT_CONFIG_CONTENT at task start',
      stringValue: collectorConfigYaml,
    });

    // -----------------------------------------------------------------------
    // 4. ECS Cluster
    // -----------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'orgiq-otel-collector',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // -----------------------------------------------------------------------
    // 5. Task role — permissions the collector container exercises at runtime
    // -----------------------------------------------------------------------
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${prefix}-otel-collector-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime role for the OrgIQ ADOT Collector ECS task',
      inlinePolicies: {
        OtelCollectorAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'CloudWatchLogs',
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogStreams',
              ],
              resources: [
                this.logGroup.logGroupArn,
                `${this.logGroup.logGroupArn}:*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'XRay',
              actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // Grant SSM GetParameter for the collector config
    configParam.grantRead(taskRole);

    // -----------------------------------------------------------------------
    // 6. Task execution role — used by ECS agent to pull the image + fetch secrets
    // -----------------------------------------------------------------------
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${prefix}-otel-collector-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // ECS needs to pull the SSM SecureString (or StringParameter via secrets:) at
    // task launch — grant GetParameter to the execution role as well.
    configParam.grantRead(executionRole);

    // -----------------------------------------------------------------------
    // 7. Fargate task definition (0.5 vCPU / 1 GB)
    // -----------------------------------------------------------------------
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole,
    });

    // Container log group for ECS task logs (separate from the span log group)
    const containerLogGroup = new logs.LogGroup(this, 'ContainerLogs', {
      logGroupName: `/orgiq/ecs/otel-collector`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDef.addContainer('collector', {
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/aws-observability/aws-otel-collector:latest',
      ),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'otel-collector',
        logGroup: containerLogGroup,
      }),
      environment: {
        REGION: cdk.Stack.of(this).region,
        ENVIRONMENT: stage,
      },
      secrets: {
        // ADOT reads AOT_CONFIG_CONTENT as its entire YAML config when set.
        AOT_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(configParam),
      },
      portMappings: [
        { containerPort: 4317, protocol: ecs.Protocol.TCP }, // OTLP gRPC
        { containerPort: 4318, protocol: ecs.Protocol.TCP }, // OTLP HTTP
      ],
      essential: true,
    });

    // -----------------------------------------------------------------------
    // 8. Internal Application Load Balanced Fargate service
    //    The ALB is internal — only reachable from within the VPC.
    //    Primary listener is on 4318 (HTTP OTLP); gRPC 4317 is exposed via
    //    the security group / network path (ALB → target port 4317).
    // -----------------------------------------------------------------------
    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      'Service',
      {
        cluster,
        taskDefinition: taskDef,
        publicLoadBalancer: false,   // internal ALB
        listenerPort: 4318,          // HTTP OTLP listener
        desiredCount: 1,
        assignPublicIp: false,
        loadBalancerName: `${prefix}-otel-collector`,
        serviceName: `${prefix}-otel-collector`,
      },
    );

    // Allow gRPC traffic (4317) inbound to the service's security group from within the VPC
    service.service.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(4317),
      'OTLP gRPC from VPC',
    );

    // Allow HTTP OTLP (4318) inbound from within the VPC (the ALB already handles
    // the listener, but the security group must also permit direct container access)
    service.service.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(4318),
      'OTLP HTTP from VPC',
    );

    this.endpoint = service.loadBalancer.loadBalancerDnsName;

    // -----------------------------------------------------------------------
    // 9. CloudFormation Outputs — consumed by Phase 3 span projector stack
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'OtelCollectorEndpoint', {
      value: this.endpoint,
      description: 'Internal ALB DNS name for the ADOT Collector (OTLP HTTP on :4318, gRPC on :4317)',
      exportName: `${prefix}-otel-collector-endpoint`,
    });

    new cdk.CfnOutput(this, 'OtelCollectorLogGroup', {
      value: this.logGroup.logGroupName,
      description: 'CloudWatch log group receiving OTLP spans from the ADOT Collector',
      exportName: `${prefix}-otel-collector-log-group`,
    });
  }
}
