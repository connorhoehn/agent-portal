import { chromium } from 'playwright';
import fs from 'node:fs';
const S=process.env.S, B='http://127.0.0.1:5183';
const roles=[['assessor','u-asha','assessor'],['lead-assessor','u-jonas','lead-assessor'],['program-lead','u-farah','program-lead'],['admin','u-operator','admin']];
const surfaces={workspace:'/assessment/workspace?doc=page%3A100002',enterprise:'/assessment/enterprise?doc=ec%3Astandards%2Fci-cd-standards.md',rules:'/assessment/rules?doc=rule%3Ascoring-guardrails.md',prompts:'/assessment/prompts?doc=prompt%3Aclassify-transcript.md'};
async function go(p,u){for(let i=0;i<4;i++){try{await p.goto(u,{waitUntil:"domcontentloaded"});return}catch(e){await p.waitForTimeout(2000)}}}
const browser=await chromium.launch({headless:true});
const out={};
for(const [role,user,r] of roles){
  const ctx=await browser.newContext({viewport:{width:1552,height:958}});
  const page=await ctx.newPage();
  const errs=[];
  page.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,200))});
  page.on('response',x=>{if(x.status()>=500)errs.push('HTTP '+x.status()+' '+x.url().replace(B,''))});
  await page.goto(B+'/select');
  const me=await page.evaluate(async([u,r])=>{
    const j=h=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(h)});
    await fetch('/api/session/login',j({userId:u}));
    await fetch('/api/session/tenant',j({tenant:'assessment'}));
    let m=await (await fetch('/api/session/me')).json();
    if(m.role!==r){await fetch('/api/session/role',j({role:r}));m=await (await fetch('/api/session/me')).json();}
    return {sub:m.sub,tenant:m.tenant,role:m.role};
  },[user,r]);
  out[role]={me};
  for(const [s,url] of Object.entries(surfaces)){
    errs.length=0;
    await go(page,B+url);await page.waitForSelector("main h1",{timeout:20000}).catch(()=>{});
    await page.waitForTimeout(6000);for(let i=0;i<3&&!(await page.$("main"));i++){await page.reload({waitUntil:"domcontentloaded"});await page.waitForTimeout(7000);}
    await page.waitForFunction(()=>document.querySelector("main h1"),null,{timeout:40000}).catch(()=>{});await page.waitForTimeout(3000);
    const d=await page.evaluate(()=>{
      const main=document.querySelector('main');const mr=main.getBoundingClientRect();const cs=getComputedStyle(main);
      const cl=mr.left+parseFloat(cs.paddingLeft);const cw=mr.width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
      const vw=[...main.querySelectorAll('*')].find(e=>/^DOCUMENTS\s*\d+\s*VIEWS/i.test(e.innerText?.replace(/\s+/g,' ')||'')&&e.getBoundingClientRect().width<400&&e.getBoundingClientRect().height>500);const rr=vw?vw.getBoundingClientRect():null;const hd=document.querySelector('h1');const paneEl=hd?.closest('main>div>div:last-child, main div[class*=flex-1]');const pnr=[...main.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return rr&&r.left>=rr.right-1&&r.width>600&&r.height>700}).sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0];
      const ce=[...document.querySelectorAll('[contenteditable]')];
      const pane=document.querySelector('.ProseMirror');
      const vis=e=>{if(e.offsetParent===null)return false;for(let a=e;a;a=a.parentElement){const c=getComputedStyle(a);if(c.visibility==='hidden'||c.display==='none')return false}return true};
      const ctl=[...main.querySelectorAll('a,button,input,select,textarea,[tabindex]')].filter(vis);
      const pr=pane?pane.getBoundingClientRect():null;
      const sc=document.scrollingElement;
      return {sw:document.documentElement.scrollWidth,iw:innerWidth,mains:document.querySelectorAll('main').length,h1:document.querySelector('h1')?.textContent,cl:Math.round(cl),cw:Math.round(cw),railLeft:rr?Math.round(rr.left):null,railW:rr?Math.round(rr.width):null,
        paneW:pnr?Math.round(pnr.getBoundingClientRect().width):null,canvasW:pr?Math.round(pr.width):null,toolbar:!!document.querySelector('[role=toolbar]'),dock:/Message this document|Ask the drafter/.test(document.body.innerText),agent:/Agent/.test(document.body.innerText),presence:(document.body.innerText.match(/\d+ online/)||[''])[0],pill:[...document.querySelectorAll('main *')].filter(e=>e.children.length===0&&/^(Draft|In review|Approved|Published|Finalized|Synced|Saved|Saving…?)$/.test(e.textContent.trim())).map(e=>e.textContent.trim()).slice(0,4),editable:ce.filter(e=>e.contentEditable==='true').map(e=>e.className.slice(0,20)).length,pm:!!pane,pmEditable:pane?pane.getAttribute('contenteditable'):null,
        ctl:ctl.length,bodyScroll:sc.scrollHeight,ih:innerHeight,
        text:main.innerText.replace(/\s+/g,' ').slice(0,600),
        tabs:[...document.querySelectorAll('[role=tab]')].map(t=>t.textContent.trim()),
        readerFallback:/Retry connection|read-only reader/i.test(main.innerText),unavail:/collaboration is unavailable/i.test(document.body.innerText)};
    });
    // Tab walk
    await page.mouse.click(5,5);
    const seen=new Set();
    for(let i=0;i<70;i++){await page.keyboard.press('Tab');const k=await page.evaluate(()=>{const e=document.activeElement;return e&&e!==document.body?(e.tagName+'|'+(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,24)):'body'});seen.add(k);}
    d.tabStops=seen.size;
    await page.keyboard.press('Escape');
    d.errs=[...errs];
    d.menus=await page.evaluate(()=>document.querySelectorAll('[role=menu]').length);
    await page.screenshot({path:`${S}/shots/${role}-${s}.jpg`,type:'jpeg',quality:80});
    out[role][s]=d;
  }
  // empty state
  errs.length=0;
  await go(page,B+'/assessment/workspace?doc=page%3A99999999');await page.waitForTimeout(4000);
  out[role].empty=await page.evaluate(()=>(document.querySelector('main')?.innerText||document.body.innerText).replace(/\s+/g,' ').slice(0,200));
  out[role].emptyErrs=[...errs];
  await ctx.close();
}
fs.writeFileSync(S+'/walk.json',JSON.stringify(out,null,1));
await browser.close();
