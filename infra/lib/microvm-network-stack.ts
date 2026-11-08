import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as networkfirewall from 'aws-cdk-lib/aws-networkfirewall';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';
import { bedrockModelArns, resolveDevboxModels } from './devbox-stack';
import { GITHUB_EGRESS_CIDRS } from './github-ip-ranges';

/**
 * The only names a microVM session may reach on the internet
 * (docs/microvm-runner-design.md §5): clone, push and the API. Network Firewall
 * allows TLS to exactly these SNI values and DNS Firewall resolves exactly these
 * names (plus the in-VPC names below); everything else is dropped.
 */
export const MICROVM_EGRESS_DOMAINS: readonly string[] = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

/** The Suricata IP-set variable that holds GITHUB_EGRESS_CIDRS in the destination rule group. */
export const GITHUB_NETS_VARIABLE = 'GITHUB_NETS';

/** The private name the BFF callback answers on (`LAB_API_BASE`). */
export const microvmLabZoneName = (prefix: string): string => `lab.${prefix}.internal`;
/**
 * The BFF origin the microVM's lab broker forwards to: the runtime's
 * LAB_API_BASE and the middleware's MICROVM_LAB_API_BASE (which the dispatcher
 * puts in every boot payload). One function so the two can never disagree.
 */
export const microvmLabApiBase = (prefix: string): string => `https://${microvmLabZoneName(prefix)}`;

/** The Bedrock actions the role and the endpoint policy both allow. */
export const MICROVM_BEDROCK_ACTIONS: readonly string[] = [
  'bedrock:InvokeModel',
  'bedrock:InvokeModelWithResponseStream',
  'bedrock:CountTokens',
];

/** Stable export names the runtime stack imports (no hash-named exports to freeze). */
export const microvmNetworkExports = (prefix: string) => ({
  runtimeSubnetIds: `${prefix}-microvm-runtime-subnet-ids`,
  runtimeSecurityGroupId: `${prefix}-microvm-runtime-sg-id`,
  endpointSecurityGroupId: `${prefix}-microvm-endpoint-sg-id`,
  bedrockEndpointId: `${prefix}-microvm-bedrock-endpoint-id`,
});

export interface MicrovmNetworkStackProps extends cdk.StackProps {
  readonly prefix?: string;
  /**
   * The BFF's load balancer. When set, `lab.<prefix>.internal` is an alias to it
   * and the runtime SG may reach `albSecurityGroup` on 443. Optional so the
   * stack synthesises alone. It must be reachable from this VPC (same VPC,
   * peering or a transit gateway) for the SG reference to deploy; see
   * infra/SECURITY-NOTES.md "microVM runner".
   */
  readonly alb?: elbv2.IApplicationLoadBalancer;
  readonly albSecurityGroup?: ec2.ISecurityGroup;
}

/**
 * OrgIQ-MicrovmNetwork: the egress allowlist the `orgiq_microvm` runtime runs
 * behind (docs/microvm-runner-design.md §5).
 *
 *   runtime subnets ──0.0.0.0/0──▶ firewall endpoint ──▶ NAT (public) ──▶ IGW
 *   public subnets  ──runtime CIDRs──▶ firewall endpoint (return path)
 *   bedrock-runtime  interface endpoint in the runtime subnets (never leaves the VPC)
 *
 * Network Firewall (strict order) drops port 80 first, then 443 to any address
 * outside GitHub's published ranges (GITHUB_EGRESS_CIDRS), then passes TLS whose
 * SNI is one of MICROVM_EGRESS_DOMAINS and drops everything else; DNS Firewall
 * answers NXDOMAIN for every name not on the same list.
 */
