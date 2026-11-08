// Fixture (valid): the same decision as a composer prompt — counts as a deck, no decisionmodal.
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { ConversationComposer } from './composer';

export function Decide({ approve }: { approve: (reason: string) => Promise<void> }) {
  const prompts: ComposerPrompt[] = [{
    id: 'approve', title: 'Approve this spend?', question: 'Why is it worth it?', kind: 'text',
    onAnswer: async (answer) => { if (answer.kind === 'text') await approve(answer.text); },
  }];
  return <ConversationComposer prompts={prompts} />;
}
