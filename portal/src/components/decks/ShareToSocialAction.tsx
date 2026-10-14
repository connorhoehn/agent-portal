// "Share to Social" for an assessment deck revision. Two steps in one library
// Modal: pick a destination the person is a member of, then confirm (members
// of that conversation will be able to download a copy). The copy is the
// revision's .pptx, fetched through the BFF, uploaded over the gateway's file
// feature (useChatAttachmentSend, lib/conversationComposer.ts) and posted with useChat as a message carrying
// metadata.attachments plus a display-only metadata.sourceDeck. Success is
// declared only once the channel echoes the message back.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useChat, useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import { Button, ChoiceRow, InlineAlert, Inline, Input, Modal, Prose, SectionLabel, ShareIcon, Spinner, Stack, T, FormField } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useChatAttachmentSend } from '../../lib/conversationComposer';
import { useEmbeddedSocial } from '../shell/EmbeddedSocial';
import { useSession } from '../../lib/auth';
import { toastSuccess } from '../../lib/toastStore';
import { channelHref, deckFileUrl, messageConfirmsShare, PPTX_MIME, pptxName, readShareDestinations, shareMessageText, shareMetadata,
  type ShareDestination } from '../../lib/shareToSocial';

export interface ShareToSocialActionProps {
  deckId: string; revisionId: string; fileName: string;
  /** The revision's .pptx endpoint. Defaults to the assessment deck route; the pipelines run report passes its own. */
  fileUrl?: string;
  disabled?: boolean;
}
const CONFIRM_TIMEOUT_MS = 15_000;

export function ShareToSocialAction(props: ShareToSocialActionProps) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  if (!session || (session.grants.social?.length ?? 0) === 0) return null;
  return <>
    <Button variant="secondary" size="sm" disabled={props.disabled} title={props.disabled ? 'Save your changes before sharing a copy.' : 'Share a PowerPoint copy to a conversation'}
      onClick={() => setOpen(true)} data-testid="deck-share-open"><ShareIcon size={14} />Share</Button>
    {open && <ShareDialog {...props} onClose={() => setOpen(false)} />}
  </>;
}

function ShareDialog({ deckId, revisionId, fileName, fileUrl, onClose }: ShareToSocialActionProps & { onClose(): void }) {
  const fetched = useFetch<unknown>('/api/social/share-destinations');
  const destinations = useMemo(() => readShareDestinations(fetched.data), [fetched.data]);
  const [chosen, setChosen] = useState<ShareDestination | null>(null);
  const [confirming, setConfirming] = useState(false);
  return <Modal open onClose={onClose} maxWidth={520}>
    <Stack gap="md" className="px-4.5 py-4" data-testid="deck-share-dialog">
      <SectionLabel as="h3" className="text-sm font-semibold text-text-primary normal-case tracking-normal">
        {confirming ? 'Share a copy?' : 'Share presentation'}
      </SectionLabel>
      {confirming && chosen
        ? <ConfirmStep key={chosen.channel} destination={chosen} deckId={deckId} revisionId={revisionId} fileName={pptxName(fileName)} fileUrl={fileUrl ?? deckFileUrl(deckId, revisionId)}
          onBack={() => setConfirming(false)} onClose={onClose} />
        : <>
          {fetched.isLoading && !fetched.data && <Inline gap="sm" align="center"><Spinner size="sm" /><T size="sm" className="text-text-secondary">Loading your conversations…</T></Inline>}
          {fetched.error && <InlineAlert tone="error">Your Social conversations could not be loaded. {fetched.error}</InlineAlert>}
          {!fetched.isLoading && !fetched.error && destinations.length === 0
            && <T size="sm" className="text-text-secondary" wrap>You are not a member of any channel or direct message yet. Join a channel in Social first.</T>}
          <Stack gap="xs" className="max-h-72 overflow-y-auto">
            {destinations.map(d => <ChoiceRow key={d.channel} title={d.label} description={d.detail} selected={chosen?.channel === d.channel}
              onSelect={() => setChosen(d)} data-testid={`deck-share-destination-${d.kind}`} />)}
          </Stack>
          <Inline gap="sm" justify="end" wrap={false}>
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!chosen} onClick={() => setConfirming(true)} data-testid="deck-share-next">Continue</Button>
          </Inline>
        </>}
    </Stack>
  </Modal>;
}

