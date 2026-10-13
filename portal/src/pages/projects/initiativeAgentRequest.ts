import { composerAsk, composerScope, type ComposerSubject } from '../project-detail/composerPrompts.ts';
import { askScopeBody, type AskScope } from '../../lib/askScope.ts';
import type { SearchRef } from '../search/searchTypes.ts';
import type { DeckSpec } from '../../components/decks/deckApi.ts';

export interface PresentationQuestionContext {
  kind: 'initiative-deck'; deckId: string; revisionId: string;
  scope: 'slide' | 'deck' | 'sources'; slideId?: string; draftSpec?: DeckSpec;
}

export interface InitiativeAgentRequest {
  prompt: string;
  question: string;
  contextLabel: string | null;
  records: SearchRef[];
  presentationContext?: PresentationQuestionContext;
  /** The composer's context chip as a structured scope (asked advise-only);
   *  the server answers within it and never reads it from the question text. */
  scope?: AskScope;
}

/** A presentation's IDs are resolved by the server; an initiative cannot replace its scope. */
export function initiativeAgentBody(message: string, request: InitiativeAgentRequest | null, sessionId?: string): {
  message: string; sessionId?: string; presentationContext?: PresentationQuestionContext; selection?: { records: SearchRef[] };
  scope?: AskScope; stance?: 'advise';
} {
  return { message: request?.presentationContext ? request.question : message,
    ...(sessionId ? { sessionId } : {}),
    ...(request?.presentationContext ? {} : askScopeBody(request?.scope)),
    ...(request?.presentationContext ? { presentationContext: request.presentationContext }
      : request?.records.length ? { selection: { records: request.records } } : {}) };
}

export interface PresentationReadReceipt {
  deckId: string; revisionId: string; title: string; slideTitles: string[];
  provenance: 'saved-revision' | 'visible-draft'; scope: 'slide' | 'deck' | 'sources';
}
/** Receipt comes from the completed server context read, not the request or a source-document lookup. */
export function presentationReadReceipt(tools?: ReadonlyArray<{ name: string; result?: unknown }>): PresentationReadReceipt | null {
  for (const tool of tools ?? []) {
    if (tool.name !== 'presentation_context' || typeof tool.result !== 'string') continue;
    let result: Record<string, unknown>;
    try { result = JSON.parse(tool.result); } catch { continue; }
    if (!result || result.kind !== 'initiative-deck' || typeof result.deckId !== 'string'
      || typeof result.revisionId !== 'string' || typeof result.title !== 'string'
      || !Array.isArray(result.slideTitles) || !result.slideTitles.every(value => typeof value === 'string')
      || !['saved-revision', 'visible-draft'].includes(String(result.provenance))
      || !['slide', 'deck', 'sources'].includes(String(result.scope))) continue;
    return { deckId: result.deckId, revisionId: result.revisionId, title: result.title, slideTitles: result.slideTitles,
      provenance: result.provenance as PresentationReadReceipt['provenance'], scope: result.scope as PresentationReadReceipt['scope'] };
  }
  return null;
}

/** Capture the submitted context. Navigating to another leaf never retargets a run or its retry. */
export function initiativeAgentRequest(text: string, subject: ComposerSubject, withContext = true): InitiativeAgentRequest | null {
  const prompt = composerAsk(text, subject);
  if (!prompt) return null;
  const scope = composerScope(subject, withContext);
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
  return { prompt, question: text.replace(/^\/agent\s+/, '').trim(), contextLabel, records, ...(scope ? { scope } : {}) };
}
