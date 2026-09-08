/**
 * OrgIQ-MiddlewareService — the three ways this service has already shipped broken.
 *
 *  1. x86_64 default        → tasks died with `exec format error`, replaced in a
 *                             loop, stack sat in UPDATE_IN_PROGRESS, nothing in
 *                             the ECS events named an architecture.
 *  2. openListener: true    → this account's Cloud Custodian
 *                             (`custodian-restrict-security-group-admin-ingress`)
 *                             revoked 0.0.0.0/0 six seconds after CloudFormation
 *                             authorised it, with no stack event and no drift.
 *                             Task running, target group healthy, ALB unreachable.
 *  3. service + empty repo  → the Fargate service could not pull, the circuit
 *                             breaker tripped, the failed-stack cleanup deleted
 *                             the repo along with the image just pushed into it.
 *
 * This file is deliberately written against *behaviour* (what the template says
 * about ingress, architecture and desired count), not line numbers — the stack
 * source is under active change by other work.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { middlewareServiceStack } from './helpers/stacks';

const CERT_ARN = 'arn:aws:acm:us-east-1:111111111111:certificate/abc-123';

const closed = middlewareServiceStack();
const closedTemplate = Template.fromStack(closed);

function containerDefinition(template: Template): any {
  const taskDefs = Object.values<any>(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(taskDefs.length, 1, 'expected one task definition');
  const containers = taskDefs[0].Properties.ContainerDefinitions as any[];
  const middleware = containers.find((c) => c.Name === 'middleware');
  assert.ok(middleware, 'no container named "middleware"');
  return middleware;
}

describe('the middleware task must be ARM64', () => {
  test('RuntimePlatform pins ARM64/LINUX — Fargate defaults to x86_64 and the image is arm64', () => {
    // Symptom when this regresses: task starts, entrypoint fails with
    // `exec format error`, ECS replaces it forever, stack never settles.
    closedTemplate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RuntimePlatform: {
        CpuArchitecture: 'ARM64',
        OperatingSystemFamily: 'LINUX',
      },
    });
  });
});

describe('the load balancer is never opened to 0.0.0.0/0', () => {
  test('no ingress rule allows 0.0.0.0/0 when no albAllowCidr is given', () => {
    // Re-adding the open rule just loses the same race with custodian again.
    const openAnywhere: string[] = [];
    for (const [id, sg] of Object.entries(closedTemplate.findResources('AWS::EC2::SecurityGroup'))) {
      for (const rule of (sg.Properties?.SecurityGroupIngress ?? []) as any[]) {
        if (rule?.CidrIp === '0.0.0.0/0' || rule?.CidrIpv6 === '::/0') openAnywhere.push(id);
      }
    }
    for (const [id, rule] of Object.entries(
      closedTemplate.findResources('AWS::EC2::SecurityGroupIngress'),
    )) {
      if (rule.Properties?.CidrIp === '0.0.0.0/0' || rule.Properties?.CidrIpv6 === '::/0') {
        openAnywhere.push(id);
      }
    }
    assert.deepEqual(
      openAnywhere,
      [],
      'openListener must stay false: custodian revokes open ingress within seconds, silently',
    );
  });

  test('synth WARNS when the load balancer would accept no traffic', () => {
    // A closed ALB looks exactly like a broken deploy. The stack is the only
    // thing that knows the difference, so it has to say so at synth time.
    Annotations.fromStack(closed).hasWarning(
      '*',
      Match.stringLikeRegexp('albAllowCidr'),
    );
  });

  test('albAllowCidr opens exactly the CIDRs given, on the listener port', () => {
    const allowed = middlewareServiceStack({ albAllowCidr: '203.0.113.4/32,198.51.100.0/24' });
    const t = Template.fromStack(allowed);
    for (const cidr of ['203.0.113.4/32', '198.51.100.0/24']) {
      t.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ CidrIp: cidr, FromPort: 80, ToPort: 80, IpProtocol: 'tcp' }),
        ]),
      });
    }
    Annotations.fromStack(allowed).hasNoWarning('*', Match.stringLikeRegexp('albAllowCidr'));
  });

  test('with a certificate the allowed CIDRs are opened on 443, not 80', () => {
    const t = Template.fromStack(
      middlewareServiceStack({ albAllowCidr: '203.0.113.4/32' }, { certificateArn: CERT_ARN }),
    );
    t.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: '203.0.113.4/32', FromPort: 443, ToPort: 443 }),
      ]),
    });
  });
});

describe('two-phase deploy: the repo exists before anything tries to pull from it', () => {
  test('phase one leaves DesiredCount at 0', () => {
    // The L2 pattern refuses desiredCount 0, so it is forced on the CfnService.
    // Without this the service pulls from an empty repo on the first deploy,
    // the circuit breaker trips, and the failed-stack cleanup takes the repo.
    closedTemplate.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
  });

  test('phase two (--context deployMiddlewareService=true) scales it up', () => {
    const t = Template.fromStack(middlewareServiceStack({ deployMiddlewareService: 'true' }));
    t.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });

  test('the ECR repo is RETAIN and does NOT empty on delete — deleting a failed stack must not eat the image', () => {
    const repos = Object.entries(closedTemplate.findResources('AWS::ECR::Repository'));
    assert.equal(repos.length, 1);
    const [id, repo] = repos[0]!;
    assert.equal(repo.DeletionPolicy, 'Retain', `${id}: repo must survive a failed-stack delete`);
    // emptyOnDelete: true would synthesise the ECR auto-delete custom resource.
    closedTemplate.resourceCountIs('Custom::ECRAutoDeleteImages', 0);
  });

  test('the deployment circuit breaker rolls back rather than churning forever', () => {
    closedTemplate.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
    });
  });

  test('a single-task service is never taken to zero during a rolling update', () => {
    closedTemplate.hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100 }),
    });
  });
});

describe('machine-callback secrets are injected, never baked into the task definition', () => {
  // These three flip requireServiceAuth / requireTraceAuth /
  // requireRunCompleteAuth from open to required the moment this stack
  // deploys. They must arrive as ECS secrets (pulled at task start by the
  // execution role), not as plaintext env in the task definition — a task
  // definition is readable by anyone with ecs:DescribeTaskDefinition.
  const names = [
    'APPROVALS_REQUEST_SECRET',
    'HARNESS_TRACE_SECRET',
    'ASSESSMENT_RUN_COMPLETE_SECRET',
  ];
  for (const name of names) {
    test(`${name} is an ECS secret and absent from plaintext Environment`, () => {
      const container = containerDefinition(closedTemplate);
      const secretNames = ((container.Secrets ?? []) as any[]).map((s) => s.Name);
      const envNames = ((container.Environment ?? []) as any[]).map((e) => e.Name);
      assert.ok(secretNames.includes(name), `${name} must be in ContainerDefinitions[].Secrets`);
      assert.ok(!envNames.includes(name), `${name} must not be plaintext in Environment`);
    });
  }

  test('each secret is generated, not a literal in the template', () => {
    for (const secretName of [
      'orgiq-approvals-request-secret',
      'orgiq-harness-trace-secret',
      'orgiq-assessment-run-complete-secret',
    ]) {
      closedTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
        Name: secretName,
        GenerateSecretString: Match.objectLike({ PasswordLength: 40 }),
      });
    }
  });

  test('the Cognito client secret is injected the same way when wired', () => {
    const container = containerDefinition(closedTemplate);
    const envNames = ((container.Environment ?? []) as any[]).map((e) => e.Name);
    assert.ok(
      !envNames.includes('COGNITO_CLIENT_SECRET'),
      'the OIDC client secret must never be plaintext task-definition env',
    );
  });
});

describe('routing and health', () => {
  test('tasks are not publicly addressable; only the ALB is', () => {
    closedTemplate.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      }),
    });
    closedTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
    });
  });

  test('the target group health check hits /health, which is what the app serves', () => {
    closedTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health',
      Matcher: { HttpCode: '200' },
    });
  });

  test('without a certificate the listener is plain HTTP on 80', () => {
    closedTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  test('with a certificate there is an HTTPS listener AND an 80→443 redirect', () => {
    const t = Template.fromStack(middlewareServiceStack({}, { certificateArn: CERT_ARN }));
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: Match.arrayWith([
        Match.objectLike({ Type: 'redirect', RedirectConfig: Match.objectLike({ Port: '443' }) }),
      ]),
    });
  });
});

describe('IAM scoping that is easy to widen by accident', () => {
  test('devbox shell/stop permissions are scoped to devbox runtimes only', () => {
    // InvokeAgentRuntimeCommandShell on * would hand every runtime an
    // interactive PTY to whoever holds the middleware task role.
    const policies = Object.values<any>(closedTemplate.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p) => (p.Properties?.PolicyDocument?.Statement ?? []) as any[],
    );
    const devbox = statements.find((s) => s.Sid === 'DevboxCommandAndStop');
    assert.ok(devbox, 'expected a DevboxCommandAndStop statement');
    assert.ok(
      !JSON.stringify(devbox.Resource).includes('"*"'),
      'devbox command/stop must not be granted on *',
    );
    assert.ok(
      JSON.stringify(devbox.Resource).includes('orgiq_devbox'),
      'devbox command/stop must be scoped to the orgiq_devbox runtime',
    );
  });

  test('iam:PassRole is limited to the KB service role, passed only to Bedrock', () => {
    const statements = Object.values<any>(closedTemplate.findResources('AWS::IAM::Policy')).flatMap(
      (p) => (p.Properties?.PolicyDocument?.Statement ?? []) as any[],
    );
    const passRole = statements.filter((s) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('iam:PassRole'),
    );
    assert.ok(passRole.length > 0, 'expected an iam:PassRole statement');
    for (const s of passRole) {
      assert.ok(
        !JSON.stringify(s.Resource).includes('"*"'),
        'iam:PassRole on * lets the middleware hand any role to any service',
      );
      assert.deepEqual(s.Condition?.StringEquals?.['iam:PassedToService'], 'bedrock.amazonaws.com');
    }
  });
});
