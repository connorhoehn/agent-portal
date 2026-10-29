import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here=path.dirname(fileURLToPath(import.meta.url));
const gallery=path.resolve(here,'../../../.scratch/initiatives-mockups-2026-10-28');
const out=path.join(gallery,'revision-5');
const skill=process.env.UI_DOM_AUDIT_SKILL??path.join(os.homedir(),'.codex/skills/ui-dom-audit');
const {measureDOM}=await import(pathToFileURL(path.join(skill,'scripts/measure.mjs')));
const scrollers=[{selector:'#review-content',reason:'The record body scrolls above its docked response area.'}];
// The inline response is already traversed under #review-content. Only add
// standalone composers as roots, to avoid measuring each text node twice.
const contract={version:1,name:'Initiatives detail review',rules:[
  {id:'viewport',kind:'viewport'},
  {id:'text.overlap',kind:'text-overlap',selector:'#review-content, #review-composer:not(#review-content #review-composer), #review-rail, #review-discussion'},
  {id:'text.cramped',kind:'text-cramped',selector:'#review-content, #review-composer:not(#review-content #review-composer), #review-rail, #review-discussion',maxLines:2,minChars:12},
  {id:'text.clipped',kind:'text-clipped',selector:'#review-content, #review-composer:not(#review-content #review-composer), #review-rail, #review-discussion',scrollers,requireFullText:true},
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
  // Reproduce the prior integration defect before verifying the fix.
  await page.goto(pathToFileURL(path.join(gallery,'revision-4/dispatch.html')).href);
  await page.keyboard.press('1');
  assert.equal(await page.getByText('This job needs a sprint envelope',{exact:true}).count(),1);
  measurements.reproducedV4ShortcutFailure=true;
  for(const width of [1440,900]){
    await open('budget',width);
    assert.equal(await page.locator('#review-rail').getByRole('navigation',{name:'Initiative budgets',exact:true}).getByRole('button').count(),14);
    assert.equal(await page.locator('#review-content table table').count(),0);
    assert.equal(await page.locator('.v5-funding-table tbody tr').count(),3);
    measurements.budgetPersonHeight=await page.locator('.v5-funding-table tbody tr').first().evaluate(e=>e.getBoundingClientRect().height);
    assert.ok(measurements.budgetPersonHeight<=60);
    const type=await page.locator('.v5-last-used').first().evaluate(e=>({style:getComputedStyle(e).fontStyle,size:getComputedStyle(e).fontSize,family:getComputedStyle(e).fontFamily}));
    assert.equal(type.style,'italic');assert.equal(type.size,'12px');assert.match(type.family,/Georgia/);
    assert.equal(await page.locator('.v5-funding-table [data-ui-text="avatar"]').count(),3);
    await page.getByText('View automations',{exact:true}).click();
    assert.equal(await page.getByText('auth-dep-watch',{exact:true}).count(),1);
    await measure('budget','automations-expanded',width);
    await page.locator('#review-rail').getByRole('button',{name:'All initiatives',exact:true}).click();
    assert.equal(await page.getByRole('table',{name:'Budget overview'}).count(),1);
    await measure('budget','overview',width);
    await page.locator('#review-rail').getByRole('textbox',{name:'Find initiative'}).fill('Auth');
    assert.equal(await page.locator('#review-rail').getByRole('navigation',{name:'Initiative budgets',exact:true}).getByRole('button').count(),1);
    await page.locator('#review-rail').getByRole('button',{name:'Auth Migration',exact:true}).click();
    assert.equal(await page.getByRole('table',{name:'Sprint envelopes',exact:true}).count(),1);
  }
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
  assert.equal(await page.getByRole('heading',{name:'Active sprint',exact:true}).count(),1);
  await page.locator('#review-rail').getByRole('button',{name:/^All open work/}).click();
  assert.equal(await page.getByRole('heading',{name:'All open work',exact:true}).count(),1);
  assert.match(page.url(),/initiatives\/auth\/work\/all-open-work/);
  await measure('sprints','all-open-work',width);
  await page.locator('#review-rail').getByRole('button',{name:/^In progress/}).click();
  assert.equal(await page.locator('.review-work-link').count(),1);
  await measure('sprints','work-status',width);
  await page.locator('#review-rail').getByRole('button',{name:/^Sprint envelopes/}).click();
  assert.equal(await page.getByRole('table',{name:'Sprint envelopes',exact:true}).count(),1);
  await measure('sprints','sidebar-envelopes',width);
  await page.locator('#review-rail').getByRole('button',{name:/^Active sprint/}).click();
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
    const initial=await page.locator('#review-composer').boundingBox();
    const instruction=await page.locator('.v5-instruction').boundingBox();
    assert.ok(initial.y-(instruction.y+instruction.height)<=16,'Decision must sit next to instruction');
    assert.ok(initial.y+initial.height<650,'The full initial response must fit above the fold');
    measurements[`dispatchResponse${width}`]=initial;
    assert.equal(await page.locator('#review-composer [data-testid$="format-toolbar"]').count(),0);
    await page.keyboard.press('1');
    assert.equal(await page.getByText('Request funding from Sienna?',{exact:true}).count(),1,'1 must work on arrival without clicking the deck');
    await measure('dispatch','keyboard-request',width);
    await page.keyboard.press('Enter');
    assert.equal(await page.getByText('Your request is ready to review',{exact:true}).count(),1);
    await page.keyboard.press('1');
    assert.equal(await page.getByText('This job needs a sprint envelope',{exact:true}).count(),1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-composer-prompt-option="request"]').count(),0);
    await page.keyboard.press('Control+ArrowDown');
    assert.equal(await page.locator('[data-composer-prompt-option="request"]').count(),1);
    // Blur to the document, then use the shortcut again, as in the reported defect.
    await page.evaluate(()=>document.activeElement.blur());
    await page.keyboard.press('2');
    assert.equal(await page.getByText('Saved for later',{exact:true}).count(),1);
    await page.keyboard.press('1');
    await page.getByRole('button',{name:'Change cap',exact:true}).click();
    await page.keyboard.press('1');
    assert.equal(await page.getByLabel('Run cap (USD)').inputValue(),'1','A typed number must not activate a response');
    await measure('dispatch','cap-answer',width);
    await page.getByLabel('Run cap (USD)').fill('0.50');
    await page.keyboard.press('Enter');
    assert.match(await page.locator('.v5-job-settings').innerText(),/\$0\.50/);
    await page.getByRole('button',{name:'Edit instruction',exact:true}).click();
    await page.getByRole('textbox',{name:'Job instruction',exact:true}).fill('Preserve the first alert.');
    await page.getByRole('button',{name:'Save answer',exact:true}).click();
    assert.equal(await page.locator('.v5-instruction p').innerText(),'Preserve the first alert.');
    await page.getByRole('button',{name:'Switch to discussion'}).click();
    await page.getByRole('textbox',{name:'Initiative discussion message'}).fill('Keep this draft ');
    await page.keyboard.press('1');
    assert.equal(await page.getByRole('textbox',{name:'Initiative discussion message'}).innerText(),'Keep this draft 1');
    assert.equal(await page.locator('#review-composer [data-testid$="format-toolbar"]').count(),1);
    await measure('dispatch','discussion',width);
    await page.screenshot({path:path.join(out,`dispatch-chat-${width}.png`)});
    await page.getByRole('button',{name:'Return to agent response'}).click();
    assert.equal(await page.locator('#review-composer [data-testid$="format-toolbar"]').count(),0);
    await page.getByRole('button',{name:'Switch to discussion'}).click();
    assert.equal(await page.getByRole('textbox',{name:'Initiative discussion message'}).innerText(),'Keep this draft 1');
    await page.getByRole('button',{name:'Return to agent response'}).click();
    await page.getByRole('button',{name:'Change model',exact:true}).click();
    await page.keyboard.press('2');
    assert.match(await page.locator('.v5-job-settings').innerText(),/Needs updating/);
    await page.getByRole('combobox',{name:'Preview funding state'}).selectOption('funded');
    assert.ok(await page.locator('[data-composer-prompt-option="queue"]').isDisabled(),'Stale estimate cannot queue');
    await page.keyboard.press('1');
    assert.equal(await page.getByText('Ready to queue this job?',{exact:true}).count(),1,'Disabled choices must ignore their shortcut');
    await measure('dispatch','stale-forecast',width);
    await page.getByRole('button',{name:'Change model',exact:true}).click();
    await page.keyboard.press('1');
    assert.ok(await page.locator('[data-composer-prompt-option="queue"]').isEnabled());
    await measure('dispatch','funded',width);
    await page.screenshot({path:path.join(out,`dispatch-funded-${width}.png`)});
    await page.keyboard.press('1');
    assert.equal(await page.getByText('Job queued in this preview',{exact:true}).count(),1);
    await measure('dispatch','queued-preview',width);
  }
  assert.deepEqual(errors,[],'No browser runtime errors');
  assert.deepEqual(requests,[],'The review must make no network requests');
}finally{
  fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify({scope:'Revision 5 prototypes: keyboard response integration, initiative budget sidebar, active sprint and retained work/run views. Remaining captured shell is not certified. Light theme at 1440 and 900px.',measurements,results,errors,requests},null,2));
  await browser.close();
}
const failures=results.flatMap(r=>r.issues.map(i=>({page:r.id,state:r.state,width:r.width,...i})));
console.log(JSON.stringify({cases:results.length,issues:failures.length,browserErrors:errors.length,networkRequests:requests.length,failures:failures.slice(0,15)},null,2));
assert.equal(failures.length,0,'DOM contract violations remain; see revision-5/audit.json');
