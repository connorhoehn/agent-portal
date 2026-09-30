// The ChannelBinding strip (docs/social-tenant-design.md §4.6, lane E): one
// line on an embedding page — "Discussion · #auth-migration · Open in Social"
// — naming the `social:` channel bound to this context, plus Bind / Unbind for
// a holder of ManageChannels in social.
//
// Composed locally from library parts (Inline, Chip, Button, Select, Text,
// MetaLine) until ui-components ships the strip — the queue row in
// docs/ui-components-queue.md is what records that.
//
// Reads GET /api/social/bindings?context=<kind>:<id> — the BFF's cross-tenant
// route, gated on a grant in social AND in the context's tenant — and renders
// NOTHING for a session with no social grant (no fetch either): the strip is a
// door into another product, and a person who cannot go through it should not
// see it.
//
// The composer discipline (docs/social-calls-plan.md, "one composer, modes by
// context"): the strip does not draw a second composer. When the caller is a
// MEMBER of the bound channel it subscribes to it (`useChat`, the gateway
// admits members only — design E5 lets an orgiq token with a social grant
// through) and hands the page a `send` for its own composer's Chat mode via
// `onChat`. The newest message is shown on the strip so a sent line lands
// somewhere visible. Reading the whole conversation is Social's job: "Open in
// Social" crosses into that workspace on the channel's page.

