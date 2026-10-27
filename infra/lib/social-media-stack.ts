import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { socialRepoName } from './social-images-stack';
import { realtimeAlarm, realtimeAlarmsEnabled, realtimeAlarmTopic } from './realtime-alarms';

export interface SfuPortPlan {
  readonly api: number;
  readonly rtcUdp: { readonly from: number; readonly to: number };
  readonly rtcTcp: { readonly from: number; readonly to: number };
  readonly workers: number;
}

/**
 * The SFU's port set, derived from its worker count. With mediasoup's
 * `WebRtcServer` each worker multiplexes every transport on ONE UDP and ONE
 * TCP port — worker N binds UDP 40000+N and TCP 40010+N (LVS
 * `WorkerPool.js`) — so N workers need exactly 2N media ports, not a
 * thousand-port range. mediasoup cannot announce a port different from the
 * one it binds, so these are also what the browser dials.
 *
 * Derived, never typed twice: `MEDIASOUP_WORKERS` and the security group come
 * from the same number. A worker whose port the group does not open fails ICE
 * only for the calls placed on it (capacity review §1). UDP and TCP are
 * separate port spaces, so a UDP range running past 40010 collides with
 * nothing.
 */
export function sfuPorts(workers = 2): SfuPortPlan {
  if (!Number.isInteger(workers) || workers < 1 || workers > 64) {
    throw new Error(`sfuWorkers must be an integer 1-64, got ${String(workers)}`);
  }
  return {
    api: 3901,
    rtcUdp: { from: 40000, to: 40000 + workers - 1 },
    rtcTcp: { from: 40010, to: 40010 + workers - 1 },
    workers,
  };
}

/** The default (two workers): UDP 40000-40001, TCP 40010-40011. */
export const SFU_PORTS: SfuPortPlan = sfuPorts(2);

/** coturn's ports when `deployTurn=true` (see the TURN section below). */
export const TURN_PORTS = { plain: 3478, tls: 443, relay: { from: 49152, to: 49651 } } as const;

/**
 * SSM parameters this stack writes the SFU host's private IP and instance id
 * to. OrgIQ-Social reads them BY NAME at deploy time instead of importing
 * them: the instance is REPLACED on every image or env change
 * (userDataCausesReplacement), which renames CDK's hash exports, and a
 * renamed export that OrgIQ-Social still imports makes this stack's update
 * fail with "Cannot delete export … in use" — every SFU image roll would have
 * wedged. A parameter changes value freely.
 */
export function sfuParameterNames(prefix: string): { privateIp: string; instanceId: string } {
  return { privateIp: `/${prefix}/social/sfu-private-ip`, instanceId: `/${prefix}/social/sfu-instance-id` };
}

/** The TURN shared secret (coturn `static-auth-secret` = LVS `LVS_TURN_STATIC_SECRET`). */
export function turnSecretName(prefix: string): string {
  return `${prefix}-social-turn-secret`;
}

/** Secrets the SFU owns; OrgIQ-Social imports them by these names. */
export function sfuSecretNames(prefix: string): { adminToken: string; webhook: string; serviceToken: string } {
  return {
    adminToken: `${prefix}-social-sfu-admin-token`,
    webhook: `${prefix}-social-sfu-webhook-secret`,
    serviceToken: `${prefix}-social-sfu-service-token`,
  };
}

