// Forward for every chat panel (parity item 6): the library's `onForwardMessage` opens a picker
// built from the library's own ConversationList (PopoverForm + SearchInput + QuoteBlock), limited
// to conversations the actor can post to right now. Delivery is a NEW message in the target
// (join, send, wait for the persisted ack) quoting the original with `metadata.forwardedFrom`, which
// the library's ChatPanel shows as "Forwarded from …". The gateway still decides every send.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import { forwardAttributionLine, QuoteBlock, ConversationList, type ConversationItem } from '@connorhoehn/ui-components/social';
import { ChatIcon, EmptyState, PopoverForm, SearchInput, T } from '@connorhoehn/ui-components/shared';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import type { TeamSummary } from '../../pages/assessment/types';
import type { WorkItem } from '../../pages/project-detail/types';
import type { ProjectSummary } from '../../pages/projects/types';
import type { RunListResponse } from '../../lib/pipelineRuns';
import { useEmbeddedSocial } from '../shell/EmbeddedSocial';
import { sendAndWaitForSocialChatAck, socialChatError } from '../../pages/social/socialChatDelivery';
import { channelRailItems, dmRailItems, type SocialChannel } from '../../pages/social/socialChat';
import { buildForwardSource, composeForwardBody, forwardMetadata, forwardedFromRef, forwardTargets, originLabel, scopedOriginLabel, FORWARD_SECTION, type ScopedSources, type ForwardableMessage, type ForwardSource } from '../../lib/chatForward';

type Frame = Record<string, unknown>;

export interface ChatForward {
  /** Pass to the panel's `onForwardMessage`; undefined when the conversation is not connected. */
  onForwardMessage: ((message: ForwardableMessage, trigger: HTMLElement) => void) | undefined;
  /** Render once, next to the panel. */
  picker: ReactNode;
}

