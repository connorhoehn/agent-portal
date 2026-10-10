import { composerAsk, type ComposerSubject } from '../project-detail/composerPrompts.ts';
import type { SearchRef } from '../search/searchTypes.ts';

export interface InitiativeAgentRequest {
  prompt: string;
  question: string;
  contextLabel: string | null;
  records: SearchRef[];
}

/** Capture the submitted context. Navigating to another leaf never retargets a run or its retry. */
export function initiativeAgentRequest(text: string, subject: ComposerSubject, withContext = true): InitiativeAgentRequest | null {
  const prompt = composerAsk(text, subject, withContext);
  if (!prompt) return null;
  const records: SearchRef[] = [];
  let contextLabel: string | null = null;
  if (withContext && subject.kind !== 'initiatives') {
    records.push({ type: 'initiative', id: subject.project.id });
    contextLabel = subject.project.name;
    if (subject.kind === 'item') {
      records.push({ type: 'work', id: subject.item.id });
      contextLabel += ` › ${subject.item.key ?? subject.item.title}`;
    }
  }
  return { prompt, question: text.replace(/^\/agent\s+/, '').trim(), contextLabel, records };
}
