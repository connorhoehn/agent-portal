const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTsx } = require('./audit-ui-inheritance.cjs');
test('finds aliased library overrides, but does not mistake local components or render props for control attributes', () => {
  const rows = analyzeTsx(`import { IconButton as Action, DataTable } from '@connorhoehnslalom/ui-components/shared';
    const view = <><Action size="sm" className={active ? 'h-8 px-4' : 'h-7'} /><LocalButton size="lg" />
      <DataTable rowActions={() => <LocalButton className="h-20" />} /></>;`, 'portal/src/pages/Test.tsx');
  assert.equal(rows.filter(r => r.pattern === 'explicit-control-size').length, 1);
  assert.deepEqual(rows.filter(r => r.pattern === 'component-class-override').map(r => r.detail), ['IconButton: h-8 px-4 h-7']);
});
test('recognizes local collection composition and ignores strings that only mention tags', () => {
  const source = `import { PageHeader, DataTable, CollectionPage } from '@connorhoehnslalom/ui-components/shared';
    const text = '<CollectionPage />'; const view = <><PageHeader title="Test" /><DataTable /></>;`;
  assert.equal(analyzeTsx(source, 'portal/src/pages/Test.tsx').filter(r => r.pattern === 'local-collection-composition').length, 1);
  assert.equal(analyzeTsx(source.replace('<><PageHeader', '<CollectionPage title="Test"><PageHeader').replace('</>;', '</CollectionPage>;'), 'portal/src/pages/Test.tsx').filter(r => r.pattern === 'local-collection-composition').length, 0);
});
