// Run against the journey's populated reports, never an empty or synthetic table.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifyRunsLayout(page, out) {
  const table = page.getByTestId('iq-runs-table');
  const results = [];
  const measure = () => table.evaluate(root => {
    const table = root.querySelector('table');
    const scroller = table.parentElement;
    const clip = scroller.getBoundingClientRect();
    const heads = [...table.querySelectorAll('thead th')].filter(el => el.getBoundingClientRect().width > 0);
    const shown = heads.map(el => el.getAttribute('data-column')).filter(Boolean);
    return {
      mode: getComputedStyle(table).display,
      shown, hidden: (root.getAttribute('data-hidden-columns') ?? '').split(' ').filter(Boolean),
      scroll: scroller.scrollWidth - scroller.clientWidth,
      clipped: heads.filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < clip.left - 1 || r.right > clip.right + 1;
      }).map(el => el.textContent.trim()),
      missing: ['when', 'what', 'outcome', 'learned', 'cost'].filter(key => !shown.includes(key)),
    };
  });
  const settled = async (requireTable = true) => {
    let result, stable = 0;
    const end = Date.now() + 7000;
    do {
      await page.waitForTimeout(100);
      result = await measure();
      const fits = result.scroll <= 1 && (!requireTable || (result.mode === 'table' && !result.missing.length && !result.clipped.length));
      stable = fits ? stable + 1 : 0;
    } while (stable < 3 && Date.now() < end);
    assert.ok(stable >= 3, `Runs must fit its desktop column: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    for (const [width, reload] of [[1440, true], [1280, true], [1440, false], [1280, false], [1440, false]]) {
      await page.setViewportSize({ width, height: 900 });
      if (reload) await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('run-row-link').first().waitFor();
      const geometry = await settled();
      if (width === 1440) assert.equal(geometry.shown.length, 8, 'all fields return when the table has room');
      results.push({ width, state: reload ? 'load' : 'resize', ...geometry });
      console.log(`PASS Runs columns @${width} ${reload ? 'load' : 'resize'}: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: path.join(out, `runs-columns-${results.length}-${width}.png`) });
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    const geometry = await settled();
    assert.ok(geometry.hidden.length, 'the populated desktop case must exercise hidden fields');
    const first = table.locator('tbody tr').first();
    const fields = await table.evaluate((root, keys) => keys.map(key => {
      const label = root.querySelector(`th[data-column="${key}"]`).textContent.trim();
      const value = [...root.querySelector('tbody tr').querySelectorAll('td[data-label]')].find(el => el.getAttribute('data-label') === label).textContent.trim();
      return { key, label, value };
    }), geometry.hidden);
    const before = page.url();
    const more = first.locator('td[data-column-more] button');
    const id = await more.getAttribute('data-testid');
    await more.click();
    const popover = page.getByTestId(`${id}-popover`);
    await popover.waitFor();
    for (const field of fields) {
      assert.equal(await popover.getByText(field.label, { exact: true }).count(), 1);
      assert.ok((await popover.innerText()).includes(field.value), `${field.label} lost its value`);
    }
    assert.equal(page.url(), before, 'opening hidden fields must not open the run');
    await page.keyboard.press('Escape');
    await table.getByTestId('datatable-more-header-control').click();
    for (const field of fields) assert.equal(await page.getByTestId(`datatable-more-header-show-${field.key}`).count(), 1);
    await page.getByTestId(`datatable-more-header-show-${fields[0].key}`).click();
    const chosen = await settled(false);
    assert.ok(chosen.mode === 'block' || chosen.shown.includes(fields[0].key), 'choosing a hidden column must expose it');
    assert.equal(page.url(), before, 'choosing a column must not open the run');
    results.push({ state: 'hidden-fields', fields, chosen });
    console.log('PASS Runs hidden fields: row values and column choice remain accessible without navigation');
  } finally {
    fs.writeFileSync(path.join(out, 'runs-columns.json'), JSON.stringify(results, null, 2));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