import { useEffect, useRef, useState } from 'react';
import { Button, Chip, Inline, MetaLine, Select, Text } from '@connorhoehnslalom/ui-components/shared';
import { useChat, useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { writeJson } from '../../lib/writeJson';

export interface ChannelBindingView {
  context: string;
  tenant: string;
  binding: {
    channel: string;
    slug: string | null;
    name: string;
    privacy: 'public' | 'private' | null;
    createdBy: string;
    createdAt: string;
  } | null;
  joined: boolean;
  canManage: boolean;
  choices: Array<{ channel: string; slug: string; name: string; privacy: 'public' | 'private' }>;
}

/** What the strip hands its page for the page's composer (Chat mode). */
export interface BoundChannelChat {
  channel: string;
  /** `#slug` — for the composer's placeholder and reasons. */
  label: string;
  /** Post into the bound channel; false when the socket is down or the text is empty. */
  send(text: string): boolean;
}

export interface ChannelBindingProps {
  /** `<kind>:<id>` — e.g. `initiative:p-auth-migration`. */
  context: string;
  /** Called with the bound channel's chat (member + connected), or null. */
  onChat?(chat: BoundChannelChat | null): void;
  'data-testid'?: string;
}

const bindingsUrl = (context: string) => `/api/social/bindings?context=${encodeURIComponent(context)}`;

export function ChannelBinding({ context, onChat, 'data-testid': testId = 'channel-binding' }: ChannelBindingProps) {
  const { session, enterContext } = useSession();
  const socialRole = session?.grants?.['social']?.[0] ?? null;
  const { data, error, refresh } = useFetch<ChannelBindingView>(socialRole ? bindingsUrl(context) : null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);

  const binding = data?.binding ?? null;
  const live = !!binding && !!data?.joined;
  // No chat to hand over unless the subscriber below is mounted.
  useEffect(() => { if (!live) onChat?.(null); }, [live, onChat]);

  if (!socialRole) return null;
  if (error) {
    return <MetaLine size="xs" tone="tertiary" data-testid={testId} items={['Discussion unavailable', error]} />;
  }
  if (!data) return null;
  // Unbound and nothing this caller could do about it: no strip.
  if (!binding && !data.canManage) return null;

  const write = async (method: 'PUT' | 'DELETE', body?: unknown) => {
    setBusy(true);
    setWriteError(null);
    const res = await writeJson<ChannelBindingView>(bindingsUrl(context), method, body);
    setBusy(false);
    if (!res.ok) { setWriteError(res.error); return; }
    setPick('');
    refresh();
  };
  const label = binding ? `#${binding.slug ?? binding.name}` : '';
  const openInSocial = () => {
    if (!binding?.slug) return;
    void enterContext('social', socialRole, `/social/channels/${encodeURIComponent(binding.slug)}`);
  };

  return (
    <Inline gap="sm" align="center" wrap className="min-w-0 px-6 pt-3" data-testid={testId}>
      <Text className="text-[12px] font-medium text-text-secondary">Discussion</Text>
      {binding ? (
        <>
          <Chip tone="accent" size="xs" data-testid={`${testId}-channel`}>{label}</Chip>
          {live && (
            <BoundChannelSubscriber
              channel={binding.channel}
              label={label}
              displayName={session?.name ?? session?.sub ?? ''}
              onChat={onChat}
              onLatest={setLatest}
            />
          )}
          {latest && <Text className="min-w-0 truncate text-[12px] text-text-tertiary" title={latest} data-testid={`${testId}-latest`}>{latest}</Text>}
          {!data.joined && <MetaLine size="xs" tone="tertiary" items={['Join the channel in Social to post from here']} />}
          <Button size="sm" variant="ghost" className="h-7 text-[12px] font-medium" data-testid={`${testId}-open`} onClick={openInSocial} disabled={!binding.slug}>
            Open in Social
          </Button>
          {data.canManage && (
            <Button size="sm" variant="ghost" className="h-7 text-[12px] font-medium" data-testid={`${testId}-unbind`} disabled={busy}
              onClick={() => { void write('DELETE'); }}>
              Unbind
            </Button>
          )}
        </>
      ) : (
        <>
          <MetaLine size="xs" tone="tertiary" items={['No channel bound']} />
          <Select
            aria-label="Channel to bind"
            size="sm"
            className="w-48"
            value={pick}
            placeholder="Choose a channel"
            onChange={(e) => setPick(e.target.value)}
            options={data.choices.map((c) => ({ value: c.channel, label: `#${c.slug}${c.privacy === 'private' ? ' (private)' : ''}` }))}
            data-testid={`${testId}-choice`}
          />
          <Button size="sm" variant="secondary" className="h-7 text-[12px] font-medium" data-testid={`${testId}-bind`} disabled={!pick || busy}
            onClick={() => { void write('PUT', { channel: pick }); }}>
            Bind
          </Button>
        </>
      )}
      {writeError && <Text className="text-[12px] text-danger" role="alert" data-testid={`${testId}-error`}>{writeError}</Text>}
    </Inline>
  );
}

/**
 * Mounted only for a member of the bound channel: subscribes to it and hands
 * the page's composer a `send`. Separate so `useChat` is never called for a
 * channel the gateway would refuse (a forged subscribe answers
 * AUTHZ_CHANNEL_DENIED and a console error).
 */
function BoundChannelSubscriber({ channel, label, displayName, onChat, onLatest }: {
  channel: string;
  label: string;
  displayName: string;
  onChat?(chat: BoundChannelChat | null): void;
  onLatest(text: string | null): void;
}) {
  const chat = useChat(channel);
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const chatRef = useRef(chat);
  chatRef.current = chat;

  useEffect(() => {
    if (!connected) { onChat?.(null); return undefined; }
    onChat?.({
      channel,
      label,
      send: (text: string) => {
        const t = text.trim();
        if (!t) return false;
        try {
          chatRef.current.sendMessage(t, { displayName });
          return true;
        } catch {
          return false;
        }
      },
    });
    return () => onChat?.(null);
  }, [channel, label, connected, displayName, onChat]);

  const last = chat.messages[chat.messages.length - 1] as { message?: unknown; metadata?: { displayName?: unknown }; userId?: unknown } | undefined;
  const who = typeof last?.metadata?.displayName === 'string' ? last.metadata.displayName : typeof last?.userId === 'string' ? last.userId : '';
  const text = typeof last?.message === 'string' ? last.message.replace(/\s+/g, ' ').trim() : '';
  const summary = text ? `${who ? `${who}: ` : ''}${text}` : null;
  useEffect(() => { onLatest(summary); }, [summary, onLatest]);
  return null;
}
