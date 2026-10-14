// The library Select (ui-components 2.445.0) is a custom listbox, not a
// native <select>: a `<button role="combobox" data-ui-control="select"
// data-value="…">` whose options exist only while it is open, in a portal
// `[data-ui-listbox="select"]` of `[role="option"][data-value]` rows.
// Playwright's `selectOption`, `toHaveValue` and `inputValue` do not apply to
// it; these helpers do the same jobs through the listbox.
import { expect, type Locator } from '@playwright/test';

/** The open listbox the trigger controls. */
function listboxOf(trigger: Locator, id: string | null): Locator {
  const page = trigger.page();
  return id ? page.locator(`[id="${id}"]`) : page.locator('[data-ui-listbox]').last();
}

async function open(trigger: Locator): Promise<Locator> {
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const list = listboxOf(trigger, await trigger.getAttribute('aria-controls'));
  await expect(list).toBeVisible();
  return list;
}

/** Choose an option by value (a string) or by its visible label. */
export async function chooseOption(trigger: Locator, choice: string | { label: string | RegExp }): Promise<void> {
  const list = await open(trigger);
  const option = typeof choice === 'string'
    ? list.locator(`[role="option"][data-value="${choice.replace(/"/g, '\\"')}"]`)
    : list.getByRole('option', { name: choice.label });
  await option.first().click();
  await expect(list).toBeHidden();
}

/** The trigger's current value. */
export async function selectedValue(trigger: Locator): Promise<string> {
  return (await trigger.getAttribute('data-value')) ?? '';
}

/** Every option's value, in order (opens the list, reads it, closes it). */
export async function optionValues(trigger: Locator): Promise<string[]> {
  const list = await open(trigger);
  const values = await list.locator('[role="option"]').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.value ?? ''));
  await trigger.press('Escape');
  await expect(list).toBeHidden();
  return values;
}

/** Every option's visible label, in order. */
export async function optionLabels(trigger: Locator): Promise<string[]> {
  const list = await open(trigger);
  const labels = await list.locator('[role="option"]').evaluateAll((rows) => rows.map((r) => (r.querySelector('span.truncate')?.textContent ?? r.textContent ?? '').trim()));
  await trigger.press('Escape');
  await expect(list).toBeHidden();
  return labels;
}
