import { expect } from '@playwright/test';
import base from './ui-dom-audit.adapter';

export default {
  ...base,
  async cases(options: Parameters<typeof base.cases>[0]) {
    return (await base.cases({ ...options, tenant: 'orgiq', path: '/iq/search' }))
      .map(spec => ({ ...spec, path: '/iq/search?tab=connections&selection=person%3Ap-042' }));
  },
  async discoverStates() {
    return [
      { name: 'person-inspector', enter: async (page: import('@playwright/test').Page) => {
        await page.getByRole('button', { name: 'View person', exact: true }).click();
        await expect(page.getByTestId('search-pane-record')).toContainText('Katya Petrov');
      } },
      { name: 'graph-settings', enter: async (page: import('@playwright/test').Page) => {
        await page.getByRole('button', { name: 'Graph settings', exact: true }).click();
        await expect(page.getByRole('slider', { name: 'Connections per person' })).toBeVisible();
      } },
      { name: 'relationship-facet', enter: async (page: import('@playwright/test').Page) => {
        await page.getByRole('combobox', { name: 'Relationship lens' }).click();
        await expect(page.getByRole('option', { name: 'Hierarchy', exact: true })).toBeVisible();
      } },
    ];
  },
};
