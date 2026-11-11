#!/usr/bin/env node
/** Audit composition drift as well as raw HTML. Findings are review candidates,
 * not proof of a defect; --check enforces only the documented contracts below.
 * Run after npm ci in portal. No browser, session or application writes. */
const fs = require('node:fs');
const path = require('node:path');
const { resolveUiAuditSkill } = require('./lib/ui-audit-skill.cjs');
const ts = require('../portal/node_modules/typescript');
const root = path.resolve(__dirname, '..');
const skill = resolveUiAuditSkill({ root, resource: 'scripts/source-audit.cjs' });
const { createSourceAudit, verifyInstalledArchive } = require(path.join(skill, 'scripts/source-audit.cjs'));
const { analyzeTsx, scanSource } = createSourceAudit({
  typescript: ts, packageName: '@connorhoehn/ui-components',
  densityEntryPoints: ['portal/src/main.tsx'], isPage: file => file.includes('/pages/'),
});

function audit() {
  const findings = scanSource({ root, sourceDirs: ['portal/src'] }), failures = [];
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
  const collectionFiles = ['Definitions', 'Artifacts', 'Approvals', 'Workflows', 'Sources', 'Queues', 'Runs'].map(name => `portal/src/pages/pipelines/${name}Page.tsx`);
  for (const file of collectionFiles) {
    // CollectionCommandPage is the app's adapter over CollectionPage (components/collections); it owns the same composition.
    requireContract(/<Collection(?:Command)?Page[\s/>]/.test(read(file)), `${file}: collection layout belongs in CollectionPage.`);
    const drift = findings.filter(f => f.file === file && ['component-class-override', 'component-style-override'].includes(f.pattern));
    for (const finding of drift) failures.push(`${file}:${finding.line}: ${finding.detail}; use shared metrics or a library variant.`);
  }
  for (const file of ['portal/src/app.css', 'portal/src/components/decks/DeckAssistantPane.css', 'portal/src/components/decks/deckReviewLayout.css']) {
    requireContract(!/composer-star-(?:drift|twinkle)|\.uic-composer-surface\b|\[data-composer-surface\]/.test(read(file)), `${file}: composer surface geometry/effects belong in ui-components.`);
  }
  failures.push(...verifyInstalledArchive({
    packageRoot: path.join(root, 'portal'), packageName: '@connorhoehn/ui-components', archivePrefix: 'file:vendor/',
  }));
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
