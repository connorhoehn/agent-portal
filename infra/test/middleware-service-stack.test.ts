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
  // These flip requireServiceAuth / requireTraceAuth / requireRunCompleteAuth
  // and the lab guard from open to required the moment this stack deploys.
  // They must arrive as ECS secrets (pulled at task start by the execution
  // role), not as plaintext env in the task definition — a task definition is
  // readable by anyone with ecs:DescribeTaskDefinition.
  //
  // LAB_CALLBACK_SECRET was the late addition: `lib/service-auth.ts` had always
  // declared the spec and `routes/lab.ts` had always guarded on it, but nothing
  // minted it — so of the five specs the module defines, it was the one whose
  // guard could never close in a deployed environment, leaving the lab consult
  // routes reachable by anything that could route to the service.
  const names = [
    'APPROVALS_REQUEST_SECRET',
    'HARNESS_TRACE_SECRET',
    'ASSESSMENT_RUN_COMPLETE_SECRET',
    'LAB_CALLBACK_SECRET',
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
      'orgiq-lab-callback-secret',
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

describe('the Claude price table (DE-32)', () => {
  test('the task role may read parameter/orgiq/pricing/* and nothing more under it', () => {
    const policies = Object.values<any>(closedTemplate.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap((p) => (p.Properties?.PolicyDocument?.Statement ?? []) as any[]);
    const pricing = statements.find((s) => s.Sid === 'PricingParameters');
    assert.ok(pricing, 'no PricingParameters statement on the task role');
    assert.deepEqual([pricing.Action].flat(), ['ssm:GetParameter'], 'read-only: a task must not rewrite the rates');
    const resources = JSON.stringify(pricing.Resource);
    assert.match(resources, /parameter\/orgiq\/pricing\/\*/, 'the grant must be scoped to /orgiq/pricing/*');
  });

  test('money and service auth fail closed in the task definition (work item 16)', () => {
    const container = containerDefinition(closedTemplate);
    const env = Object.fromEntries(((container.Environment ?? []) as any[]).map((e) => [e.Name, e.Value]));
    assert.equal(env.SPEND_HOLDS_UNATTRIBUTED, 'actor'); // 'refuse' once chat and /summarize attribute spend (docs/spend-map.md)
    assert.equal(env.BUDGET_FAIL_CLOSED, 'true');
    assert.equal(env.SERVICE_AUTH_LEGACY_HEADERS, 'refuse');
  });

  test('the container is told which parameter holds the table', () => {
    const container = containerDefinition(closedTemplate);
    const env = Object.fromEntries(((container.Environment ?? []) as any[]).map((e) => [e.Name, e.Value]));
    assert.equal(env.MODEL_PRICES_PARAM, '/orgiq/pricing/model_prices');
  });
});

describe('the task never runs in insecure development mode (docs/fail-open-audit.md §2)', () => {
  // INSECURE_DEV_MODE=true is the one switch that opens the middleware's
  // security defaults (dev signing keys, seed-policy authz, open callbacks,
  // localhost origins). It belongs to laptops and compose files, never a task.
  const variants: Array<[string, Template]> = [
    ['default', closedTemplate],
    ['portal + http origin', Template.fromStack(middlewareServiceStack({ deployPortal: 'true', allowHttpOrigin: 'true', cloudFrontPrefixListId: 'pl-3b927c52' }))],
  ];
  for (const [name, template] of variants) {
    test(`${name}: INSECURE_DEV_MODE appears nowhere in the template, and NODE_ENV is production`, () => {
      assert.ok(!JSON.stringify(template.toJSON()).includes('INSECURE_DEV_MODE'), 'INSECURE_DEV_MODE must never reach a deployed task');
      const container = containerDefinition(template);
      const names = [...(container.Environment ?? []), ...(container.Secrets ?? [])].map((e: any) => e.Name);
      assert.ok(!names.includes('INSECURE_DEV_MODE'));
      const env = Object.fromEntries(((container.Environment ?? []) as any[]).map((e) => [e.Name, e.Value]));
      assert.equal(env.NODE_ENV, 'production');
    });
  }
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

  test('the chat path can write and read its memory — and only the one memory it is given', () => {
    // routes/agents.ts records every turn through providers/memory.ts
    // (CreateEvent / ListEvents / ListSessions). MEMORY_ID was set while the
    // role had none of these, so a deployed chat answered and kept no history.
    const statements = Object.values<any>(closedTemplate.findResources('AWS::IAM::Policy')).flatMap(
      (p) => (p.Properties?.PolicyDocument?.Statement ?? []) as any[],
    );
    const memory = statements.find((s) => s.Sid === 'AgentCoreMemoryEvents');
    assert.ok(memory, 'expected an AgentCoreMemoryEvents statement');
    for (const action of ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents', 'bedrock-agentcore:ListSessions']) {
      assert.ok(memory.Action.includes(action), `${action} missing`);
    }
    const resource = JSON.stringify(memory.Resource);
    assert.ok(resource.includes(':memory/') && resource.includes('orgiq_memory-ABCDEF'), resource);
    assert.ok(!resource.includes('memory/*'), 'memory events must not be granted on every memory');
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

// ─── Realtime gateway wiring ─────────────────────────────────────────────────
//
// The websocket-gateway is NOT an AWS component — it is a separate service on
// Kubernetes (docs/deploy-via-operator.md). This stack's only job is telling
// the middleware where it is and how to sign for it. The URL half already
// existed; the signing half did not, so a middleware on ECS could be pointed at
// the gateway and still have every call refused.

describe('websocket-gateway wiring', () => {
  const wired = Template.fromStack(middlewareServiceStack(
    { deployMiddlewareService: 'true' },
    {
      websocketGatewayUrl: 'http://gateway.platform.svc.cluster.local',
      gatewayServiceAuthSecretArn:
        'arn:aws:secretsmanager:us-east-1:111111111111:secret:orgiq-service-auth-AbCdEf',
    },
  ));

  test('the gateway origin is plaintext env — it is a location, not a credential', () => {
    const env = (containerDefinition(wired).Environment ?? []) as any[];
    const found = env.find((e) => e.Name === 'WEBSOCKET_GATEWAY_URL');
    assert.equal(found?.Value, 'http://gateway.platform.svc.cluster.local');
  });

  test('the shared HMAC secret arrives as an ECS secret, never plaintext', () => {
    const container = containerDefinition(wired);
    const secretNames = ((container.Secrets ?? []) as any[]).map((s) => s.Name);
    const envNames = ((container.Environment ?? []) as any[]).map((e) => e.Name);
    assert.ok(secretNames.includes('GATEWAY_SERVICE_AUTH_SECRET'));
    assert.ok(!envNames.includes('GATEWAY_SERVICE_AUTH_SECRET'));
  });

  test('the secret is IMPORTED, not generated — a fresh value could never match the gateway', () => {
    // Every generated secret in this stack is one this stack owns. The gateway's
    // shared secret is owned by the gateway, so it must appear as a reference
    // and never as an AWS::SecretsManager::Secret resource of ours.
    const generated = Object.values<any>(wired.findResources('AWS::SecretsManager::Secret'))
      .map((r) => r.Properties?.Name)
      .filter(Boolean);
    assert.ok(!generated.some((n: string) => /service-auth/.test(n)),
      'the gateway HMAC secret must be imported by ARN, not minted here');
  });

  test('unset leaves the proxy disabled rather than half-configured', () => {
    const bare = Template.fromStack(middlewareServiceStack({ deployMiddlewareService: 'true' }));
    const container = containerDefinition(bare);
    const envNames = ((container.Environment ?? []) as any[]).map((e) => e.Name);
    const secretNames = ((container.Secrets ?? []) as any[]).map((s) => s.Name);
    assert.ok(!envNames.includes('WEBSOCKET_GATEWAY_URL'));
    assert.ok(!secretNames.includes('GATEWAY_SERVICE_AUTH_SECRET'));
  });
});

// ─── The KB surface's grants and the config that names them ──────────────────
//
// The deployed middleware reported an EMPTY knowledge base that held 157 indexed
// documents behind an AVAILABLE data source with two COMPLETE sync jobs:
// /api/ingest/jobs returned `[]`, /api/ingest/storage returned
// `bucket: "", totalObjects: 0, kb.totalDocuments: 0`, the reconcile page's
// last-sync column read "—", and its banner claimed the documents had never
// been indexed. Two independent causes, both of this stack's making, both of
// which fail by reporting nothing rather than by erroring:
//
//   1. The task role granted `bedrock:ListDataSources` but none of the three
//      Ingestion* actions, so every "when did this sync" read got AccessDenied
//      and fell into a catch.
//   2. Only the bucket ARNs were passed, never the NAMES — so the task held S3
//      permissions on a bucket it could not name, and read an empty one.
//
// Neither shows up in stack status, the health check, or the page. These tests
// are the judge, because there is nothing else to notice them.

describe('the KB surface has the grants and the config it needs', () => {
  function statementBySid(template: Template, sid: string): any {
    const s = Object.values<any>(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => (p.Properties?.PolicyDocument?.Statement ?? []) as any[],
    ).find((st) => st.Sid === sid);
    assert.ok(s, `expected an IAM statement with Sid ${sid}`);
    return s;
  }

  test('the ingestion-job actions are granted — without them the KB reads as empty', () => {
    const kb = statementBySid(closedTemplate, 'BedrockKBProvisioning');
    const actions: string[] = Array.isArray(kb.Action) ? kb.Action : [kb.Action];
    for (const action of [
      'bedrock:ListIngestionJobs',   // sync history: /api/ingest/jobs, the reconcile columns
      'bedrock:GetIngestionJob',     // the live SSE job monitor in routes/ingest.ts
      'bedrock:StartIngestionJob',   // every Sync button
    ]) {
      assert.ok(
        actions.includes(action),
        `${action} is missing — the KB surface will report empty instead of failing`,
      );
    }
  });

  test('the data-source actions it already relied on are still there', () => {
    // The asymmetry is the whole bug: with List*DataSources granted and
    // ListIngestionJobs denied, the page found the source and then threw the
    // finding away. Pinning both halves keeps them from drifting apart again.
    const kb = statementBySid(closedTemplate, 'BedrockKBProvisioning');
    const actions: string[] = Array.isArray(kb.Action) ? kb.Action : [kb.Action];
    for (const action of ['bedrock:ListDataSources', 'bedrock:ListKnowledgeBases']) {
      assert.ok(actions.includes(action), `${action} is missing`);
    }
  });

  test('the bucket NAMES reach the container, not just the ARNs in IAM', () => {
    // config.foundation.documentsBucket reads DOCUMENTS_BUCKET. With it unset,
    // /api/ingest/storage answered `bucket: ""` on a bucket holding the corpus.
    const env = (containerDefinition(closedTemplate).Environment ?? []) as any[];
    const names = env.map((e) => e.Name);
    for (const key of ['DOCUMENTS_BUCKET', 'ARTIFACTS_BUCKET']) {
      assert.ok(names.includes(key), `${key} must be in the container environment`);
    }
  });

  test('KB_SERVICE_ROLE_ARN is set — the PassRole grant is useless without it', () => {
    // providers/kb-registry.ts fails KB provisioning at step 4 with
    // "KB_SERVICE_ROLE_ARN not configured" when this is absent, while the
    // iam:PassRole grant for that exact role sits right there unused.
    const env = (containerDefinition(closedTemplate).Environment ?? []) as any[];
    const entry = env.find((e) => e.Name === 'KB_SERVICE_ROLE_ARN');
    assert.ok(entry, 'KB_SERVICE_ROLE_ARN must be in the container environment');
    assert.ok(
      JSON.stringify(entry.Value).includes('kb-service-role'),
      'KB_SERVICE_ROLE_ARN must name the KB service role that PassRole allows',
    );
  });
});


test('browser network inspection and session operations are scoped to the configured browser', () => {
  const browserArn = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:browser-custom/orgiq_browser-abcdefghij';
  const template = Template.fromStack(middlewareServiceStack({}, { browserArn, browserId: 'orgiq_browser-abcdefghij' }));
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: Match.arrayWith([
      Match.objectLike({ Sid: 'PublicBrowserCrawl', Resource: browserArn,
        Action: Match.arrayWith(['bedrock-agentcore:GetBrowser', 'bedrock-agentcore:StartBrowserSession']) }),
    ]) },
  });
  const env = containerDefinition(template).Environment;
  assert.ok(env.some((v: any) => v.Name === 'BROWSER_ID' && v.Value === 'orgiq_browser-abcdefghij'));
  const statements = Object.values<any>(template.findResources('AWS::IAM::Policy')).flatMap(p => p.Properties.PolicyDocument.Statement);
  const browserPolicy = statements.find((s: any) => s.Sid === 'PublicBrowserCrawl');
  assert.ok(!browserPolicy.Action.includes('bedrock-agentcore:UpdateBrowser'));
});

describe('devbox lifetime and git wiring (DE-48, DE-45)', () => {
  const envOf = (t: Template) => Object.fromEntries(((containerDefinition(t).Environment ?? []) as any[]).map((e) => [e.Name, e.Value]));
  const secretNames = (t: Template) => ((containerDefinition(t).Secrets ?? []) as any[]).map((s) => s.Name);

  test('the lifetime env equals the middleware defaults and the runtime task timeout', () => {
    const env = envOf(closedTemplate);
    assert.equal(env['DEVBOX_IDLE_TIMEOUT_MINUTES'], '20');
    assert.equal(env['DEVBOX_MAX_LIFETIME_MINUTES'], '240');
    assert.equal(env['DEVBOX_TASK_TIMEOUT_S'], '840');
    assert.equal(env['DEVBOX_TASK_MAX_S'], '3300');
    assert.equal(env['DEVBOX_REAP_GRACE_MINUTES'], '5');
  });

  test('the git entrypoint is off by default and on only with its context flag', () => {
    assert.equal(envOf(closedTemplate)['DEVBOX_GIT_ENTRYPOINT'], 'off');
    const on = Template.fromStack(middlewareServiceStack({ devboxGitEntrypoint: 'true' }));
    assert.equal(envOf(on)['DEVBOX_GIT_ENTRYPOINT'], 'on');
  });

  test('without githubAppSecretArn no GitHub App secret is referenced — it does not exist yet', () => {
    const names = secretNames(closedTemplate);
    assert.ok(!names.includes('GITHUB_APP_ID'));
    assert.ok(!names.includes('GITHUB_APP_PRIVATE_KEY'));
    assert.ok(!JSON.stringify(closedTemplate.toJSON()).includes('github-app'));
  });

  test('githubAppSecretArn injects both fields as ECS secrets by complete ARN, never plaintext', () => {
    const t = Template.fromStack(middlewareServiceStack({ githubAppSecretArn: 'arn:aws:secretsmanager:us-east-1:647757222309:secret:orgiq/github-app-AbCdEf' }));
    const secrets = (containerDefinition(t).Secrets ?? []) as any[];
    const byName = Object.fromEntries(secrets.map((s) => [s.Name, JSON.stringify(s.ValueFrom)]));
    assert.match(byName['GITHUB_APP_ID'] ?? '', /orgiq\/github-app.*:appId::/);
    assert.match(byName['GITHUB_APP_PRIVATE_KEY'] ?? '', /orgiq\/github-app.*:privateKey::/);
    const env = envOf(t);
    assert.ok(!('GITHUB_APP_ID' in env) && !('GITHUB_APP_PRIVATE_KEY' in env));
  });
});
