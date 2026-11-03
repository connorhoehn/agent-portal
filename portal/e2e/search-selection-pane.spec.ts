import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

// The selected record opens directly in the shell inspector. Asking changes
// that same pane to the conversation and preserves the one content composer.
test('person inspector keeps initiative scope and Ask only prepares a contextual draft', async ({ browser }) => {
  const reader=await openAsClone(browser,'u-theo',{tenant:'orgiq',landing:null,preJoin:'remembered',label:'selection-inspector'});
  const {page}=reader;
  try {
    await page.setViewportSize({width:1440,height:900});
    await page.goto('/iq/search?scope=p-llm-platform&tab=connections&type=person&selection=person%3Ap-016');
    const pane=page.getByTestId('page-conversation-pane');
    await expect(pane.getByTestId('search-pane-record')).toContainText('Tara Wright');
    await expect(page.getByTestId('search-person-expand')).toHaveCount(0);
    await expect(page.getByTestId('search-explorer').getByTestId('search-pane-record')).toHaveCount(0);
    await pane.getByRole('button',{name:'Ask about Tara',exact:true}).click();
    await expect(pane.getByTestId('search-pane-transcript')).toContainText('Ask about Tara Wright');
    const dock=page.getByTestId('search-composer-dock');
    await expect(dock).toContainText('LLM Application Platform');
    await expect(dock).toContainText('Tara Wright');
    await expect(dock).toContainText('Tell me about this record.');
    expect(new URL(page.url()).searchParams.get('scope')).toBe('p-llm-platform');
    expect(new URL(page.url()).searchParams.get('context')).toBe('person:p-016');
    await expect(page.locator('[contenteditable="true"]:visible')).toHaveCount(1);
    await expect(pane.locator('[contenteditable="true"], textarea')).toHaveCount(0);
    await expect(page.getByTestId('search-assistant-strip')).toHaveCount(0);
    await pane.getByRole('tab',{name:'Tara Wright',exact:true}).click();
    await expect(pane.getByTestId('search-pane-record')).toContainText('Tara Wright');
    await expect(page.getByTestId('search-org-graph')).toBeVisible();
    expect(reader.errors).toEqual([]);
  } finally {await reader.close();}
});

test('multiple people retain one selection action and the graph while preparing their question', async ({ browser })=>{
  const reader=await openAsClone(browser,'u-theo',{tenant:'orgiq',landing:null,preJoin:'remembered',label:'multi-selection-inspector'});
  const {page}=reader;
  try {
    await page.setViewportSize({width:1440,height:900});
    await page.goto('/iq/search?tab=connections&type=person&selection=person%3Ap-042%2Cperson%3Ap-041');
    await expect(page.getByTestId('search-org-graph')).toBeVisible();
    await expect(page.getByTestId('search-pane-record')).toHaveCount(0);
    const ask=page.getByRole('button',{name:'Ask about 2 people',exact:true});
    await expect(ask).toHaveCount(1);
    await ask.click();
    await expect(page.getByTestId('search-pane-transcript')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('context')).toBe('person:p-042,person:p-041');
    await expect(page.getByTestId('search-composer-dock')).toContainText('What connects these 2 records, and what needs attention?');
    await expect(page.getByTestId('search-org-graph')).toBeVisible();
    expect(reader.errors).toEqual([]);
  } finally {await reader.close();}
});

test('the shared directory profile remains readable in an initiative inspector', async ({ browser })=>{
  const reader=await openAsClone(browser,'u-theo',{tenant:'orgiq',landing:null,preJoin:'remembered',label:'initiative-profile-layout'});
  const {page}=reader;
  try {
    await page.setViewportSize({width:1440,height:900});
    await page.goto('/iq/projects/p-llm-platform?pane=person&paneRecord=person%3Ap-042');
    const profile=page.getByTestId('initiative-person');
    await expect(profile).toContainText('Katya Petrov');
    await expect(profile.getByText('Staff ML Engineer · ML / AI',{exact:true})).toHaveCount(1);
    await expect(profile.getByRole('button',{name:'Discuss',exact:true})).toBeVisible();
    await expect(profile.getByRole('button',{name:'Close',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    expect(reader.errors).toEqual([]);
  } finally {await reader.close();}
});
