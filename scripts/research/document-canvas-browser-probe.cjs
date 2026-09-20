// Isolated reuse proof: mounts shipped components, edits only an in-memory Y.Doc,
// and records errors/network writes. Run from any directory after portal npm ci.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const examples = process.argv.includes('--examples');
const portal = path.resolve(__dirname, examples ? '../../../realtime-examples/frontend' : '../../portal');
const scope = examples ? '@connorhoehn' : '@connorhoehnslalom';
const req = createRequire(path.join(portal, 'package.json'));
const excluded = [scope+'/ui-components', '@tiptap/pm/model', '@tiptap/pm/state', '@tiptap/pm/transform', '@tiptap/pm/view', 'prosemirror-state', 'prosemirror-model', 'prosemirror-transform', 'prosemirror-view', 'prosemirror-gapcursor', 'prosemirror-dropcursor', 'prosemirror-history', 'prosemirror-keymap', 'prosemirror-commands', 'prosemirror-schema-list', 'prosemirror-tables', 'prosemirror-changeset', '@tiptap/y-tiptap'];
(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-canvas-probe-')));
  let server, browser;
  try {
    fs.symlinkSync(path.join(portal, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
    fs.writeFileSync(path.join(root, 'main.tsx'), `
import React, {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import * as Y from 'yjs';
import {CanvasDocumentView} from '${scope}/ui-components/doc-editor';
import {useCanvasDocument} from '${scope}/realtime-modules/client';
import {CanvasTextAlign, MarkdownClipboard} from '${scope}/realtime-modules/adapters/tiptap';
import {TableKit} from '@tiptap/extension-table';
import {Image} from '@tiptap/extension-image';
import {TextStyleKit} from '@tiptap/extension-text-style';
const extensions=[CanvasTextAlign,MarkdownClipboard,TableKit,Image,TextStyleKit];
import '${scope}/ui-components/styles.css';
function Probe(){
 const [ydoc]=useState(()=>new Y.Doc());
 const canvas=useCanvasDocument({ydoc});
 const seeded=useRef(false);
 return <CanvasDocumentView isCanvas={canvas.isCanvas} body={canvas.body} ydoc={ydoc}
   extensions={extensions} provider={null} user={{name:'Isolated research',color:'#0B6666'}} editable
   schemaProbe={ydoc.getXmlFragment('body')} onConvert={async()=>null}
   onEditorReady={editor=>{
     if(!editor)return;
     window.canvasResearch??={};
     window.canvasResearch.focusEnd=()=>editor.commands.focus('end');
     if(seeded.current)return;
     seeded.current=true;
     const result=canvas.importMarkdown(editor.schema,'# Research document\\n\\nExisting **canvas component**, ruler and toolbar.\\n\\n| Dimension | Evidence |\\n| --- | --- |\\n| CI | **Build logs** |\\n\\n![Architecture](/probe-diagram.svg \"Evidence diagram\")\\n\\nEnd of sample.\\n');
     Object.assign(window.canvasResearch,{result,exportMarkdown:canvas.exportMarkdown});
   }}/>;
}
createRoot(document.getElementById('root')).render(<Probe/>);
`);
    fs.writeFileSync(path.join(root,'probe-diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" fill="teal"/><text x="15" y="36" fill="white">Preserved image</text></svg>');
    const {createServer} = await import(pathToFileURL(req.resolve('vite')).href);
    const {default:react} = await import(pathToFileURL(req.resolve('@vitejs/plugin-react')).href);
    server = await createServer({root,configFile:false,logLevel:'silent',plugins:[react()],esbuild:{jsx:'automatic'},
      cacheDir:path.join(root,'.vite'),
      resolve:{dedupe:['react','react-dom','yjs','y-protocols','lib0']},
      optimizeDeps:{include:[scope+'/realtime-modules/client',scope+'/realtime-modules/adapters/tiptap','yjs','y-protocols/awareness','lib0/observable','@tiptap/core','@tiptap/react'],exclude:excluded},
      server:{host:'127.0.0.1',port:0,fs:{allow:[root,portal]}}
    });
    await server.listen();
    const {chromium,expect}=req('@playwright/test');browser=await chromium.launch();
    const page=await browser.newPage({viewport:{width:1500,height:1000}});
    const pageErrors=[],backendWrites=[],badScripts=[];
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Debugger.enable');
    cdp.on('Debugger.scriptFailedToParse',data=>badScripts.push({url:data.url,line:data.endLine,column:data.endColumn}));
    page.on('response',async r=>{if(r.request().resourceType()==='script'){const body=await r.text().catch(()=> '');if(body.trimStart().startsWith('<'))badScripts.push(r.url());}});
    page.on('pageerror',e=>pageErrors.push(e.stack || e.message));
    page.on('request',r=>{if(['POST','PUT','PATCH','DELETE'].includes(r.method()))backendWrites.push({method:r.method(),path:new URL(r.url()).pathname});});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    const editor=page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({timeout:20000}).catch(error => { throw new Error(`${error.message}; page errors: ${JSON.stringify(pageErrors)}; HTML scripts: ${JSON.stringify(badScripts)}`); });
    await expect(editor.locator('table')).toBeVisible();
    await expect(editor.locator('img[alt="Architecture"]')).toBeVisible();
    await page.evaluate(()=>window.canvasResearch.focusEnd());await page.keyboard.type(' Local canvas edit.');await page.keyboard.press('Enter');
    await editor.evaluate(element=>{
      const clipboardData=new DataTransfer();
      clipboardData.setData('text/plain','| Deployment | Result |\n| --- | --- |\n| Release | Passed |\n');
      element.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
    });
    await expect(editor.locator('table')).toHaveCount(2);
    await expect(editor.locator('table table')).toHaveCount(0);
    const observed=await page.evaluate(()=>({seed:window.canvasResearch.result,markdown:window.canvasResearch.exportMarkdown()}));
    assert.equal(observed.seed.ok,true);assert.ok(observed.markdown.includes('Local canvas edit.'));
    assert.ok(observed.markdown.includes('![Architecture](/probe-diagram.svg \"Evidence diagram\")'));
    assert.ok(observed.markdown.includes('Deployment'));
    assert.ok(observed.markdown.includes('| Dimension'));
    assert.deepEqual(pageErrors,[]);assert.deepEqual(backendWrites,[]);
    const screenshot=process.env.CANVAS_PROBE_SCREENSHOT;
    if(screenshot)await page.screenshot({path:screenshot});
    console.log(JSON.stringify({consumer:examples?'realtime-examples':'aws-agentcore/portal',component:'CanvasDocumentView',hook:'useCanvasDocument',seedResult:observed.seed,localEditReflectedInExport:true,nativeTableAndImage:true,markdownTablePaste:true,pageErrors,backendWrites,configuration:'examples ProseMirror singleton exclusions adapted to consumer scope'},null,2));
  } finally {
    await browser?.close();await server?.close();fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
