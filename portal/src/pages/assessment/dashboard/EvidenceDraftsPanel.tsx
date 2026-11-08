// "Summarize evidence" and "Draft follow-ups" for the selected dimension
// (docs/agentic-flows-migration.md slice 8). Results are the assessor's own
// DRAFTS shared by every assessor on the team (readers see them read-only; Revise… refines a ready draft, with a newer-version notice if a teammate did first): a summary stays a read-only note until discarded; follow-up questions
// become real follow-up rows only through "Add selected", which the server
// authorizes as ScoreAssessment and writes from the stored draft. The levels
// shown come from the provider's facts; Nova writes the prose.

import { useEffect, useRef, useState } from 'react';
import { AgentRunCard } from '@connorhoehn/ui-components/social';
import { SuggestionCard, SuggestionReviewList } from '@connorhoehn/ui-components/doc-editor';
import { Button, Card, Chip, FormField, InlineAlert, Inline, MarkdownView, MetaLine, Stack, Textarea } from '@connorhoehn/ui-components/shared';
import { useFlowRun } from '../../../hooks/useFlowRun';
import { isDocumentHidden } from '../../../hooks/pollSchedule';
import { Can, useCapabilities } from '../../../lib/capabilities';
import {
  MAX_POLLS, NewerVersionError, acceptDraft, acceptPayload, agentRunStatusOf, canAccept, canRevise, commandOf, discardDraft, factsLine, fetchDraft,
  isLive, isNewer, isTerminal, kindLabel, listDrafts, newRequestId, pollDelayMs, reviseDraft, startDraft, summaryMarkdown, type DraftView,
} from './evidenceDrafts';

interface DraftCardProps {
  runId: string; onGone: (runId: string) => void; onAccepted: () => void;
  /** The latest list read of this draft (another assessor may have revised it). */
  listed: DraftView | undefined;
  /** Re-reads this draft from the server. */
  onRefresh: (notice?: string) => void;
  /** Shown after a refresh that replaced this card (a stale Revise). */
  notice?: string | undefined;
}

