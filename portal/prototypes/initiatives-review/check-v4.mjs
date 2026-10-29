import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here=path.dirname(fileURLToPath(import.meta.url));
const gallery=path.resolve(here,'../../../.scratch/initiatives-mockups-2026-10-28');
const out=path.join(gallery,'revision-4');
const skill=process.env.UI_DOM_AUDIT_SKILL??path.join(os.homedir(),'.codex/skills/ui-dom-audit');
const {measureDOM}=await import(pathToFileURL(path.join(skill,'scripts/measure.mjs')));
const scrollers=[{selector:'#review-content',reason:'The record body scrolls above its docked response area.'}];
const contract={version:1,name:'Initiatives detail review',rules:[
  {id:'viewport',kind:'viewport'},
  {id:'text.overlap',kind:'text-overlap',selector:'#review-content, #review-composer, #review-rail, #review-discussion'},
  {id:'text.cramped',kind:'text-cramped',selector:'#review-content, #review-composer, #review-rail, #review-discussion',maxLines:2,minChars:12},
  {id:'text.clipped',kind:'text-clipped',selector:'#review-content, #review-composer, #review-rail, #review-discussion',scrollers,requireFullText:true},
  {id:'identifiers.unbroken',kind:'style',selector:'.review-id',properties:{whiteSpace:'nowrap'}},
  {id:'tables.row-density',kind:'box',selector:'.review-table:not(.refine-compact-table) > tbody > tr:not(:has(> [colspan]))',properties:{height:{min:40,max:100}}},
  {id:'tables.compact-detail',kind:'box',selector:'.refine-compact-table > tbody > tr',properties:{height:{min:30,max:40}},owner:'Compact envelope detail requested by the user'},
  {id:'tables.header',kind:'style',selector:'.review-table thead th',properties:{fontSize:12,fontWeight:600}},
  {id:'tables.cells',kind:'style',selector:'.review-table tbody td:not([colspan])',properties:{fontSize:13,paddingLeft:12,paddingRight:12}},
  {id:'tables.contained',kind:'within',selector:'.review-table',anchor:'.review-table-wrap',ancestor:true,axes:['x']},
  {id:'response.clearance',kind:'dock-clearance',selector:'#review-composer'},
  {id:'response.presence',kind:'composer-presence',selector:'#review-composer'},
]};
const browser=await chromium.launch();
const page=await browser.newPage();
const errors=[];const requests=[];const results=[];
const measurements={};
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(!/^(file:|data:|blob:)/.test(r.url()))requests.push(r.url());});
async function open(id,width=1440){await page.setViewportSize({width,height:900});await page.goto(pathToFileURL(path.join(out,id+'.html')).href);await page.locator('.review-page').waitFor();await page.evaluate(()=>document.fonts.ready);}
async function measure(id,state,width){
  const composerExpectation={mode:'exempt',reason:id==='dispatch'?'A pending choice uses the library prompt deck; discussion and typed-answer states are verified separately.':'This case measures the record body. The captured application composer is outside the revised composition.'};
  const result=await page.evaluate(measureDOM,{contract,selectors:{},composerExpectation});
  results.push({id,state,width,...result});
}
try{
  assert.equal(fs.readFileSync(path.join(out,'run.html'),'utf8'),fs.readFileSync(path.join(gallery,'revision-3/run.html'),'utf8'),'Approved run must remain identical');
  for(const width of [1440,900])for(const id of ['budget','work','run','dispatch','sprints']){
    await open(id,width);await measure(id,'default',width);
    await page.screenshot({path:path.join(out,`${id}${width===1440?'':'-900'}.png`)});
    await page.locator('#review-content').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await measure(id,'scrolled',width);
    await page.screenshot({path:path.join(out,`${id}-${width}-detail.png`)});
  }
  await open('budget');
  measurements.budgetDetailHeight=await page.locator('.refine-budget-child').evaluate(e=>e.getBoundingClientRect().height);
  assert.ok(measurements.budgetDetailHeight<270,'Compact budget detail must fit within 270px');
  assert.equal(await page.getByRole('table',{name:'Sprint envelopes',exact:true}).count(),1);
  await page.getByRole('button',{name:'Auth Migration',exact:true}).click();
  assert.equal(await page.getByRole('table',{name:'Sprint envelopes',exact:true}).count(),0);
  await page.getByRole('button',{name:'Auth Migration',exact:true}).click();
  assert.equal(await page.getByRole('table',{name:'Sprint envelopes',exact:true}).count(),1);
  await page.getByRole('textbox',{name:'Search initiative budgets'}).fill('Auth');
  assert.equal(await page.locator('table.budget > tbody > tr:not(.review-child-row)').count(),1);
  for(const width of [1440,900]){
  await open('work',width);
  assert.equal(await page.locator('#review-rail').getByRole('navigation',{name:'Work views'}).count(),1);
  await page.locator('#review-rail').getByRole('button',{name:/^In progress/}).click();
  assert.equal(await page.locator('.review-work-link').count(),1);
  await measure('work','sidebar-filter',width);
  await page.locator('#review-rail').getByRole('button',{name:'Your envelope'}).click();
  assert.equal(await page.getByRole('heading',{name:'Your envelope'}).count(),1);
  await measure('work','sidebar-budget',width);
  await page.locator('#review-rail').getByRole('button',{name:/^Open work/}).click();
  await page.getByRole('textbox',{name:'Find work'}).fill('ORG-AUTH-8');
  assert.equal(await page.locator('.review-work-link').count(),1);
  assert.equal(await page.locator('.review-work-title').innerText(),'Tenant-by-tenant cutover runbook with rollback');
  await page.locator('.review-work-link').click();
  assert.match(page.url(),/ORG-AUTH-8/);
  await page.getByRole('button',{name:'Back to work'}).click();
  // The view remounts with a fresh search after returning from a record.
  assert.equal(await page.locator('.review-work-link').count(),4);
  if(width===900)await page.getByRole('button',{name:'Show discussion'}).click();
  assert.equal(await page.locator('#review-discussion [data-testid="chat-post-boundary"]').count(),0);
  assert.equal(await page.locator('#review-discussion [data-testid="chat-message"]').count(),6);
  measurements.discussionMessages=6;
  await measure('work','discussion-open',width);
  await page.getByRole('textbox',{name:'Discussion message'}).fill('Keep this draft.');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Show discussion'}).click();
  assert.equal(await page.getByRole('textbox',{name:'Discussion message'}).innerText(),'Keep this draft.');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await measure('work','discussion-closed',width);
  await open('sprints',width);
  assert.equal(await page.locator('#review-content [role="tablist"]').count(),0);
  assert.equal(await page.locator('#review-content table table').count(),0);
  assert.equal(await page.getByRole('table',{name:'Work items'}).count(),1);
  await page.locator('#review-rail').getByRole('button',{name:/^Envelopes/}).click();
  assert.equal(await page.getByRole('table',{name:'Sprint envelopes',exact:true}).count(),1);
  await measure('sprints','sidebar-envelopes',width);
  await page.screenshot({path:path.join(out,`sprints-envelopes-${width}.png`)});
  await page.locator('#review-rail').getByRole('button',{name:/^All sprints/}).click();
  assert.equal(await page.getByRole('table',{name:'Sprints',exact:true}).count(),1);
  await measure('sprints','all-sprints',width);
  await page.getByRole('table',{name:'Sprints',exact:true}).getByRole('button',{name:'Sprint 10 — Session hygiene',exact:true}).click();
  assert.equal(await page.getByRole('table',{name:'Work items'}).count(),1);
  }
  await open('run');
  assert.equal(await page.locator('.review-timeline > li').count(),4);
  await page.getByText('View 5 execution steps',{exact:true}).click();
  assert.equal(await page.locator('.review-tool-events > li').count(),5);
  await measure('run','execution-expanded',1440);
  await page.screenshot({path:path.join(out,'run-expanded.png')});
  await page.getByRole('tab',{name:'Outputs',exact:true}).click();
  assert.equal(await page.getByText('canary/report.md',{exact:true}).count(),1);
  for(const width of [1440,900]){
    await open('dispatch',width);
    assert.equal(await page.locator('#review-composer [data-testid$="format-toolbar"]').count(),0);
    assert.equal(await page.getByRole('button',{name:'Dispatch',exact:true}).count(),0);
    await page.getByRole('button',{name:'Switch to discussion'}).click();
    await page.getByRole('textbox',{name:'Initiative discussion message'}).fill('Keep this discussion draft.');
    assert.equal(await page.locator('#review-composer [data-testid$="format-toolbar"]').count(),1);
    await measure('dispatch','discussion',width);
    await page.screenshot({path:path.join(out,`dispatch-chat-${width}.png`)});
    await page.getByRole('button',{name:'Return to agent response'}).click();
    assert.equal(await page.locator('#review-composer [data-testid$="format-toolbar"]').count(),0);
    await page.getByRole('button',{name:'Switch to discussion'}).click();
    assert.equal(await page.getByRole('textbox',{name:'Initiative discussion message'}).innerText(),'Keep this discussion draft.');
    await page.getByRole('button',{name:'Return to agent response'}).click();
    await page.locator('[data-composer-prompt-option="request"]').click();
    assert.equal(await page.getByText('Prepare an envelope request',{exact:true}).count(),1);
    await page.locator('[data-composer-prompt-option="back"]').click();
    await page.getByRole('button',{name:'Change cap',exact:true}).click();
    await measure('dispatch','cap-answer',width);
    await page.getByLabel('Run cap (USD)').fill('0.50');
    await page.getByRole('button',{name:'Save answer'}).click();
    assert.match(await page.locator('.review-facts').innerText(),/\$0\.50/);
    await page.getByRole('button',{name:'Change model',exact:true}).click();
    await page.locator('[data-composer-prompt-option="Nova"]').click();
    assert.match(await page.locator('.review-facts').innerText(),/Recalculation required/);
    await page.getByRole('combobox',{name:'Preview funding state'}).selectOption('funded');
    assert.ok(await page.locator('[data-composer-prompt-option="queue"]').isDisabled(),'Stale estimate cannot queue');
    await page.getByRole('button',{name:'Change model',exact:true}).click();
    await page.locator('[data-composer-prompt-option="Haiku"]').click();
    assert.ok(await page.locator('[data-composer-prompt-option="queue"]').isEnabled());
    await measure('dispatch','funded-confirmation',width);
    await page.screenshot({path:path.join(out,`dispatch-funded-${width}.png`)});
    await page.locator('[data-composer-prompt-option="queue"]').click();
    assert.equal(await page.getByText('Job queued in this preview',{exact:true}).count(),1);
  }
  assert.deepEqual(errors,[],'No browser runtime errors');
  assert.deepEqual(requests,[],'The review must make no network requests');
}finally{
  fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify({scope:'Revision 4 prototypes, sidebar and discussion; remaining captured shell is not certified. Light theme at 1440 and 900px.',measurements,results,errors,requests},null,2));
  await browser.close();
}
const failures=results.flatMap(r=>r.issues.map(i=>({page:r.id,state:r.state,width:r.width,...i})));
console.log(JSON.stringify({cases:results.length,issues:failures.length,browserErrors:errors.length,networkRequests:requests.length,failures:failures.slice(0,15)},null,2));
assert.equal(failures.length,0,'DOM contract violations remain; see revision-4/audit.json');
