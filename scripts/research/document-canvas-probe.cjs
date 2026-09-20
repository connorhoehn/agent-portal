// Read-only package probe. Run from the repository root; --examples uses the
// sibling example's installed schema peers. No network calls or document writes.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const examples = process.argv.includes('--examples');
const upstream = process.argv.includes('--upstream');
const base = resolve(__dirname, upstream ? '../../../realtime-modules' : examples ? '../../../realtime-examples/frontend' : '../../portal');
const req = createRequire(resolve(base, 'package.json'));
const scope = (examples || upstream) ? '@connorhoehn/realtime-modules' : '@connorhoehnslalom/realtime-modules';
const { parseDocument, serializeDocument } = req('distributed-core/applications/document');
const adapter = req(`${scope}/adapters/tiptap`);
const samples = {
  assessment: '# Rubric Overview\n\nEvery team is assessed against **17 dimensions**.\n\n## Two tracks\n\n- **Claimed level** — what the team reports.\n- **Verified level** — what evidence establishes.\n',
  frontmatter: '---\ntitle: Runbook\nowner: assessment\n---\n\n# Runbook\n\n[Evidence](https://example.com/evidence) and `code`.\n',
  table: '| Dimension | Level |\n| --- | --- |\n| CI | 3 |\n',
  image: '![Architecture](https://example.com/architecture.png)\n',
  tasks: '- [ ] Validate evidence\n- [x] Read the rubric\n',
  code: '```json\n{"verified": true}\n```\n',
};
const peers = Object.fromEntries(['@tiptap/extension-text-style','@tiptap/extension-table','@tiptap/extension-image'].map(name => {
  try { return [name, req.resolve(name) ? true : false]; } catch { return [name, false]; }
}));
const extensions = [req('@tiptap/starter-kit').StarterKit.configure({undoRedo:false})];
if (peers['@tiptap/extension-table']) extensions.push(req('@tiptap/extension-table').TableKit);
if (peers['@tiptap/extension-image']) extensions.push(req('@tiptap/extension-image').default);
if (adapter.CanvasTextAlign) extensions.push(adapter.CanvasTextAlign);
const schema = req('@tiptap/core').getSchema(extensions);
const results = Object.entries(samples).map(([name, markdown]) => {
  const model = parseDocument(markdown);
  const converted = adapter.docModelToPm(model, schema);
  const back = adapter.pmToDocModel(converted.doc, model.frontMatter);
  return { name, inputBlockTypes: model.content.map(x=>x.type), pmTypes: converted.doc.content.map(x=>x.type), unsupported: converted.unsupported, exportedMarkdown: serializeDocument(back) };
});
let binaryProof = null;
if (examples) {
  const Y = req('yjs');
  const bridge = req('@tiptap/y-tiptap');
  const { getSchema } = req('@tiptap/core');
  const { StarterKit } = req('@tiptap/starter-kit');
  const { TextStyleKit } = req('@tiptap/extension-text-style');
  const { TableKit } = req('@tiptap/extension-table');
  const Image = req('@tiptap/extension-image').default;
  const schema = getSchema([StarterKit.configure({undoRedo:false}), TextStyleKit, TableKit, Image, adapter.CanvasTextAlign]);
  const rich = { type:'doc',content:[
    {type:'paragraph',attrs:{textAlign:'center'},content:[{type:'text',text:'Styled assessment',marks:[{type:'textStyle',attrs:{fontFamily:'Georgia',fontSize:'24px',color:'#112233'}},{type:'underline'}]}]},
    {type:'image',attrs:{src:'https://example.com/diagram.png',alt:'Diagram'}},
    {type:'table',content:[{type:'tableRow',content:[{type:'tableCell',attrs:{colspan:1,rowspan:1,colwidth:[160]},content:[{type:'paragraph',content:[{type:'text',text:'Evidence'}]}]}]}]},
  ]};
  const first = new Y.Doc();
  bridge.prosemirrorJSONToYXmlFragment(schema,rich,first.getXmlFragment('body'));
  first.getMap('meta').set('schemaVersion',2);
  const before = bridge.yXmlFragmentToProsemirrorJSON(first.getXmlFragment('body'));
  const snapshot = Y.encodeStateAsUpdate(first);
  const restored = new Y.Doc(); Y.applyUpdate(restored,snapshot);
  const after = bridge.yXmlFragmentToProsemirrorJSON(restored.getXmlFragment('body'));
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
  assert.equal(restored.getMap('meta').get('schemaVersion'),2);
  const markdown = serializeDocument(adapter.pmToDocModel(before,{}));
  binaryProof = {equalAfterBinaryRestore:true,bytes:snapshot.byteLength,marks:before.content[0].content[0].marks,nodeTypes:before.content.map(x=>x.type),markdownProjection:markdown};
  first.destroy();restored.destroy();
}
console.log(JSON.stringify({consumer:upstream?'realtime-modules':examples?'realtime-examples':'aws-agentcore/portal',runtimeVersion:JSON.parse(require('node:fs').readFileSync(upstream ? resolve(base,'package.json') : resolve(base,'node_modules',scope,'package.json'),'utf8')).version,peers,results,binaryProof},null,2));