type Phase = 'idle' | 'sending' | 'done';

function ConfirmStep({ destination, deckId, revisionId, fileName, fileUrl, onBack, onClose }:
  { destination: ShareDestination; deckId: string; revisionId: string; fileName: string; fileUrl: string; onBack(): void; onClose(): void }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const social = useEmbeddedSocial();
  const gateway = useGatewayOptional();
  const displayName = session?.name ?? session?.sub ?? 'Someone';
  const chat = useChat(destination.channel);
  const attachmentSend = useChatAttachmentSend(destination.channel, displayName);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const connected = gateway?.connectionState === 'connected';

  useEffect(() => {
    if (!awaiting) return;
    if (messageConfirmsShare(chat.messages, awaiting)) {
      setAwaiting(null); setPhase('done'); toastSuccess(null, 'Deck shared', `${fileName} is in ${destination.label}.`); return;
    }
    const timer = window.setTimeout(() => {
      setAwaiting(null); setPhase('idle');
      setError('The conversation did not confirm the message. Check the conversation before sharing again.');
    }, CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [awaiting, chat.messages, fileName, destination.label]);

  async function share() {
    setPhase('sending'); setError(null);
    try {
      const response = await fetch(fileUrl, { credentials: 'include' });
      if (!response.ok) throw new Error(response.status === 403 ? 'You cannot download this deck.' : `The deck file could not be read (${response.status}).`);
      const file = new File([await response.blob()], fileName, { type: PPTX_MIME });
      const [attachment] = (await attachmentSend.prepare('', [file])).uploaded;
      if (!attachment) throw new Error('The upload did not return a file.');
      setAwaiting(attachment.id);
      chat.sendMessage(shareMessageText(fileName, note), shareMetadata(attachment, deckId, revisionId, displayName));
    } catch (err) {
      setPhase('idle'); setAwaiting(null);
      setError(err instanceof Error ? err.message : 'Sharing failed.');
    }
  }
  function openConversation() {
    onClose();
    const href = channelHref(destination);
    if (href) navigate(href); else void social?.openDm(destination.channel.split(':').slice(2).find(id => id !== session?.sub) ?? '');
  }

  if (phase === 'done') return <Stack gap="md" data-testid="deck-share-done">
    <InlineAlert tone="success">Shared {fileName} with {destination.label}.</InlineAlert>
    <Inline gap="sm" justify="end" wrap={false}>
      <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      <Button size="sm" onClick={openConversation} data-testid="deck-share-open-conversation">Open conversation</Button>
    </Inline>
  </Stack>;
  const busy = phase === 'sending';
  return <Stack gap="md">
    <Prose size="sm"><p>
      This sends a copy of <strong>{fileName}</strong> to <strong>{destination.label}</strong>. Everyone who is a member of
      {' '}{destination.kind === 'dm' ? 'this conversation' : 'that channel'} will be able to download it, and later edits to the deck will not change the copy.
    </p></Prose>
    <FormField label="Note (optional)">
      {({ id }) => <Input id={id} value={note} onChange={e => setNote(e.target.value)} placeholder={fileName} disabled={busy} maxLength={500} />}
    </FormField>
    {!connected && <InlineAlert tone="warning">Reconnecting to the realtime gateway. Sharing is available once it is connected.</InlineAlert>}
    {error && <InlineAlert tone="error" data-testid="deck-share-error">{error}</InlineAlert>}
    <Inline gap="sm" justify="end" wrap={false}>
      <Button variant="secondary" size="sm" onClick={onBack} disabled={busy}>Back</Button>
      <Button size="sm" onClick={() => void share()} disabled={busy || !connected} data-testid="deck-share-confirm">{busy ? 'Sharing…' : 'Share copy'}</Button>
    </Inline>
  </Stack>;
}
