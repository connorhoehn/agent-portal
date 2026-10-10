// The composer docked under the Initiatives pane and the initiative / work-item
// content column (F11, O10, W16, M5): the library `ConversationComposer`,
// configured for this subject. What it does (D6):
//
//   Agent — ASKS. Sending builds a prompt from what was typed plus the page
//           reference and runs in the initiative's Agent pane. Standalone
//           list views use the Ask page. Open to every role; nothing
//           here changes data. Removing the reference (×) sends the question
//           without it. `/deck` on an initiative opens its stored status deck.
//   Chat  — posts to an explicitly selected To: — this item's Discussion, the
//           huddle, or a person (a DM). Each destination checks its own
//           authority and acknowledges a stored message before the draft clears.
//
// The words — reference, prefill, placeholder, the three workflows behind
// "Workflow ⌄" and the matching "/ commands" — come from
// `project-detail/composerPrompts.ts`, built from row data. The prefill is
// keyed by subject (`setup.draftKey`). The huddle's draft belongs to the shell
// and survives navigation to Search, another work item, or a presentation.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { ConversationCommand, ConversationOutgoing, ConversationRecipient, RichChatComposerHandle } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { ComposerSendError, composerDraftOf } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import { Button, Inline, Select, Stack, T, useDensity } from '@connorhoehnslalom/ui-components/shared';
import { useSidePane } from '@connorhoehnslalom/ui-components';
import { useHuddleChat } from '../../components/shell/HuddleChat';
import { useEmbeddedSocial } from '../../components/shell/EmbeddedSocial';
import { ConversationComposer } from '../../lib/conversationComposer';
import type { ConversationRuntime } from '../../components/chat/ConversationThread';
import { huddleChannel } from '../../lib/huddleRoster';
import { dmLobby } from '../social/socialPlatform';
import {
  askHref, composerCommands, composerPageReference, composerSetup, workflowMenuRows,
  type ComposerSetup, type ComposerSubject,
} from '../project-detail/composerPrompts';
import { buildTenantDeckFromText, deckCommandSpec } from '../../components/chat/tenantDeckCompose';
import { useCapabilities } from '../../lib/capabilities';
import { postInitiativeComment } from './initiativeComment';
import { initiativeAgentRequest, type InitiativeAgentRequest } from './initiativeAgentRequest';
import { useSession } from '../../lib/auth';
import { useCallHost } from '../../lib/conversationCall';
import { callScopeKey } from '../../components/shell/callShellModel';
import { readSharedPeople } from '../../components/shell/tenantDirectModel';
import { InitiativeDiscussionDelivery, inquiryInvitationFeedback, invitationTargets, mentionedInquiryPeople, readInitiativeDestination, rememberInitiativeDestination,
  type InquiryInvitationReceipt, type InquiryPerson } from './initiativeChatDelivery';
import { planeViewHref } from '../../components/communication/planeRailModel';

export interface InitiativeComposerProps {
  /** Use the shared document-view toolbar in full-width initiative details. */
  presentation?: 'compact' | 'document';
  /** What the composer is about: the initiatives list, one initiative, or one work item. */
  subject: ComposerSubject;
  /**
   * Overrides for the words `composerSetup(subject)` derives — a route that
   * knows better (a different placeholder, no prefill) passes only what differs.
   * `draftKey` must change whenever the subject does.
   */
  setup?: Partial<ComposerSetup>;
  /**
   * This subject's Discussion (the page's one `useConversation`, shared with
   * the thread in the side pane): Chat's "This item's Discussion" posts there,
   * and its `/summarize` cards land in that thread.
   */
  conversation?: ConversationRuntime | null;
  /** Why the Discussion cannot take a message (a reader). */
  chatUnavailableReason?: string;
  /** The call bar and tiles, flush on the composer's top edge (`useCallBlock`). */
  dock?: ReactNode;
  defaultMode?: 'agent' | 'chat';
  expanded?: boolean;
  onComment?: () => void;
  /** Run beside the current content instead of navigating to standalone Ask. */
  onAsk?: (request: InitiativeAgentRequest) => boolean | string;
  'data-testid'?: string;
}