function DraftCard({ runId, onGone, onAccepted, listed, onRefresh, notice }: DraftCardProps) {
  const flow = useFlowRun<DraftView>(runId, (id) => fetchDraft(id), { isFinished: isTerminal, delayMs: pollDelayMs, maxPolls: MAX_POLLS });
  const draft = flow.run;
  const { can } = useCapabilities();
  const [selected, setSelected] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<number | null>(null);
  const [revising, setRevising] = useState(false);
  const [instruction, setInstruction] = useState('');
  const requestId = useRef<string | null>(null);

  const questions = draft?.result?.kind === 'followups' ? draft.result.questions : [];
  const chosen = selected ?? questions.map((_, i) => i);
  const decided = accepted !== null || draft?.decision === 'accepted';
  const problem = error ?? flow.error ?? (flow.timedOut ? 'The draft is taking too long. Discard it and try again.' : null);

  const accept = async (picked: number[]): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const out = await acceptDraft(runId, acceptPayload(picked, questions.length), draft?.revision);
      setAccepted(out.created.length);
      setMessage(out.created.length === 0
        ? 'Every selected question was already open, so nothing new was added.'
        : `Added ${out.created.length} follow-up question${out.created.length === 1 ? '' : 's'} to this dimension.`);
      onAccepted();
    } catch (cause) {
      if (cause instanceof NewerVersionError) onRefresh(`${cause.message} Showing the newer version.`);
      else setError(cause instanceof Error ? cause.message : 'The follow-ups could not be added.');
    } finally { setBusy(false); }
  };
  const revise = async (): Promise<void> => {
    if (!draft || !instruction.trim()) return;
    setBusy(true); setError(null);
    requestId.current ??= newRequestId();
    try {
      await reviseDraft(runId, instruction.trim(), draft.revision, requestId.current);
      requestId.current = null; setInstruction(''); setRevising(false); setSelected(null); onRefresh();
    } catch (cause) {
      if (cause instanceof NewerVersionError) { requestId.current = null; setRevising(false); onRefresh(`${cause.message} Showing the newer version.`); }
      else setError(cause instanceof Error ? cause.message : 'The draft could not be revised.');
    } finally { setBusy(false); }
  };
  const discard = async (): Promise<void> => {
    // An accepted draft is immutable: Dismiss only hides the card here and never calls the server.
    if (decided) { onGone(runId); return; }
    setBusy(true); setError(null);
    try { await discardDraft(runId); onGone(runId); } catch (cause) {
      if (cause instanceof NewerVersionError) onRefresh(`${cause.message} Showing the newer version.`);
      else setError(cause instanceof Error ? cause.message : 'The draft could not be discarded.');
      setBusy(false);
    }
  };

  const canResolve = can('ScoreAssessment') && !busy && !decided && draft !== null && draft !== undefined && canAccept(draft) && draft.decision === null;
  return (
    <Card padding="sm" data-testid="evidence-draft-card" data-kind={draft?.kind ?? ''} data-phase={draft?.phase ?? 'received'}>
      <Stack gap="sm">
        <Inline gap="xs" align="center" wrap>
          <Chip tone="warning" size="xs" uppercase>Draft</Chip>
          <MetaLine size="sm" items={[draft ? `${kindLabel(draft.kind)} · version ${draft.revision}` : 'Starting', 'Shared with assessors on this team until someone adds or discards it']} />
        </Inline>
        <AgentRunCard runId={runId} instruction={draft ? kindLabel(draft.kind) : 'Draft'} agentName="Nova"
          {...(draft ? { command: commandOf(draft.kind), status: agentRunStatusOf(draft) } : {})} defaultExpanded={false} data-testid="evidence-draft-run" />
        {isNewer(draft, listed) && (
          <InlineAlert tone="info" data-testid="evidence-draft-newer">
            <Inline gap="sm" align="center" wrap>
              A newer version of this draft is available.
              <Button variant="ghost" size="sm" onClick={() => onRefresh()} data-testid="evidence-draft-show-newer">Show newer version</Button>
            </Inline>
          </InlineAlert>
        )}
        {draft?.result?.revisionNote && <InlineAlert tone="warning">{draft.result.revisionNote}</InlineAlert>}
        {notice && <InlineAlert tone="info" data-testid="evidence-draft-notice">{notice}</InlineAlert>}
        {problem && <InlineAlert tone="error">{problem}</InlineAlert>}
        {message && <InlineAlert tone="success" data-testid="evidence-draft-message">{message}</InlineAlert>}
        {draft?.result && (
          <Stack gap="xs">
            <MetaLine size="sm" items={[factsLine(draft.result.facts)]} data-testid="evidence-draft-facts" />
            {draft.result.kind === 'summary' && (
              <MarkdownView markdown={summaryMarkdown(draft.result)} scale="sm" data-testid="evidence-draft-summary" />
            )}
            {draft.result.kind === 'followups' && (
              <Stack gap="xs" data-testid="evidence-draft-questions">
                {draft.result.summary}
                {questions.length === 0 && <InlineAlert tone="info">No new follow-up questions are needed.</InlineAlert>}
                {questions.length > 0 && !decided && (
                  <SuggestionReviewList variant="pane" count={questions.length} acceptLabel="Add selected as follow-ups"
                    emptyTitle="No follow-ups"
                    {...(canResolve && chosen.length > 0 ? { onAcceptAll: () => { void accept(chosen); } } : {})}>
                    {questions.map((q, i) => (
                      <li key={i} data-testid={`evidence-draft-pick-${i}`}>
                        <SuggestionCard kind="insert" author="Nova (powered by Nova Pro)" when={Date.parse(draft.createdAt) || null}
                          insertedBlocks={[q.text, ...q.sourceSpans.map(sp => `\u201C${sp.text}\u201D`)]}
                          {...(q.criterionText ? { context: `Closes: ${q.criterionText}` } : {})}
                          {...(canResolve ? {
                            selected: chosen.includes(i),
                            onSelectedChange: (on: boolean) => setSelected(on ? [...chosen, i].sort((x, y) => x - y) : chosen.filter(x => x !== i)),
                            onAccept: () => { void accept([i]); }, acceptLabel: 'Add this one',
                          } : {})} />
                      </li>
                    ))}
                  </SuggestionReviewList>
                )}
              </Stack>
            )}
          </Stack>
        )}
        {revising && (
          <FormField label="How should Nova revise this draft?">
            {({ labelId: _labelId, ...wiring }) => (
              <Textarea {...wiring} value={instruction} onChange={(e) => setInstruction(e.target.value)} minRows={2} maxLength={500}
                placeholder="For example: shorter, and lead with the open gaps" data-testid="evidence-draft-revise-input" />
            )}
          </FormField>
        )}
        <Inline gap="sm" align="center" wrap>
          {draft && canRevise(draft) && can('RunAssessmentAgent') && !revising && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRevising(true)} data-testid="evidence-draft-revise">Revise…</Button>
          )}
          {revising && (
            <>
              <Button variant="primary" size="sm" disabled={busy || !instruction.trim()} onClick={() => { void revise(); }} data-testid="evidence-draft-revise-send">Revise draft</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRevising(false); setInstruction(''); requestId.current = null; }}>Cancel</Button>
            </>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void discard(); }} data-testid="evidence-draft-discard">
            {decided ? 'Dismiss' : 'Discard'}
          </Button>
        </Inline>
      </Stack>
    </Card>
  );
}

