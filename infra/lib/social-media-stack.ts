import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { socialRepoName } from './social-images-stack';

/**
 * The SFU's fixed port set. With mediasoup's `WebRtcServer` each worker
 * multiplexes every transport on ONE UDP and ONE TCP port, so two workers
 * need exactly four media ports — not a thousand-port range. mediasoup
 * cannot announce a port different from the one it binds, so these are also
 * what the browser dials.
 */
export const SFU_PORTS = {
  api: 3901,
  rtcUdp: { from: 40000, to: 40001 },
  rtcTcp: { from: 40010, to: 40011 },
  workers: 2,
} as const;

/** Secrets the SFU owns; OrgIQ-Social imports them by these names. */
export function sfuSecretNames(prefix: string): { adminToken: string; webhook: string } {
  return {
    adminToken: `${prefix}-social-sfu-admin-token`,
    webhook: `${prefix}-social-sfu-webhook-secret`,
  };
}

export interface SocialMediaStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** The OrgIQ-MiddlewareService VPC — the SFU sits in one of its public subnets. */
  readonly vpc: ec2.IVpc;
  /**
   * The OrgIQ Cognito pool. LVS verifies forwarded user bearers against it on
   * /api/sessions until platform-api calls it as a service (plan §2, option A).
   */
  readonly cognitoUserPoolId?: string;
}

/**
 * OrgIQ-SocialMedia: the mediasoup SFU (live-video-streaming) on one small
 * ARM64 EC2 instance with an Elastic IP.
 *
 * EC2, not Fargate + NLB: under half the idle cost (~$18/mo vs ~$49), no NLB
 * UDP flow subtleties, and it is the shape LVS's own `k8s/overlays/ec2` uses.
 * See docs/social-calls-deploy-plan.md §3.
 *
 * ⚠️ THE CUSTODIAN. This account runs `custodian-restrict-security-group-
 * admin-ingress`, which revoked 0.0.0.0/0:80 on the middleware ALB six seconds
 * after CloudFormation added it, with no stack event and no drift. Whether it
 * also matches UDP or high TCP ports is unmeasured (phase 0 of the plan). So
 * media ingress is an explicit allowlist:
 *
 *   --context sfuAllowCidr=203.0.113.4/32,198.51.100.7/32
 *
 * applied to UDP 40000-40001 and TCP 40010-40011. With none given the SFU
 * accepts no media and synth says so. A participant who is not allowlisted
 * cannot load the portal either (albAllowCidr), so for a two-person test put
 * both participants' public IPs in BOTH lists.
 *
 * The HTTP API on 3901 is NOT opened to clients here: browsers reach it over
 * HTTPS through the shared ALB (a host rule OrgIQ-Social adds), and
 * platform-api reaches it inside the VPC. OrgIQ-Social adds both rules.
 */
