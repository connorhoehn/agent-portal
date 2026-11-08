// The ChannelBinding (docs/social-tenant-design.md §4.6, lane E): the `social:`
// channel bound to an embedding context (`initiative:<id>`), plus Bind /
// Unbind for a holder of ManageChannels in social.
//
// Where it lives (the user, 2026-10-06): "i never wanted the social stuff
// floating on the top fyi. the social bar is supposed to be on bottom with
// section tabs and stuff like my original design." So the binding is NOT a
// strip at the top of a page any more. A page names its context with
// `usePageSocialChannel` (components/shell/EmbeddedSocial.tsx); the bottom
// Social bar then offers that channel as a tab, and the embedded Social panel
// shows this file's `ChannelBinding` (the library's ChannelBindingStrip, 2.410.0)
// over the channel's own conversation.
//
// This file owns the data: the bindings fetch and the bind/unbind writes.
//
// Reads GET /api/social/bindings?context=<kind>:<id> — the BFF's cross-tenant
// route, gated on a grant in social AND in the context's tenant — and fetches
// NOTHING for a session with no social grant: the binding is a door into
// another product, and a person who cannot go through it should not see it.

import { useCallback, useState } from 'react';
import { MetaLine } from '@connorhoehn/ui-components/shared';
import { ChannelBindingStrip } from '@connorhoehn/ui-components/social';
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

export interface ChannelBindingState {
  data: ChannelBindingView | null;
  error: string | null;
  busy: boolean;
  writeError: string | null;
  /** `#slug` of the bound channel, or null. */
  label: string | null;
  /** Bound, or unbound but this caller may bind: worth a tab in the bar. */
  visible: boolean;
  bind(channel: string): Promise<void>;
  unbind(): Promise<void>;
  openInSocial(): void;
}

const bindingsUrl = (context: string) => `/api/social/bindings?context=${encodeURIComponent(context)}`;

/** The binding for `context` (`<kind>:<id>`), or an idle state when `context` is null. */
export function useChannelBinding(context: string | null): ChannelBindingState {
  const { session, enterContext } = useSession();
  const socialRole = session?.grants?.['social']?.[0] ?? null;
  const { data, error, refresh } = useFetch<ChannelBindingView>(socialRole && context ? bindingsUrl(context) : null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const write = useCallback(async (method: 'PUT' | 'DELETE', body?: unknown) => {
    if (!context) return;
    setBusy(true);
    setWriteError(null);
    const res = await writeJson<ChannelBindingView>(bindingsUrl(context), method, body);
    setBusy(false);
    if (!res.ok) { setWriteError(res.error); return; }
    refresh();
  }, [context, refresh]);
  const binding = socialRole && context ? data?.binding ?? null : null;
  return {
    data: socialRole && context ? data ?? null : null,
    error: socialRole && context ? error ?? null : null,
    busy, writeError,
    label: binding ? `#${binding.slug ?? binding.name}` : null,
    visible: !!socialRole && !!context && !!data && (!!binding || data.canManage),
    bind: (channel) => write('PUT', { channel }),
    unbind: () => write('DELETE'),
    openInSocial: () => {
      if (!socialRole || !binding?.slug) return;
      void enterContext('social', socialRole, `/social/channels/${encodeURIComponent(binding.slug)}`);
    },
  };
}

/** The library strip over a binding: channel, notice, Open in Social, Bind / Unbind. */
export function ChannelBinding({ state, latest, className, 'data-testid': testId = 'channel-binding' }: {
  state: ChannelBindingState;
  latest?: string | null;
  className?: string;
  'data-testid'?: string;
}) {
  const { data, error } = state;
  if (error) return <MetaLine size="xs" tone="tertiary" data-testid={testId} items={['Discussion unavailable', error]} />;
  if (!data || !state.visible) return null;
  const binding = data.binding;
  return (
    <ChannelBindingStrip
      label="Discussion"
      {...(className ? { className } : {})}
      data-testid={testId}
      {...(binding ? { channel: { name: binding.slug ?? binding.name, ...(binding.privacy ? { privacy: binding.privacy } : {}) } } : {})}
      latest={latest ?? null}
      {...(binding && !data.joined ? { notice: 'Join the channel in Social to post from here' } : {})}
      {...(binding ? { onOpen: state.openInSocial, openDisabled: !binding.slug } : {})}
      {...(binding ? {} : {
        choices: data.choices.map((c) => ({ value: c.channel, label: `#${c.slug}${c.privacy === 'private' ? ' (private)' : ''}` })),
        onBind: (value: string) => state.bind(value),
      })}
      {...(binding && data.canManage ? { onUnbind: () => state.unbind() } : {})}
      busy={state.busy}
      error={state.writeError}
    />
  );
}
