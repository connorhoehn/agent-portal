// Read-only browser audit. Uses an isolated Chromium context and the dev picker.
// No scoring, source changes, shared cookies, or service restarts.
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const fs=require('node:fs');
const req=createRequire(resolve(__dirname,'../../portal/package.json'));
const {chromium,expect}=req('@playwright/test');
const out=resolve(process.env.TEAM_AUDIT_OUTPUT||'/tmp/team-certification-audit');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch();
 try {
  const context=await browser.newContext({viewport:{width:1500,height:1000}});
  const page=await context.newPage();let phase='login';const errors=[];const pageErrors=[];
  page.on('console',m=>{if(m.type()==='error')errors.push({phase,message:m.text()})});
  page.on('pageerror',e=>pageErrors.push({phase,message:e.message}));
  await page.goto('http://127.0.0.1:5183/select');
  await page.getByRole('tab',{name:'Sign in as'}).click();
  await page.getByRole('button',{name:'Sign in as Platform Operator',exact:true}).click();
  await page.getByRole('button',{name:'Enter Assessment as Admin',exact:true}).click();
  await page.waitForURL('**/assessment/**');
  const identity=await page.evaluate(()=>fetch('/api/session/me').then(r=>r.json()).then(x=>({sub:x.sub,tenant:x.tenant,role:x.role})));
  expect(identity).toEqual({sub:'u-operator',tenant:'assessment',role:'admin'});
  phase='team';await page.goto('http://127.0.0.1:5183/assessment/teams/TEAM-001');
  await page.getByRole('heading',{name:'Northstar Payments'}).waitFor();
  const rail=page.getByTestId('assessment-dimension-master-detail-rail');
  const row=id=>page.getByTestId(`assessment-dimension-master-detail-row-${id}`);
  await expect(rail.getByRole('option')).toHaveCount(17);
  await row('3').focus();await page.keyboard.press('Enter');await expect(row('3')).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('ArrowDown');await expect(row('4')).toHaveAttribute('aria-selected','true');
  const tabs=[];
  for(const name of ['Improvement Plan','Stories','Evidence & Intake','Documents','Certification']){
   phase=name;await page.getByRole('tab',{name,exact:true}).click();
   await expect(page.getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true');
   tabs.push({name,url:page.url()});
  }
  await expect(row('4')).toHaveAttribute('aria-selected','true');
  phase='dimension detail tabs';
  for(const name of ['How it was assessed','Evidence','Definition & rubric','History','Progress & follow-ups']){
   await page.getByRole('tab',{name,exact:true}).click();await expect(page.getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true');
  }
  phase='filters';await page.getByRole('textbox',{name:'Find a dimension'}).fill('no-matching-dimension');
  await expect(page.getByText('No dimensions match these filters.')).toBeVisible();
  await page.getByRole('textbox',{name:'Find a dimension'}).fill('');
  await page.getByRole('button',{name:'Open claims',exact:true}).click();
  const claims=await rail.getByRole('option').count();expect(claims).toBe(6);
  await page.getByRole('button',{name:'Open claims',exact:true}).click();
  phase='team details';await page.getByRole('button',{name:'Team details',exact:true}).click();
  const repos=await page.getByTestId('team-repos').getByRole('link').evaluateAll(es=>es.map(e=>({name:e.textContent,url:e.href})));
  expect(repos).toHaveLength(2);await page.keyboard.press('Escape');await expect(page.getByTestId('team-repos')).not.toBeVisible();
  phase='keyboard';
  const keyboard=await page.evaluate(()=>{
   const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility==='visible'&&!e.closest('[hidden],[inert]');
   const controls=[...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(e=>visible(e)&&!e.disabled&&e.tabIndex>=0);
   controls.forEach((e,i)=>e.dataset.auditFocus=String(i));return{controls:controls.length,visited:[]};
  });
  await page.locator('[data-audit-focus="0"]').focus();
  for(let i=0;i<keyboard.controls+3;i++){
   const id=await page.evaluate(()=>document.activeElement?.getAttribute('data-audit-focus'));
   if(id!==null&&!keyboard.visited.includes(id))keyboard.visited.push(id);
   await page.keyboard.press('Tab');
  }
  keyboard.reachedAll=keyboard.visited.length===keyboard.controls;
  await row('1').click();await page.locator('#main-content').evaluate(e=>e.scrollTop=0);
  const measurement=()=>page.evaluate(()=>{const box=e=>e?.getBoundingClientRect().toJSON();const main=document.querySelector('main');return{viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,main:box(main),contentLeft:main.getBoundingClientRect().left+parseFloat(getComputedStyle(main).paddingLeft),contentWidth:main.clientWidth-parseFloat(getComputedStyle(main).paddingLeft)-parseFloat(getComputedStyle(main).paddingRight),master:box(document.querySelector('[data-testid="assessment-dimension-master-detail"]')),rail:box(document.querySelector('[data-testid="assessment-dimension-master-detail-rail"]')),detail:box(document.querySelector('[data-testid="assessment-dimension-master-detail-detail"]')),selected:document.querySelector('[aria-selected="true"][role="option"]')?.getAttribute('data-testid')};});
  const measurements={};
  for(const [name,width,height] of [['desktop',1500,1000],['tablet',768,1024],['mobile',390,844]]){
   phase=name;await page.setViewportSize({width,height});await page.locator('#main-content').evaluate(e=>e.scrollTop=0);
   measurements[name]=await measurement();expect(measurements[name].scrollWidth).toBeLessThanOrEqual(width);await page.screenshot({path:resolve(out,`${name}.png`)});
   if(name==='mobile'){await page.getByRole('button',{name:'Assessment navigation',exact:true}).click(); await expect(page.getByRole('menuitem',{name:'Dashboard',exact:true})).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('menuitem',{name:'Dashboard',exact:true})).not.toBeVisible();}
   if(name==='tablet'||name==='mobile'){await page.getByTestId('assessment-dimension-master-detail').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(out,`${name}-dimensions.png`)});}
  }
  phase='mobile navigation';
  await page.getByRole('tab',{name:'Documents',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.getByText('Documents live in Workspace',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Certification',exact:true}).click();
  await page.getByRole('button',{name:'Assessment navigation',exact:true}).click();
  await page.getByRole('menuitem',{name:'Dashboard',exact:true}).click();
  await expect(page).toHaveURL(/\/assessment\/teams$/);
  await page.goBack();await page.getByRole('heading',{name:'Northstar Payments'}).waitFor();
  phase='missing team';await page.setViewportSize({width:1500,height:1000});await page.goto('http://127.0.0.1:5183/assessment/teams/TEAM-999');
  await expect(page.getByText('No team TEAM-999',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Back to the dashboard'})).toBeVisible();
  const result={identity,tabs,dimensionSelectionSurvivesTabs:true,detailTabs:5,claims,emptyFilter:true,mobileNavigation:{escapeCloses:true,dashboardRoutes:true,documentsTabKeyboard:true},repos,keyboard,measurements,missingTeam:'No team TEAM-999 with Back to the dashboard',errors,pageErrors};
  fs.writeFileSync(resolve(out,'observations.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
 } finally {await browser.close();}
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
