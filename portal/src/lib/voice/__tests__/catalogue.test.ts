import test from 'node:test';
import assert from 'node:assert/strict';
import { NAVIGATE_PAGE_IDS, SEARCH_ACTIONS, SEARCH_RECORD_TYPES, VOICE_TENANTS, VOICE_TOOLS, navigatePageIds, searchRecordTypes } from '../catalogue.ts';
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
  for (const tenant of mw.VOICE_TENANTS) {
    const tools = mw.toolsForTenant(tenant);
    const page = tools.find((t) => t.name === 'navigate')!.parameters as { properties: { page: { enum: string[] } } };
    assert.deepEqual(navigatePageIds(tenant), page.properties.page.enum, `navigate enum in ${tenant}`);
    const search = tools.find((t) => t.name === 'search_records')!.parameters as { properties: { type: { enum: string[] } } };
    assert.deepEqual(searchRecordTypes(tenant), search.properties.type.enum, `search_records enum in ${tenant}`);
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
  // Only the catalogue's ids carry a pageId: the palette never offers voice a page the model was not told about.
  const ids = PALETTE.pages.filter((p) => p.pageId).map((p) => p.pageId);
  assert.deepEqual(new Set(ids), new Set(NAVIGATE_PAGE_IDS.map((p) => p.id).filter((id) => id !== 'workspaces')));
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
