// Shared presentation conversation: readers ask through the authorized agent
// stream; editors can explicitly select the tenant's saved-version revise flow.
// The bottom composer owns the draft and the shell pane owns answers/progress.
// Flow-run IDs use the requester-private gateway; other revise runs poll.

import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Banner, EmptyState } from '@connorhoehnslalom/ui-components/shared';
import type { PresentationFooterContext, PresentationInstructContext, PresentationInstructResult } from '@connorhoehnslalom/ui-components/doc-editor';
import { useFlowRun } from '../../hooks/useFlowRun';
import { DeckComposer } from './DeckComposer';
import { DeckRunProgress } from './DeckRunProgress';
import type { DeckEditorDocument, DeckEditorExtras } from './DeckEditorPage';
import { DeckRevisionConflictError, type DeckDetailCore, type DeckReviseResult, type DeckRunState } from './deckApi';
import { failedLastRun, generatingIds, hasPendingRun, isRunFinished, openRevisionId, runFailureMessage } from './decksModel';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { InitiativeAgentPanel, type InitiativeAgentHandle } from '../../pages/projects/InitiativeAgentPanel';
import { DeckAssistantPane } from './DeckAssistantPane';
import { deckQuestionRequest } from './deckQuestionRequest';

interface DeckAgentRunBase {
  /** Opt in only when this page's tenant has a supported question endpoint. */
  questionAgent?: 'orgiq-supervisor';
  /** May this person use the agent box (a capability, already `ready`)? */
  canInstruct: boolean;
  hints: readonly string[];
  /** The banner title while a run is in flight. */
  progressTitle: (deck: DeckDetailCore) => string;
  /** Offer the deck's own source options on slides. */
  sourceOptions?: boolean;
}

/** Assessment, pipelines: the revise starts a run, which the page follows. */
interface DeckAgentRunByRun extends DeckAgentRunBase {
  revise: (deckId: string, input: { instruction: string; slideId?: string; baseRevisionId: string }) => Promise<{ runId: string }>;
  getRun: (runId: string, signal: AbortSignal) => Promise<DeckRunState>;
  reviseNow?: undefined;
}

/** Orgiq, Social: the revise is answered in the request (the new revision is already saved). */
interface DeckAgentRunInline extends DeckAgentRunBase {
  reviseNow: (deckId: string, input: { instruction: string; slideId?: string; baseRevisionId: string; requestId: string }) => Promise<DeckReviseResult>;
  revise?: undefined;
  getRun?: undefined;
}

export type DeckAgentRunConfig = DeckAgentRunByRun | DeckAgentRunInline;

