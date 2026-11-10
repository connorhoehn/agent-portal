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
import { Template } from 'aws-cdk-lib/assertions';
import { KB_PREFIXES_FILE, declaredKbPrefixes, parseKbPrefixes } from '../lib/kb-prefixes';
import { knowledgeBaseStack } from './helpers/stacks';

const template = Template.fromStack(knowledgeBaseStack());
const declared = declaredKbPrefixes();
const sources = Object.values(template.findResources('AWS::Bedrock::DataSource')) as any[];
const ROOT = path.join(__dirname, '..', '..');

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
    const ts = fs.readFileSync(path.join(ROOT, 'middleware/src/lib/kb-prefixes.ts'), 'utf8');
    const tsBlock = /DECLARED_KB_PREFIXES[^=]*= \{([\s\S]*?)\n\};/.exec(ts)![1]!;
    const py = fs.readFileSync(path.join(ROOT, 'agents/_shared/kb_resolver.py'), 'utf8');
    const pyBlock = /DECLARED_PREFIXES = \{([\s\S]*?)\n\}/.exec(py)![1]!;
    const parse = (block: string, quote: string) => Object.fromEntries(
      [...block.matchAll(new RegExp(`${quote === "'" ? '(\\w+)' : '"(\\w+)"'}: [\\[(]([^\\])]*)[\\])]`, 'g'))]
        .map((m) => [m[1], [...m[2]!.matchAll(new RegExp(`${quote}([^${quote}]+)${quote}`, 'g'))].map((x) => x[1])]),
    );
    assert.deepEqual(parse(tsBlock, "'"), file);
    assert.deepEqual(parse(pyBlock, '"'), file);
  });
});
