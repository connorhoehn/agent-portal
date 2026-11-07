/**
 * OrgIQ-Aurora.
 *
 * Aurora is reached ONLY through the RDS Data API — there is no NAT, no
 * bastion, and the subnets are isolated. That is a design decision the whole
 * fleet depends on (every agent, the middleware, the span projector and the KB
 * all talk rds-data), and it is one boolean away from being untrue.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Template } from 'aws-cdk-lib/assertions';
import { auroraStack } from './helpers/stacks';

const template = Template.fromStack(auroraStack());

describe('the Data API is the access path', () => {
  test('EnableHttpEndpoint is on — without it every rds-data call fails', () => {
    // The whole fleet authenticates by (cluster ARN, secret ARN) over the Data
    // API. With the HTTP endpoint off, every agent tool, the middleware, the
    // span projector and the KB's own vector store all fail at once.
    template.hasResourceProperties('AWS::RDS::DBCluster', { EnableHttpEndpoint: true });
  });

  test('the VPC has no NAT gateways and only isolated subnets', () => {
    // A NAT gateway here would be ~$32/mo of nothing: the Data API is an
    // AWS-managed endpoint, not a route out of the VPC.
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    const subnets = Object.values<any>(template.findResources('AWS::EC2::Subnet'));
    assert.ok(subnets.length > 0);
    for (const subnet of subnets) {
      assert.notEqual(
        subnet.Properties?.MapPublicIpOnLaunch,
        true,
        'Aurora subnets must stay isolated',
      );
    }
  });

  test('the cluster is not publicly accessible and is encrypted at rest', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', { StorageEncrypted: true });
    template.hasResourceProperties('AWS::RDS::DBInstance', { PubliclyAccessible: false });
  });

  test('the security group does not allow the world in on 5432', () => {
    for (const [id, sg] of Object.entries(template.findResources('AWS::EC2::SecurityGroup'))) {
      for (const rule of (sg.Properties?.SecurityGroupIngress ?? []) as any[]) {
        assert.notEqual(rule?.CidrIp, '0.0.0.0/0', `${id}: open ingress on the database SG`);
      }
    }
  });
});

describe('cost floor', () => {
  test('serverless v2 min capacity stays at the 0.5-ACU floor (~$45/mo idle)', () => {
    // Raising this raises the idle bill of a lab that is idle most of the time.
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
    });
  });
});

const throwaway = Template.fromStack(auroraStack({ protectData: 'false' }));

function deleterProps(t: Template): Record<string, unknown> {
  const [, r] = Object.entries<any>(t.findResources('AWS::CloudFormation::CustomResource'))
    .find(([id]) => id.includes('AuroraFastDeleter'))!;
  return r.Properties;
}

describe('protectData (the default)', () => {
  test('deletion protection is on, the cluster keeps a week of backups', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', { DeletionProtection: true, BackupRetentionPeriod: 7 });
  });

  test('the subnet group is RETAINed with the cluster', () => {
    for (const [id, sg] of Object.entries(template.findResources('AWS::RDS::DBSubnetGroup'))) {
      assert.equal(sg.DeletionPolicy, 'Retain', id);
    }
  });

  test('the deleter stays in the template but is told the cluster is protected', () => {
    // Removing the custom resource would run its Delete handler — which
    // deleted the cluster before this flag existed.
    assert.equal(deleterProps(template).Protected, 'true');
  });
});

describe('teardown (protectData=false)', () => {
  test('deletion protection is OFF — on, `cdk destroy` cannot delete the cluster at all', () => {
    throwaway.hasResourceProperties('AWS::RDS::DBCluster', { DeletionProtection: false, BackupRetentionPeriod: 1 });
  });

  test('the deleter takes a final snapshot unless auroraSkipFinalSnapshot=true', () => {
    assert.equal(deleterProps(throwaway).Protected, 'false');
    assert.equal(deleterProps(throwaway).SkipFinalSnapshot, 'false');
    const skip = Template.fromStack(auroraStack({ protectData: 'false', auroraSkipFinalSnapshot: 'true' }));
    assert.equal(deleterProps(skip).SkipFinalSnapshot, 'true');
  });

  test('a misspelt flag fails the synth rather than taking the default', () => {
    assert.throws(() => auroraStack({ protectData: 'no' }), /protectData must be true or false/);
  });

  test('the cluster and its writer are RETAINed so CFN does not double-delete them', () => {
    // The AuroraFastDeleter custom resource calls DeleteDBCluster and WAITS.
    // By the time CloudFormation's own cleanup pass runs, the cluster is gone;
    // letting CFN delete it too produces an error on an already-deleted
    // resource and drops the stack into DELETE_FAILED.
    for (const [id, cluster] of Object.entries(template.findResources('AWS::RDS::DBCluster'))) {
      assert.equal(cluster.DeletionPolicy, 'Retain', `${id}: must be RETAIN, the deleter owns it`);
    }
    for (const [id, instance] of Object.entries(template.findResources('AWS::RDS::DBInstance'))) {
      assert.equal(instance.DeletionPolicy, 'Retain', `${id}: must be RETAIN, the deleter owns it`);
    }
  });

  test('the fast-deleter custom resource exists and depends on the cluster', () => {
    const deleters = Object.entries(template.findResources('AWS::CloudFormation::CustomResource'));
    const aurora = deleters.filter(([id]) => id.includes('AuroraFastDeleter'));
    assert.equal(aurora.length, 1, 'the deleter is what makes RETAIN safe — both or neither');
    const deps = aurora[0]![1].DependsOn ?? [];
    assert.ok(
      (Array.isArray(deps) ? deps : [deps]).some((d: string) => d.includes('AuroraCluster')),
      'the deleter must run before the cluster resource is released',
    );
  });

  test('the deleter can delete THIS cluster only: rds:DeleteDBCluster + DescribeDBClusters on its ARN', () => {
    const statements = Object.values<any>(template.findResources('AWS::IAM::Role'))
      .flatMap((r) => (r.Properties?.Policies ?? []) as any[])
      .flatMap((p) => (p.PolicyDocument?.Statement ?? []) as any[]);
    const del = statements.find((s) => [].concat(s.Action).includes('rds:DeleteDBCluster' as never));
    assert.ok(del, 'no rds:DeleteDBCluster grant');
    assert.ok([].concat(del.Action).includes('rds:DescribeDBClusters' as never));
    // It used to be '*': any cluster in the account.
    assert.notEqual(del.Resource, '*');
    assert.match(JSON.stringify(del.Resource), /AuroraCluster/);
    const snap = statements.find((s) => [].concat(s.Action).includes('rds:CreateDBClusterSnapshot' as never));
    assert.match(JSON.stringify(snap.Resource), /cluster-snapshot:orgiq-aurora-final-\*/);
  });
});

