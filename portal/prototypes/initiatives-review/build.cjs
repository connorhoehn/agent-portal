const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require('@playwright/test');
const repo = path.resolve(__dirname, '../../..');
const gallery = path.join(repo, '.scratch/initiatives-mockups-2026-10-28');
const revision = Number(process.env.REVIEW_REVISION || 4);
const out = path.join(gallery, `revision-${revision}`);
const pages = [
  ['budget', 'admin-budgets--release--floor-vs-discretionary', 'Budget by initiative', 'Initiative navigation in the sidebar; people, avatars and quieter activity metadata in the detail.'],
  ['work', 'initiative-auth-migration-work--nora--work-board-agent-status', 'Work with sidebar navigation', 'Work status and funding in the second sidebar. Compact discussion with its own composer.'],
  ['run', 'work-job--nora--run-steps', 'Run timeline · approved', 'The approved revision 3 artifact, preserved exactly.'],
  ['dispatch', 'initiative-observability-deep--nora--dispatch-stepper', 'Dispatch · start here', 'Compact agent dialogue beside job settings, with working numbered keyboard responses.'],
  ['sprints', 'projects-sprints--release--sprint-envelopes', 'Initiative work', 'All open work and Active sprint are sibling views within the initiative.'],
];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({entryPoints:[path.join(__dirname,revision===5?'v5.tsx':revision===4?'v4.tsx':'main-v3.tsx')],bundle:true,outfile:path.join(out,'review.js'),format:'iife',platform:'browser',target:'es2022',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}});
  const js=fs.readFileSync(path.join(out,'review.js'),'utf8').replaceAll('</script','<\\/script');
  const css=fs.readFileSync(path.join(out,'review.css'),'utf8');
  const browser=await chromium.launch();
  const page=await browser.newPage();
  for(const [id,original,title] of pages){
    if(revision>=4&&id==='run'){
      for(const file of ['run.html','run.png','run-900.png'])fs.copyFileSync(path.join(gallery,'revision-3',file),path.join(out,file));
      continue;
    }
    await page.goto('file://'+path.join(gallery,'variants',original+'.html'));
    await page.evaluate(({id,title,revision})=>{
      document.title=title+` · Revision ${revision}`;
      document.body.dataset.reviewPage=id;
      document.body.dataset.reviewRevision=String(revision);
      if(revision>=4&&id==='work'){
        const messages=[...document.querySelectorAll('[data-testid="chat-message"]')].map(e=>({
          id:e.getAttribute('data-message-id'), clientId:e.getAttribute('data-message-id'),
          displayName:e.querySelector('[data-testid="message-row-author"]')?.textContent,
          content:e.querySelector('[data-testid="message-body"]')?.textContent,
          timestamp:e.querySelector('[data-testid="message-row-time"]')?.getAttribute('datetime'),
          avatarUrl:e.querySelector('img')?.getAttribute('src'),
        }));
        const data=document.createElement('script');data.id='review-messages';data.type='application/json';data.textContent=JSON.stringify(messages).replaceAll('<','\\u003c');document.body.append(data);
        const pane=document.querySelector('[data-testid="page-conversation-pane"]');
        if(pane)pane.innerHTML='<div id="review-discussion"></div>';
        document.querySelector('[data-testid="explorer-layout-pane-footer"]')?.remove();
      }
      if(revision>=4&&(id==='work'||id==='sprints'||(revision===5&&id==='dispatch'))){
        const rail=document.querySelector('[data-testid="explorer-layout-rail"]');
        if(rail){rail.className='review-context-rail';rail.removeAttribute('style');rail.innerHTML='<div id="review-rail"></div>';}
        const header=document.querySelector('[data-testid="explorer-layout-pane-header"]');
        const crumbs=header?.querySelector('nav[aria-label="Breadcrumb"]');
        if(header&&crumbs){crumbs.classList.add('refine-crumbs');header.replaceChildren(crumbs);}else header?.remove();
      }
      document.querySelectorAll('aside').forEach((nav,index)=>nav.setAttribute('data-review-nav',index===0?'primary':'secondary'));
      if(revision===5&&id==='budget'){
        const rail=document.querySelector('[data-review-nav="secondary"]');
        rail.className='review-context-rail';rail.removeAttribute('style');rail.innerHTML='<div id="review-rail"></div>';
        const section=document.querySelector('[data-mockup-region="content"]').closest('section');
        section.className='flex-1 min-w-0 min-h-0 overflow-hidden';
        section.innerHTML='<div data-mockup-region="content" style="height:100%;min-height:0"></div>';
      }
      if(revision===5&&id==='dispatch'){
        document.querySelector('[data-testid="explorer-layout-pane-footer"]')?.remove();
        document.querySelector('[data-testid="shell-split-secondary"]')?.remove();
      }
      if(revision===5&&id==='sprints'){
        const crumbs=document.querySelector('.refine-crumbs');
        if(crumbs)crumbs.textContent='Initiatives › Auth Migration › Work';
      }
      const content=document.querySelector('[data-mockup-region="content"]');
      content.innerHTML=`<div id="review-content" data-page="${id}"></div>`;
      const composer=document.querySelector('[data-testid="initiative-central-composer"]');
      if(id==='dispatch'&&revision<5&&composer){composer.innerHTML='<div id="review-composer"></div>';}
      // Preserve the captured discussion composition; fold its idle editor so it
      // does not consume a quarter of the work list before the user writes.
      if(id==='work'||id==='sprints'){
        const rich=document.querySelector('[data-testid="rich-chat-composer"]');
        if(rich){
          const parent=rich.parentElement;
          const toggle=document.createElement('details');toggle.setAttribute('data-review-idle-composer','');
          const summary=document.createElement('summary');summary.textContent='Discuss this work…';summary.style.cssText='padding:10px 12px;cursor:pointer;font-size:13px;';
          toggle.append(summary);parent.replaceChild(toggle,rich);toggle.append(rich);
        }
      }
    },{id,title,revision});
    let html=await page.content();
    html=html.replace(/http:\/\/127\.0\.0\.1:5183\/avatars\/photos\/([a-z0-9_-]+\.jpg)/g,(_,name)=>`data:image/jpeg;base64,${fs.readFileSync(path.join(repo,'portal/public/avatars/photos',name)).toString('base64')}`);
    html=html.replace('</head>',()=>`<style data-review-layout>${css}</style></head>`).replace('</body>',()=>`<script>${js}</script></body>`);
    fs.writeFileSync(path.join(out,id+'.html'),html);
  }
  await browser.close();
  fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Initiatives · revised detail layouts</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 24px;color:#172038}h1{font-size:24px}h2{font-size:17px}a{color:#5145cd}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px}article{border:1px solid #dbe1eb;border-radius:8px;overflow:hidden}article h2,article p{margin:12px 16px}img{width:100%;display:block;border-bottom:1px solid #dbe1eb}.note{color:#596579}</style><p><a href="../index.html">← Original gallery</a> · <a href="../revision-3/index.html">Revision 3</a></p><h1>Revised detail layouts</h1><p class="note">Revision ${revision} · sidebar navigation, compact funding detail and contextual responses. Interactive local prototypes using the installed UI library. All data is illustrative; actions stay in the preview.</p><div class="grid">${pages.map(([id,,title,description])=>`<article><a href="${id}.html"><img src="${id}.png" alt="${title}"></a><h2><a href="${id}.html">${title} →</a></h2><p>${description}</p></article>`).join('')}</div></html>`);
  const index=path.join(gallery,'index.html');
  let html=fs.readFileSync(index,'utf8');
  if(!html.includes('data-revision-three')) html=html.replace(/<body[^>]*>/,m=>m+'<aside data-revision-three style="padding:16px 24px;margin:16px;border:1px solid #dbe1eb;border-radius:8px;background:#fff"><strong>Revised detail layouts</strong> · <a href="revision-3/index.html">Open revision 3: nesting, timelines and adaptive agent dialogue →</a></aside>');
  if(revision===4&&!html.includes('data-revision-four'))html=html.replace(/<body[^>]*>/,m=>m+'<aside data-revision-four style="padding:16px 24px;margin:16px;border:1px solid #dbe1eb;border-radius:8px;background:#fff"><strong>Latest revision</strong> · <a href="revision-4/index.html">Open revision 4: sidebar navigation and compact details →</a></aside>');
  if(revision===5&&!html.includes('data-revision-five'))html=html.replace(/<body[^>]*>/,m=>m+'<aside data-revision-five style="padding:16px 24px;margin:16px;border:1px solid #dbe1eb;border-radius:8px;background:#fff"><strong>Latest revision</strong> · <a href="revision-5/index.html">Open revision 5: compact dispatch, initiative budget sidebar and active sprint →</a></aside>');
  fs.writeFileSync(index,html);
  console.log(`Built ${pages.length} interactive review pages in ${out}`);
})().catch(error=>{console.error(error);process.exitCode=1});