const LIST_POLL_MS = 8000;

export interface EvidenceDraftsPanelProps {
  teamId: string;
  dimensionId: string;
  /** Called after follow-ups are added so the scorecard re-reads the team. */
  onChanged: () => void;
  /** false hides the Summarize/Draft buttons (the dimension composer starts drafts instead). */
  showControls?: boolean;
  /** A draft the host asked for (the composer's Agent mode); each new `nonce` starts one. */
  command?: { nonce: number; kind: 'summary' | 'followups' } | null;
  /** Reports a start failure to the host. */
  onStartError?: (message: string) => void;
  'data-testid'?: string;
}

export function EvidenceDraftsPanel({ teamId, dimensionId, onChanged, showControls = true, command = null, onStartError, 'data-testid': testId = 'evidence-drafts' }: EvidenceDraftsPanelProps) {
  const [runIds, setRunIds] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listed, setListed] = useState<Record<string, DraftView>>({});
  const [bumps, setBumps] = useState<Record<string, number>>({});
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [notices, setNotices] = useState<Record<string, string | undefined>>({});

  // Drafts are shared: read the dimension's list on arrival and while it is visible, so a
  // teammate's draft, revision or discard appears without a reload.
  useEffect(() => {
    let live = true;
    setRunIds([]); setListed({}); setError(null);
    const read = (first: boolean): void => {
      if (isDocumentHidden()) return;
      listDrafts(teamId, dimensionId).then(
        (drafts) => {
          if (!live) return;
          const mine = drafts.filter(isLive);
          setListed(Object.fromEntries(mine.map((d) => [d.runId, d])));
          setRunIds((ids) => {
            const keep = ids.filter((id) => first ? false : mine.some((d) => d.runId === id) || !drafts.some((d) => d.runId === id));
            return [...keep, ...mine.map((d) => d.runId).filter((id) => !keep.includes(id))];
          });
        },
        () => undefined, // recovery is best-effort; starting a new draft still works
      );
    };
    read(true);
    const timer = setInterval(() => read(false), LIST_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [teamId, dimensionId]);

  const start = async (kind: 'summary' | 'followups'): Promise<void> => {
    setStarting(true); setError(null);
    try {
      const { runId } = await startDraft(teamId, dimensionId, kind);
      setRunIds((ids) => [runId, ...ids.filter((id) => id !== runId)]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The draft could not be started.';
      setError(message); onStartError?.(message);
    } finally { setStarting(false); }
  };
  const handled = useRef<number | null>(command?.nonce ?? null);
  useEffect(() => {
    if (!command || handled.current === command.nonce) return;
    handled.current = command.nonce;
    void start(command.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  return (
    <Stack gap="sm" data-testid={testId}>
      {showControls && <Can do="RunAssessmentAgent">
        <Inline gap="sm" align="center" wrap>
          <Button variant="secondary" size="sm" disabled={starting} onClick={() => { void start('summary'); }} data-testid="evidence-summarize">
            Summarize evidence
          </Button>
          <Button variant="secondary" size="sm" disabled={starting} onClick={() => { void start('followups'); }} data-testid="evidence-draft-followups">
            Draft follow-ups
          </Button>
        </Inline>
      </Can>}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {runIds.filter((id) => !dismissed.includes(id)).map((id) => (
        <DraftCard key={`${id}:${bumps[id] ?? 0}`} runId={id} listed={listed[id]} notice={notices[id]} onRefresh={(notice) => { setNotices((n) => ({ ...n, [id]: notice })); setBumps((b) => ({ ...b, [id]: (b[id] ?? 0) + 1 })); }} onGone={(gone) => { setDismissed((d) => [...d, gone]); setRunIds((ids) => ids.filter((x) => x !== gone)); }} onAccepted={onChanged} />
      ))}
    </Stack>
  );
}
