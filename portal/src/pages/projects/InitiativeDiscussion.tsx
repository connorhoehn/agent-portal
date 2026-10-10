// The initiative's Social channel (docs/social-tenant-design.md §4.6, lane E).
// The context key is `initiative:<id>` — the kind the BFF's bindings route maps
// to the orgiq tenant. The page does not draw the binding: it names the context
// and the bottom Social bar offers the bound channel as a tab (bind/unbind,
// newest message, Open in Social and the channel's own conversation live in the
// embedded Social panel). The user, 2026-10-06: "i never wanted the social stuff
// floating on the top fyi. the social bar is supposed to be on bottom with
// section tabs and stuff like my original design."

import { usePageSocialChannel } from '../../components/shell/EmbeddedSocial';

/** `initiative:<id>` — the bindings route's context for an initiative. */
export function initiativeBindingContext(initiativeId: string): string {
  return `initiative:${initiativeId}`;
}

/** Offer this initiative's bound Social channel in the bottom bar while the page is open. */
export function useInitiativeSocialChannel(initiativeId: string | null): void {
  usePageSocialChannel(initiativeId ? initiativeBindingContext(initiativeId) : null);
}