export class SocialMediaStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly securityGroup: ec2.SecurityGroup;
  /** The Elastic IP — also what mediasoup announces. */
  public readonly publicIp: string;
  public readonly privateIp: string;
  public readonly adminTokenSecret: secretsmanager.Secret;
  public readonly webhookSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SocialMediaStackProps) {
    super(scope, id, props);
    const prefix = props.prefix ?? 'orgiq';

    // ── Image ──────────────────────────────────────────────────────────────
    // By digest, like the document workspace, so a redeploy runs exactly the
    // image that was verified. `:latest` is accepted (with a warning) so the
    // stack can be synthesised before the first push.
    const digest = this.node.tryGetContext('sfuImageDigest') as string | undefined;
    if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`sfuImageDigest must be sha256:<64 hex>, got ${digest}`);
    }
    const repo = ecr.Repository.fromRepositoryName(this, 'SfuRepo', socialRepoName(prefix, 'sfu'));
    const imageRef = digest ? `${repo.repositoryUri}@${digest}` : `${repo.repositoryUri}:latest`;
    if (!digest) {
      cdk.Annotations.of(this).addWarning(
        'No sfuImageDigest given — the SFU instance will run orgiq-lvs-sfu:latest. '
        + 'Deploy with --context sfuImageDigest=sha256:… to pin the verified image.',
      );
    }

    // ── Secrets ────────────────────────────────────────────────────────────
    // ADMIN_TOKEN is strict in production (no default), and several
    // platform-api routes still default the admin bearer to the literal
    // 'admin' — only a real secret guarantees they don't. The webhook HMAC is
    // one secret under two names: the SFU's WEBHOOK_HMAC_SECRET and
    // platform-api's LVS_WEBHOOK_SECRET. Minted HERE because this stack
    // deploys before OrgIQ-Social, which imports both by name.
    const names = sfuSecretNames(prefix);
    this.adminTokenSecret = new secretsmanager.Secret(this, 'SfuAdminToken', {
      secretName: names.adminToken,
      description: 'LVS ADMIN_TOKEN = platform-api VIDEO_ADMIN_TOKEN',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    this.webhookSecret = new secretsmanager.Secret(this, 'SfuWebhookSecret', {
      secretName: names.webhook,
      description: 'LVS WEBHOOK_HMAC_SECRET = platform-api LVS_WEBHOOK_SECRET',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    // ── Security group ─────────────────────────────────────────────────────
    this.securityGroup = new ec2.SecurityGroup(this, 'SfuSecurityGroup', {
      vpc: props.vpc,
      securityGroupName: `${prefix}-social-sfu`,
      description: 'orgiq-lvs-sfu media ports - allowlisted CIDRs only (sfuAllowCidr)',
      allowAllOutbound: true,
    });

    const allowRaw = this.node.tryGetContext('sfuAllowCidr');
    const allowCidrs = typeof allowRaw === 'string'
      ? allowRaw.split(',').map((c) => c.trim()).filter(Boolean)
      : [];
    for (const cidr of allowCidrs) {
      const peer = cidr.includes(':') ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr);
      this.securityGroup.addIngressRule(
        peer, ec2.Port.udpRange(SFU_PORTS.rtcUdp.from, SFU_PORTS.rtcUdp.to), `RTC media (UDP) from ${cidr}`,
      );
      // mediasoup's own TCP candidate — the fallback for networks that block UDP.
      this.securityGroup.addIngressRule(
        peer, ec2.Port.tcpRange(SFU_PORTS.rtcTcp.from, SFU_PORTS.rtcTcp.to), `RTC media (TCP fallback) from ${cidr}`,
      );
    }
    if (allowCidrs.length === 0) {
      cdk.Annotations.of(this).addWarning(
        'No sfuAllowCidr given — the SFU will accept no media traffic. '
        + 'Deploy with --context sfuAllowCidr=<participant-ip>/32[,…] (this account\'s custodian '
        + 'revokes 0.0.0.0/0 ingress; see docs/social-calls-deploy-plan.md §3).',
      );
    }
    if (allowCidrs.some((c) => c === '0.0.0.0/0' || c === '::/0')) {
      cdk.Annotations.of(this).addWarning(
        'sfuAllowCidr includes an open range — custodian-restrict-security-group-admin-ingress may '
        + 'revoke it within seconds, silently. Measure it first (plan phase 0).',
      );
    }

    // ── Instance role ──────────────────────────────────────────────────────
    const role = new iam.Role(this, 'SfuInstanceRole', {
      roleName: `${prefix}-social-sfu-instance-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'orgiq-lvs-sfu host: ECR pull, its two secrets, SSM Session Manager',
      managedPolicies: [
        // Shell access without an SSH port — nothing listens on 22.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    repo.grantPull(role);
    this.adminTokenSecret.grantRead(role);
    this.webhookSecret.grantRead(role);

    // ── Elastic IP ─────────────────────────────────────────────────────────
    // Allocated before the instance so its address can be written into the
    // user data as MEDIASOUP_ANNOUNCED_IP; associated after.
    const eip = new ec2.CfnEIP(this, 'SfuEip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${prefix}-social-sfu` }],
    });
    this.publicIp = eip.attrPublicIp;

    // ── User data ──────────────────────────────────────────────────────────
    // A systemd unit, not a one-shot `docker run`: it survives a reboot and
    // re-reads the secrets on every start, so a rotated ADMIN_TOKEN needs a
    // restart, not a rebuild. `--network host` because mediasoup must bind the
    // very ports it announces. Participant-token PEMs are not mounted: LVS
    // then generates an ephemeral keypair, so a restart invalidates
    // outstanding participant tokens (clients refresh). Fine for one instance.
    const cognito = props.cognitoUserPoolId;
    const corsOrigins = this.node.tryGetContext('socialPortalOrigin') as string | undefined;
    const redisUrl = this.node.tryGetContext('sfuRedisUrl') as string | undefined;
    const env: Array<[string, string]> = [
      ['NODE_ENV', 'production'],
      ['PORT', String(SFU_PORTS.api)],
      ['AWS_REGION', this.region],
      ['CLUSTER_ENABLED', 'false'],
      ['SEED_NODES', ''],
      ['MEDIASOUP_WORKERS', String(SFU_PORTS.workers)],
      ['MEDIASOUP_RTC_PORT', String(SFU_PORTS.rtcUdp.from)],
      ['MEDIASOUP_RTC_TCP_PORT', String(SFU_PORTS.rtcTcp.from)],
      ['MEDIASOUP_RTC_TCP_PORT_PER_POD', 'false'],
      ['MEDIASOUP_ANNOUNCED_IP', eip.attrPublicIp],
      ['MEDIASOUP_ANNOUNCED_IP_TCP', eip.attrPublicIp],
      ['ENABLE_UDP', 'true'],
      // Conversation calls start recording at two participants, and
      // recordings need a disk and a finalize path — phase 4, not now.
      ['RECORDING_ENABLED', 'false'],
      ['WEBHOOK_FORMAT', 'bare'],
      ...(cognito ? [['COGNITO_REGION', this.region], ['COGNITO_USER_POOL_ID', cognito]] as Array<[string, string]> : []),
      ...(corsOrigins ? [['LVS_CORS_ORIGINS', corsOrigins]] as Array<[string, string]> : []),
      ...(redisUrl ? [['REDIS_URL', redisUrl]] as Array<[string, string]> : []),
    ];
    const registry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'dnf install -y docker',
      'systemctl enable --now docker',
      "cat > /usr/local/bin/lvs-sfu-run <<'EOS'",
      '#!/bin/bash',
      'set -euo pipefail',
      'IMDS=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
      'PRIVATE_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS" http://169.254.169.254/latest/meta-data/local-ipv4)',
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${registry}`,
      `ADMIN_TOKEN=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${this.adminTokenSecret.secretArn} --query SecretString --output text)`,
      `WEBHOOK_HMAC_SECRET=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${this.webhookSecret.secretArn} --query SecretString --output text)`,
      'umask 077',
      '{',
      ...env.map(([k, v]) => `  echo "${k}=${v}"`),
      '  echo "POD_IP=$PRIVATE_IP"',
      '  echo "MESH_ANNOUNCED_IP=$PRIVATE_IP"',
      '  echo "ADMIN_TOKEN=$ADMIN_TOKEN"',
      '  echo "WEBHOOK_HMAC_SECRET=$WEBHOOK_HMAC_SECRET"',
      '} > /run/lvs-sfu.env',
      'docker rm -f lvs-sfu >/dev/null 2>&1 || true',
      `exec docker run --name lvs-sfu --network host --ulimit nofile=65536:65536 --env-file /run/lvs-sfu.env ${imageRef}`,
      'EOS',
      'chmod 0755 /usr/local/bin/lvs-sfu-run',
      "cat > /etc/systemd/system/lvs-sfu.service <<'EOS'",
      '[Unit]',
      'Description=orgiq-lvs-sfu (mediasoup SFU)',
      'After=docker.service network-online.target',
      'Requires=docker.service',
      '[Service]',
      'ExecStart=/usr/local/bin/lvs-sfu-run',
      'ExecStop=/usr/bin/docker stop lvs-sfu',
      'Restart=always',
      'RestartSec=10',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOS',
      'systemctl daemon-reload',
      'systemctl enable --now lvs-sfu.service',
    );

    // ── Instance ───────────────────────────────────────────────────────────
    this.instance = new ec2.Instance(this, 'SfuInstance', {
      vpc: props.vpc,
      // One public subnet (the first AZ): a single SFU is single-AZ anyway.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      // Resolved from the public SSM parameter at deploy time — no context lookup.
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: this.securityGroup,
      role,
      userData,
      // A new digest (or env) must actually roll the host; user data only
      // runs on first boot, so an in-place update would change nothing.
      userDataCausesReplacement: true,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(20, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
      }],
      instanceName: `${prefix}-social-sfu`,
    });
    this.privateIp = this.instance.instancePrivateIp;

    new ec2.CfnEIPAssociation(this, 'SfuEipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SfuPublicIp', {
      value: eip.attrPublicIp,
      description: 'Elastic IP — announced by mediasoup; clients send media here',
      exportName: `${prefix}-social-sfu-public-ip`,
    });
    new cdk.CfnOutput(this, 'SfuPrivateIp', {
      value: this.instance.instancePrivateIp,
      description: 'platform-api VIDEO_API_URL host (http://<this>:3901)',
    });
    new cdk.CfnOutput(this, 'SfuInstanceId', {
      value: this.instance.instanceId,
      description: 'aws ssm start-session --target <this>',
    });
    new cdk.CfnOutput(this, 'SfuAllowedCidrs', {
      value: allowCidrs.length ? allowCidrs.join(',') : '(none — SFU accepts no media)',
      description: 'CIDRs permitted to send media to the SFU',
    });
  }
}
