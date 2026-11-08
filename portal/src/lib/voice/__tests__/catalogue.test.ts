import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_SCOPES, GET_PARTS, LIST_KINDS, SUMMARY_KINDS, NAVIGATE_PAGE_IDS, QUEUE_WORK_ACTIONS, QUEUE_WORK_KINDS, SEARCH_ACTIONS, SEARCH_RECORD_TYPES, VOICE_TENANTS, VOICE_TOOLS, activityScopes, getParts, listKinds, summaryKinds, navigatePageIds, queueWorkKinds, searchRecordTypes } from '../catalogue.ts';
import { voicePage, hashToolArgs } from '../tools.ts';
import { commandAllowedBy, composeCommand } from '../actions.ts';
import { PALETTE, middlewareVoice } from './voiceHarness.ts';

interface MwTool { name: string; parameters: unknown; kind: string; backing: string; confirm: boolean; action: string | null; says: string; tenants: readonly string[] }
interface MwCatalogue {
  VOICE_TOOLS: MwTool[];
  NAVIGATE_PAGES: Array<{ id: string; path: string; tenants: readonly string[] }>;
  toolsForTenant(t: string): MwTool[];
  hashToolArgs(a: unknown): string;
  VOICE_TENANTS: readonly string[];
  SEARCH_RECORD_TYPES: Record<string, readonly string[]>;
  SEARCH_ACTIONS: Record<string, string>;
  ACTIVITY_SCOPES: Record<string, readonly string[]>;
  QUEUE_WORK_KINDS: Record<string, readonly string[]>;
  QUEUE_WORK_ACTIONS: Record<string, string>;
  LIST_KINDS: Record<string, readonly string[]>;
  GET_PARTS: Record<string, readonly string[]>;
  SUMMARY_KINDS: Record<string, readonly string[]>;
  RUN_COMMAND_PHRASES: readonly string[];
  RUN_COMMAND_PHRASE_COMMANDS: Record<string, string>;
  commandAllowedBy(prefixes: readonly string[], command: string): boolean;
}

test('the portal catalogue matches the middleware one the session is minted with', async () => {
  const mw = await middlewareVoice<MwCatalogue>('catalogue.ts');
  assert.deepEqual(VOICE_TOOLS.map((t) => t.name), mw.VOICE_TOOLS.map((t) => t.name));
  for (const mine of VOICE_TOOLS) {
    const theirs = mw.VOICE_TOOLS.find((t) => t.name === mine.name)!;
    assert.deepEqual(mine.parameters, theirs.parameters, `${mine.name} schema`);
    for (const k of ['kind', 'backing', 'confirm', 'action', 'says'] as const) assert.equal(mine[k], theirs[k], `${mine.name}.${k}`);
    assert.deepEqual([...mine.tenants], [...theirs.tenants], `${mine.name} tenants`);
  }
  assert.deepEqual(NAVIGATE_PAGE_IDS.map((p) => ({ id: p.id, tenants: [...p.tenants] })), mw.NAVIGATE_PAGES.map((p) => ({ id: p.id, tenants: p.tenants })));
  assert.deepEqual([...VOICE_TENANTS], [...mw.VOICE_TENANTS]);
  assert.deepEqual(SEARCH_RECORD_TYPES, mw.SEARCH_RECORD_TYPES);
  assert.deepEqual(SEARCH_ACTIONS, mw.SEARCH_ACTIONS);
  assert.deepEqual(ACTIVITY_SCOPES, mw.ACTIVITY_SCOPES);
  assert.deepEqual(QUEUE_WORK_KINDS, mw.QUEUE_WORK_KINDS);
  assert.deepEqual(QUEUE_WORK_ACTIONS, mw.QUEUE_WORK_ACTIONS);
  assert.deepEqual(LIST_KINDS, mw.LIST_KINDS);
  assert.deepEqual(GET_PARTS, mw.GET_PARTS);
  assert.deepEqual(SUMMARY_KINDS, mw.SUMMARY_KINDS);
  for (const tenant of mw.VOICE_TENANTS) {
    const tools = mw.toolsForTenant(tenant);
    const page = tools.find((t) => t.name === 'navigate')!.parameters as { properties: { page: { enum: string[] } } };
    assert.deepEqual(navigatePageIds(tenant), page.properties.page.enum, `navigate enum in ${tenant}`);
    const search = tools.find((t) => t.name === 'search')!.parameters as { properties: { type: { enum: string[] } } };
    assert.deepEqual(searchRecordTypes(tenant), search.properties.type.enum, `search enum in ${tenant}`);
    const activity = tools.find((t) => t.name === 'activity')?.parameters as { properties: { scope: { enum: string[] } } } | undefined;
    if (activity) assert.deepEqual(activityScopes(tenant), activity.properties.scope.enum, `activity enum in ${tenant}`);
    else assert.deepEqual(activityScopes(tenant), [], `${tenant} is offered no activity tool`);
    const list = tools.find((t) => t.name === 'list')!.parameters as { properties: { kind: { enum: string[] } } };
    assert.deepEqual(listKinds(tenant), list.properties.kind.enum, `list enum in ${tenant}`);
    const get = tools.find((t) => t.name === 'get')!.parameters as { properties: { part: { enum: string[] } } };
    assert.deepEqual(getParts(tenant), get.properties.part.enum, `get parts in ${tenant}`);
    const sum = tools.find((t) => t.name === 'summary')!.parameters as { properties: { kind: { enum: string[] } } };
    assert.deepEqual(summaryKinds(tenant), sum.properties.kind.enum, `summary kinds in ${tenant}`);
    const work = tools.find((t) => t.name === 'queue_work')?.parameters as { properties: { kind: { enum: string[] } } } | undefined;
    if (work) assert.deepEqual(queueWorkKinds(tenant), work.properties.kind.enum, `queue_work enum in ${tenant}`);
    else assert.deepEqual(queueWorkKinds(tenant), [], `${tenant} is offered no queue_work tool`);
  }
});