const noRun = (): Promise<DeckRunState> => Promise.reject(new Error('This tenant revises inline; there is no run to read.'));
const newRequestId = (): string => `req-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

interface Waiter { resolve: (run: DeckRunState) => void }

export function useDeckAgentRun<D extends DeckDetailCore & { title: string }>(doc: DeckEditorDocument<D>, cfg: DeckAgentRunConfig): DeckEditorExtras {
  const { deckId, deck, revisionId, setRevisionId, spec, dirtyRef, reload, setConflict, specRevisionId } = doc;
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const { session } = useSession();
  // Search alone does not establish cross-tenant supervisor support. This
  // supervisor currently resolves Work context, so its host opts in explicitly.
  const supportsQuestions = cfg.questionAgent === 'orgiq-supervisor' && session?.tenant === 'orgiq';
  const canAsk = supportsQuestions && ready && can('Search');
  const askUnavailableReason = supportsQuestions ? 'Agent questions are not included in your current access.' : 'Questions are available for Work presentations.';
  const questions = useRef<InitiativeAgentHandle | null>(null);
  const [questionRequest, setQuestionRequest] = useState(0);
  const projectId = deck && 'projectId' in deck && typeof deck.projectId === 'string' ? deck.projectId : '';
  const ask = (text: string, ctx: PresentationInstructContext, withReference: boolean, generatedTitle?: string): boolean | string => {
    if (!canAsk) return ready ? askUnavailableReason : 'Access is still loading.';
    if (!deck || !spec) return 'The presentation is still loading.';
    const captured = deckQuestionRequest({ deckId, title: deck.title, revisionId: specRevisionId ?? revisionId,
      spec, question: text, slideId: ctx.slideId, generatedTitle, withReference, dirty: dirtyRef.current,
      records: projectId ? [{ type: 'initiative', id: projectId }] : [],
    });
    if (!captured) return false;
    const accepted = questions.current?.submit(captured) ?? 'The presentation assistant is still loading.';
    if (accepted === true) setQuestionRequest(value => value + 1);
    return accepted;
  };
  // The run being followed: the server's pendingRun (a teammate's included), or one this page started.
  const [localRunId, setLocalRunId] = useState<string | null>(null);
  const [runSlideId, setRunSlideId] = useState<string | undefined>(undefined);
  const waiter = useRef<Waiter | null>(null);
  // Inline revise: busy while the request is out, and the id a failed send is retried under.
  const [inlineBusy, setInlineBusy] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);

  const runId = localRunId ?? (hasPendingRun(deck) ? deck.pendingRun.runId : null);

  const { run } = useFlowRun<DeckRunState>(runId, cfg.getRun ?? noRun, {
    isFinished: isRunFinished,
    onFinished: (final) => {
      void (async () => {
        const next = await reload();
        setLocalRunId(null);
        setRunSlideId(undefined);
        // A teammate's run must not replace edits on screen; ours always opens.
        if (final.status === 'completed' && next && !dirtyRef.current) {
          const id = openRevisionId(next);
          if (id && id !== revisionId) setRevisionId(id);
        }
        waiter.current?.resolve(final);
        waiter.current = null;
      })();
    },
  });

  const instruct = useCallback(async (instruction: string, ctx: PresentationInstructContext): Promise<PresentationInstructResult> => {
    if (!cfg.canInstruct) throw new Error('This presentation is read-only. Ask a question instead.');
    if (dirtyRef.current) throw new Error('Save your edits first: the agent revises the saved version.');
    if (!revisionId) throw new Error('There is no saved version to revise.');
    if (cfg.reviseNow) {
      // The same instruction on the same saved version retries under one request id, so a
      // send whose answer was lost replays instead of editing twice.
      const key = `${revisionId}\n${ctx.slideId ?? ''}\n${instruction}`;
      const requestId = attempt.current?.key === key ? attempt.current.requestId : newRequestId();
      attempt.current = { key, requestId };
      setRunSlideId(ctx.slideId);
      setInlineBusy(true);
      try {
        const out = await cfg.reviseNow(deckId, { instruction, ...(ctx.slideId ? { slideId: ctx.slideId } : {}), baseRevisionId: revisionId, requestId });
        attempt.current = null;
        const next = await reload();
        if (out.revisionId && next && !dirtyRef.current) setRevisionId(out.revisionId);
        return {
          summary: out.summary.trim() || 'The agent saved a new version.',
          changedSlideIds: out.changedSlideIds.length || !out.revisionId ? out.changedSlideIds : (ctx.slideId ? [ctx.slideId] : []),
        };
      } catch (err) {
        if (err instanceof DeckRevisionConflictError) { attempt.current = null; setConflict(true); void reload(); }
        throw err;
      } finally {
        setInlineBusy(false);
        setRunSlideId(undefined);
      }
    }
    if (!cfg.revise) throw new Error('The agent cannot revise this deck.');
    let started;
    try {
      started = await cfg.revise(deckId, { instruction, ...(ctx.slideId ? { slideId: ctx.slideId } : {}), baseRevisionId: revisionId });
    } catch (err) {
      if (err instanceof DeckRevisionConflictError) { setConflict(true); void reload(); }
      throw err;
    }
    const finished = new Promise<DeckRunState>((resolve) => { waiter.current = { resolve }; });
    setRunSlideId(ctx.slideId);
    setLocalRunId(started.runId);
    const final = await finished;
    if (final.status !== 'completed') throw new Error(runFailureMessage(final));
    return {
      summary: final.summary?.trim() || 'The agent saved a new version.',
      changedSlideIds: final.changedSlideIds ?? (ctx.slideId ? [ctx.slideId] : []),
    };
  }, [deckId, revisionId, cfg.revise, cfg.reviseNow, cfg.canInstruct]);

  const lastFailure = deck ? failedLastRun(deck) : null;
  const notices = deck ? (
    <>
      {inlineBusy && (
        <Banner variant="info" layout="stacked" title={cfg.progressTitle(deck)} data-testid="deck-run-progress" />
      )}
      {runId && <DeckRunProgress title={cfg.progressTitle(deck)} run={run} runId={runId} />}
      {!runId && !inlineBusy && lastFailure && (
        <Banner variant="error" layout="stacked" title="The last agent run failed" data-testid="deck-last-run-failed">
          {runFailureMessage(lastFailure)}
        </Banner>
      )}
    </>
  ) : null;

  return {
    notices,
    busy: !!runId || inlineBusy,
    ...(cfg.sourceOptions ? { sourceOptions: true } : {}),
    generatingSlideIds: generatingIds(spec, runSlideId, !!runId || inlineBusy),
    ...(deck ? {
      assistant: <DeckAssistantPane deckTitle={deck.title} questionRequest={questionRequest}
        question={supportsQuestions ? <InitiativeAgentPanel key={`${session?.tenant}:${session?.sub}:${session?.role}:${deckId}`}
          ref={questions} projectId={projectId} assistantTitle="Presentation assistant" emptyTitle="Ask about this presentation"
          onOpenWorkItem={id => navigate(`/iq/projects/${encodeURIComponent(projectId)}?tab=work&item=${encodeURIComponent(id)}`)} />
          : <EmptyState title={cfg.canInstruct ? 'Edit this presentation' : 'View only'}
              body={cfg.canInstruct ? 'Use Edit in the composer below to revise the saved slides.' : 'Use the slide list, notes and Present to review this version.'} />} />,
      footer: (ctx: PresentationFooterContext) => (
        <DeckComposer
          deckId={deckId}
          deckTitle={deck.title}
          hints={cfg.hints}
          instruct={instruct}
          canInstruct={cfg.canInstruct} canAsk={canAsk} askUnavailableReason={askUnavailableReason}
          onAsk={(text, context, withReference) => ask(text, context, withReference, ctx.selectedGeneratedSlide?.title)}
          onChanged={ctx.markChanged}
          slideNumber={ctx.selectedIndex + 1}
          {...(ctx.selectedSlide ? { selectedSlideId: ctx.selectedSlide.id } : {})}
          {...(ctx.selectedGeneratedSlide ? { generatedSlideTitle: ctx.selectedGeneratedSlide.title } : {})}
        />
      ),
    } : {}),
  };
}
