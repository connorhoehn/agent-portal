// Social `/deck` (docs/agentic-flows-migration.md slice 5): the private run
// behind the command. References: realtime-examples
// frontend/src/chat/commands/deckCommand.ts (the command: topic, `#` pages,
// `--preview` writes nothing; "Save as document" is the only write) and
// deckPreviewCard.ts (a preview is a private card carrying the spec and a
// rendered slide). Differences, on purpose:
//   - the sources are the conversation lines the requester may read (the same
//     `readChatLines` as /summarize: membership, history floor, deletions) plus
//     pages they may read; there is no recording source in Social yet;
//   - Nova is the drafter's `social-deck` mode (tenant 'social' only); the merge keeps template text for any slide whose quotes are
//     not verbatim in that slide's own messages or whose numbers are not in
//     its facts (lib/deck-shared/narrative.ts mergeDraft);
//   - the run is durable and requester-private (lib/flow-runs), like /summarize.
//     `--preview` stores no deck (nothing in social_decks); the run record holds
//     the spec privately (2 h TTL) and "Save deck" is the only write. Without
//     `--preview` the run saves the deck itself when it finishes.

import { config } from '../config.js';
import { agentcore } from '../providers/index.js';
import { previewSpec, saveGeneratedDeck } from '../providers/social-decks.js';
import { validateDeckSpec, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { mergeDraft, mockDraftResult } from './deck-shared/narrative.js';
import { SOCIAL_DECK_MODE, narrativeModeAllowed } from './deck-shared/narrative-modes.js';
import { buildConversationDeckFacts, buildConversationDraftInput, type DeckPageFact } from './social-deck/facts.js';
import { flowRunStore, kickFlowRun, registerFlowExecutor, type FlowExecutionContext, type FlowRunRow, type FlowRunStep } from './flow-runs/index.js';
import type { TranscriptLine } from './social-summarize.js';
import { RECORDING_SOURCE_PREFIX } from './recording-transcript.js';

export const DECK_AGENT_ID = 'orgiq-assessment-drafter';
export const DECK_MODE = SOCIAL_DECK_MODE;
export const DECK_KIND = 'social.deck';
export const DECK_TENANT = 'social';
export const DECK_ID_PREFIX = 'sdk';
export const MAX_ACTIVE_DECK_RUNS_PER_USER = 3;
export const DECK_RUN_TTL_MS = 2 * 3_600_000;
export const DECK_PIPELINE_ID = 'conversation-deck';

export type DeckPhase = 'received' | 'running' | 'completed' | 'failed';

export interface DeckNarrativeOutcome {
  /** applied: every narrative slide used Nova's prose · partial: some kept the template · fallback: all template · unavailable: no agent */
  status: 'none' | 'applied' | 'partial' | 'fallback' | 'unavailable';
  templatedSlideIds: string[];
  reason?: string;
}
export interface DeckRunResult {
  title: string;
  /** Set once the deck is stored (auto-save, or the Save act). Null for an unsaved preview. */
  deckId: string | null;
  preview: boolean;
  spec: DeckSpec;
  slides: Array<{ id: string; svg: string; title?: string; generated?: boolean }>;
  warnings: string[];
  narrative: DeckNarrativeOutcome;
  messageCount: number;
  pages: Array<{ kind: string; id: string; title: string }>;
  /** The message ids the deck cites, in order. */
  sourceMessageIds: string[];
}

export interface DeckRunInput { lines: TranscriptLine[]; pages: DeckPageFact[]; title: string; conversationName: string; preview: boolean; recordingId?: string }

const INITIAL_STEPS: FlowRunStep[] = [
  { id: 'read-history', label: 'Read the conversation', status: 'completed' },
  { id: 'outline', label: 'Count the facts and cite the messages', status: 'pending' },
  { id: 'narrative', label: 'Write the slide text (Nova)', status: 'pending' },
  { id: 'check', label: 'Check every quote and draw the slides', status: 'pending' },
];
const withStatus = (steps: readonly FlowRunStep[], id: string, status: FlowRunStep['status']): FlowRunStep[] =>
  steps.map(s => (s.id === id ? { ...s, status } : s));
const PHASE: Record<FlowRunRow['status'], DeckPhase> = { queued: 'received', running: 'running', 'waiting-approval': 'running', completed: 'completed', failed: 'failed' };

/** "social:ch:general" -> "#general"; a DM or team channel gets a plain label. */
export function conversationLabel(channel: string): string {
  if (channel.startsWith('social:ch:')) return `#${channel.slice('social:ch:'.length)}`;
  if (channel.startsWith('social:dm:')) return 'a direct message';
  const team = /^social:team:([^:]+):([^:]+)$/.exec(channel);
  return team ? `${team[1]} / ${team[2]}` : 'a conversation';
}

export function deckView(run: FlowRunRow): {
  id: string; channel: string; phase: DeckPhase; steps: FlowRunStep[]; result: DeckRunResult | null; error: string | null;
  updatedAt: string; preview: boolean; savedDeckId: string | null;
} {
  const input = run.input as Partial<DeckRunInput> | null;
  const savedMeta = run.meta['deckId'];
  const result = (run.result as DeckRunResult | null) ?? null;
  return {
    id: run.id, channel: run.scope, phase: PHASE[run.status], steps: run.progress, result, error: run.error, updatedAt: run.updatedAt,
    preview: result?.preview ?? input?.preview === true,
    savedDeckId: typeof savedMeta === 'string' ? savedMeta : result?.deckId ?? null,
  };
}

export const getDeckRunFor = (userId: string, id: string): Promise<FlowRunRow | null> => flowRunStore.getFor(DECK_TENANT, userId, id);
export async function findDeckRun(id: string): Promise<FlowRunRow | null> {
  const run = await flowRunStore.get(id);
  return run && run.tenant === DECK_TENANT && run.kind === DECK_KIND ? run : null;
}
export const activeDeckRunCount = (userId: string): Promise<number> => flowRunStore.countActive(DECK_TENANT, DECK_KIND, userId);

export async function startDeckRun(input: { userId: string; channel: string } & DeckRunInput): Promise<FlowRunRow> {
  await flowRunStore.prune(DECK_KIND, DECK_RUN_TTL_MS);
  const { userId, channel, ...rest } = input;
  const run = await flowRunStore.create({
    tenant: DECK_TENANT, kind: DECK_KIND, requestedBy: userId, scope: channel, idPrefix: DECK_ID_PREFIX,
    maxAttempts: 2, progress: INITIAL_STEPS, input: { ...rest } as unknown as Record<string, unknown>,
  });
  kickFlowRun(run.id, DECK_KIND);
  return run;
}

/** Nova prose for the narrative slides, or the reason it was not used. */
async function draftNarrative(runId: string, input: ReturnType<typeof buildConversationDraftInput>, facts: ReturnType<typeof buildConversationDeckFacts>, sub: string): Promise<{ result?: unknown; unavailable?: string }> {
  if (!input.slides.length) return { unavailable: 'no slide has messages to narrate' };
  if (!narrativeModeAllowed(DECK_MODE, DECK_TENANT)) return { unavailable: `forbidden: ${DECK_MODE} is not a ${DECK_TENANT} mode` };
  if (config.mock.agentcore) return { result: mockDraftResult(input, facts) };
  if (process.env['DEV_OFFLINE'] === 'true') return { unavailable: 'the drafter agent is offline' };
  try {
    const res = await agentcore.invokeAgent(DECK_AGENT_ID, {
      message: `Execute social deck command ${DECK_MODE}`,
      structuredInput: { tenant: 'social', mode: DECK_MODE, run_id: runId, ...input, auth: { tenant: 'social', sub } },
      timeoutMs: 120_000,
    });
    if (res.raw && typeof res.raw === 'object' && 'error' in res.raw) return { unavailable: String((res.raw as { error: unknown }).error) };
    if (!res.text.trim()) return { unavailable: 'the drafter returned an empty result' };
    return { result: JSON.parse(res.text) };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : 'the drafter failed' };
  }
}

