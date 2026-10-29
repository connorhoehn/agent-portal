const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const gallery = path.resolve(__dirname, '../../../.scratch/initiatives-mockups-2026-10-28');
const baseline = path.join(gallery, 'revision-4');
const out = path.join(gallery, 'revision-4-response-flow');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(baseline)) {
    if (/\.(html|png)$/.test(name)) fs.copyFileSync(path.join(baseline, name), path.join(out, name));
  }
  const built = await esbuild.build({entryPoints:[path.join(__dirname,'main-response-flow.tsx')],bundle:true,write:false,outfile:'keyboard.js',format:'iife',platform:'browser',target:'es2022',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
  const js = built.outputFiles.find(f => f.path.endsWith('.js')).text.replaceAll('</script','<\\/script');
  // Keep the actual baseline HTML and every style byte. Replace only the last
  // script, which mounts the interactive prototype body and response component.
  let html = fs.readFileSync(path.join(baseline,'dispatch.html'),'utf8');
  const start = html.indexOf('<script>"use strict";');
  const end = html.indexOf('</script>',start);
  if (start < 0 || end < 0) throw new Error('Baseline application script not found');
  html = html.slice(0,start)+'<script>'+js+'</script>'+html.slice(end+9);
  const css=fs.readFileSync(path.join(__dirname,'budget-request-flow.css'),'utf8');
  html=html.replace('</head>',()=>'<style data-response-flow>'+css+'</style></head>');
  fs.writeFileSync(path.join(out,'dispatch.html'),html);
  let index = fs.readFileSync(path.join(out,'index.html'),'utf8');
  index = index.replace('<h1>Revised detail layouts</h1>','<h1>Revision 4 · progressive budget request component</h1>').replace(/<p class="note">.*?<\/p>/,'<p class="note">Only the dispatch response component changes: choose a path, edit the request, review, then confirm. The page structure and other pages are preserved from revision 4.</p>');
  fs.writeFileSync(path.join(out,'index.html'),index);
  const original = path.join(gallery,'index.html');
  let root = fs.readFileSync(original,'utf8').replace(/<aside data-revision-five[\s\S]*?<\/aside>/,'');
  root = root.replace(/<aside data-keyboard-fix[\s\S]*?<\/aside>/,'');
  root = root.replace(/<body[^>]*>/,m=>m+'<aside data-keyboard-fix style="padding:16px 24px;margin:16px;border:1px solid #dbe1eb;border-radius:8px;background:#fff"><strong>Component-only correction</strong> · <a href="revision-4-response-flow/dispatch.html">Revision 4 dispatch: progressive response component →</a></aside>');
  fs.writeFileSync(original,root);
  console.log(`Built ${out}; only dispatch response component changed.`);
})().catch(error=>{console.error(error);process.exitCode=1});
