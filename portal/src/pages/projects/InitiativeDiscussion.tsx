// The initiative's discussion (docs/social-tenant-design.md §4.6, lane E): the
// `social:` channel bound to this initiative, as the ChannelBinding strip on
// the overview. The context key is `initiative:<id>` — the kind the BFF's
// bindings route maps to the orgiq tenant. The strip hands the bound channel's
// chat to the page, whose ONE composer posts into it in Chat mode.

import { ChannelBinding, type BoundChannelChat } from '../../components/social/ChannelBindingStrip';

export type { BoundChannelChat };

/** `initiative:<id>` — the bindings route's context for an initiative. */
export function initiativeBindingContext(initiativeId: string): string {
  return `initiative:${initiativeId}`;
}

export function InitiativeDiscussion({ initiativeId, onChat }: {
  initiativeId: string;
  onChat(chat: BoundChannelChat | null): void;
}) {
  return <ChannelBinding context={initiativeBindingContext(initiativeId)} onChat={onChat} data-testid="initiative-channel-binding" />;
}