export interface SocialMediaStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /** The OrgIQ-MiddlewareService VPC — the SFU sits in one of its public subnets. */
  readonly vpc: ec2.IVpc;
  /**
   * The OrgIQ Cognito pool. Optional since platform-api calls LVS's
   * /api/sessions lifecycle as a service (`LVS_SERVICE_TOKEN`, below): a
   * Cognito id_token presented directly to the SFU is still verified against
   * it when set.
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
  public readonly ports: SfuPortPlan;
  /** The TURN relay's Elastic IP, when `deployTurn=true`. */
  public readonly turnPublicIp?: string;
  public readonly securityGroup: ec2.SecurityGroup;
  /** The Elastic IP — also what mediasoup announces. */
  public readonly publicIp: string;
  public readonly privateIp: string;
  public readonly adminTokenSecret: secretsmanager.Secret;
  public readonly webhookSecret: secretsmanager.Secret;
  public readonly serviceTokenSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SocialMediaStackProps) {
    super(scope, id, props);
    const prefix = props.prefix ?? 'orgiq';
    const ctx = (k: string) => this.node.tryGetContext(k) as string | undefined;
    const flag = (k: string) => { const v = this.node.tryGetContext(k); return v === true || v === 'true'; };
    const posInt = (k: string): number | undefined => {
      const raw = this.node.tryGetContext(k);
      if (raw === undefined || raw === null || raw === '') return undefined;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${k} must be a positive integer, got ${String(raw)}`);
      return n;
    };

    // ── Size (capacity review §1, ranked change #3) ────────────────────────
    // Defaults stay the dev shape (t4g.small, two workers). The instance must
    // be Graviton: the AMI and the image are arm64. A burstable `t` family
    // throttles to its baseline once its credits run out — at real load that
    // freezes every call at once — so the 100-call profile names a `c7g`.
    // NOTE (upstream LVS, ranked change #5): today every transport lands on
    // worker 0, so extra workers idle until LVS places rooms across them; the
    // ports and the group are derived from the count regardless, so the day
    // that ships nothing here has to change.
    const instanceTypeName = ctx('sfuInstanceType') ?? 't4g.small';
    if (!/^[a-z]+\d+g[a-z]*\.[a-z0-9]+$/.test(instanceTypeName)) {
      throw new Error(`sfuInstanceType must be a Graviton (arm64) type such as t4g.small or c7g.2xlarge, got ${instanceTypeName}`);
    }
    const burstable = instanceTypeName.startsWith('t');
    this.ports = sfuPorts(posInt('sfuWorkers') ?? 2);
    const ports = this.ports;

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
    // platform-api calls LVS's session lifecycle (/api/sessions, /join, /end,
    // /refresh-token) as a SERVICE with this token instead of forwarding its
    // user's bearer (live-video-streaming cognito-auth.js, platform-api
    // lib/lvsServiceAuth.ts). Separate from ADMIN_TOKEN, which also opens the
    // SFU's debug and cluster surfaces.
    this.serviceTokenSecret = new secretsmanager.Secret(this, 'SfuServiceToken', {
      secretName: names.serviceToken,
      description: 'LVS LVS_SERVICE_TOKEN = platform-api VIDEO_SERVICE_TOKEN',
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
    const mediaPort = (proto: 'udp' | 'tcp') => (proto === 'udp'
      ? ec2.Port.udpRange(ports.rtcUdp.from, ports.rtcUdp.to)
      : ec2.Port.tcpRange(ports.rtcTcp.from, ports.rtcTcp.to));
    for (const cidr of allowCidrs) {
      const peer = cidr.includes(':') ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr);
      this.securityGroup.addIngressRule(peer, mediaPort('udp'), `RTC media (UDP) from ${cidr}`);
      // mediasoup's own TCP candidate — the fallback for networks that block UDP.
      this.securityGroup.addIngressRule(peer, mediaPort('tcp'), `RTC media (TCP fallback) from ${cidr}`);
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
      description: 'orgiq-lvs-sfu host: ECR pull, its three secrets, SSM Session Manager',
      managedPolicies: [
        // Shell access without an SSH port — nothing listens on 22.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    repo.grantPull(role);
    this.adminTokenSecret.grantRead(role);
    this.webhookSecret.grantRead(role);
    this.serviceTokenSecret.grantRead(role);

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
    // ── The SFU's Redis (capacity review §3, ranked change #1) ─────────────
    // platform-api's find-or-create DELEGATES to LVS: one lobby → one session
    // only through LVS's Redis `SET NX` on `session:byname:<lobby>`, and LVS
    // honours findOrCreate only while its session store is connected. With no
    // REDIS_URL it fell back to redis://localhost:6377 (nothing listens),
    // logged a warning, and gave EVERY joiner a fresh session: each person
    // alone in their own call, no error anywhere. So a Redis is the default,
    // not an option.
    //
    // A loopback Redis on the SFU host, not OrgIQ-Social's ElastiCache,
    // because nothing is shared through it: platform-api talks to LVS over
    // HTTP and never reads LVS's keys, and LVS reads none of platform-api's.
    // Loopback also (1) keeps LVS's unprefixed `session:*`/`quota:*`/
    // `channel*` keys out of the cache the middleware and platform-api use,
    // (2) has no deploy-order problem — this stack deploys BEFORE
    // OrgIQ-Social creates the ElastiCache — and (3) lives and dies with the
    // SFU, whose restart ends every transport anyway, so persistence would
    // only resurrect sessions with no media behind them. `sfuRedisUrl`
    // overrides (e.g. a shared Redis once LVS clustering is turned on).
    const redisOverride = ctx('sfuRedisUrl');
    const redisUrl = redisOverride ?? 'redis://127.0.0.1:6379';
    // ── LVS caps (verified against live-video-streaming's source) ──────────
    //   MAX_CONCURRENT_STREAMS  quotaEnforcer.js: default 50 per account,
    //       checked on every WHIP publish, enforced ONLY with Redis.
    //       Turning Redis on (above) arms it, and every caller is account
    //       'default' — so 50 publishers (25 two-person calls) would be the
    //       ceiling of the whole SFU. The pinned worker-placement release now
    //       treats 0 / unlimited as uncapped; keep the explicit 1000 default
    //       here for a bounded quota. `sfuMaxStreams` overrides.
    //   MAX_TRANSPORTS_PER_POD  TransportManager.js, default 1000, refuses at
    //       100%. Set only when `sfuMaxTransports` is given.
    //   ADMISSION_GATE_CAPACITY app.js, default 100 in-flight WHIP/WHEP
    //       negotiations. Set only when `sfuAdmissionCapacity` is given.
    const maxStreams = posInt('sfuMaxStreams') ?? 1000;
    const maxTransports = posInt('sfuMaxTransports');
    const admission = posInt('sfuAdmissionCapacity');
    const env: Array<[string, string]> = [
      ['NODE_ENV', 'production'],
      ['PORT', String(ports.api)],
      ['AWS_REGION', this.region],
      ['CLUSTER_ENABLED', 'false'],
      ['SEED_NODES', ''],
      ['MEDIASOUP_WORKERS', String(ports.workers)],
      ['MEDIASOUP_RTC_PORT', String(ports.rtcUdp.from)],
      ['MEDIASOUP_RTC_TCP_PORT', String(ports.rtcTcp.from)],
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
      ['REDIS_URL', redisUrl],
      ['MAX_CONCURRENT_STREAMS', String(maxStreams)],
      ...(maxTransports ? [['MAX_TRANSPORTS_PER_POD', String(maxTransports)]] as Array<[string, string]> : []),
      ...(admission ? [['ADMISSION_GATE_CAPACITY', String(admission)]] as Array<[string, string]> : []),
    ];
    const registry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;

    // ── TURN relay (opt-in: deployTurn=true; capacity review ranked change #6)
    const turn = flag('deployTurn') ? this.turnRelay(prefix, props.vpc, eip) : undefined;
    const sfuTurnLines: string[] = [];
    if (turn) {
      this.turnPublicIp = turn.publicIp;
      // LVS /api/ice-servers (src/api/ice-servers.js) mints coturn
      // use-auth-secret credentials from these two; the browser fetches them
      // from `<videoUrl>/api/ice-servers` (realtime-modules fetchIceServers).
      env.push(['LVS_TURN_URL', turn.urls]);
      sfuTurnLines.push(
        `LVS_TURN_STATIC_SECRET=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${turn.secret.secretArn} --query SecretString --output text)`,
      );
      turn.secret.grantRead(role);
      // coturn relays from ITS Elastic IP to the address mediasoup announces,
      // so the SFU must admit the relay's public address on the media ports.
      this.securityGroup.addIngressRule(ec2.Peer.ipv4(`${turn.publicIp}/32`), mediaPort('udp'), 'TURN relay to RTC media (UDP)');
      this.securityGroup.addIngressRule(ec2.Peer.ipv4(`${turn.publicIp}/32`), mediaPort('tcp'), 'TURN relay to RTC media (TCP)');
    }

    const userData = ec2.UserData.forLinux();
    // The SFU's loopback Redis (see "The SFU's Redis" above): AL2023's redis6
    // package when it installs, else the redis:7-alpine image. Bound to
    // 127.0.0.1, no persistence (the SFU's restart ends every transport
    // anyway), noeviction so a full cache refuses rather than drops a session.
    const redisSetup = redisOverride ? [] : [
      'dnf install -y redis6 || true',
      "cat > /usr/local/bin/lvs-redis-run <<'EOS'",
      '#!/bin/bash',
      'set -euo pipefail',
      'ARGS=(--bind 127.0.0.1 --port 6379 --protected-mode yes --save "" --appendonly no --maxmemory 512mb --maxmemory-policy noeviction)',
      'for bin in redis6-server redis-server; do',
      '  if command -v "$bin" >/dev/null 2>&1; then exec "$bin" "${ARGS[@]}"; fi',
      'done',
      'docker rm -f lvs-redis >/dev/null 2>&1 || true',
      'exec docker run --rm --name lvs-redis --network host redis:7-alpine redis-server "${ARGS[@]}"',
      'EOS',
      'chmod 0755 /usr/local/bin/lvs-redis-run',
      "cat > /etc/systemd/system/lvs-redis.service <<'EOS'",
      '[Unit]',
      'Description=Redis for the SFU session store (loopback only)',
      'After=docker.service network-online.target',
      '[Service]',
      'ExecStart=/usr/local/bin/lvs-redis-run',
      'DynamicUser=yes',
      'StateDirectory=lvs-redis',
      'WorkingDirectory=/var/lib/lvs-redis',
      'SupplementaryGroups=docker',
      'Restart=always',
      'RestartSec=5',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOS',
    ];
    userData.addCommands(
      'set -euo pipefail',
      'dnf install -y docker',
      'systemctl enable --now docker',
      ...redisSetup,
      "cat > /usr/local/bin/lvs-sfu-run <<'EOS'",
      '#!/bin/bash',
      'set -euo pipefail',
      'IMDS=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
      'PRIVATE_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS" http://169.254.169.254/latest/meta-data/local-ipv4)',
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${registry}`,
      `ADMIN_TOKEN=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${this.adminTokenSecret.secretArn} --query SecretString --output text)`,
      `WEBHOOK_HMAC_SECRET=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${this.webhookSecret.secretArn} --query SecretString --output text)`,
      `LVS_SERVICE_TOKEN=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${this.serviceTokenSecret.secretArn} --query SecretString --output text)`,
      ...sfuTurnLines,
      'umask 077',
      '{',
      ...env.map(([k, v]) => `  echo "${k}=${v}"`),
      '  echo "POD_IP=$PRIVATE_IP"',
      '  echo "MESH_ANNOUNCED_IP=$PRIVATE_IP"',
      '  echo "ADMIN_TOKEN=$ADMIN_TOKEN"',
      '  echo "WEBHOOK_HMAC_SECRET=$WEBHOOK_HMAC_SECRET"',
      '  echo "LVS_SERVICE_TOKEN=$LVS_SERVICE_TOKEN"',
      ...(turn ? ['  echo "LVS_TURN_STATIC_SECRET=$LVS_TURN_STATIC_SECRET"'] : []),
      '} > /run/lvs-sfu.env',
      'docker rm -f lvs-sfu >/dev/null 2>&1 || true',
      `exec docker run --name lvs-sfu --network host --ulimit nofile=65536:65536 --env-file /run/lvs-sfu.env ${imageRef}`,
      'EOS',
      'chmod 0755 /usr/local/bin/lvs-sfu-run',
      "cat > /etc/systemd/system/lvs-sfu.service <<'EOS'",
      '[Unit]',
      'Description=orgiq-lvs-sfu (mediasoup SFU)',
      ...(redisOverride
        ? ['After=docker.service network-online.target', 'Requires=docker.service']
        : ['After=docker.service network-online.target lvs-redis.service', 'Requires=docker.service lvs-redis.service']),
      '[Service]',
      'ExecStart=/usr/local/bin/lvs-sfu-run',
      'ExecStop=/usr/bin/docker stop lvs-sfu',
      'Restart=always',
      'RestartSec=10',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOS',
      'systemctl daemon-reload',
      ...(redisOverride ? [] : ['systemctl enable --now lvs-redis.service']),
      'systemctl enable --now lvs-sfu.service',
    );

    // ── Instance ───────────────────────────────────────────────────────────
    this.instance = new ec2.Instance(this, 'SfuInstance', {
      vpc: props.vpc,
      // One public subnet (the first AZ): a single SFU is single-AZ anyway.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(instanceTypeName),
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
      // 1-minute metrics for the load alarms (≈$2/mo), only when they exist.
      ...(realtimeAlarmsEnabled(this) ? { detailedMonitoring: true } : {}),
    });
    this.privateIp = this.instance.instancePrivateIp;
    const sfuParams = sfuParameterNames(prefix);
    new ssm.StringParameter(this, 'SfuPrivateIpParameter', {
      parameterName: sfuParams.privateIp, stringValue: this.instance.instancePrivateIp,
      description: 'SFU host private IP (platform-api VIDEO_API_URL); OrgIQ-Social reads it by name',
    });
    new ssm.StringParameter(this, 'SfuInstanceIdParameter', {
      parameterName: sfuParams.instanceId, stringValue: this.instance.instanceId,
      description: 'SFU host instance id (the ALB target); OrgIQ-Social reads it by name',
    });

    // ── Auto-recovery (always) ─────────────────────────────────────────────
    // A failed SYSTEM status check (the host under the instance) recovers the
    // instance onto new hardware with the same id, private IP and EIP — the
    // announced address survives, so clients rejoin the same SFU. Nothing
    // else restarts this host on failure; the ALB health check only marks it.
    const recover = new cloudwatch.Alarm(this, 'SfuAutoRecoverAlarm', {
      alarmName: `${prefix}-social-sfu-auto-recover`,
      alarmDescription: 'SFU host failed its system status check — EC2 recover (same id, IP and EIP).',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2', metricName: 'StatusCheckFailed_System', statistic: 'Maximum',
        period: cdk.Duration.minutes(1), dimensionsMap: { InstanceId: this.instance.instanceId },
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    recover.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.RECOVER));

    // ── Load alarms (realtimeAlarms=true) ──────────────────────────────────
    if (realtimeAlarmsEnabled(this)) {
      const topic = realtimeAlarmTopic(this, prefix);
      recover.addAlarmAction(new cwActions.SnsAction(topic));
      const ec2Metric = (metricName: string, statistic: string) => new cloudwatch.Metric({
        namespace: 'AWS/EC2', metricName, statistic, period: cdk.Duration.minutes(1),
        dimensionsMap: { InstanceId: this.instance.instanceId },
      });
      const alarm = (spec: Parameters<typeof realtimeAlarm>[3]) => realtimeAlarm(this, prefix, topic, spec);
      alarm({ id: 'sfu-cpu', threshold: 70, evaluationPeriods: 5, metric: ec2Metric('CPUUtilization', 'Average'),
        description: 'SFU host CPU above 70% for 5 minutes. LVS runs every transport on worker 0 today, so one core saturates first.' });
      const netMbps = posInt('alarmSfuNetworkOutMbps') ?? (burstable ? 100 : 1000);
      alarm({ id: 'sfu-network-out', threshold: netMbps * 1e6 / 8 * 60, evaluationPeriods: 5,
        metric: ec2Metric('NetworkOut', 'Sum'),
        description: `SFU egress above ${netMbps} Mbps for 5 minutes (alarmSfuNetworkOutMbps).` });
      if (burstable) {
        alarm({ id: 'sfu-cpu-credits', threshold: 30, comparison: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: 3, metric: ec2Metric('CPUCreditBalance', 'Minimum'),
          description: 'Burstable SFU almost out of CPU credits — it will throttle to baseline and every call will stutter. Move to the 100-call profile.' });
      }
      alarm({ id: 'sfu-status-check', threshold: 1, comparison: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 2, metric: ec2Metric('StatusCheckFailed', 'Maximum'),
        description: 'SFU instance or system status check failing.' });
    }

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
    // Read back by deploy.sh's sticky context, so a later deploy keeps the
    // verified image instead of failing over to :latest.
    new cdk.CfnOutput(this, 'SfuImageDigest', {
      value: digest ?? '(none — :latest)',
      description: 'sfuImageDigest this stack was deployed with',
    });
    new cdk.CfnOutput(this, 'SfuMediaPorts', {
      value: `${instanceTypeName}, ${ports.workers} workers: UDP ${ports.rtcUdp.from}-${ports.rtcUdp.to}, TCP ${ports.rtcTcp.from}-${ports.rtcTcp.to}`,
      description: 'Instance type, worker count and the media ports the group opens',
    });
    if (turn) {
      new cdk.CfnOutput(this, 'TurnPublicIp', { value: turn.publicIp, description: 'coturn relay Elastic IP' });
      new cdk.CfnOutput(this, 'TurnUrls', { value: turn.urls, description: 'LVS_TURN_URL handed to browsers via /api/ice-servers' });
    }
  }

  /**
   * coturn on its own small ARM64 instance with an Elastic IP — the relay for
   * networks that let nothing out but TCP 443 (capacity review §1 "No TURN").
   *
   * Why its own host and not a container beside the SFU: TURN is the piece
   * that has to face the whole internet, so it gets its own security group
   * (and its own custodian question) instead of widening the SFU's.
   *
   * Listeners:
   *   - 3478 UDP+TCP, plain TURN — the fast path for networks that allow it;
   *   - 443/TCP — without a certificate, PLAIN TURN over TCP on 443. That
   *     passes firewalls that filter by port; it does NOT pass a proxy that
   *     inspects for TLS. With `turnTlsDomain` + `turnTlsCertSecretName` (a
   *     Secrets Manager secret holding JSON {"cert": <PEM chain>, "key":
   *     <PEM key>} for that domain), 443 is TURN over TLS (`turns:`), which
   *     passes both. A browser checks the certificate against the hostname
   *     in the `turns:` URL, so TLS needs a DNS name pointing at the TURN EIP
   *     and a certificate for it: neither CloudFront (HTTP only) nor ACM
   *     (keys are not exportable to an instance) can supply that in the
   *     no-domain path.
   *   - relay ports 49152-49651 UDP, admitted from the SFU's EIP only (the
   *     one peer allowed — `allowed-peer-ip`, private ranges denied).
   *
   * Ingress: `turnAllowCidr`, like `sfuAllowCidr`. The custodian question is
   * the same as the SFU's (deploy plan §3): `0.0.0.0/0` on 443/3478 is what
   * real users need, the custodian may revoke it within seconds, and that is
   * an owner decision — measure it, or get the exception.
   */
  private turnRelay(prefix: string, vpc: ec2.IVpc, sfuEip: ec2.CfnEIP): {
    publicIp: string; urls: string; secret: secretsmanager.Secret;
  } {
    const ctx = (k: string) => this.node.tryGetContext(k) as string | undefined;
    const secret = new secretsmanager.Secret(this, 'TurnSecret', {
      secretName: turnSecretName(prefix),
      description: 'coturn static-auth-secret = LVS LVS_TURN_STATIC_SECRET',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });
    const sg = new ec2.SecurityGroup(this, 'TurnSecurityGroup', {
      vpc,
      securityGroupName: `${prefix}-social-turn`,
      description: 'coturn TURN relay - allowlisted CIDRs only (turnAllowCidr)',
      allowAllOutbound: true,
    });
    const allowRaw = this.node.tryGetContext('turnAllowCidr');
    const allow = typeof allowRaw === 'string' ? allowRaw.split(',').map((c) => c.trim()).filter(Boolean) : [];
    for (const cidr of allow) {
      const peer = cidr.includes(':') ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr);
      sg.addIngressRule(peer, ec2.Port.udp(TURN_PORTS.plain), `TURN (UDP) from ${cidr}`);
      sg.addIngressRule(peer, ec2.Port.tcp(TURN_PORTS.plain), `TURN (TCP) from ${cidr}`);
      sg.addIngressRule(peer, ec2.Port.tcp(TURN_PORTS.tls), `TURN on 443 from ${cidr}`);
    }
    if (allow.length === 0) {
      cdk.Annotations.of(this).addWarning('deployTurn=true without turnAllowCidr — the TURN relay accepts nobody. '
        + 'Real users need 0.0.0.0/0 on 443/3478, which the account custodian may revoke (deploy plan §3/§11).');
    }
    if (allow.some((c) => c === '0.0.0.0/0' || c === '::/0')) {
      cdk.Annotations.of(this).addWarning('turnAllowCidr includes an open range — custodian-restrict-security-group-admin-ingress '
        + 'may revoke it within seconds, silently. Read the group\'s IpPermissions after deploy.');
    }
    // The relayed leg: the SFU sends media back to the relay's allocated port.
    sg.addIngressRule(ec2.Peer.ipv4(`${sfuEip.attrPublicIp}/32`),
      ec2.Port.udpRange(TURN_PORTS.relay.from, TURN_PORTS.relay.to), 'SFU to TURN relay ports');

    const eip = new ec2.CfnEIP(this, 'TurnEip', { domain: 'vpc', tags: [{ key: 'Name', value: `${prefix}-social-turn` }] });

    const tlsDomain = ctx('turnTlsDomain');
    const tlsSecretName = ctx('turnTlsCertSecretName');
    if (Boolean(tlsDomain) !== Boolean(tlsSecretName)) {
      throw new Error('turnTlsDomain and turnTlsCertSecretName go together (a certificate is only valid for a name)');
    }
    const tlsSecret = tlsSecretName ? secretsmanager.Secret.fromSecretNameV2(this, 'TurnTlsCert', tlsSecretName) : undefined;
    const image = ctx('turnImage') ?? 'coturn/coturn:4.6.3';

    const role = new iam.Role(this, 'TurnInstanceRole', {
      roleName: `${prefix}-social-turn-instance-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'coturn host: its auth secret (and TLS cert), SSM Session Manager',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    secret.grantRead(role);
    tlsSecret?.grantRead(role);

    const conf = [
      'fingerprint',
      'use-auth-secret',
      'static-auth-secret=$TURN_SECRET',
      `realm=${prefix}-turn`,
      'external-ip=$EXTERNAL_IP/$PRIVATE_IP',
      `min-port=${TURN_PORTS.relay.from}`,
      `max-port=${TURN_PORTS.relay.to}`,
      // The SFU is the only legitimate peer; never relay into private space.
      'no-multicast-peers',
      'denied-peer-ip=0.0.0.0-0.255.255.255',
      'denied-peer-ip=10.0.0.0-10.255.255.255',
      'denied-peer-ip=100.64.0.0-100.127.255.255',
      'denied-peer-ip=127.0.0.0-127.255.255.255',
      'denied-peer-ip=169.254.0.0-169.254.255.255',
      'denied-peer-ip=172.16.0.0-172.31.255.255',
      'denied-peer-ip=192.168.0.0-192.168.255.255',
      'no-cli',
      'no-tlsv1',
      'no-tlsv1_1',
      'log-file=stdout',
      'simple-log',
      ...(tlsSecret
        ? [`listening-port=${TURN_PORTS.plain}`, `tls-listening-port=${TURN_PORTS.tls}`, 'cert=/etc/coturn/cert.pem', 'pkey=/etc/coturn/key.pem']
        : [`listening-port=${TURN_PORTS.tls}`, `alt-listening-port=${TURN_PORTS.plain}`, 'no-tls', 'no-dtls']),
    ];
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'dnf install -y docker jq',
      'systemctl enable --now docker',
      "cat > /usr/local/bin/coturn-run <<'EOS'",
      '#!/bin/bash',
      'set -euo pipefail',
      'IMDS=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
      'PRIVATE_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS" http://169.254.169.254/latest/meta-data/local-ipv4)',
      `EXTERNAL_IP=${eip.attrPublicIp}`,
      `TURN_SECRET=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${secret.secretArn} --query SecretString --output text)`,
      'umask 077',
      'mkdir -p /etc/coturn',
      ...(tlsSecret ? [
        `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${tlsSecretName} --query SecretString --output text > /run/turn-tls.json`,
        'jq -r .cert /run/turn-tls.json > /etc/coturn/cert.pem',
        'jq -r .key /run/turn-tls.json > /etc/coturn/key.pem',
        'rm -f /run/turn-tls.json',
      ] : []),
      'cat > /etc/coturn/turnserver.conf <<EOC',
      ...conf,
      'EOC',
      'docker rm -f coturn >/dev/null 2>&1 || true',
      // root inside the container: the image defaults to `nobody`, which cannot bind 443.
      `exec docker run --name coturn --network host --user 0:0 --ulimit nofile=65536:65536 -v /etc/coturn:/etc/coturn:ro ${image} -c /etc/coturn/turnserver.conf`,
      'EOS',
      'chmod 0755 /usr/local/bin/coturn-run',
      "cat > /etc/systemd/system/coturn.service <<'EOS'",
      '[Unit]',
      'Description=coturn TURN relay',
      'After=docker.service network-online.target',
      'Requires=docker.service',
      '[Service]',
      'ExecStart=/usr/local/bin/coturn-run',
      'ExecStop=/usr/bin/docker stop coturn',
      'Restart=always',
      'RestartSec=10',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOS',
      'systemctl daemon-reload',
      'systemctl enable --now coturn.service',
    );
    const instance = new ec2.Instance(this, 'TurnInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(ctx('turnInstanceType') ?? 't4g.small'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: sg,
      role,
      userData,
      userDataCausesReplacement: true,
      requireImdsv2: true,
      instanceName: `${prefix}-social-turn`,
    });
    new ec2.CfnEIPAssociation(this, 'TurnEipAssociation', { allocationId: eip.attrAllocationId, instanceId: instance.instanceId });
    const turnRecover = new cloudwatch.Alarm(this, 'TurnAutoRecoverAlarm', {
      alarmName: `${prefix}-social-turn-auto-recover`,
      alarmDescription: 'TURN host failed its system status check — EC2 recover.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2', metricName: 'StatusCheckFailed_System', statistic: 'Maximum',
        period: cdk.Duration.minutes(1), dimensionsMap: { InstanceId: instance.instanceId },
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    turnRecover.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.RECOVER));

    // What browsers are told (LVS expands an un-pinned URL to udp + tcp).
    const urls = [
      `turn:${eip.attrPublicIp}:${TURN_PORTS.plain}`,
      tlsDomain ? `turns:${tlsDomain}:${TURN_PORTS.tls}?transport=tcp` : `turn:${eip.attrPublicIp}:${TURN_PORTS.tls}?transport=tcp`,
    ].join(',');
    return { publicIp: eip.attrPublicIp, urls, secret };
  }
}