/** Builds the deck from the stored lines; a throw is the run's failure. */
export async function deckExecutor(ctx: FlowExecutionContext): Promise<{ result: DeckRunResult; progress: FlowRunStep[] }> {
  const { run } = ctx;
  const input = (run.input ?? {}) as Partial<DeckRunInput>;
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const pages = Array.isArray(input.pages) ? input.pages : [];
  if (lines.length === 0 && pages.length === 0) throw new Error('There is nothing you can read to build a deck from.');
  let steps = withStatus(run.progress.length ? run.progress : INITIAL_STEPS, 'outline', 'running');
  await ctx.report(steps);
  const facts = buildConversationDeckFacts({
    runId: run.id, title: input.title || 'Conversation deck', conversationName: input.conversationName || conversationLabel(run.scope), lines, pages,
  });
  steps = withStatus(withStatus(steps, 'outline', 'completed'), 'narrative', 'running');
  await ctx.report(steps);

  const draftInput = buildConversationDraftInput(facts);
  const narrated = facts.slides.filter(s => s.prose !== 'none').map(s => s.slideId);
  let spec = facts.spec;
  let narrative: DeckNarrativeOutcome = { status: 'none', templatedSlideIds: [] };
  if (narrated.length) {
    const drafted = await draftNarrative(run.id, draftInput, facts, run.requestedBy);
    if (drafted.unavailable !== undefined) {
      narrative = { status: 'unavailable', templatedSlideIds: narrated, reason: drafted.unavailable };
    } else {
      const merged = mergeDraft(facts, drafted.result);
      spec = merged.spec;
      const templated = merged.templated.filter(id => narrated.includes(id));
      narrative = { status: templated.length === 0 ? 'applied' : templated.length === narrated.length ? 'fallback' : 'partial', templatedSlideIds: templated };
    }
  }
  steps = withStatus(withStatus(steps, 'narrative', 'completed'), 'check', 'running');
  await ctx.report(steps);

  const valid = validateDeckSpec(spec);
  if (!valid.ok) throw new Error(`The generated deck is not valid: ${valid.errors.join('; ')}`);
  const preview = previewSpec(valid.spec);
  if (!preview.ok) throw new Error(`The deck could not be drawn: ${preview.reason}`);
  const preview_ = input.preview === true;
  let deckId: string | null = null;
  if (!preview_) {
    const saved = await saveGeneratedDeck({ runId: run.id, channel: run.scope, spec: valid.spec, summary: `Built from ${lines.length} ${input.recordingId ? 'transcript segments' : 'messages'}.`, sub: run.requestedBy });
    if (!saved.ok) throw new Error(saved.reason);
    deckId = saved.value.deckId;
  }
  const sourceMessageIds = [...new Set(valid.spec.slides.flatMap(s => s.sources.map(src => src.documentId))
    .filter(id => id.startsWith('social-message:') || id.startsWith(RECORDING_SOURCE_PREFIX))
    .map(id => id.startsWith('social-message:') ? id.slice('social-message:'.length) : id))];
  return {
    result: {
      title: valid.spec.title, deckId, preview: preview_, spec: valid.spec, slides: preview.value.slides, warnings: preview.value.warnings,
      narrative, messageCount: lines.length, pages: pages.map(p => ({ kind: p.kind, id: p.id, title: p.title })), sourceMessageIds,
    },
    progress: withStatus(steps, 'check', 'completed'),
  };
}

registerFlowExecutor(DECK_KIND, deckExecutor);
