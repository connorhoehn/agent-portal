#!/usr/bin/env node
/** Audit composition drift as well as raw HTML. Findings are review candidates,
 * not proof of a defect; --check enforces only the documented contracts below.
 * Run after npm ci in portal. No browser, session or application writes. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const ts = require('../portal/node_modules/typescript');
const root = path.resolve(__dirname, '..');
const controls = new Set(['Button', 'IconButton', 'Input', 'Select', 'SearchInput', 'DropdownMenu', 'FilterChip', 'DataTable', 'Table', 'SegmentedControl']);
const surfaces = new Set(['Toolbar', 'PageHeader', 'ChatPanel', 'ChatSidePanelFrame', 'ComposerSurface', 'CollectionPage', 'CollectionToolbar', 'SubNavLayout']);
const geometry = /(?:^|\s)(?:[\w-]+:)*(?:[mp][xytrblse]?|gap(?:-[xy])?|[wh]|min-[wh]|max-[wh]|text|leading|rounded)(?:-[\w.[\]()%#,/-]+)(?=\s|$)/g;

function analyzeTsx(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map(), hits = [], used = new Set();
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || !node.moduleSpecifier.text.startsWith('@connorhoehnslalom/ui-components')) continue;
    const names = node.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) imports.set(item.name.text, (item.propertyName ?? item.name).text);
  }
  function add(node, pattern, detail) { hits.push({ pattern, file: filename, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, detail }); }
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = imports.get(node.tagName.getText(tree));
      if (name) used.add(name);
      if (controls.has(name) || surfaces.has(name) || name === 'DensityProvider') {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          const key = attr.name.getText(tree), value = attr.initializer;
          if (key === 'size' && controls.has(name)) add(attr, 'explicit-control-size', `${name} ${attr.getText(tree)}`);
          if (key === 'className' && value) {
            // Parse literal portions only. Dynamic results require rendered inspection.
            const literals = [];
            function collect(n) { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) literals.push(n.text); else ts.forEachChild(n, collect); }
            collect(value);
            const overrides = literals.flatMap(text => [...text.matchAll(geometry)].map(m => m[0].trim()));
            if (overrides.length) add(attr, 'component-class-override', `${name}: ${overrides.join(' ')}`);
          }
          if (key === 'style') add(attr, 'component-style-override', name);
        }
        if (name === 'DensityProvider' && filename !== 'portal/src/main.tsx') add(node, 'local-density-provider', 'Check intentional local density against the real shell');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (filename.includes('/pages/') && used.has('PageHeader') && (used.has('Toolbar') || used.has('DataTable')) && !used.has('CollectionPage')) hits.push({ pattern: 'local-collection-composition', file: filename, line: 1, detail: 'PageHeader plus table/toolbar: review whether CollectionPage owns this composition' });
  return hits;
}

function audit() {
  const findings = [], failures = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__tests__'].includes(item.name)) continue;
      const file = path.join(dir, item.name), relative = path.relative(root, file);
      if (item.isDirectory()) walk(file);
      else if (/\.tsx$/.test(file) && !/\.(test|stories)\./.test(file)) findings.push(...analyzeTsx(fs.readFileSync(file, 'utf8'), relative));
      else if (/\.css$/.test(file)) {
        const source = fs.readFileSync(file, 'utf8');
        // Selector scan, not declaration text: test IDs and library-private classes
        // turn component markup into an undocumented styling API.
        for (const match of source.matchAll(/([^{}]+)\{/g)) {
          const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
          if (/data-testid|\.uic-/.test(selector)) findings.push({ pattern: 'css-internal-selector', file: relative, line: source.slice(0, match.index).split('\n').length, detail: selector.replace(/\s+/g, ' ') });
        }
      }
    }
  }
  walk(path.join(root, 'portal/src'));
  function requireContract(condition, message) { if (!condition) failures.push(message); }
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  const main = ts.createSourceFile('main.tsx', read('portal/src/main.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let densityWrapsApp = false;
  function visit(node, compact = false) {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement;
      compact ||= tag.tagName.getText(main) === 'DensityProvider' && tag.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(main) === 'density' && a.initializer?.text === 'compact');
    }
    if (compact && ts.isJsxSelfClosingElement(node) && node.tagName.getText(main) === 'App') densityWrapsApp = true;
    ts.forEachChild(node, child => visit(child, compact));
  }
  visit(main);
  requireContract(densityWrapsApp, 'The real App must inherit compact DensityProvider in main.tsx, not only in fixtures.');
  for (const area of ['pipelines', 'iq', 'assessment']) {
    const file = `portal/src/pages/${area}/RunsPage.tsx`;
    requireContract(/<RunsLedger[\s/>]/.test(read(file)), `${file}: use the shared RunsLedger.`);
  }
  const collectionFiles = ['Definitions', 'Artifacts', 'Approvals', 'Runbooks', 'Sources', 'Queues', 'Runs'].map(name => `portal/src/pages/pipelines/${name}Page.tsx`);
  for (const file of collectionFiles) {
    // CollectionCommandPage is the app's adapter over CollectionPage (components/collections); it owns the same composition.
    requireContract(/<Collection(?:Command)?Page[\s/>]/.test(read(file)), `${file}: collection layout belongs in CollectionPage.`);
    const drift = findings.filter(f => f.file === file && ['component-class-override', 'component-style-override'].includes(f.pattern));
    for (const finding of drift) failures.push(`${file}:${finding.line}: ${finding.detail}; use shared metrics or a library variant.`);
  }
  for (const file of ['portal/src/app.css', 'portal/src/components/decks/DeckAssistantPane.css', 'portal/src/components/decks/deckReviewLayout.css']) {
    requireContract(!/composer-star-(?:drift|twinkle)|\.uic-composer-surface\b|\[data-composer-surface\]/.test(read(file)), `${file}: composer surface geometry/effects belong in ui-components.`);
  }
  // A correct source tree with a stale vendor archive/install still renders old UI.
  const name = '@connorhoehnslalom/ui-components';
  const pkg = JSON.parse(read('portal/package.json'));
  const lock = JSON.parse(read('portal/package-lock.json'));
  const spec = pkg.dependencies[name];
  requireContract(spec?.startsWith('file:vendor/'), 'UI dependency must reference the reviewed vendor archive.');
  if (spec?.startsWith('file:vendor/')) {
    const archive = path.join(root, 'portal', spec.slice(5));
    const entry = lock.packages[`node_modules/${name}`];
    const hash = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
    requireContract(entry?.integrity === hash && entry?.resolved === spec, 'UI archive does not match package-lock integrity/resolution.');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-inheritance-'));
    try {
      cp.execFileSync('tar', ['-xzf', archive, '-C', temp]);
      const installed = path.join(root, 'portal/node_modules', name);
      let checked = 0;
      function compare(dir, relative = '') {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = path.join(relative, item.name), file = path.join(dir, item.name);
          if (item.isDirectory()) compare(file, rel);
          else {
            checked++;
            const target = path.join(installed, rel);
            if (!fs.existsSync(target) || !fs.readFileSync(file).equals(fs.readFileSync(target))) failures.push(`Installed UI differs from archive: ${rel}. Reinstall before browser verification.`);
          }
        }
      }
      compare(path.join(temp, 'package'));
      requireContract(checked > 0, 'UI archive comparison checked no files.');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return { findings, failures };
}

if (require.main === module) {
  const result = audit();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const pattern of [...new Set(result.findings.map(f => f.pattern))].sort()) {
      const rows = result.findings.filter(f => f.pattern === pattern);
      console.log(`${pattern}: ${rows.length} candidates in ${new Set(rows.map(f => f.file)).size} files`);
      if (process.argv.includes('--list')) for (const row of rows) console.log(`  ${row.file}:${row.line} ${row.detail}`);
    }
    for (const failure of result.failures) console.error(`FAIL ${failure}`);
    console.log(`${result.failures.length} inheritance contract failures; candidates require review, not blind replacement.`);
  }
  if (process.argv.includes('--check') && result.failures.length) process.exitCode = 1;
}
module.exports = { analyzeTsx };