describe('the read-only graph credential', () => {
  test('the generated password excludes characters the ALTER ROLE applier cannot escape', () => {
    // schema/apply_all_seed.py inlines this password into `ALTER ROLE ...
    // PASSWORD '<pw>'` because ALTER ROLE takes no bind parameters. A quote or
    // a backslash would be an escaping problem, not a formatting one — the
    // applier re-checks the same character set and refuses rather than escape.
    const secrets = Object.values<any>(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter((s) => s.Properties?.Name === 'orgiq-aurora-readonly-credentials');
    assert.equal(secrets.length, 1);
    const exclude: string = secrets[0].Properties.GenerateSecretString.ExcludeCharacters;
    for (const ch of ['\'', '"', '\\', '`', '$', ';', '/', '@', ' ']) {
      assert.ok(exclude.includes(ch), `password charset must exclude ${JSON.stringify(ch)}`);
    }
    assert.equal(secrets[0].Properties.GenerateSecretString.GenerateStringKey, 'password');
  });

  test('the secret payload names the orgiq_graph_reader role, not the admin', () => {
    // The template is an Fn::Join (it interpolates the cluster endpoint), so
    // this reads the joined literal rather than parsed JSON.
    const secret = Object.values<any>(template.findResources('AWS::SecretsManager::Secret')).find(
      (s) => s.Properties?.Name === 'orgiq-aurora-readonly-credentials',
    );
    const payload = JSON.stringify(secret.Properties.GenerateSecretString.SecretStringTemplate);
    assert.ok(payload.includes('orgiq_graph_reader'), 'must be the SELECT-only login');
    assert.ok(!payload.includes('postgres_admin'), 'must not be the admin login');
  });
});

describe('exports the rest of the fleet imports', () => {
  for (const name of [
    'orgiq-aurora-cluster-arn',
    'orgiq-aurora-secret-arn',
    'orgiq-aurora-readonly-secret-arn',
    'orgiq-aurora-endpoint',
    'orgiq-aurora-db-name',
  ]) {
    test(`exports ${name}`, () => {
      template.hasOutput('*', { Export: { Name: name } });
    });
  }
});
