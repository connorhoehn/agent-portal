/**
 * The interviews tenant (`-c interviews=true`) and the meeting assistant, Milo (`-c meetingAssistant=true`):
 * what each flag adds to OrgIQ-Foundation, OrgIQ-MiddlewareService and OrgIQ-SocialMedia, and that nothing
 * of either is there without its flag.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SocialMediaStack } from '../lib/social-media-stack';
import { interviewsSettingsEnv } from '../lib/middleware-service-stack';
import { PREFIX, foundationStack, middlewareServiceStack, newApp } from './helpers/stacks';
import { statementsForRole } from './helpers/cfn';

const BUCKET = { interviewResumesBucketName: 'orgiq-interview-resumes-x', interviewResumesBucketArn: 'arn:aws:s3:::orgiq-interview-resumes-x' };
const container = (t: Template) => Object.values<any>(t.findResources('AWS::ECS::TaskDefinition'))[0].Properties.ContainerDefinitions[0];
const envOf = (t: Template): Record<string, unknown> => Object.fromEntries(container(t).Environment.map((e: any) => [e.Name, e.Value]));
const secretNames = (t: Template): string[] => (container(t).Secrets ?? []).map((s: any) => s.Name);
const sids = (t: Template) => statementsForRole(t, 'orgiq-middleware-task-role').map((s) => s.Sid);

describe('the interviews tenant', () => {
  test('Foundation: a private, unversioned résumé bucket with exports, only with the flag', () => {
    assert.equal(Object.keys(Template.fromStack(foundationStack()).findResources('AWS::S3::Bucket')).filter((k) => /Resume/.test(k)).length, 0);
    const t = Template.fromStack(foundationStack({ interviews: 'true' }));
    const [bucket] = Object.entries<any>(t.findResources('AWS::S3::Bucket')).filter(([k]) => /InterviewResumes/.test(k)).map(([, r]) => r.Properties);
    assert.match(JSON.stringify(bucket.BucketName), /orgiq-interview-resumes-/);
    assert.deepEqual(bucket.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    assert.equal(bucket.VersioningConfiguration, undefined);
    const outputs = Object.values<any>(t.toJSON().Outputs).map((o) => o.Export?.Name);
    assert.ok(outputs.includes('orgiq-interview-resumes-bucket-name') && outputs.includes('orgiq-interview-resumes-bucket-arn'));
  });

  test('without the flag the task carries no INTERVIEWS_ setting and no interviews grant', () => {
    const t = Template.fromStack(middlewareServiceStack());
    assert.deepEqual(Object.keys(envOf(t)).filter((k) => k.startsWith('INTERVIEWS_')), []);
    assert.ok(!sids(t).includes('InterviewResumeObjects'));
  });

  test('the flag needs the bucket', () => {
    assert.throws(() => middlewareServiceStack({ interviews: 'true' }), /interviewResumesBucketName/);
  });

  test('with the gateway: on, the bucket, guest realtime, objects only', () => {
    const t = Template.fromStack(middlewareServiceStack({ interviews: 'true', realtimeGateway: 'true' }, BUCKET));
    const env = envOf(t);
    assert.equal(env['INTERVIEWS_ENABLED'], 'true');
    assert.equal(env['INTERVIEWS_RESUME_BUCKET'], BUCKET.interviewResumesBucketName);
    assert.equal(env['INTERVIEWS_GUEST_REALTIME'], 'true');
    const st = statementsForRole(t, 'orgiq-middleware-task-role').find((s) => s.Sid === 'InterviewResumeObjects')!;
    assert.deepEqual(st.Action, ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']);
    assert.equal(st.Resource, `${BUCKET.interviewResumesBucketArn}/*`);
  });

  test('without the gateway the candidate cannot join, said at synth; asking for it anyway is refused', () => {
    const stack = middlewareServiceStack({ interviews: 'true' }, BUCKET);
    assert.equal(envOf(Template.fromStack(stack))['INTERVIEWS_GUEST_REALTIME'], 'false');
    const msgs = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('candidate cannot join'));
    assert.equal(msgs.length, 1);
    assert.throws(() => middlewareServiceStack({ interviews: 'true', interviewsGuestRealtime: 'true' }, BUCKET), /realtimeGateway/);
  });

  test('interviewsSettings passes INTERVIEWS_* settings and refuses the rest', () => {
    const t = Template.fromStack(middlewareServiceStack({
      interviews: 'true', realtimeGateway: 'true', interviewsSettings: '{"INTERVIEWS_INTERVIEW_CAP_USD":6,"INTERVIEWS_REQUIRED_CONSENTS":"recording"}',
    }, BUCKET));
    assert.equal(envOf(t)['INTERVIEWS_INTERVIEW_CAP_USD'], '6');
    assert.equal(envOf(t)['INTERVIEWS_REQUIRED_CONSENTS'], 'recording');
    assert.deepEqual(interviewsSettingsEnv(undefined), {});
    assert.throws(() => interviewsSettingsEnv('{"NODE_ENV":"development"}'), /not a settable/);
    assert.throws(() => interviewsSettingsEnv('{"INTERVIEWS_ENABLED":"false"}'), /not a settable/);
    assert.throws(() => interviewsSettingsEnv('[1]'), /JSON object/);
    assert.throws(() => interviewsSettingsEnv('{"INTERVIEWS_X":{}}'), /string, number or boolean/);
  });
});

describe('the meeting assistant', () => {
  test('without the flag: no MEETING_ASSISTANT_ setting, no sink secret', () => {
    const t = Template.fromStack(middlewareServiceStack());
    assert.deepEqual(Object.keys(envOf(t)).filter((k) => k.startsWith('MEETING_ASSISTANT')), []);
    assert.equal(Object.keys(t.findResources('AWS::SecretsManager::Secret')).filter((k) => /MeetingAssistant/.test(k)).length, 0);
  });

  test('the OpenAI live session: the sink secret and the voice key, once even with voice=true', () => {
    const t = Template.fromStack(middlewareServiceStack({ meetingAssistant: 'true' }));
    assert.equal(envOf(t)['MEETING_ASSISTANT_ENABLED'], 'true');
    assert.ok(secretNames(t).includes('MEETING_ASSISTANT_SINK_SECRET'));
    assert.ok(secretNames(t).includes('OPENAI_API_KEY'));
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'orgiq/meeting-assistant/sink-secret' });
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/orgiq/meeting-assistant/sink-secret-arn' });
    const both = Template.fromStack(middlewareServiceStack({ meetingAssistant: 'true', voice: 'true' }));
    assert.equal(secretNames(both).filter((n) => n === 'OPENAI_API_KEY').length, 1);
  });

  test('first deploy: says what is missing; later deploy: the SFU address, its admin token and the portal URL', () => {
    const first = middlewareServiceStack({ meetingAssistant: 'true' });
    const said = Annotations.fromStack(first).findWarning('*', Match.anyValue()).map((w) => String(w.entry.data));
    assert.ok(said.some((m) => /nowhere to send audio/.test(m)));
    assert.ok(said.some((m) => /without sfuLive/.test(m)));
    assert.ok(!('MEETING_ASSISTANT_MEDIA_URL' in envOf(Template.fromStack(first))));

    const later = Template.fromStack(middlewareServiceStack({ meetingAssistant: 'true', portalPublicUrls: 'true', sfuLive: 'true' }));
    assert.match(JSON.stringify(envOf(later)['MEETING_ASSISTANT_MEDIA_URL']), /http:\/\/.*:3901/);
    assert.ok(secretNames(later).includes('MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN'));
    assert.ok(secretNames(later).includes('MEETING_ASSISTANT_SINK_BASE_URL'));

    const explicit = Template.fromStack(middlewareServiceStack({ meetingAssistant: 'true', meetingAssistantSinkBaseUrl: 'https://milo.example.com/' }));
    assert.equal(envOf(explicit)['MEETING_ASSISTANT_SINK_BASE_URL'], 'https://milo.example.com');
  });

  test('SocialMedia: the middleware on the API port, the sink secret and the tap origin, only with the flag', () => {
    const build = (context: Record<string, unknown>) => {
      const app = newApp({ sfuAllowCidr: '203.0.113.4/32', ...context });
      const vpc = new ec2.Vpc(new cdk.Stack(app, 'Net'), 'Vpc', { maxAzs: 2, natGateways: 0 });
      return Template.fromStack(new SocialMediaStack(app, 'OrgIQ-SocialMedia', { prefix: PREFIX, vpc, middlewareSecurityGroupId: 'sg-0middleware' }));
    };
    const off = JSON.stringify(build({}).toJSON());
    assert.ok(!off.includes('LIVE_CAPTIONS') && !off.includes('Milo audio taps'));
    const on = build({ meetingAssistant: 'true' });
    const json = JSON.stringify(on.toJSON());
    assert.ok(json.includes('LIVE_CAPTIONS_ORIGIN') && json.includes('LIVE_CAPTIONS_SHARED_SECRET'));
    assert.ok(json.includes('/orgiq/meeting-assistant/sink-secret-arn') && json.includes('/orgiq/portal/url'));
    const sg = Object.values<any>(on.findResources('AWS::EC2::SecurityGroup')).find((r) => r.Properties.GroupName === 'orgiq-social-sfu')!;
    const rule = (sg.Properties.SecurityGroupIngress ?? []).find((r: any) => /Milo/.test(r.Description));
    assert.deepEqual([rule.SourceSecurityGroupId, rule.FromPort, rule.ToPort, rule.IpProtocol], ['sg-0middleware', 3901, 3901, 'tcp']);
    const sinkOverride = JSON.stringify(build({ meetingAssistant: 'true', meetingAssistantSinkBaseUrl: 'https://milo.example.com/x' }).toJSON());
    assert.ok(sinkOverride.includes('LIVE_CAPTIONS_ORIGIN=https://milo.example.com') && !sinkOverride.includes('/orgiq/portal/url'));
  });
});

