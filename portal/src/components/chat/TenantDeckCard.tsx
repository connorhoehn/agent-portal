// The private card a tenant `/deck` leaves in the requester's own thread (an
// initiative Discussion, a pipelines run thread): the same card shape as
// Social's `/deck` (pages/social/decks/SocialDeckCard) — slides to look at in
// the library's PresentationView, then Open / Revise… / Post to conversation.
// The deck is already stored (these tenants build synchronously), so there is
// no Save step. Revise… opens the deck page, whose composer revises it.
// Nothing reaches the thread until "Post to conversation" is pressed.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { PresentationView, svgDataUri, type PresentationRevision } from '@connorhoehnslalom/ui-components/doc-editor';
import { Button, Card, InlineAlert, Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { ImageThumbnail } from '@connorhoehnslalom/ui-components';
import type { DeckPreviewResult } from '../decks/deckApi';
import { tenantDeckAdapterOf } from './tenantDeck';

export interface TenantDeckCardProps {
  deckId: string;
  channel: string;
  instruction: string;
  /** How Nova's prose was used, when it was asked for. */
  notice?: string | null;
  /** `--preview`: look at the slides; posting is not offered from this card. */
  preview?: boolean;
  /** Sends the confirmed message into the thread. Rejects when delivery fails. */
  onPost: (message: { channel: string; text: string; metadata: Record<string, unknown> }) => Promise<void>;
  onDismiss: () => void;
  bare?: boolean;
}

interface Loaded { title: string; slides: DeckPreviewResult['slides']; warnings: string[]; postWithheld: string | null }

export default function TenantDeckCard({ deckId, channel, instruction, notice = null, preview = false, onPost, onDismiss, bare = false }: TenantDeckCardProps) {
  const navigate = useNavigate();
  const adapter = useMemo(() => tenantDeckAdapterOf(channel), [channel]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(false);
  const [slideIndex, setSlideIndex] = useState(1);

  useEffect(() => {
    if (!adapter) return;
    let live = true;
    void (async () => {
      try {
        const detail = await adapter.detail(deckId);
        if (!detail.activeRevisionId) throw new Error('The deck has no version yet.');
        const spec = await adapter.spec(deckId, detail.activeRevisionId);
        const rendered = await adapter.preview(deckId, spec);
        if (live) setLoaded({ title: detail.title, slides: rendered.slides, warnings: rendered.warnings, postWithheld: adapter.postWithheld(detail) });
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : 'The deck could not be read.'); }
    })();
    return () => { live = false; };
  }, [adapter, deckId]);

  const revision = useMemo<PresentationRevision | null>(() => (loaded?.slides.length ? {
    id: 'built', label: 'Current',
    slides: loaded.slides.map((slide, i) => ({
      id: slide.id, index: i + 1, title: slide.title ?? slide.id,
      preview: <ImageThumbnail src={svgDataUri(slide.svg) ?? ''} alt={`Slide ${i + 1}: ${slide.title ?? slide.id}`} size="lg" aspectRatio="video" className="w-full"
        data-testid={`tenant-deck-slide-${slide.id}`} />,
    })),
  } : null), [loaded]);

  if (!adapter) return null;
  const postReason = preview ? null : loaded?.postWithheld ?? null;
  const post = async (): Promise<void> => {
    if (!loaded) return;
    setBusy(true); setError(null);
    try {
      await onPost({ channel, text: `${loaded.title} — ${adapter.noun}: ${window.location.origin}${adapter.page(deckId)}`, metadata: {} });
      setPosted(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The deck could not be posted.'); }
    finally { setBusy(false); }
  };

  const content = (
    <Stack gap="sm">
      <T size="xs" tone="secondary" wrap data-testid="tenant-deck-instruction">{instruction}</T>
      {!loaded && !error && <T size="sm" tone="secondary" data-testid="tenant-deck-loading">Loading the {adapter.noun}…</T>}
      {error && <InlineAlert tone="error" data-testid="tenant-deck-error">{error}</InlineAlert>}
      {notice && <InlineAlert tone="info" data-testid="tenant-deck-narrative">{notice}</InlineAlert>}
      {loaded?.warnings.map(warning => <InlineAlert key={warning} tone="warning">{warning}</InlineAlert>)}
      {revision && loaded && (
        <PresentationView title={loaded.title} subtitle={`Saved ${adapter.noun}`} revisions={[revision]} revisionId={revision.id}
          onRevisionChange={() => undefined} slideIndex={slideIndex} onSlideChange={setSlideIndex} maxSlideWidth={560} data-testid="tenant-deck-view" />
      )}
      {postReason && <T size="xs" tone="secondary" wrap data-testid="tenant-deck-post-withheld">{postReason}</T>}
      <Inline gap="sm" align="center">
        <Button variant="secondary" size="sm" onClick={() => navigate(adapter.page(deckId))} data-testid="tenant-deck-open">Open deck</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate(adapter.page(deckId))} data-testid="tenant-deck-revise">Revise…</Button>
        {loaded && !preview && !posted && !postReason && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void post(); }} data-testid="tenant-deck-post">Post to conversation</Button>
        )}
        {posted && <T size="sm" tone="secondary" data-testid="tenant-deck-posted">Posted to the conversation.</T>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss} data-testid="tenant-deck-dismiss">Dismiss</Button>
      </Inline>
    </Stack>
  );
  return bare ? <Stack gap="none" data-testid="tenant-deck-card">{content}</Stack> : <Card padding="sm" data-testid="tenant-deck-card">{content}</Card>;
}
