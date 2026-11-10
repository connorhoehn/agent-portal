/**
 * One knowledge-base data source per declared tenant prefix
 * (tenants/kb-prefixes.json), each with that prefix as its only inclusion
 * prefix: nothing outside a declared prefix is indexed, and no data source
 * spans two tenants. The middleware's and the agents' copies of the map are
 * compared to the same file here and in their own suites.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Template } from 'aws-cdk-lib/assertions';
import { KB_PREFIXES_FILE, declaredKbPrefixes, literalCopies, parseKbPrefixes } from '../lib/kb-prefixes';
import { knowledgeBaseStack } from './helpers/stacks';

const template = Template.fromStack(knowledgeBaseStack());
const declared = declaredKbPrefixes();
const sources = Object.values(template.findResources('AWS::Bedrock::DataSource')) as any[];

describe('knowledge-base data sources', () => {
  test('one data source per declared prefix, and no other', () => {
    assert.equal(sources.length, declared.length);
    const included = sources.map((s) => s.Properties.DataSourceConfiguration.S3Configuration.InclusionPrefixes);
    for (const prefixes of included) assert.equal(prefixes?.length, 1, 'exactly one inclusion prefix each');
    assert.deepEqual(included.map((p) => p[0]).sort(), declared.map((d) => d.prefix).sort());
  });

  test('no data source indexes the whole bucket', () => {
    for (const s of sources) {
      const s3 = s.Properties.DataSourceConfiguration.S3Configuration;
      assert.ok(Array.isArray(s3.InclusionPrefixes) && s3.InclusionPrefixes.every((p: string) => p && p !== '/'));
    }
  });

  test('each data source is named for its tenant', () => {
    for (const { tenant, prefix } of declared) {
      const s = sources.find((x) => x.Properties.DataSourceConfiguration.S3Configuration.InclusionPrefixes[0] === prefix);
      assert.ok(s, prefix);
      assert.match(s.Properties.Name, new RegExp(`-${tenant}-`));
    }
  });

  test('the corpus load still finds its outputs', () => {
    const outputs = template.findOutputs('*');
    for (const name of ['KnowledgeBaseId', 'DataSourceId', 'SynthDataSourceId', 'TenantDataSources']) {
      assert.ok(outputs[name], name);
    }
  });

  test('the declared file is valid: disjoint prefixes, within the per-KB data source limit', () => {
    assert.throws(() => parseKbPrefixes({ homeTenant: 'orgiq', tenants: { orgiq: ['a/'], t2: ['a/b/'] } }), /overlap/);
    assert.throws(() => parseKbPrefixes({ homeTenant: 'orgiq', tenants: { orgiq: ['a/', 'b/', 'c/', 'd/', 'e/', 'f/'] } }), /at most 5/);
    assert.throws(() => parseKbPrefixes({ homeTenant: 'orgiq', tenants: { orgiq: ['/'] } }), /relative folder/);
    assert.throws(() => parseKbPrefixes({ homeTenant: 'x', tenants: { orgiq: ['a/'] } }), /home tenant/);
  });

  test('the middleware and agent copies say the same as the file', () => {
    const file = JSON.parse(fs.readFileSync(KB_PREFIXES_FILE, 'utf8')).tenants as Record<string, string[]>;
    const { middleware, agents } = literalCopies();
    assert.deepEqual(middleware, file);
    assert.deepEqual(agents, file);
  });

  test('synth fails loudly when the file is absent, unreadable or not JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prefixes-'));
    try {
      assert.throws(() => declaredKbPrefixes(path.join(dir, 'kb-prefixes.json')), /tenants\/kb-prefixes\.json is missing or unreadable .*ENOENT.*synth refuses/);
      fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
      assert.throws(() => declaredKbPrefixes(path.join(dir, 'bad.json')), /not valid JSON/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('synth fails loudly when a tenant is missing from the file or from a copy, or is unknown', () => {
    const file = JSON.parse(fs.readFileSync(KB_PREFIXES_FILE, 'utf8'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prefixes-'));
    try {
      const write = (body: unknown) => { const f = path.join(dir, `f${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(body)); return f; };
      // A tenant dropped from the file while the copies still name it.
      const { assessment: _dropped, ...rest } = file.tenants;
      assert.throws(() => declaredKbPrefixes(write({ ...file, tenants: rest })), /assessment is missing from the file/);
      // A tenant the copies do not know.
      const copies = literalCopies();
      assert.throws(() => declaredKbPrefixes(KB_PREFIXES_FILE, { copies: { ...copies, agents: { orgiq: copies.agents['orgiq']! } } }),
        /kb_resolver\.py: assessment is missing from the copy/);
      // A tenant the manifest does not know.
      assert.throws(() => declaredKbPrefixes(write({ ...file, tenants: { ...file.tenants, nobody: ['nobody/'] } }), { copies: null }),
        /"nobody" is not a tenant in tenants\/manifest\.json/);
      // The real file passes.
      assert.ok(declaredKbPrefixes().length >= 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
