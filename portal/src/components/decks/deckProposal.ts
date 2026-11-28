// What the composer does with the agent's proposed operations (DeckComposer.tsx):
// a card to Apply or Discard, a refusal said plainly, or just the reply. The
// card's lines use the voice's words (lib/voice/decks.ts planDeckOperations).
//
// Decision (first version): every proposal waits for Apply, not only a removal.
// A destructive list (remove_slide) also says so on the card.

import type { DeckOperationsProposal } from './deckApi.ts';
import { plainDeckRefusal } from './deckRefusal.ts';

export type ProposalOutcome =
  | { kind: 'card'; status: string }
  | { kind: 'refused'; status: string }
  | { kind: 'nothing'; status: string };

export function proposalOutcome(p: DeckOperationsProposal): ProposalOutcome {
  if (p.refusal) {
    return { kind: 'refused', status: `${p.reply ? `${p.reply} ` : ''}Nothing can be applied: ${plainDeckRefusal(p.refusal.reason, p.refusal.errors ?? [])}` };
  }
  if (p.operations.length) return { kind: 'card', status: p.reply || 'Here is the change. Apply it to save a new version.' };
  return { kind: 'nothing', status: p.reply || 'There is nothing to change for that.' };
}

/** The card's lines: each operation, a removal's warning, and the version note the voice card ends with. */
export function proposalDetail(p: Pick<DeckOperationsProposal, 'lines' | 'destructive'>): string[] {
  return [
    ...p.lines.map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)),
    ...(p.destructive ? ['This removes a slide. Nothing is removed until you click Apply.'] : []),
    'It saves a new version; the current one stays in the history.',
  ];
}

export const proposalTitle = (deckTitle: string): string => `Change "${deckTitle.replace(/["“”]/g, "'").slice(0, 80)}"`;
