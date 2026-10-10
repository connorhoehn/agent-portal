// `/deck` typed into a dock composer that has no thread to hold a card (the
// initiative page's Chat | Agent composer): the same build as the thread's
// command (tenantDeck.ts), answered with the stored deck's page to open — the
// way the assessment scorecard composer's `/deck` does. Pure; fetch-free apart
// from the deck routes the adapter calls.

import { deckRefusal, parseTenantDeckText, tenantDeckAdapterOf } from './tenantDeck.ts';

export const isDeckCommand = (text: string): boolean => /^\/deck(\s|$)/i.test(text.trim());

/** The slash-menu row (the dock's own ComposerCommandSpec shape). */
export const deckCommandSpec = { trigger: '/deck', label: 'Status deck', hint: 'Build this initiative’s status deck · <title> · --preview', disabled: false };

/** The deck's page, or the sentence a refusal reads as. */
export async function buildTenantDeckFromText(channel: string, text: string, mayBuild: boolean): Promise<{ deckId: string; page: string } | string> {
  const adapter = tenantDeckAdapterOf(channel);
  if (!adapter) return '/deck is not available here.';
  if (!mayBuild) return deckRefusal(adapter);
  const request = parseTenantDeckText(text.trim().replace(/^\/deck\b/i, ''));
  if (typeof request === 'string') return request;
  try {
    const built = await adapter.create({ ...(request.title ? { title: request.title } : {}), narrative: true });
    return { deckId: built.deckId, page: adapter.page(built.deckId) };
  } catch (cause) { return cause instanceof Error && cause.message ? cause.message : '/deck could not be started.'; }
}