export class MicrovmNetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly runtimeSubnets: ec2.ISubnet[];
  public readonly runtimeSecurityGroup: ec2.SecurityGroup;
  public readonly endpointSecurityGroup: ec2.SecurityGroup;
  public readonly bedrockEndpoint: ec2.InterfaceVpcEndpoint;
  public readonly labZone: route53.PrivateHostedZone;
  public readonly egressLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: MicrovmNetworkStackProps = {}) {
    super(scope, id, props);
    const prefix = props.prefix ?? 'orgiq';
    if (!!props.alb !== !!props.albSecurityGroup) {
      throw new Error('MicrovmNetworkStack: pass alb and albSecurityGroup together, or neither');
    }

    // ── VPC: public (NAT), firewall (→ NAT), runtime (→ firewall) ───────────
    this.vpc = new ec2.Vpc(this, 'MicrovmVpc', {
      vpcName: `${prefix}-microvm-vpc`,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26 },
        // PRIVATE_WITH_EGRESS: CDK routes these to the NAT gateway, which is
        // exactly the firewall subnets' route.
        { name: 'firewall', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 28 },
        // ISOLATED: no route CDK adds; the only default route is the firewall's (below).
        { name: 'runtime', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const firewallSubnets = this.vpc.selectSubnets({ subnetGroupName: 'firewall' }).subnets;
    this.runtimeSubnets = this.vpc.selectSubnets({ subnetGroupName: 'runtime' }).subnets;

    // ── Egress log group (flow + alert) ─────────────────────────────────────
    this.egressLogGroup = new logs.LogGroup(this, 'EgressLogGroup', {
      logGroupName: `/${prefix}/microvm/egress`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Network Firewall ────────────────────────────────────────────────────
    // Port 80 is dropped outright, before the TCP handshake, at the highest priority.
    const denyPlainHttp = new networkfirewall.CfnRuleGroup(this, 'DenyPlainHttpRuleGroup', {
      ruleGroupName: `${prefix}-microvm-deny-http`,
      type: 'STATEFUL',
      capacity: 10,
      description: 'Drop all plain HTTP (port 80) from the microVM subnets',
      ruleGroup: {
        rulesSource: {
          rulesString: 'drop tcp $HOME_NET any -> $EXTERNAL_NET 80 (msg:"microvm: plain http dropped"; sid:1000080; rev:1;)',
        },
        statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
      },
    });
    // Destination allowlist, ahead of the SNI group (sweep 4 M2). SNI is what
    // the client SAYS; nothing checks the server is GitHub, so a run that knows
    // an IP could open TLS to it with SNI=github.com. Every 443 flow to an
    // address outside GitHub's published ranges (lib/github-ip-ranges.ts,
    // embedded and dated, refreshed by scripts/refresh-github-ip-ranges.mjs) is
    // dropped on its first packet, before the SNI group can pass it. The
    // endpoint and the BFF are reached inside the VPC (or by a peering route)
    // and never cross this firewall.
    const githubDestinations = new networkfirewall.CfnRuleGroup(this, 'GithubDestinationRuleGroup', {
      ruleGroupName: `${prefix}-microvm-github-destinations`,
      type: 'STATEFUL',
      capacity: 10,
      description: "Drop TLS (443) to any address outside GitHub's published git/web/api ranges",
      ruleGroup: {
        ruleVariables: { ipSets: { [GITHUB_NETS_VARIABLE]: { definition: [...GITHUB_EGRESS_CIDRS] } } },
        rulesSource: {
          rulesString: `drop tcp $HOME_NET any -> !$${GITHUB_NETS_VARIABLE} 443 (msg:"microvm: 443 outside GitHub's published ranges"; sid:1000443; rev:1;)`,
        },
        statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
      },
    });
    // Domain allowlist on TLS SNI. ALLOWLIST generates pass rules for these
    // names and drops other TLS; the policy's default drops everything else.
    const sniAllowlist = new networkfirewall.CfnRuleGroup(this, 'SniAllowlistRuleGroup', {
      ruleGroupName: `${prefix}-microvm-sni-allowlist`,
      type: 'STATEFUL',
      capacity: 100,
      description: 'Allow TLS only to the GitHub names the runner clones and pushes through',
      ruleGroup: {
        rulesSource: {
          rulesSourceList: {
            targets: [...MICROVM_EGRESS_DOMAINS],
            targetTypes: ['TLS_SNI'],
            generatedRulesType: 'ALLOWLIST',
          },
        },
        statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
      },
    });
    const policy = new networkfirewall.CfnFirewallPolicy(this, 'EgressFirewallPolicy', {
      firewallPolicyName: `${prefix}-microvm-egress`,
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulEngineOptions: { ruleOrder: 'STRICT_ORDER' },
        // drop_established, not drop_strict: the TCP handshake must complete so
        // the TLS ClientHello (and its SNI) can be inspected; every established
        // flow no rule passed is then dropped and alerted.
        statefulDefaultActions: ['aws:drop_established', 'aws:alert_established'],
        statefulRuleGroupReferences: [
          { resourceArn: denyPlainHttp.attrRuleGroupArn, priority: 10 },
          { resourceArn: githubDestinations.attrRuleGroupArn, priority: 15 },
          { resourceArn: sniAllowlist.attrRuleGroupArn, priority: 20 },
        ],
      },
    });
    const firewall = new networkfirewall.CfnFirewall(this, 'EgressFirewall', {
      firewallName: `${prefix}-microvm-egress`,
      firewallPolicyArn: policy.attrFirewallPolicyArn,
      vpcId: this.vpc.vpcId,
      subnetMappings: firewallSubnets.map((s) => ({ subnetId: s.subnetId })),
      deleteProtection: false,
      description: 'Egress allowlist for the orgiq_microvm runtime',
    });
    new networkfirewall.CfnLoggingConfiguration(this, 'EgressFirewallLogging', {
      firewallArn: firewall.attrFirewallArn,
      loggingConfiguration: {
        logDestinationConfigs: ['FLOW', 'ALERT'].map((logType) => ({
          logType,
          logDestinationType: 'CloudWatchLogs',
          logDestination: { logGroup: this.egressLogGroup.logGroupName },
        })),
      },
    });

    // Routes. EndpointIds is an unordered list of "az:vpce-id", so the AZ of
    // each entry is not knowable with intrinsics; every route uses the first
    // endpoint, which keeps the path symmetric (out and back through the same
    // endpoint) at the cost of cross-AZ traffic for one of the two subnets.
    const firewallEndpointId = cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.select(0, firewall.attrEndpointIds)));
    this.runtimeSubnets.forEach((subnet, i) => {
      new ec2.CfnRoute(this, `RuntimeDefaultViaFirewall${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        vpcEndpointId: firewallEndpointId,
      }).addDependency(firewall);
      this.vpc.publicSubnets.forEach((pub, j) => {
        new ec2.CfnRoute(this, `ReturnViaFirewall${j}To${i}`, {
          routeTableId: pub.routeTable.routeTableId,
          destinationCidrBlock: subnet.ipv4CidrBlock,
          vpcEndpointId: firewallEndpointId,
        }).addDependency(firewall);
      });
    });

    // ── Security groups ─────────────────────────────────────────────────────
    this.runtimeSecurityGroup = new ec2.SecurityGroup(this, 'RuntimeSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-microvm-runtime`,
      description: 'orgiq_microvm sessions: no inbound; 443 to the Bedrock endpoint, the BFF and the firewall',
      allowAllOutbound: false,
    });
    this.endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${prefix}-microvm-bedrock-endpoint`,
      description: 'bedrock-runtime interface endpoint: 443 from the microVM runtime SG only',
      allowAllOutbound: false,
    });
    this.endpointSecurityGroup.addIngressRule(this.runtimeSecurityGroup, ec2.Port.tcp(443), 'microVM sessions to Bedrock');
    this.runtimeSecurityGroup.addEgressRule(this.endpointSecurityGroup, ec2.Port.tcp(443), 'Bedrock through the interface endpoint');
    // The only route for this rule is the firewall endpoint (above).
    this.runtimeSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'TLS through Network Firewall (GitHub allowlist)');
    if (props.albSecurityGroup) {
      this.runtimeSecurityGroup.addEgressRule(props.albSecurityGroup, ec2.Port.tcp(443), 'lab callback to the BFF');
      // In this stack, not via addIngressRule: that would put the rule in the
      // ALB's stack and make the two stacks reference each other.
      new ec2.CfnSecurityGroupIngress(this, 'AlbIngressFromRuntime', {
        groupId: props.albSecurityGroup.securityGroupId,
        sourceSecurityGroupId: this.runtimeSecurityGroup.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        description: 'lab callback from microVM sessions',
      });
    }

    // ── Bedrock interface endpoint ──────────────────────────────────────────
    const { allowedModels } = resolveDevboxModels(this);
    const modelArns = allowedModels.flatMap((m) => bedrockModelArns(this.region, this.account, m));
    this.bedrockEndpoint = new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      privateDnsEnabled: true,
      subnets: { subnets: this.runtimeSubnets },
      securityGroups: [this.endpointSecurityGroup],
      open: false,
    });
    // A credential used from inside the VPC meets this AND the role policy.
    this.bedrockEndpoint.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeConfiguredModels',
      principals: [new iam.AnyPrincipal()],
      actions: [...MICROVM_BEDROCK_ACTIONS],
      resources: modelArns,
      conditions: { StringEquals: { 'aws:PrincipalAccount': this.account } },
    }));

    // ── DNS Firewall: allow the list, NXDOMAIN for everything else ──────────
    const githubNames = new route53resolver.CfnFirewallDomainList(this, 'DnsAllowGithub', {
      name: `${prefix}-microvm-github`,
      domains: [...MICROVM_EGRESS_DOMAINS],
    });
    // Names that resolve inside the VPC and never cross Network Firewall: the
    // endpoint's private DNS and the BFF's private zone. Blocking them would
    // take Bedrock and the lab loop down with everything else.
    const inVpcNames = new route53resolver.CfnFirewallDomainList(this, 'DnsAllowInVpc', {
      name: `${prefix}-microvm-in-vpc`,
      domains: [`bedrock-runtime.${this.region}.amazonaws.com`, microvmLabZoneName(prefix)],
    });
    const everything = new route53resolver.CfnFirewallDomainList(this, 'DnsEverything', {
      name: `${prefix}-microvm-everything`,
      domains: ['*'],
    });
    const dnsRules = new route53resolver.CfnFirewallRuleGroup(this, 'DnsFirewallRuleGroup', {
      name: `${prefix}-microvm-dns`,
      firewallRules: [
        { priority: 100, action: 'ALLOW', firewallDomainListId: githubNames.attrId },
        { priority: 110, action: 'ALLOW', firewallDomainListId: inVpcNames.attrId },
        { priority: 900, action: 'BLOCK', blockResponse: 'NXDOMAIN', firewallDomainListId: everything.attrId },
      ],
    });
    new route53resolver.CfnFirewallRuleGroupAssociation(this, 'DnsFirewallAssociation', {
      name: `${prefix}-microvm-dns`,
      firewallRuleGroupId: dnsRules.attrId,
      vpcId: this.vpc.vpcId,
      priority: 101,
    });

    // ── lab.<prefix>.internal → the BFF ─────────────────────────────────────
    // The ACM certificate for this name is out of scope here: the BFF's HTTPS
    // listener needs one (private CA or an imported cert) before
    // LAB_API_BASE=https://lab.<prefix>.internal verifies.
    this.labZone = new route53.PrivateHostedZone(this, 'LabZone', {
      zoneName: microvmLabZoneName(prefix),
      vpc: this.vpc,
      comment: 'The BFF callback for orgiq_microvm sessions (LAB_API_BASE)',
    });
    if (props.alb) {
      new route53.ARecord(this, 'LabAlias', {
        zone: this.labZone,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(props.alb)),
      });
    }

    // ── Exports for OrgIQ-MicrovmRuntime ────────────────────────────────────
    const ex = microvmNetworkExports(prefix);
    new cdk.CfnOutput(this, 'RuntimeSubnetIds', {
      value: cdk.Fn.join(',', this.runtimeSubnets.map((s) => s.subnetId)),
      exportName: ex.runtimeSubnetIds,
    });
    new cdk.CfnOutput(this, 'RuntimeSecurityGroupId', {
      value: this.runtimeSecurityGroup.securityGroupId,
      exportName: ex.runtimeSecurityGroupId,
    });
    new cdk.CfnOutput(this, 'EndpointSecurityGroupId', {
      value: this.endpointSecurityGroup.securityGroupId,
      exportName: ex.endpointSecurityGroupId,
    });
    new cdk.CfnOutput(this, 'BedrockEndpointId', {
      value: this.bedrockEndpoint.vpcEndpointId,
      exportName: ex.bedrockEndpointId,
    });
  }
}
