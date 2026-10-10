import type { Locator, Page } from '@playwright/test';

/**
 * Pick a conversation view (Chat | Pinned | Files | Calls): the icon switcher
 * (ui-components 2.435 `SegmentedControl iconOnly`, portal useChatPins) on
 * the pane's header row or above the thread. Every view is always drawn —
 * nothing folds — and each button keeps its `<prefix>-tab-<view>` test id.
 */
export async function openConversationView(page: Page, prefix: string, view: 'chat' | 'pins' | 'files' | 'calls'): Promise<void> {
  await page.getByTestId(`${prefix}-tab-${view}`).first().click();
}

/**
 * The composer's file input. In a narrow pane (ui-components 2.431
 * `responsive="pane"`) the attach control sits behind `Aa` with the rest of
 * the formatting strip, so open the strip first when it is folded.
 */
export async function composerFileInput(page: Page, composerTestId: string) {
  await page.getByTestId(`${composerTestId}-input`).click();
  const toggle = page.getByTestId(`${composerTestId}-format-toggle`);
  if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  return page.getByTestId(`${composerTestId}-dock`).locator('input[type="file"]').first();
}

/**
 * Switch a ContextComposer to a mode whatever its width: the wide card's
 * `Composer mode: …` menu, or a narrow card's compact `1 2` pill (each
 * button named for its mode) — the shell's conversation pane is narrow.
 */
export async function chooseComposerMode(page: Page, composer: Locator, from: string, to: string): Promise<void> {
  const menu = composer.getByRole('button', { name: `Composer mode: ${from}`, exact: true });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.getByRole('menuitem', { name: to, exact: true }).click();
    return;
  }
  await composer.getByRole('button', { name: to, exact: true }).first().click();
}
