// The private card a `/deck` leaves in the requester's own conversation: the
// library's AgentRunCard for progress, then the slides to look at
// (PresentationView), and the explicit acts. Nothing reaches the conversation
// until "Post to conversation" is pressed; a `--preview` card stores no deck
// until "Save deck". In memory only, like the /summarize card — a reload loses
// the card (a saved deck is kept and reachable from its page).

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useFlowRun } from '../../../hooks/useFlowRun';
import { AgentRunCard } from '@connorhoehn/ui-components/social';
import { PresentationView, svgDataUri, type PresentationRevision } from '@connorhoehn/ui-components/doc-editor';
import { Button, Card, InlineAlert, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { ImageThumbnail } from '@connorhoehn/ui-components';
import {
  MAX_POLLS, canSave, deckRunStatusOf, fetchDeckStatus, isTerminal, narrativeNotice, pollDelayMs, saveDeckRun, savedDeckId, socialDeckPaths,
  type DeckRunStatus,
} from './socialDecksApi';

export interface SocialDeckCardProps {
  runId: string;
  instruction: string;
  requestedBy: string;
  /** Posts the stored deck's .pptx into the conversation (attachment path). Rejects when delivery fails. */
  onPost: (deckId: string) => Promise<void>;
  onDismiss: () => void;
  /** Drawn inside the thread's private-message frame (localMessages `body`): no Card, no privacy notice. */
  bare?: boolean;
}

function revisionOf(status: DeckRunStatus): PresentationRevision | null {
  const slides = status.result?.slides;
  if (!slides?.length) return null;
  return {
    id: 'preview', label: status.preview ? 'Preview' : 'v1',
    slides: slides.map((slide, i) => ({
      id: slide.id, index: i + 1, title: slide.title ?? slide.id,
      preview: <ImageThumbnail src={svgDataUri(slide.svg) ?? ""} alt={`Slide ${i + 1}: ${slide.title ?? slide.id}`} size="lg" aspectRatio="video" className="w-full"
        data-testid={`social-deck-slide-${slide.id}`} />,
    })),
  };
}

export default function SocialDeckCard({ runId, instruction, requestedBy, onPost, onDismiss, bare = false }: SocialDeckCardProps) {
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'post' | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const [slideIndex, setSlideIndex] = useState(1);
  const flow = useFlowRun<DeckRunStatus>(runId, (id, signal) => fetchDeckStatus(id, signal), {
    isFinished: isTerminal, delayMs: pollDelayMs, maxPolls: MAX_POLLS,
  });
  const status = flow.run;
  const error = actionError ?? flow.error ?? (flow.timedOut ? 'The deck is taking too long. Dismiss it and try again.' : null);
  const revision = useMemo(() => (status ? revisionOf(status) : null), [status]);
  const deckId = savedId ?? (status ? savedDeckId(status) : null);
  const notice = narrativeNotice(status?.result?.narrative);

  const save = async (): Promise<void> => {
    setBusy('save'); setActionError(null);
    try { setSavedId((await saveDeckRun(runId)).deckId); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'The deck could not be saved.'); }
    finally { setBusy(null); }
  };
  const post = async (): Promise<void> => {
    if (!deckId) return;
    setBusy('post'); setActionError(null);
    try { await onPost(deckId); setPosted(true); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'The deck could not be posted.'); }
    finally { setBusy(null); }
  };

  const content = (
      <Stack gap="sm">
        {!bare ? (
          <InlineAlert tone="info" data-testid="social-deck-privacy">
            {deckId ? 'Only you and the people in this conversation can open the saved deck. Post the file when it is ready.'
              : 'Preview only. Nothing has been saved, and only you can see this.'}
          </InlineAlert>
        ) : !deckId && <InlineAlert tone="info" data-testid="social-deck-privacy">Preview only. Nothing has been saved.</InlineAlert>}
        <AgentRunCard runId={runId} instruction={instruction} agentName="Nova" command="/deck" requestedBy={requestedBy}
          {...(status ? { status: deckRunStatusOf(status) } : {})} defaultExpanded data-testid="social-deck-run" />
        {error && <InlineAlert tone="error" data-testid="social-deck-error">{error}</InlineAlert>}
        {notice && <InlineAlert tone="info" data-testid="social-deck-narrative">{notice}</InlineAlert>}
        {status?.result?.warnings.map((warning) => <InlineAlert key={warning} tone="warning">{warning}</InlineAlert>)}
        {revision && status?.phase === 'completed' && (
          <PresentationView
            title={status.result?.title ?? 'Conversation deck'}
            subtitle={`${status.result?.messageCount ?? 0} messages cited`}
            revisions={[revision]} revisionId={revision.id} onRevisionChange={() => undefined}
            slideIndex={slideIndex} onSlideChange={setSlideIndex} maxSlideWidth={560}
            data-testid="social-deck-view" />
        )}
        <Inline gap="sm" align="center">
          {status && canSave(status) && !savedId && (
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => { void save(); }} data-testid="social-deck-save">Save deck</Button>
          )}
          {deckId && (
            <Button variant="secondary" size="sm" onClick={() => navigate(socialDeckPaths.page(deckId))} data-testid="social-deck-open">Open deck</Button>
          )}
          {deckId && !posted && (
            <Button variant={status?.preview ? 'secondary' : 'primary'} size="sm" disabled={busy !== null} onClick={() => { void post(); }} data-testid="social-deck-post">
              Post to conversation
            </Button>
          )}
          {posted && <T className="text-sm text-text-secondary" data-testid="social-deck-posted">Posted to the conversation.</T>}
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onDismiss} data-testid="social-deck-dismiss">Dismiss</Button>
        </Inline>
      </Stack>
  );
  return bare ? <Stack gap="none" data-testid="social-deck-card">{content}</Stack>
    : <Card padding="sm" data-testid="social-deck-card">{content}</Card>;
}