export function useChatForward({ channel, userId, displayName, enabled = true }: { channel: string; userId: string; displayName: string; enabled?: boolean }): ChatForward {
  const gateway = useGatewayOptional();
  const { session } = useSession();
  const { can } = useCapabilities();
  const social = useEmbeddedSocial();
  const isSocial = session?.tenant === 'social';
  const channelsFetch = useFetch<{ channels: SocialChannel[] }>(enabled && isSocial ? '/api/social/channels' : null, undefined, { share: true });
  const channels = useMemo(() => channelsFetch.data?.channels ?? [], [channelsFetch.data]);

  // The same registries the pages use: the roster, initiative list and runs ledger, each read
  // only in its own tenant and only when the live capability allows posting there.
  const tenant = session?.tenant ?? null;
  const scopedAllowed = tenant === 'assessment' ? can('ViewAssessment') : tenant === 'orgiq' ? can('DispatchAgentRun') : tenant === 'pipelines' ? can('ViewPipelines') : false;
  const on = enabled && scopedAllowed;
  const teamsFetch = useFetch<TeamSummary[]>(on && tenant === 'assessment' ? '/api/assessment/teams' : null, undefined, { share: true });
  const initiativesFetch = useFetch<ProjectSummary[]>(on && tenant === 'orgiq' ? `/api/graph/projects?limit=100&scope=${can('ManageBudgets') ? 'all' : 'mine'}` : null, undefined, { share: true });
  const workFetch = useFetch<WorkItem[]>(on && tenant === 'orgiq' ? '/api/graph/work?limit=200' : null, undefined, { share: true });
  const runsFetch = useFetch<RunListResponse>(on && tenant === 'pipelines' ? '/api/pipelines/runs?limit=50' : null, undefined, { share: true });
  const scoped = useMemo<ScopedSources>(() => ({
    teams: (Array.isArray(teamsFetch.data) ? teamsFetch.data : []).map(t => ({ id: t.id, label: t.name })),
    initiatives: (Array.isArray(initiativesFetch.data) ? initiativesFetch.data : []).map(p => ({ id: p.id, label: p.name })),
    workItems: (Array.isArray(workFetch.data) ? workFetch.data : []).map(w => ({ id: w.id, label: w.title, initiativeId: w.projectId, initiativeName: w.projectName, status: w.status })),
    runs: (runsFetch.data?.runs ?? []).map(r => ({ id: r.id, label: `Run ${r.id}` })),
  }), [teamsFetch.data, initiativesFetch.data, workFetch.data, runsFetch.data]);

  const [source, setSource] = useState<ForwardSource | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLElement | null>(null);
  const busy = useRef(false);

  const connected = gateway?.connectionState === 'connected';
  const targets = useMemo(() => forwardTargets({
    originChannel: channel, dms: social?.conversations ?? [], channels,
    canSendDms: !!social?.canSend && !!social.authorityVerified, canPostChannels: isSocial && can('PostMessage'),
    tenant, scoped, canPostScoped: scopedAllowed,
  }), [channel, social?.conversations, social?.canSend, social?.authorityVerified, channels, isSocial, can, tenant, scoped, scopedAllowed]);
  const items = useMemo<ConversationItem[]>(() => {
    const allowed = new Set(targets.map(t => t.channel));
    const dms = social?.me ? dmRailItems((social.conversations ?? []).filter(d => allowed.has(d.channel)), null, social.me.userId, social.people) : [];
    const pages = targets.flatMap(t => t.kind === 'team' || t.kind === 'initiative' || t.kind === 'run' || t.kind === 'work'
      ? [{ channel: t.channel, kind: 'channel' as const, name: t.label ?? t.channel, peers: [], section: t.section ?? FORWARD_SECTION[t.kind as 'team' | 'initiative' | 'run'] }] : []);
    return [...dms, ...channelRailItems(channels.filter(c => allowed.has(c.channel))), ...pages] as ConversationItem[];
  }, [targets, social, channels]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter(i => `${i.name ?? ''} ${i.peers.map(p => p.displayName).join(' ')}`.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const close = useCallback(() => { setSource(null); setError(null); setQuery(''); }, []);
  const open = useCallback((message: ForwardableMessage, trigger: HTMLElement) => {
    const current = channels.find(c => c.channel === channel);
    const next = buildForwardSource(message, { channel, label: scopedOriginLabel(channel, scoped) ?? originLabel(channel, current?.slug, current?.privacy === 'public') });
    if (!next) return;
    anchor.current = trigger; setError(null); setSource(next);
  }, [channel, channels, scoped]);

  const pick = useCallback(async (target: string) => {
    if (!source || busy.current || !gateway || !targets.some(t => t.channel === target)) return;
    busy.current = true; setPending(true); setError(null);
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 25_000);
    const listen = gateway.onMessage as unknown as (handler: (frame: Frame) => void) => () => void;
    const send = gateway.sendMessage as unknown as (frame: Frame) => void;
    try {
      // The target is not the conversation this panel joined: join, and send only on the ack.
      await new Promise<void>((resolve, reject) => {
        const off = listen(frame => {
          const refused = socialChatError(frame, target);
          if (refused) { off(); reject(new Error(refused)); }
          else if (frame.type === 'chat' && frame.action === 'joined' && frame.channel === target) { off(); resolve(); }
        });
        abort.signal.addEventListener('abort', () => { off(); reject(new Error('The conversation did not accept the forward in time.')); }, { once: true });
        send({ service: 'chat', action: 'join', channel: target });
      });
      const deliveryId = crypto.randomUUID();
      const header = forwardAttributionLine(forwardedFromRef(source));
      await sendAndWaitForSocialChatAck({ channel: target, deliveryId, userId, listen, signal: abort.signal,
        send: () => send({ service: 'chat', action: 'send', channel: target, message: composeForwardBody(source, header),
          metadata: forwardMetadata(source, target, displayName, deliveryId) }) });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The message could not be forwarded.');
    } finally { clearTimeout(timer); busy.current = false; setPending(false); }
  }, [source, gateway, targets, userId, displayName, close]);

  const picker = source ? (
    <PopoverForm open anchor={anchor} placement="bottom-end" title="Forward to" busy={pending} error={error} submitSlot={false}
      onSubmit={() => {}} onClose={close} width="lg" data-testid="forward-message">
      <QuoteBlock quote={{ messageId: source.messageId, author: source.author, text: source.text || 'Attachment' }} data-testid="forward-message-preview" />
      <T size="xs" className="text-text-tertiary" data-testid="forward-message-origin">It will be posted with a note that it came from {source.origin.label}.</T>
      {items.length === 0
        ? <EmptyState icon={<ChatIcon size={24} />} title="Nowhere to send this" description="You can post in no other conversation right now." testId="forward-message-empty" />
        : <>
            <SearchInput value={query} onChange={setQuery} placeholder="Find a conversation…" aria-label="Find a conversation to forward to" />
            <ConversationList items={visible} grouped onSelect={target => { void pick(target); }} emptyLabel="No conversation matches" data-testid="forward-message-list" />
          </>}
    </PopoverForm>
  ) : null;

  return { onForwardMessage: enabled && connected ? open : undefined, picker };
}