export function InitiativeComposer(props: InitiativeComposerProps) {
  const { session } = useSession();
  const derived = composerSetup(props.subject);
  const setup: ComposerSetup = { ...derived, ...props.setup };
  // Remount per subject: the prefill, the reference and any half-typed text all
  // belong to the subject they were written against.
  return <DockedComposer key={`${callScopeKey(session)}:${setup.draftKey}`} {...props} setup={setup} />;
}

function destinationStorage(): Storage | null { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }

function DockedComposer({
  subject, setup, conversation, chatUnavailableReason, dock, defaultMode = 'agent', expanded, onComment, onAsk, presentation = 'compact', 'data-testid': testId = 'initiative-composer',
}: Omit<InitiativeComposerProps, 'setup'> & { setup: ComposerSetup }) {
  const navigate = useNavigate();
  const location = useLocation();
  const pane = useSidePane();
  const { session } = useSession();
  const gateway = useGatewayOptional();
  const host = useCallHost();
  const { can } = useCapabilities();
  const compact = useDensity() === 'compact';
  const huddle = useHuddleChat();
  const social = useEmbeddedSocial();
  const reference = useMemo(() => composerPageReference(subject), [subject]);
  const scopeKey = `${callScopeKey(session)}:${setup.draftKey}`;
  const [rememberedDestination] = useState(() => readInitiativeDestination(destinationStorage(), scopeKey));
  // On the focused work item the huddle chat is the shell's right pane: choosing
  // the huddle opens it, and a huddle-bound send hands the draft to it.
  const [recipient, setRecipient] = useState<string | null>(rememberedDestination?.recipient ?? null);
  const [mode, setMode] = useState<'agent' | 'chat'>(rememberedDestination?.mode ?? defaultMode);
  // Removing the reference (×) drops it from this draft only: sends and asks go without it.
  const [withReference, setWithReference] = useState(true);
  const page = withReference ? reference.page : null;
  const commentDelivery = useRef<{ signature: string; id: string } | null>(null);
  const composerRef = useRef<RichChatComposerHandle | null>(null);
  const [discussionDelivery] = useState(() => new InitiativeDiscussionDelivery());
  const [draftText, setDraftText] = useState('');
  const draftHasFiles = useRef(false);
  const [receipt, setReceipt] = useState<{ scope: string; operationScope?: string; destination: string; state: 'pending' | 'saved' | 'requested' | 'failed' | 'notice'; detail?: string; invitation?: InquiryInvitationReceipt; open?: () => void } | null>(null);
  const [inquiryHandoff, setInquiryHandoff] = useState<{ recipientId: string; text: string } | null>(null);
  const [huddleRecovery, setHuddleRecovery] = useState<string | null>(null);
  const [retiredChoice, setRetiredChoice] = useState<string | null>(null);
  const deliveryScope = `${scopeKey}:${mode}:${recipient ?? 'discussion'}:${conversation?.channel ?? ''}:${conversation?.maySend ?? false}:${gateway?.authToken ?? ''}`;
  const latestScope = useRef(deliveryScope); latestScope.current = deliveryScope;
  const abort = useRef(new AbortController());
  useLayoutEffect(() => {
    const next = new AbortController(), captured = deliveryScope; abort.current = next;
    return () => { next.abort(); if (latestScope.current === captured) latestScope.current = `abandoned:${captured}`; };
  }, [deliveryScope]);
  useEffect(() => { setReceipt(previous => previous?.state === 'pending' && previous.operationScope !== deliveryScope
    ? { ...previous, state: 'failed', detail: `Confirmation stopped when the destination or connection changed. Check ${previous.destination} before retrying.` } : previous); }, [deliveryScope]);
  useEffect(() => { rememberInitiativeDestination(destinationStorage(), scopeKey, { recipient, mode }); }, [scopeKey, recipient, mode]);

  const currentHuddle = huddle?.callId ? `huddle:${huddle.callId}` : null;
  // A newly joined call can take an empty chat composer. An existing draft,
  // attachment or explicit private destination stays exactly where it was.
  useEffect(() => {
    const editor = composerRef.current?.editor;
    if (!currentHuddle || mode !== 'chat' || (recipient && recipient !== 'discussion') || !editor?.isEmpty) return;
    if (draftHasFiles.current) return;
    setRecipient(currentHuddle);
  }, [currentHuddle]); // eslint-disable-line react-hooks/exhaustive-deps
  const retiredDrafts = (huddle?.retiredDrafts ?? []).filter(row => row.scope.actorId === session?.sub
    && row.scope.tenant === session?.tenant && row.scope.identityKey === callScopeKey(session));
  const selectedRetiredDraft = retiredDrafts.find(row => `huddle:${row.scope.callId}` === recipient && recipient !== currentHuddle);
  const recoveryDraft = retiredDrafts.find(row => row.scope.callId === huddleRecovery);
  const visibleRetiredDraft = selectedRetiredDraft ?? retiredDrafts.find(row => row.scope.callId === retiredChoice) ?? recoveryDraft ?? retiredDrafts.at(-1);
  const invitationCallScope = `${scopeKey}:${huddle?.callId ?? ''}:${host?.call.call?.callId ?? ''}:${host?.self?.userId ?? ''}:${host?.tenant ?? ''}:${host?.connectionState ?? ''}`;
  const latestInvitationCall = useRef(invitationCallScope); latestInvitationCall.current = invitationCallScope;
  // Joining a call offers another destination. It never retargets an unfinished inquiry.
  const people = social?.people.filter(person => person.userId !== social.actorId) ?? [];
  const openDiscussion = () => {
    huddle?.closeMessage(); pane.reveal();
    const params = new URLSearchParams(location.search); params.set('pane', 'discussion'); params.delete('paneRecord');
    navigate({ pathname: location.pathname, search: params.toString() });
  };
  const deliver = async (destination: string, send: () => Promise<boolean>, open: () => void) => {
    const captured = latestScope.current;
    setReceipt({ scope: scopeKey, operationScope: captured, destination, state: 'pending', open });
    try {
      const sent = await send();
      if (latestScope.current !== captured) return false;
      if (!sent) throw new ComposerSendError('The message was not confirmed. Your draft has been kept.');
      setReceipt({ scope: scopeKey, destination, state: 'saved', open });
      return true;
    } catch (error) {
      if (latestScope.current !== captured) return false;
      const detail = error instanceof Error ? error.message : 'The message was not confirmed. Your draft has been kept.';
      setReceipt({ scope: scopeKey, destination, state: 'failed', detail, open });
      throw new ComposerSendError(detail);
    }
  };
  const recipients: ConversationRecipient[] = [
    // Files go to the Discussion (its writers) and to a DM; the huddle's send is text-only.
    { id: 'discussion', label: 'Initiative discussion', channel: conversation?.channel ?? null, placeholder: subject.kind === 'item' ? 'Discuss this work, or /comment to add a note…' : 'Add to the discussion…', attachments: true,
      ...(!conversation?.maySend ? { disabled: true, unavailableReason: chatUnavailableReason ?? 'Posting to this discussion is not included in your current access.' } : {}),
      send: out => deliver('Initiative discussion', async () => {
        const captured = latestScope.current;
        if (!conversation?.maySend || !conversation.connected || !gateway?.onMessage) throw new ComposerSendError('This discussion cannot receive a message right now. Your draft has been kept.');
        return discussionDelivery.send({ scopeKey, channel: conversation.channel, userId: conversation.userId, text: out.text, metadata: out.metadata,
          signal: abort.current.signal, current: () => latestScope.current === captured,
          listen: gateway.onMessage, sendMessage: conversation.chat.sendMessage, newId: () => crypto.randomUUID() });
      }, openDiscussion) },
    ...(huddle && currentHuddle ? [{
      id: currentHuddle, label: `${huddle.title ?? 'Current huddle'} · Huddle`, channel: huddleChannel(huddle.callId!), placeholder: 'Message this huddle…',
      carriesReference: !!reference.page, unavailableReason: huddle.unavailableReason, error: huddle.state.error, claim: true,
      onSelect: () => { huddle.openPane({ page, focus: false }); },
      send: async out => deliver(`${huddle.title ?? 'Current huddle'} · Huddle`, async () => {
        const sent = await huddle.send(out.text, page, out.metadata, huddle.draft);
        if (sent) huddle.openPane();
        return sent;
      }, () => { huddle.openPane({ focus: false }); }),
    } satisfies ConversationRecipient] : []),
    // An explicitly chosen huddle stays bound to that call: ending it never redirects the draft.
    ...(recipient?.startsWith('huddle:') && recipient !== currentHuddle ? [{ id: recipient, label: 'Previous huddle', disabled: true,
      unavailableReason: selectedRetiredDraft ? 'This huddle has ended. Recover the retained draft into a destination you choose.' : 'This huddle has ended. Choose a current destination.' }] : []),
    ...people.map(person => ({
      id: `person:${person.userId}`, label: person.displayName, group: 'Direct message', claim: false,
      channel: social?.actorId ? dmLobby([social.actorId, person.userId]) : null, attachments: true, carriesReference: !!reference.page,
      placeholder: `Message ${person.displayName}…`, error: social?.state.error ?? null,
      unavailableReason: social?.unavailableReason ?? (!social?.canMessagePeople ? 'Direct messages are unavailable.' : null),
      // Files land first (the composer uploads to the DM); only what the gateway confirmed is cited.
      send: (out: ConversationOutgoing) => deliver(`Direct message · ${person.displayName}`, async () => {
        return Object.keys(out.metadata).length
          ? social?.controller.sendToPerson(person.userId, out.text, page, async text => ({ text, extra: { ...out.metadata } })) ?? false
          : social?.sendToPerson(person.userId, out.text, page) ?? false;
      }, () => { void social?.openDm(person.userId); }),
    })),
    ...(recipient?.startsWith('person:') && !people.some(p => `person:${p.userId}` === recipient) ? [{ id: recipient, label: 'Unavailable person', disabled: true,
      unavailableReason: 'This person is no longer available. Choose a current destination.' }] : []),
  ];
  const selectRecipient = (value: string) => {
    setRecipient(value);
    if (value === 'discussion') huddle?.closeMessage();
    recipients.find(option => option.id === value)?.onSelect?.();
  };
  const selectedRecipient = recipients.find(option => option.id === recipient) ?? recipients[0];
  const unresolvedDestination = (recipient?.startsWith('person:') && !people.some(person => `person:${person.userId}` === recipient))
    || (recipient?.startsWith('huddle:') && recipient !== currentHuddle);
  const huddleRecipientSelected = mode === 'chat' && selectedRecipient?.id.startsWith('huddle:');
  const huddleDraftSelected = mode === 'chat' && selectedRecipient?.id === currentHuddle && !!huddle?.callId;
  const mayRecoverHere = mode === 'chat' && !selectedRecipient?.disabled && !selectedRecipient?.unavailableReason && !selectedRetiredDraft;
  const editorKey = huddleRecipientSelected ? selectedRecipient!.id : 'page';
  useEffect(() => { setDraftText(''); }, [editorKey]);
  const mentionedPeople = mentionedInquiryPeople(draftText, people);
  const inquire = (person: InquiryPerson, text?: string) => {
    const fromHuddle = huddleDraftSelected;
    selectRecipient(`person:${person.userId}`); setMode('chat');
    // This is a destination choice, not a send or a fallback after a denial.
    if (text !== undefined) {
      if (fromHuddle) setInquiryHandoff(text ? { recipientId: `person:${person.userId}`, text } : null);
      else composerRef.current?.editor?.commands.setContent(composerDraftOf(text).html);
    }
    composerRef.current?.focus();
  };
  const requestInvitation = async (targets: readonly InquiryPerson[]): Promise<boolean | string> => {
    if (!huddle?.callId || !host?.call.call || host.call.call.callId !== huddle.callId || host.connectionState !== 'connected') return 'Join a connected huddle before inviting someone.';
    if (!session || host.self?.userId !== session.sub || host.tenant !== session.tenant || huddle.actorId !== session.sub) return 'The current huddle does not match this session. Your draft has been kept.';
    const captured = latestScope.current, callId = huddle.callId;
    const result = host.call.inviteUsers([...targets]);
    if (latestScope.current !== captured || host.call.call.callId !== callId) return false;
    if (!result.requestedUserIds.length) return result.reason ?? 'No invitation was requested. The person may already be in this huddle.';
    const names = targets.filter(p => result.requestedUserIds.includes(p.userId)).map(p => p.displayName).join(', ');
    setReceipt({ scope: scopeKey, destination: huddle.title ?? 'Current huddle', state: 'requested', detail: names,
      ...(result.requestId ? { invitation: { requestId: result.requestId, callId, userIds: result.requestedUserIds } } : {}),
      open: () => { huddle.openPane({ focus: false }); } });
    return true;
  };
  const invitePeople = async (text: string): Promise<boolean | string> => {
    const captured = latestScope.current, capturedCall = latestInvitationCall.current;
    try {
      // Both a slash command and the person action refresh exact targets in the current tenant.
      const response = await fetch('/api/people/shared', { credentials: 'include', cache: 'no-store', signal: abort.current.signal });
      if (!response.ok) return 'The people directory could not confirm invitation targets. Your draft has been kept.';
      const directory = readSharedPeople(await response.json());
      if (latestScope.current !== captured || latestInvitationCall.current !== capturedCall) return false;
      if (!directory || directory.me.userId !== session?.sub || directory.tenant !== session?.tenant) return 'The people directory does not match this session. Your draft has been kept.';
      const targets = invitationTargets(text, directory.people);
      return typeof targets === 'string' ? targets : requestInvitation(targets);
    } catch {
      return latestScope.current !== captured || latestInvitationCall.current !== capturedCall ? false : 'The people directory could not confirm invitation targets. Your draft has been kept.';
    }
  };
  const invitationFeedback = receipt?.invitation && host?.call.call?.callId === receipt.invitation.callId
    ? inquiryInvitationFeedback(receipt.invitation, host.call.invitationRequests, host.call.invitationError) : null;

  // Ordinary questions and workflows share the same run destination.
  const ask = (text: string): boolean | string => {
    if (onAsk) {
      const request = initiativeAgentRequest(text, subject, withReference);
      return request ? onAsk(request) : false;
    }
    const href = askHref(text, subject, withReference);
    if (!href) return false;
    navigate(href);
    return true;
  };
  const commands = useMemo<ConversationCommand[]>(() => [
    { trigger: '/inquire', label: 'Choose a private inquiry', description: 'Choose an exact @name. Review the destination before sending.', modes: ['chat'],
      run: input => {
        const targets = mentionedInquiryPeople(input.argumentText, people);
        if (targets.length !== 1) return 'Use /inquire followed by one exact @name from the people menu.';
        const text = input.argumentText.replace(new RegExp(`^\\s*@${targets[0]!.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
        inquire(targets[0]!, text);
        return false; // Destination selection alone never sends or clears a draft.
      } },
    { trigger: '/invite', label: 'Invite to the current huddle', description: 'Request an invitation for exact @names without posting a chat message.', modes: ['chat'],
      run: input => invitePeople(input.argumentText) },
    ...(subject.kind === 'item' ? [{ trigger: '/comment', label: 'Add a work-item comment', hint: subject.item.key ?? subject.item.title,
      description: 'Save a note on this work item and keep it in the initiative conversation.', modes: ['chat' as const],
      run: async (input: { argumentText: string }) => {
        const body = input.argumentText.trim();
        if (!body) return 'Write a note after /comment.';
        if (!conversation?.maySend) return 'Your role cannot comment on work items.';
        const captured = latestScope.current;
        const signature = `${scopeKey}:${subject.project.id}:${subject.item.id}:${body}`;
        if (commentDelivery.current?.signature !== signature) commentDelivery.current = { signature, id: crypto.randomUUID() };
        const editor = composerRef.current?.editor;
        const submittedHtml = editor?.getHTML();
        await postInitiativeComment(subject.project.id, subject.item.id, body, commentDelivery.current.id);
        if (latestScope.current !== captured || composerRef.current?.editor !== editor) return false;
        commentDelivery.current = null;
        // Clear before navigation refreshes the activity view. A new edit made
        // while the request was pending belongs to the next message.
        if (editor && !editor.isDestroyed && editor.getHTML() === submittedHtml) editor.commands.clearContent(true);
        onComment?.();
        return true;
      },
    }] : []),
    ...composerCommands(subject).map(c => ({ ...c, modes: ['agent' as const], run: (input: { text: string }) => ask(input.text) })),
    ...(subject.kind === 'initiative' ? [{ ...deckCommandSpec, modes: ['agent' as const],
      // `/deck` is the same build as the Discussion's: it opens the stored status deck.
      run: async (input: { text: string }) => {
        const built = await buildTenantDeckFromText(`orgiq:initiative:${subject.project.id}`, input.text, can('DispatchAgentRun'));
        if (typeof built === 'string') return built;
        navigate(built.page);
        return true;
      } }] : []),
    // The Discussion's own commands (/summarize …) in Chat; their cards land in its thread.
    ...(conversation?.commands ?? []).map(c => ({ ...c, modes: ['chat' as const] })),
  ], [subject, conversation?.commands, withReference, onAsk, people, huddle, host, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ConversationComposer
      key={editorKey}
      channel={conversation?.channel ?? null}
      chat={conversation?.chat ?? null}
      context={{ kind: 'initiative', id: setup.draftKey, title: '', reference: selectedRetiredDraft ? null : { id: reference.id, label: reference.label, page: reference.page } }}
      capabilities={{ maySend: !!conversation?.maySend, ...(chatUnavailableReason ? { readOnlyReason: chatUnavailableReason } : {}),
        // A vanished recipient must not turn an unfinished private draft into an Agent request.
        agent: { allowed: !(mode === 'chat' && unresolvedDestination), reason: 'Choose a current destination before changing this draft’s mode.' },
        mayAttach: !!conversation?.maySend || !!social?.canMessagePeople }}
      offline={mode === 'chat' && selectedRecipient?.id === 'discussion' && conversation && !conversation.connected ? 'The realtime gateway is not connected, so the discussion is unavailable.' : null}
      // The reader can type an Agent question before its discussion runtime
      // mounts. That arrival does not change who owns this persisted draft.
      identity={session ? { userId: session.sub, displayName: session.name } : null}
      {...(conversation ? { reply: conversation.quote } : {})}
      recipients={recipients}
      recipient={selectedRecipient?.id ?? null}
      onRecipientChange={selectRecipient}
      defaultRecipient={conversation ? 'discussion' : currentHuddle ?? undefined}
      defaultMode={defaultMode}
      mode={mode}
      onModeChange={value => { if (value === 'agent' || value === 'chat') setMode(value); }}
      modeRowEnd={mode === 'chat' && currentHuddle && !huddleDraftSelected ? <Button variant="secondary" size="sm" className="text-xs shrink-0" onClick={() => { selectRecipient(currentHuddle); setMode('chat'); }}>Huddle chat</Button> : undefined}
      above={((receipt?.scope === scopeKey) || retiredDrafts.length > 0 || (mode === 'chat' && (mentionedPeople.length > 0 || selectedRecipient?.id.startsWith('person:')))) ? <Stack gap="xs">
        {receipt?.scope === scopeKey && <Inline gap="xs" align="center" wrap className="text-xs" data-testid="initiative-chat-receipt" role="status">
          <T size="xs" tone="secondary" wrap>{receipt.state === 'saved' ? `Message saved to ${receipt.destination}.` : receipt.state === 'requested' ? invitationFeedback ?? `Invitation requested for ${receipt.detail} · ${receipt.destination}.` : receipt.state === 'pending' ? `Confirming message in ${receipt.destination}…` : receipt.detail}</T>
          {receipt.open && <Button variant="link" size="sm" className="!text-xs !min-h-0 !h-auto !py-0" onClick={receipt.open}>Open conversation</Button>}
          {receipt.state !== 'pending' && <Button variant="ghost" size="sm" className="!text-xs !min-h-0 !h-auto !py-0" onClick={() => setReceipt(null)}>Dismiss</Button>}
        </Inline>}
        {visibleRetiredDraft && <Inline gap="xs" wrap data-testid="initiative-retired-huddle-draft">
          <T size="xs" tone="secondary" wrap>{retiredDrafts.length > 1 ? `${retiredDrafts.length} unsent huddle drafts` : `Unsent draft · ${visibleRetiredDraft.title || 'Previous huddle'}`}</T>
          {retiredDrafts.length > 1 && <Select aria-label="Retained huddle draft" size="sm" value={visibleRetiredDraft.scope.callId} className="max-w-64 text-xs"
            options={retiredDrafts.map((row,index) => ({ value: row.scope.callId, label: `${row.title || 'Previous huddle'} · Draft ${index+1}` }))}
            onChange={event => { setRetiredChoice(event.target.value); setHuddleRecovery(null); selectRecipient(`huddle:${event.target.value}`); setMode('chat'); }} />}
          {visibleRetiredDraft !== selectedRetiredDraft && <Button variant="link" size="sm" onClick={() => { selectRecipient(`huddle:${visibleRetiredDraft.scope.callId}`); setMode('chat'); }}>Review draft</Button>}
          <Button variant="link" size="sm" onClick={() => { setRetiredChoice(visibleRetiredDraft.scope.callId); setHuddleRecovery(visibleRetiredDraft.scope.callId);
            selectRecipient(`huddle:${visibleRetiredDraft.scope.callId}`); setMode('chat'); }}>Recover text</Button>
          <Button variant="link" size="sm" onClick={() => { huddle?.discardRetiredDraft(visibleRetiredDraft.scope.callId); if (huddleRecovery === visibleRetiredDraft.scope.callId) setHuddleRecovery(null);
            setReceipt({ scope: scopeKey, destination: visibleRetiredDraft.title, state: 'notice', detail: 'The retained draft was discarded. Choose a destination when you are ready.' }); }}>Discard draft</Button>
        </Inline>}
        {recoveryDraft && <Inline gap="xs" wrap data-testid="initiative-huddle-draft-recovery">
          <T size="xs" tone="secondary" wrap>{mayRecoverHere ? `Add retained text to ${selectedRecipient?.label}. Existing text stays in this draft.` : 'Choose a current To destination, then add the retained text.'}
            {recoveryDraft.draft.files.length > 0 ? ' Attached files stay with the original huddle draft.' : ''}</T>
          <Button variant="link" size="sm" disabled={!mayRecoverHere} onClick={() => {
            const editor = composerRef.current?.editor; if (!editor || !mayRecoverHere) return;
            editor.commands.setContent(`${editor.getText().trim() ? editor.getHTML() : ''}${recoveryDraft.draft.html}`);
            setHuddleRecovery(null); editor.commands.focus();
            setReceipt({ scope: scopeKey, destination: selectedRecipient!.label, state: 'notice', detail: `Text added to ${selectedRecipient!.label}. The original huddle draft is retained.` });
          }}>Add retained text</Button>
          <Button variant="link" size="sm" onClick={() => setHuddleRecovery(null)}>Cancel recovery</Button>
        </Inline>}
        {mode === 'chat' && mentionedPeople.map(person => <Inline key={person.userId} gap="xs" wrap data-testid="initiative-mentioned-person-actions">
          <T size="xs" tone="secondary">@{person.displayName} mentions this conversation.</T>
          <Button variant="link" size="sm" disabled={!social?.canMessagePeople} onClick={() => inquire(person)}>Inquire privately</Button>
          <Button variant="link" size="sm" onClick={() => navigate(planeViewHref('/iq/communication', { kind: 'person', userId: person.userId }))}>Shared work</Button>
          {!!huddle?.callId && <Button variant="link" size="sm" onClick={() => { void invitePeople(`@${person.displayName}`).then(result => { if (typeof result === 'string') setReceipt({ scope: scopeKey, destination: huddle.title, state: 'failed', detail: result }); }); }}>Invite to huddle</Button>}
        </Inline>)}
        {mode === 'chat' && selectedRecipient?.id.startsWith('person:') && <Inline gap="xs"><Button variant="link" size="sm" onClick={() => navigate(planeViewHref('/iq/communication', { kind: 'person', userId: selectedRecipient.id.slice('person:'.length) }))}>Shared work with {selectedRecipient.label}</Button></Inline>}
        {mode === 'chat' && inquiryHandoff?.recipientId === selectedRecipient?.id && <Inline gap="xs" wrap data-testid="initiative-inquiry-handoff">
          <T size="xs" tone="secondary" wrap>Inquiry text ready: {inquiryHandoff.text}</T>
          <Button variant="link" size="sm" onClick={() => { const editor = composerRef.current?.editor; if (!editor) return;
            editor.commands.setContent(`${editor.getHTML()}${composerDraftOf(inquiryHandoff.text).html}`); setInquiryHandoff(null); editor.commands.focus(); }}>Add to inquiry</Button>
          <Button variant="link" size="sm" onClick={() => setInquiryHandoff(null)}>Dismiss</Button>
        </Inline>}
      </Stack> : undefined}
      commands={commands}
      composerRef={composerRef}
      onAgent={text => ask(text)}
      workflows={workflowMenuRows(subject)}
      callBlock={dock}
      claim={{ label: 'the initiative composer' }}
      answersFocus
      // Native persistence stays scoped to the actor, tenant and subject. The separate
      // destination preference labels its draft; unknown legacy bytes are not adopted.
      persistDraft
      {...(huddleRecipientSelected ? { draft: huddleDraftSelected ? huddle!.draft : selectedRetiredDraft?.draft ?? composerDraftOf('') } : {})}
      onDraftChange={draft => { draftHasFiles.current = draft.files.length > 0; if (huddleDraftSelected) huddle?.setDraft(draft); else if (selectedRetiredDraft) huddle?.updateRetiredDraft(selectedRetiredDraft.scope.callId, draft);
        setDraftText(composerRef.current?.editor?.getText() ?? ''); }}
      presentation={presentation}
      label="Initiative composer"
      data-testid={testId}
      // Compact (a canvas tab): a tighter dock, so the graph keeps the column.
      className={compact ? '@container bg-surface pt-0 [--dock-inset:0px]' : '@container bg-surface pt-3 [--dock-inset:1.5rem]'}
      expanded={expanded ?? !compact}
      modePlaceholders={{ agent: setup.placeholder }}
      allowEmoji={false}
      defaultDraft={setup.draft}
      draftKey={scopeKey}
      onRemoveReference={id => { if (id === reference.id) setWithReference(false); }}
    />
  );
}