test('every navigate page id resolves to the palette entry with the same path the middleware names', async () => {
  const mw = await middlewareVoice<MwCatalogue>('catalogue.ts');
  for (const p of mw.NAVIGATE_PAGES) {
    for (const tenant of p.tenants.includes('*') ? mw.VOICE_TENANTS : p.tenants) {
      const entry = voicePage(PALETTE, p.id, tenant);
      assert.ok(entry, `${p.id} has a palette entry in ${tenant}`);
      assert.equal(entry.path, p.path, `${p.id} in ${tenant}`);
    }
  }
  // Every id the catalogue offers is a palette pageId (V2-2 gave all 109 rows one; V2-4's `open` offers them all).
  const ids = new Set(PALETTE.pages.map((p) => p.pageId));
  for (const p of NAVIGATE_PAGE_IDS) if (p.id !== 'workspaces') assert.ok(ids.has(p.id), p.id);
});

test('the dock hashes arguments exactly as the middleware does', async () => {
  const mw = await middlewareVoice<MwCatalogue>('catalogue.ts');
  for (const args of [{ query: 'Kubernetes experts', limit: 5 }, { b: [1, { z: 1, a: null }], a: 'x' }, {}, 'raw']) {
    assert.equal(await hashToolArgs(args), mw.hashToolArgs(args));
  }
});

test('the mint filters run_command phrases by the same commands and the same prefix rule the dock checks (G9)', async () => {
  const mw = await middlewareVoice<MwCatalogue>('catalogue.ts');
  for (const phrase of mw.RUN_COMMAND_PHRASES) {
    assert.equal(composeCommand(phrase, { since: 'yesterday' }), mw.RUN_COMMAND_PHRASE_COMMANDS[phrase], phrase);
  }
  const lists = [['git log', 'ls'], ['npm test'], ['npm'], ['pwd '], ['git'], []];
  for (const prefixes of lists) {
    for (const command of [...Object.values(mw.RUN_COMMAND_PHRASE_COMMANDS), 'pwd', 'npm run lint', 'git log --since=3.days.ago --oneline']) {
      assert.equal(commandAllowedBy(prefixes, command), mw.commandAllowedBy(prefixes, command), `${command} under ${prefixes.join(',')}`);
    }
  }
});
